import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditPathForDataDir } from '../../../auth/audit.js';
import { ALL_SCOPES } from '../../../auth/types.js';
import { createNamespaceSkeleton } from '../../../namespaces/store.js';
import { ScryptPasswordHasher } from '../../auth/password.js';
import { SessionService } from '../../auth/session-service.js';
import { openDb, type Db } from '../../stores/db.js';
import { SqliteOperatorStore } from '../../stores/operator-store.js';
import { SqliteSessionStore } from '../../stores/session-store.js';
import { CSRF_HEADER, SESSION_COOKIE, createAdminApp } from '../app.js';

let db: Db;
let app: FastifyInstance;
let dataDir: string;
let qdrant: { count: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };

const GOOD = { username: 'admin', password: 'password123' };
const COLLECTION = 'agent_memories';

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
  qdrant = {
    count: vi.fn(async () => ({ count: 0 })),
    delete: vi.fn(async () => ({ status: 'completed' })),
  };
  app = await createAdminApp({
    sessions,
    operators,
    cookieSecure: false,
    dataDir,
    qdrant: qdrant as never,
    collection: COLLECTION,
  });
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

/** Log in and return both the session cookie and the CSRF token (for mutating routes). */
async function loginWithCsrf(): Promise<{ sessionId: string; csrf: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/admin/setup', payload: GOOD });
  const sessionId = res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  return { sessionId, csrf: res.json().csrf_token as string };
}

/** Create the `_deleted/<id>-<ts>` dir a prior soft-delete would have produced. */
async function seedDeletedDir(name: string): Promise<void> {
  await mkdir(join(dataDir, '_deleted', name), { recursive: true });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readAuditEvents(): Promise<string[]> {
  try {
    const raw = await readFile(auditPathForDataDir(dataDir), 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { event: string }).event);
  } catch {
    return [];
  }
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

describe('admin BFF — namespace hard-delete (purge)', () => {
  const PURGE = '/api/admin/namespaces/team-alpha/purge';

  it('rejects an unauthenticated purge with 401', async () => {
    const res = await app.inject({ method: 'DELETE', url: PURGE });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a purge without the CSRF header with 403', async () => {
    const { sessionId } = await loginWithCsrf();
    const res = await app.inject({
      method: 'DELETE',
      url: PURGE,
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'csrf' });
    // No purge happened.
    expect(qdrant.delete).not.toHaveBeenCalled();
  });

  it('404s a wholly unknown namespace', async () => {
    const { sessionId, csrf } = await loginWithCsrf();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/namespaces/ghost-ns/purge',
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}`, [CSRF_HEADER]: csrf },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('409s a LIVE namespace (must be soft-deleted first)', async () => {
    const { sessionId, csrf } = await loginWithCsrf();
    // team-alpha is live (created in beforeEach) and has no _deleted dir.
    const res = await app.inject({
      method: 'DELETE',
      url: PURGE,
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}`, [CSRF_HEADER]: csrf },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'namespace_live' });
    expect(qdrant.delete).not.toHaveBeenCalled();
  });

  it('purges a soft-deleted namespace: 200, verified receipt, hard_deleted audited', async () => {
    const { sessionId, csrf } = await loginWithCsrf();
    await seedDeletedDir('team-gone-1700000000000');
    // 3 points before the purge, 0 after → verified.
    qdrant.count.mockResolvedValueOnce({ count: 3 }).mockResolvedValueOnce({ count: 0 });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/namespaces/team-gone/purge',
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}`, [CSRF_HEADER]: csrf },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      namespace_id: 'team-gone',
      vectors: { points_before: 3, points_after: 0, purged: 3 },
      filesystem: { removed_dirs: ['team-gone-1700000000000'] },
      verified: true,
      purged_by: expect.stringMatching(/^operator:/),
    });
    // Vectors purged and the dir removed.
    expect(qdrant.delete).toHaveBeenCalledTimes(1);
    expect(await exists(join(dataDir, '_deleted', 'team-gone-1700000000000'))).toBe(false);
    // Receipt was audited.
    expect(await readAuditEvents()).toContain('namespace.hard_deleted');
  });

  it('is idempotent at the receipt level (re-run 404s after the dirs are gone)', async () => {
    const { sessionId, csrf } = await loginWithCsrf();
    await seedDeletedDir('team-gone-1700000000000');

    const first = await app.inject({
      method: 'DELETE',
      url: '/api/admin/namespaces/team-gone/purge',
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}`, [CSRF_HEADER]: csrf },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'DELETE',
      url: '/api/admin/namespaces/team-gone/purge',
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}`, [CSRF_HEADER]: csrf },
    });
    expect(second.statusCode).toBe(404);
  });

  it('500s (still audits) when the purge leaves vectors behind — partial purge is not a false success', async () => {
    const { sessionId, csrf } = await loginWithCsrf();
    await seedDeletedDir('team-gone-1700000000000');
    // 5 before, 5 still there after → verified:false.
    qdrant.count.mockResolvedValueOnce({ count: 5 }).mockResolvedValueOnce({ count: 5 });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/namespaces/team-gone/purge',
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}`, [CSRF_HEADER]: csrf },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({
      verified: false,
      vectors: { points_before: 5, points_after: 5 },
      filesystem: { removed_dirs: [] },
    });
    // The _deleted dir is preserved (backstop), and the unverified outcome is
    // audited as a purge failure — NOT as a hard_deleted success.
    expect(await exists(join(dataDir, '_deleted', 'team-gone-1700000000000'))).toBe(true);
    const events = await readAuditEvents();
    expect(events).toContain('namespace.vector_purge_failed');
    expect(events).not.toContain('namespace.hard_deleted');
  });
});
