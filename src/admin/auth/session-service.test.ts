import { Secret, TOTP } from 'otpauth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../stores/db.js';
import { SqliteOperatorStore } from '../stores/operator-store.js';
import { SqliteSessionStore } from '../stores/session-store.js';
import { ScryptPasswordHasher } from './password.js';
import { SessionService, SetupClosedError } from './session-service.js';

let db: Db;
let clock: Date;
const now = () => clock;

function makeService(opts: { idleMs?: number; absoluteMs?: number } = {}): SessionService {
  return new SessionService({
    operators: new SqliteOperatorStore(db),
    sessions: new SqliteSessionStore(db),
    hasher: new ScryptPasswordHasher({ N: 16384, r: 8, p: 1 }),
    now,
    idleMs: opts.idleMs,
    absoluteMs: opts.absoluteMs,
  });
}

async function seedOwner(svc: SessionService): Promise<void> {
  await svc.createFirstOperator({ username: 'Admin', password: 'password123' });
}

function totpCode(secret: string, at: Date): string {
  return new TOTP({ secret: Secret.fromBase32(secret) }).generate({
    timestamp: at.getTime(),
  });
}

beforeEach(() => {
  db = openDb(':memory:');
  clock = new Date('2026-06-08T00:00:00.000Z');
});

afterEach(() => {
  db.close();
});

describe('SessionService — setup', () => {
  it('reports setup needed until the first operator exists', async () => {
    const svc = makeService();
    expect(await svc.needsSetup()).toBe(true);
    await seedOwner(svc);
    expect(await svc.needsSetup()).toBe(false);
  });

  it('normalizes the username to lower-case', async () => {
    const svc = makeService();
    const op = await svc.createFirstOperator({ username: 'Admin', password: 'password123' });
    expect(op.username).toBe('admin');
    expect(op.role).toBe('owner');
  });

  it('refuses a second first-operator', async () => {
    const svc = makeService();
    await seedOwner(svc);
    await expect(
      svc.createFirstOperator({ username: 'other', password: 'password123' }),
    ).rejects.toBeInstanceOf(SetupClosedError);
  });
});

describe('SessionService — login', () => {
  it('logs in with correct credentials and opens a session', async () => {
    const svc = makeService();
    await seedOwner(svc);
    const result = await svc.login({ username: 'admin', password: 'password123' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.operator_id).toBe(result.operator.id);
      expect(result.session.csrf_token).toHaveLength(64);
    }
  });

  it('rejects an unknown user and a wrong password identically', async () => {
    const svc = makeService();
    await seedOwner(svc);
    const noUser = await svc.login({ username: 'ghost', password: 'password123' });
    const badPw = await svc.login({ username: 'admin', password: 'wrong-password' });
    expect(noUser).toEqual({ ok: false, reason: 'invalid_credentials' });
    expect(badPw).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('blocks a disabled operator', async () => {
    const svc = makeService();
    await seedOwner(svc);
    db.prepare('UPDATE operators SET is_disabled = 1').run();
    const result = await svc.login({ username: 'admin', password: 'password123' });
    expect(result).toEqual({ ok: false, reason: 'disabled' });
  });

  it('enforces TOTP when a secret is enrolled', async () => {
    const svc = makeService();
    await seedOwner(svc);
    const secret = new Secret({ size: 20 }).base32;
    db.prepare('UPDATE operators SET totp_secret = ?').run(secret);

    expect(await svc.login({ username: 'admin', password: 'password123' })).toEqual({
      ok: false,
      reason: 'totp_required',
    });
    expect(
      await svc.login({ username: 'admin', password: 'password123', totp: '000000' }),
    ).toEqual({ ok: false, reason: 'totp_invalid' });

    const ok = await svc.login({
      username: 'admin',
      password: 'password123',
      totp: totpCode(secret, clock),
    });
    expect(ok.ok).toBe(true);
  });
});

describe('SessionService — resolveSession', () => {
  it('resolves a live session to its principal', async () => {
    const svc = makeService();
    await seedOwner(svc);
    const login = await svc.login({ username: 'admin', password: 'password123' });
    if (!login.ok) throw new Error('login failed');

    const principal = await svc.resolveSession(login.token);
    expect(principal).not.toBeNull();
    expect(principal?.operatorId).toBe(login.operator.id);
    expect(principal?.role).toBe('owner');
    expect(principal?.csrfToken).toBe(login.session.csrf_token);
  });

  it('rejects and deletes a session past its idle window', async () => {
    const svc = makeService({ idleMs: 1000, absoluteMs: 100_000 });
    await seedOwner(svc);
    const login = await svc.login({ username: 'admin', password: 'password123' });
    if (!login.ok) throw new Error('login failed');

    clock = new Date(clock.getTime() + 2000);
    expect(await svc.resolveSession(login.token)).toBeNull();
    // second resolve confirms the row was purged
    expect(await svc.resolveSession(login.token)).toBeNull();
  });

  it('slides the idle window forward on each resolve', async () => {
    const svc = makeService({ idleMs: 1000, absoluteMs: 100_000 });
    await seedOwner(svc);
    const login = await svc.login({ username: 'admin', password: 'password123' });
    if (!login.ok) throw new Error('login failed');

    clock = new Date(clock.getTime() + 500);
    expect(await svc.resolveSession(login.token)).not.toBeNull();
    // would be dead under the original 1000ms idle, but the resolve at +500 extended it
    clock = new Date(clock.getTime() + 900);
    expect(await svc.resolveSession(login.token)).not.toBeNull();
  });

  it('returns null after logout', async () => {
    const svc = makeService();
    await seedOwner(svc);
    const login = await svc.login({ username: 'admin', password: 'password123' });
    if (!login.ok) throw new Error('login failed');

    await svc.logout(login.session.id);
    expect(await svc.resolveSession(login.token)).toBeNull();
  });
});
