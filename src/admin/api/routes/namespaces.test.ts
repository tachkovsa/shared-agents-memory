import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALL_SCOPES } from '../../../auth/types.js';
import { createNamespaceSkeleton } from '../../../namespaces/store.js';
import { ScryptPasswordHasher } from '../../auth/password.js';
import { SessionService } from '../../auth/session-service.js';
import { openDb, type Db } from '../../stores/db.js';
import { SqliteOperatorStore } from '../../stores/operator-store.js';
import { SqliteSessionStore } from '../../stores/session-store.js';
import { SESSION_COOKIE, createAdminApp } from '../app.js';

let db: Db;
let app: FastifyInstance;
let dataDir: string;

const GOOD = { username: 'admin', password: 'password123' };

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sam-bff-ns-'));
  await createNamespaceSkeleton(dataDir, {
    id: 'team-alpha',
    display_name: 'Team Alpha',
    owner_agent_id: 'agent_owner',
    owner_scopes: [...ALL_SCOPES],
  });

  db = openDb(':memory:');
  const operators = new SqliteOperatorStore(db);
  const sessions = new SessionService({
    operators,
    sessions: new SqliteSessionStore(db),
    hasher: new ScryptPasswordHasher({ N: 16384, r: 8, p: 1 }),
  });
  app = await createAdminApp({ sessions, operators, cookieSecure: false, dataDir });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function login(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/admin/setup', payload: GOOD });
  return res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
}

describe('admin BFF — namespace read API', () => {
  it('rejects an unauthenticated list with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/namespaces' });
    expect(res.statusCode).toBe(401);
  });

  it('lists namespaces for an authenticated operator', async () => {
    const sessionId = await login();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/namespaces',
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(res.statusCode).toBe(200);
    const { namespaces } = res.json();
    expect(namespaces).toHaveLength(1);
    expect(namespaces[0]).toMatchObject({
      id: 'team-alpha',
      display_name: 'Team Alpha',
      owner_agent_id: 'agent_owner',
      dedup_threshold: 0.95,
    });
  });

  it('returns namespace detail with members', async () => {
    const sessionId = await login();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/namespaces/team-alpha',
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe('team-alpha');
    expect(body.members).toEqual(
      expect.arrayContaining([expect.objectContaining({ agent_id: 'agent_owner' })]),
    );
  });

  it('404s an unknown namespace', async () => {
    const sessionId = await login();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/namespaces/nope',
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });
});
