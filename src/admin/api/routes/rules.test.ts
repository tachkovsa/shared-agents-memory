import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNamespaceSkeleton } from '../../../namespaces/store.js';
import { upsertRule } from '../../../rules/store.js';
import { ScryptPasswordHasher } from '../../auth/password.js';
import { SessionService } from '../../auth/session-service.js';
import { openDb, type Db } from '../../stores/db.js';
import { SqliteOperatorStore } from '../../stores/operator-store.js';
import { SqliteSessionStore } from '../../stores/session-store.js';
import { SESSION_COOKIE, createAdminApp } from '../app.js';

let db: Db;
let app: FastifyInstance;
let dataDir: string;
const NS = 'team-alpha';
const GOOD = { username: 'admin', password: 'password123' };

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sam-bff-rules-'));
  await createNamespaceSkeleton(dataDir, {
    id: NS,
    display_name: 'Team Alpha',
    owner_agent_id: 'agent_owner',
    owner_scopes: ['memory:read', 'memory:write'],
  });
  await upsertRule(dataDir, NS, {
    ruleId: 'no-secrets',
    title: 'Never store secrets',
    body: 'Do not store credentials in memory.',
    severity: 'hard',
    createdBy: 'agent_owner',
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

function authGet(url: string, sessionId: string) {
  return app.inject({ method: 'GET', url, headers: { cookie: `${SESSION_COOKIE}=${sessionId}` } });
}

describe('admin BFF — rules read API', () => {
  it('rejects unauthenticated list with 401', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/admin/namespaces/${NS}/rules` })).statusCode).toBe(401);
  });

  it('lists rule summaries for a namespace', async () => {
    const sid = await login();
    const res = await authGet(`/api/admin/namespaces/${NS}/rules`, sid);
    expect(res.statusCode).toBe(200);
    expect(res.json().rules).toEqual([
      expect.objectContaining({ id: 'no-secrets', title: 'Never store secrets', severity: 'hard' }),
    ]);
  });

  it('returns a single rule with body', async () => {
    const sid = await login();
    const res = await authGet(`/api/admin/namespaces/${NS}/rules/no-secrets`, sid);
    expect(res.statusCode).toBe(200);
    expect(res.json().frontmatter.id).toBe('no-secrets');
    expect(res.json().body).toContain('Do not store credentials');
  });

  it('404s unknown namespace and unknown rule', async () => {
    const sid = await login();
    expect((await authGet('/api/admin/namespaces/nope/rules', sid)).statusCode).toBe(404);
    expect((await authGet(`/api/admin/namespaces/${NS}/rules/ghost`, sid)).statusCode).toBe(404);
  });
});
