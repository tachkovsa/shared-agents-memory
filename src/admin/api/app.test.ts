import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScryptPasswordHasher } from '../auth/password.js';
import { SessionService } from '../auth/session-service.js';
import { openDb, type Db } from '../stores/db.js';
import { SqliteOperatorStore } from '../stores/operator-store.js';
import { SqliteSessionStore } from '../stores/session-store.js';
import { SESSION_COOKIE, createAdminApp } from './app.js';

let db: Db;
let app: FastifyInstance;

const GOOD = { username: 'admin', password: 'password123' };

beforeEach(async () => {
  db = openDb(':memory:');
  const operators = new SqliteOperatorStore(db);
  const sessions = new SessionService({
    operators,
    sessions: new SqliteSessionStore(db),
    hasher: new ScryptPasswordHasher(),
  });
  app = await createAdminApp({ sessions, operators, cookieSecure: false });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
});

interface Authed {
  sessionId: string;
  csrf: string;
}

async function setup(): Promise<Authed> {
  const res = await app.inject({ method: 'POST', url: '/api/admin/setup', payload: GOOD });
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  return { sessionId: cookie!.value, csrf: res.json().csrf_token };
}

describe('admin auth routes', () => {
  it('reports setup needed on a fresh instance', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/setup/status' });
    expect(res.json()).toEqual({ needs_setup: true });
  });

  it('creates the first operator and issues a session cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/setup', payload: GOOD });
    expect(res.statusCode).toBe(201);
    expect(res.json().operator.username).toBe('admin');
    expect(res.json().csrf_token).toHaveLength(64);
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBeTruthy();
  });

  it('rejects a second setup with 409', async () => {
    await setup();
    const res = await app.inject({ method: 'POST', url: '/api/admin/setup', payload: GOOD });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'setup_closed' });
  });

  it('rejects invalid setup input with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/setup',
      payload: { username: 'ab', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('401s on /me without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('logs in with correct credentials after setup', async () => {
    await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      payload: GOOD,
    });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBeTruthy();
  });

  it('rejects a wrong password with 401', async () => {
    await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      payload: { username: 'admin', password: 'nope-nope-nope' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
  });

  it('returns the current operator on /me with a valid session', async () => {
    const { sessionId } = await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/auth/me',
      cookies: { [SESSION_COOKIE]: sessionId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().operator.username).toBe('admin');
  });

  it('blocks logout without the CSRF header', async () => {
    const { sessionId } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/logout',
      cookies: { [SESSION_COOKIE]: sessionId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'csrf' });
  });

  it('logs out with cookie + CSRF header and invalidates the session', async () => {
    const { sessionId, csrf } = await setup();
    const out = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/logout',
      cookies: { [SESSION_COOKIE]: sessionId },
      headers: { 'x-csrf-token': csrf },
    });
    expect(out.statusCode).toBe(200);

    const me = await app.inject({
      method: 'GET',
      url: '/api/admin/auth/me',
      cookies: { [SESSION_COOKIE]: sessionId },
    });
    expect(me.statusCode).toBe(401);
  });
});
