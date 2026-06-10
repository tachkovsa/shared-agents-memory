import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthAuditWriter, auditPathForDataDir } from '../../../auth/audit.js';
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
  dataDir = await mkdtemp(join(tmpdir(), 'sam-bff-audit-'));
  // successSampleRate=1 so auth.success lines are always written.
  const auditor = new AuthAuditWriter({ path: auditPathForDataDir(dataDir), successSampleRate: 1 });
  await auditor.record('auth.success', { agent_identity: 'a', tool_or_resource: 'memory_get' });
  await auditor.record('auth.failure', { reason: 'unknown_token' });
  await auditor.record('pat.minted', { pat_id: 'p1' });

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

describe('admin BFF — audit read API', () => {
  it('rejects unauthenticated read with 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/audit' })).statusCode).toBe(401);
  });

  it('returns recent entries newest-first', async () => {
    const sid = await login();
    const res = await authGet('/api/admin/audit', sid);
    expect(res.statusCode).toBe(200);
    const { entries, total } = res.json();
    expect(total).toBe(3);
    expect(entries).toHaveLength(3);
    expect(entries[0].event).toBe('pat.minted'); // newest first
  });

  it('filters by event', async () => {
    const sid = await login();
    const res = await authGet('/api/admin/audit?event=auth.failure', sid);
    expect(res.json().entries).toHaveLength(1);
    expect(res.json().entries[0].event).toBe('auth.failure');
  });

  it('respects the limit', async () => {
    const sid = await login();
    const res = await authGet('/api/admin/audit?limit=1', sid);
    expect(res.json().entries).toHaveLength(1);
    expect(res.json().total).toBe(3);
  });

  it('400s a bad limit', async () => {
    const sid = await login();
    expect((await authGet('/api/admin/audit?limit=0', sid)).statusCode).toBe(400);
  });

  it('returns an empty list when no audit file exists yet', async () => {
    // Fresh dataDir with no audit writes.
    const fresh = await mkdtemp(join(tmpdir(), 'sam-bff-audit-empty-'));
    const freshDb = openDb(':memory:');
    const operators = new SqliteOperatorStore(freshDb);
    const sessions = new SessionService({
      operators,
      sessions: new SqliteSessionStore(freshDb),
      hasher: new ScryptPasswordHasher({ N: 16384, r: 8, p: 1 }),
    });
    const freshApp = await createAdminApp({ sessions, operators, cookieSecure: false, dataDir: fresh });
    await freshApp.ready();
    try {
      const setupRes = await freshApp.inject({ method: 'POST', url: '/api/admin/setup', payload: GOOD });
      const sid = setupRes.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
      const res = await freshApp.inject({
        method: 'GET',
        url: '/api/admin/audit',
        headers: { cookie: `${SESSION_COOKIE}=${sid}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ entries: [], total: 0 });
    } finally {
      await freshApp.close();
      freshDb.close();
      await rm(fresh, { recursive: true, force: true });
    }
  });
});
