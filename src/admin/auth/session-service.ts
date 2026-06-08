import { randomBytes } from 'node:crypto';
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

export type LoginResult =
  | { ok: true; operator: Operator; session: OperatorSession }
  | {
      ok: false;
      reason: 'invalid_credentials' | 'disabled' | 'totp_required' | 'totp_invalid';
    };

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export class SessionService implements AuthProvider {
  private readonly operators: OperatorRepository;
  private readonly sessions: SessionRepository;
  private readonly hasher: PasswordHasher;
  private readonly idleMs: number;
  private readonly absoluteMs: number;
  private readonly now: () => Date;

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

  /** Create the first operator. Refuses once any operator exists. */
  async createFirstOperator(input: {
    username: string;
    password: string;
    role?: OperatorRole;
  }): Promise<Operator> {
    if (!(await this.needsSetup())) {
      throw new SetupClosedError();
    }
    const operator: NewOperator = {
      id: createId(),
      username: normalizeUsername(input.username),
      password_hash: await this.hasher.hash(input.password),
      totp_secret: null,
      role: input.role ?? 'owner',
      created_at: this.now().toISOString(),
    };
    await this.operators.create(operator);
    const created = await this.operators.getById(operator.id);
    if (!created) throw new Error('operator vanished after create');
    return created;
  }

  async login(
    input: { username: string; password: string; totp?: string },
    ctx: SessionContext = {},
  ): Promise<LoginResult> {
    const operator = await this.operators.getByUsername(
      normalizeUsername(input.username),
    );
    if (!operator) {
      return { ok: false, reason: 'invalid_credentials' };
    }
    if (operator.is_disabled) {
      return { ok: false, reason: 'disabled' };
    }
    if (!(await this.hasher.verify(input.password, operator.password_hash))) {
      return { ok: false, reason: 'invalid_credentials' };
    }
    if (operator.totp_secret) {
      if (!input.totp) return { ok: false, reason: 'totp_required' };
      if (!verifyTotp(operator.totp_secret, input.totp, this.now().getTime())) {
        return { ok: false, reason: 'totp_invalid' };
      }
    }

    await this.operators.recordLogin(operator.id, this.now().toISOString());
    const session = await this.createSession(operator.id, ctx);
    return { ok: true, operator, session };
  }

  async createSession(
    operatorId: string,
    ctx: SessionContext = {},
  ): Promise<OperatorSession> {
    const nowMs = this.now().getTime();
    const session: OperatorSession = {
      id: randomBytes(32).toString('hex'),
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
    return session;
  }

  /** AuthProvider: validate a cookie, slide the idle window, return the principal. */
  async resolveSession(sessionId: string): Promise<Principal | null> {
    const session = await this.sessions.get(sessionId);
    if (!session) return null;

    const nowMs = this.now().getTime();
    if (
      Date.parse(session.absolute_expires_at) <= nowMs ||
      Date.parse(session.idle_expires_at) <= nowMs
    ) {
      await this.sessions.delete(sessionId);
      return null;
    }

    const operator = await this.operators.getById(session.operator_id);
    if (!operator || operator.is_disabled) {
      await this.sessions.delete(sessionId);
      return null;
    }

    const nextIdle = Math.min(
      nowMs + this.idleMs,
      Date.parse(session.absolute_expires_at),
    );
    await this.sessions.touch(
      sessionId,
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
}

export class SetupClosedError extends Error {
  constructor() {
    super('setup is closed: an operator already exists');
    this.name = 'SetupClosedError';
  }
}
