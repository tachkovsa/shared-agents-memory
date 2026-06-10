import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QdrantClient } from '@qdrant/js-client-rest';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PatStore } from '../../../auth/pat-store.js';
import { createNamespaceSkeleton } from '../../../namespaces/store.js';
import { ScryptPasswordHasher } from '../../auth/password.js';
import { SessionService } from '../../auth/session-service.js';
import { openDb, type Db } from '../../stores/db.js';
import { SqliteOperatorStore } from '../../stores/operator-store.js';
import { SqliteSessionStore } from '../../stores/session-store.js';
import { SESSION_COOKIE, createAdminApp } from '../app.js';

const GOOD = { username: 'admin', password: 'password123' };
const PEPPER = Buffer.from('test-pepper-0123456789abcdef0123', 'utf8');

function makeQdrant(opts: { down?: boolean; count?: number } = {}): QdrantClient {
  return {
    async getCollection() {
      if (opts.down) throw new Error('connection refused');
      return {};
    },
    async count() {
      return { count: opts.count ?? 0 };
    },
  } as unknown as QdrantClient;
}

let db: Db;
let app: FastifyInstance;
let dataDir: string;

async function build(qdrant: QdrantClient, breaker = 'closed'): Promise<void> {
  const patStore = await PatStore.open({ storePath: join(dataDir, 'pats.jsonl'), pepper: PEPPER });
  await patStore.mint({
    display_name: 'bot',
    agent_identity: 'bot',
    allowed_namespaces: ['personal'],
    scopes: ['memory:read'],
    created_by: 'operator:test',
    expires_at: null,
  });

  db = openDb(':memory:');
  const operators = new SqliteOperatorStore(db);
  const sessions = new SessionService({
    operators,
    sessions: new SqliteSessionStore(db),
    hasher: new ScryptPasswordHasher({ N: 16384, r: 8, p: 1 }),
  });
  app = await createAdminApp({
    sessions,
    operators,
    cookieSecure: false,
    dataDir,
    patStore,
    observability: { qdrant, collection: 'agent_memories', version: '9.9.9', getBreakerState: () => breaker },
  });
  await app.ready();
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sam-bff-obs-'));
  await createNamespaceSkeleton(dataDir, {
    id: 'personal',
    display_name: 'Personal',
    owner_agent_id: 'agent_owner',
    owner_scopes: ['memory:read'],
  });
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

describe('admin BFF — observability', () => {
  it('rejects unauthenticated access with 401', async () => {
    await build(makeQdrant());
    expect((await app.inject({ method: 'GET', url: '/api/admin/observability' })).statusCode).toBe(401);
  });

  it('reports ok health + counts + metrics', async () => {
    await build(makeQdrant({ count: 42 }));
    const sid = await login();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/observability',
      headers: { cookie: `${SESSION_COOKIE}=${sid}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.health).toMatchObject({ status: 'ok', qdrant: 'ok', embeddings_breaker: 'closed', version: '9.9.9' });
    expect(body.counts).toMatchObject({ namespaces: 1, memories: 42, pats_total: 1, pats_active: 1 });
    expect(body.metrics).toBeTypeOf('object');
  });

  it('degrades when Qdrant is down', async () => {
    await build(makeQdrant({ down: true }));
    const sid = await login();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/observability',
      headers: { cookie: `${SESSION_COOKIE}=${sid}` },
    });
    expect(res.json().health.status).toBe('degraded');
    expect(res.json().health.qdrant).toBe('down');
    expect(res.json().counts.memories).toBeNull();
  });

  it('degrades when the embeddings breaker is open', async () => {
    await build(makeQdrant(), 'open');
    const sid = await login();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/observability',
      headers: { cookie: `${SESSION_COOKIE}=${sid}` },
    });
    expect(res.json().health.status).toBe('degraded');
    expect(res.json().health.embeddings_breaker).toBe('open');
  });
});
