import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QdrantClient } from '@qdrant/js-client-rest';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmbeddingClient } from '../../../embeddings.js';
import { MemoryService } from '../../../memory/service.js';
import { createNamespaceSkeleton } from '../../../namespaces/store.js';
import { ScryptPasswordHasher } from '../../auth/password.js';
import { SessionService } from '../../auth/session-service.js';
import { openDb, type Db } from '../../stores/db.js';
import { SqliteOperatorStore } from '../../stores/operator-store.js';
import { SqliteSessionStore } from '../../stores/session-store.js';
import { CSRF_HEADER, SESSION_COOKIE, createAdminApp } from '../app.js';

const GOOD = { username: 'admin', password: 'password123' };
const NS = 'team-alpha';

interface Point {
  id: string;
  payload: Record<string, unknown>;
}

/** Minimal stateful Qdrant fake backing scroll/retrieve/delete. */
function makeQdrant(points: Point[]): QdrantClient {
  const store = new Map(points.map((p) => [p.id, p]));
  return {
    async scroll(_c: string, opts: { limit?: number; offset?: unknown }) {
      const all = [...store.values()];
      const start = opts.offset ? all.findIndex((p) => p.id === opts.offset) : 0;
      const limit = opts.limit ?? 50;
      const page = all.slice(start, start + limit);
      const nextIdx = start + limit;
      return {
        points: page,
        next_page_offset: nextIdx < all.length ? all[nextIdx].id : null,
      };
    },
    async retrieve(_c: string, opts: { ids: string[] }) {
      return opts.ids.map((id) => store.get(id)).filter(Boolean);
    },
    async delete(_c: string, opts: { points: string[] }) {
      for (const id of opts.points) store.delete(id);
      return { status: 'completed' };
    },
  } as unknown as QdrantClient;
}

function mem(id: string, overrides: Partial<Record<string, unknown>> = {}): Point {
  return {
    id,
    payload: {
      namespace: NS,
      agent_id: 'agent-a',
      kind: 'episodic',
      content: `content ${id}`,
      tags: [],
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
      retrieval_count: 0,
      last_retrieved_at: null,
      decay_score: 1,
      superseded_by: null,
      deleted_at: null,
      staleness_signal: 'unverified',
      verifies_against: null,
      ...overrides,
    },
  };
}

const noEmbed = { embed: async () => [] } as unknown as EmbeddingClient;

let db: Db;
let app: FastifyInstance;
let dataDir: string;

async function build(points: Point[]): Promise<void> {
  const memoryService = new MemoryService({
    qdrant: makeQdrant(points),
    embeddings: noEmbed,
    collection: 'agent_memories',
  });
  db = openDb(':memory:');
  const operators = new SqliteOperatorStore(db);
  const sessions = new SessionService({
    operators,
    sessions: new SqliteSessionStore(db),
    hasher: new ScryptPasswordHasher({ N: 16384, r: 8, p: 1 }),
  });
  app = await createAdminApp({ sessions, operators, cookieSecure: false, dataDir, memoryService });
  await app.ready();
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sam-bff-mem-'));
  await createNamespaceSkeleton(dataDir, {
    id: NS,
    display_name: 'Team Alpha',
    owner_agent_id: 'agent_owner',
    owner_scopes: ['memory:read', 'memory:write'],
  });
});

afterEach(async () => {
  await app.close();
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function setup(): Promise<{ sessionId: string; csrf: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/admin/setup', payload: GOOD });
  const sessionId = res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  return { sessionId, csrf: res.json().csrf_token as string };
}

function authGet(url: string, sessionId: string) {
  return app.inject({ method: 'GET', url, headers: { cookie: `${SESSION_COOKIE}=${sessionId}` } });
}

describe('admin BFF — memory browser', () => {
  it('rejects unauthenticated list with 401', async () => {
    await build([mem('a')]);
    expect((await app.inject({ method: 'GET', url: `/api/admin/namespaces/${NS}/memories` })).statusCode).toBe(401);
  });

  it('404s an unknown namespace', async () => {
    await build([mem('a')]);
    const { sessionId } = await setup();
    expect((await authGet('/api/admin/namespaces/nope/memories', sessionId)).statusCode).toBe(404);
  });

  it('lists live memories and excludes soft-deleted by default', async () => {
    await build([mem('a'), mem('b', { deleted_at: '2026-06-05T00:00:00.000Z' })]);
    const { sessionId } = await setup();
    const res = await authGet(`/api/admin/namespaces/${NS}/memories`, sessionId);
    expect(res.statusCode).toBe(200);
    const { memories } = res.json();
    expect(memories.map((m: { id: string }) => m.id)).toEqual(['a']);
    expect(memories[0].content).toBe('content a');
  });

  it('includes soft-deleted with include_deleted=true', async () => {
    await build([mem('a'), mem('b', { deleted_at: '2026-06-05T00:00:00.000Z' })]);
    const { sessionId } = await setup();
    const res = await authGet(
      `/api/admin/namespaces/${NS}/memories?include_deleted=true`,
      sessionId,
    );
    expect(res.json().memories.map((m: { id: string }) => m.id).sort()).toEqual(['a', 'b']);
  });

  it('paginates via next_cursor', async () => {
    await build([mem('a'), mem('b'), mem('c')]);
    const { sessionId } = await setup();
    const first = await authGet(`/api/admin/namespaces/${NS}/memories?limit=2`, sessionId);
    expect(first.json().memories).toHaveLength(2);
    expect(first.json().next_cursor).toBe('c');
  });

  it('gets a single memory; 404 unknown', async () => {
    await build([mem('a')]);
    const { sessionId } = await setup();
    expect((await authGet(`/api/admin/namespaces/${NS}/memories/a`, sessionId)).json().id).toBe('a');
    expect((await authGet(`/api/admin/namespaces/${NS}/memories/zzz`, sessionId)).statusCode).toBe(404);
  });

  it('deletes a memory (CSRF required)', async () => {
    await build([mem('a')]);
    const { sessionId, csrf } = await setup();

    const noCsrf = await app.inject({
      method: 'DELETE',
      url: `/api/admin/namespaces/${NS}/memories/a`,
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(noCsrf.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'DELETE',
      url: `/api/admin/namespaces/${NS}/memories/a`,
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}`, [CSRF_HEADER]: csrf },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().deleted).toBe(true);
  });
});
