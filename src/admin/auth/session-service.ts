import { createHash, randomBytes } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import type {
  NewOperator,
  Operator,
  OperatorRepository,
  OperatorRole,
  OperatorSession,
  SessionRepository,
} from '../stores/types.js';
import type { AuthProvider, Principal } from './auth-provider.js';
import type { PasswordHasher } from './password.js';
import { verifyTotp } from './totp.js';

export const DEFAULT_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionServiceOptions {
  operators: OperatorRepository;
  sessions: SessionRepository;
  hasher: PasswordHasher;
  idleMs?: number;
  absoluteMs?: number;
  now?: () => Date;
}

export interface SessionContext {
  ip?: string | null;
  userAgent?: string | null;
}

/** A fresh session plus the raw cookie token (the DB stores only its hash). */
export interface IssuedSession {
  session: OperatorSession;
  token: string;
}

export type LoginResult =
  | { ok: true; operator: Operator; session: OperatorSession; token: string }
  | {
      ok: false;
      reason: 'invalid_credentials' | 'disabled' | 'totp_required' | 'totp_invalid';
    };

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * Hash the cookie token before it touches the DB so a read-only database leak
 * does not hand an attacker live sessions. The token is 256-bit random, so a
 * plain SHA-256 is preimage-safe here.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class SessionService implements AuthProvider {
  private readonly operators: OperatorRepository;
  private readonly sessions: SessionRepository;
  private readonly hasher: PasswordHasher;
  private readonly idleMs: number;
  private readonly absoluteMs: number;
  private readonly now: () => Date;
  private dummyHash: string | null = null;

  constructor(opts: SessionServiceOptions) {
    this.operators = opts.operators;
    this.sessions = opts.sessions;
    this.hasher = opts.hasher;
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.absoluteMs = opts.absoluteMs ?? DEFAULT_ABSOLUTE_MS;
    this.now = opts.now ?? (() => new Date());
  }

  /** True when no operator exists yet — the setup flow is open (ADR-0007 §3.4). */
  async needsSetup(): Promise<boolean> {
    return (await this.operators.count()) === 0;
  }

  /** Create the first operator atomically. Refuses once any operator exists. */
  async createFirstOperator(input: {
    username: string;
    password: string;
    role?: OperatorRole;
  }): Promise<Operator> {
    const operator: NewOperator = {
      id: createId(),
      username: normalizeUsername(input.username),
      password_hash: await this.hasher.hash(input.password),
      totp_secret: null,
      role: input.role ?? 'owner',
      created_at: this.now().toISOString(),
    };
    const created = await this.operators.createFirst(operator);
    if (!created) throw new SetupClosedError();
    const result = await this.operators.getById(operator.id);
    if (!result) throw new Error('operator vanished after create');
    return result;
  }

  async login(
    input: { username: string; password: string; totp?: string },
    ctx: SessionContext = {},
  ): Promise<LoginResult> {
    const operator = await this.operators.getByUsername(
      normalizeUsername(input.username),
    );
    if (!operator) {
      // Verify against a dummy hash so an unknown user costs the same as a real
      // one — no timing oracle for username enumeration.
      await this.hasher.verify(input.password, await this.getDummyHash());
      return { ok: false, reason: 'invalid_credentials' };
    }
    if (!(await this.hasher.verify(input.password, operator.password_hash))) {
      return { ok: false, reason: 'invalid_credentials' };
    }
    // Disabled is checked only after a correct password, so a wrong password
    // can't reveal that an account exists.
    if (operator.is_disabled) {
      return { ok: false, reason: 'disabled' };
    }
    if (operator.totp_secret) {
      if (!input.totp) return { ok: false, reason: 'totp_required' };
      if (!verifyTotp(operator.totp_secret, input.totp, this.now().getTime())) {
        return { ok: false, reason: 'totp_invalid' };
      }
    }

    const ts = this.now().toISOString();
    await this.operators.recordLogin(operator.id, ts);
    const { session, token } = await this.createSession(operator.id, ctx);
    return { ok: true, operator: { ...operator, last_login_at: ts }, session, token };
  }

  async createSession(
    operatorId: string,
    ctx: SessionContext = {},
  ): Promise<IssuedSession> {
    const token = randomBytes(32).toString('hex');
    const nowMs = this.now().getTime();
    const session: OperatorSession = {
      id: hashToken(token),
      operator_id: operatorId,
      created_at: new Date(nowMs).toISOString(),
      absolute_expires_at: new Date(nowMs + this.absoluteMs).toISOString(),
      idle_expires_at: new Date(nowMs + this.idleMs).toISOString(),
      last_seen_at: new Date(nowMs).toISOString(),
      csrf_token: randomBytes(32).toString('hex'),
      ip: ctx.ip ?? null,
      user_agent: ctx.userAgent ?? null,
    };
    await this.sessions.create(session);
    return { session, token };
  }

  /** AuthProvider: validate a cookie token, slide the idle window, return the principal. */
  async resolveSession(token: string): Promise<Principal | null> {
    const id = hashToken(token);
    const session = await this.sessions.get(id);
    if (!session) return null;

    const nowMs = this.now().getTime();
    if (
      Date.parse(session.absolute_expires_at) <= nowMs ||
      Date.parse(session.idle_expires_at) <= nowMs
    ) {
      await this.sessions.delete(id);
      return null;
    }

    const operator = await this.operators.getById(session.operator_id);
    if (!operator || operator.is_disabled) {
      await this.sessions.delete(id);
      return null;
    }

    const nextIdle = Math.min(
      nowMs + this.idleMs,
      Date.parse(session.absolute_expires_at),
    );
    await this.sessions.touch(
      id,
      new Date(nextIdle).toISOString(),
      new Date(nowMs).toISOString(),
    );

    return {
      operatorId: operator.id,
      role: operator.role,
      sessionId: session.id,
      csrfToken: session.csrf_token,
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessions.delete(sessionId);
  }

  async logoutAll(operatorId: string): Promise<void> {
    await this.sessions.deleteByOperator(operatorId);
  }

  private async getDummyHash(): Promise<string> {
    if (this.dummyHash === null) {
      this.dummyHash = await this.hasher.hash('invalid-credentials-placeholder');
    }
    return this.dummyHash;
  }
}

export class SetupClosedError extends Error {
  constructor() {
    super('setup is closed: an operator already exists');
    this.name = 'SetupClosedError';
  }
}
