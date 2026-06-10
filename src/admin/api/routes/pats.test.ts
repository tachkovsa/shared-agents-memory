import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PatStore } from '../../../auth/pat-store.js';
import { createNamespaceSkeleton, loadMembers } from '../../../namespaces/store.js';
import { ScryptPasswordHasher } from '../../auth/password.js';
import { SessionService } from '../../auth/session-service.js';
import { openDb, type Db } from '../../stores/db.js';
import { SqliteOperatorStore } from '../../stores/operator-store.js';
import { SqliteSessionStore } from '../../stores/session-store.js';
import { CSRF_HEADER, SESSION_COOKIE, createAdminApp } from '../app.js';

let db: Db;
let app: FastifyInstance;
let dataDir: string;
let patStore: PatStore;

const GOOD = { username: 'admin', password: 'password123' };
const PEPPER = Buffer.from('test-pepper-0123456789abcdef0123', 'utf8');

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sam-bff-pats-'));
  patStore = await PatStore.open({ storePath: join(dataDir, 'pats.jsonl'), pepper: PEPPER });

  db = openDb(':memory:');
  const operators = new SqliteOperatorStore(db);
  const sessions = new SessionService({
    operators,
    sessions: new SqliteSessionStore(db),
    hasher: new ScryptPasswordHasher({ N: 16384, r: 8, p: 1 }),
  });
  app = await createAdminApp({ sessions, operators, cookieSecure: false, patStore, dataDir });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** Create the first operator and return its session cookie + CSRF token. */
async function setup(): Promise<{ sessionId: string; csrf: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/admin/setup', payload: GOOD });
  const sessionId = res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  return { sessionId, csrf: res.json().csrf_token as string };
}

function authGet(url: string, sessionId: string) {
  return app.inject({ method: 'GET', url, headers: { cookie: `${SESSION_COOKIE}=${sessionId}` } });
}

const NEW_PAT = {
  display_name: 'CI bot',
  agent_identity: 'ci-bot',
  allowed_namespaces: ['personal'],
  scopes: ['memory:read', 'memory:write'],
};

describe('admin BFF — PAT management', () => {
  it('rejects an unauthenticated list with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/pats' });
    expect(res.statusCode).toBe(401);
  });

  it('mints a PAT, returns the secret once, and never leaks the hash', async () => {
    const { sessionId, csrf } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/pats',
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}`, [CSRF_HEADER]: csrf },
      payload: NEW_PAT,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.secret).toMatch(/^sam_pat_/);
    expect(body.pat.created_by).toMatch(/^operator:/);
    expect(body.pat.agent_identity).toBe('ci-bot');
    // The hash must never cross the wire.
    expect(body.pat.token_hash).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('token_hash');
  });

  it('lists minted PATs in redacted form', async () => {
    const { sessionId, csrf } = await setup();
    await app.inject({
      method: 'POST',
      url: '/api/admin/pats',
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}`, [CSRF_HEADER]: csrf },
      payload: NEW_PAT,
    });
    const res = await authGet('/api/admin/pats', sessionId);
    expect(res.statusCode).toBe(200);
    const { pats } = res.json();
    expect(pats).toHaveLength(1);
    expect(pats[0].agent_identity).toBe('ci-bot');
    expect(pats[0].token_hash).toBeUndefined();
    expect(pats[0].secret).toBeUndefined();
  });

  it('revokes a PAT', async () => {
    const { sessionId, csrf } = await setup();
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/admin/pats',
        headers: { cookie: `${SESSION_COOKIE}=${sessionId}`, [CSRF_HEADER]: csrf },
        payload: NEW_PAT,
      })
    ).json();
    const id = created.pat.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/pats/${id}/revoke`,
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}`, [CSRF_HEADER]: csrf },
      payload: { reason: 'compromised' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().is_revoked).toBe(true);
    expect(res.json().revoked_reason).toBe('compromised');
  });

  it('404s revoke / get on an unknown id', async () => {
    const { sessionId, csrf } = await setup();
    expect((await authGet('/api/admin/pats/nope', sessionId)).statusCode).toBe(404);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/pats/nope/revoke',
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}`, [CSRF_HEADER]: csrf },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('blocks a create without the CSRF header (403)', async () => {
    const { sessionId } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/pats',
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
      payload: NEW_PAT,
    });
    expect(res.statusCode).toBe(403);
  });

  it('prunes orphaned memberships when an agent\'s last PAT is revoked', async () => {
    // A namespace owned by (and therefore a member for) agent identity 'solo'.
    await createNamespaceSkeleton(dataDir, {
      id: 'team-solo',
      display_name: 'Solo',
      owner_agent_id: 'solo',
      owner_scopes: ['memory:read', 'memory:write'],
    });
    expect((await loadMembers(dataDir, 'team-solo'))?.some((m) => m.agent_id === 'solo')).toBe(true);

    const { sessionId, csrf } = await setup();
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/admin/pats',
        headers: { cookie: `${SESSION_COOKIE}=${sessionId}`, [CSRF_HEADER]: csrf },
        payload: { ...NEW_PAT, agent_identity: 'solo' },
      })
    ).json();

    await app.inject({
      method: 'POST',
      url: `/api/admin/pats/${created.pat.id}/revoke`,
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}`, [CSRF_HEADER]: csrf },
      payload: {},
    });

    // 'solo' had no other active PAT → its membership is pruned.
    expect((await loadMembers(dataDir, 'team-solo'))?.some((m) => m.agent_id === 'solo')).toBe(false);
  });

  it('400s an invalid scope', async () => {
    const { sessionId, csrf } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/pats',
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}`, [CSRF_HEADER]: csrf },
      payload: { ...NEW_PAT, scopes: ['memory:teleport'] },
    });
    expect(res.statusCode).toBe(400);
  });
});
