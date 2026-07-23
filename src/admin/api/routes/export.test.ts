import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QdrantClient } from '@qdrant/js-client-rest';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditPathForDataDir } from '../../../auth/audit.js';
import type { EmbeddingClient } from '../../../embeddings.js';
import { MemoryService } from '../../../memory/service.js';
import { createNamespaceSkeleton } from '../../../namespaces/store.js';
import { ScryptPasswordHasher } from '../../auth/password.js';
import { SessionService } from '../../auth/session-service.js';
import { openDb, type Db } from '../../stores/db.js';
import { SqliteOperatorStore } from '../../stores/operator-store.js';
import { SqliteSessionStore } from '../../stores/session-store.js';
import { SESSION_COOKIE, createAdminApp } from '../app.js';

const GOOD = { username: 'admin', password: 'password123' };
const NS = 'team-alpha';
const FIXED_NOW = new Date('2026-07-23T00:00:00.000Z');

interface Point {
  id: string;
  payload: Record<string, unknown>;
}

/** Minimal stateful Qdrant fake backing scroll (the only op export exercises). */
function makeQdrant(points: Point[]): QdrantClient {
  const store = new Map(points.map((p) => [p.id, p]));
  return {
    async scroll(_c: string, opts: { limit?: number; offset?: unknown }) {
      const all = [...store.values()];
      const start = opts.offset ? all.findIndex((p) => p.id === opts.offset) : 0;
      const limit = opts.limit ?? 50;
      const page = all.slice(start, start + limit);
      const nextIdx = start + limit;
      return { points: page, next_page_offset: nextIdx < all.length ? all[nextIdx].id : null };
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
  app = await createAdminApp({
    sessions,
    operators,
    cookieSecure: false,
    dataDir,
    memoryService,
    now: () => FIXED_NOW,
  });
  await app.ready();
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sam-bff-export-'));
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

async function setup(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/admin/setup', payload: GOOD });
  return res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
}

function authGet(url: string, sessionId: string) {
  return app.inject({ method: 'GET', url, headers: { cookie: `${SESSION_COOKIE}=${sessionId}` } });
}

async function readAuditLines(): Promise<Array<{ event: string; details: Record<string, unknown> }>> {
  try {
    const raw = await readFile(auditPathForDataDir(dataDir), 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe('admin BFF — namespace export', () => {
  it('rejects an unauthenticated export with 401', async () => {
    await build([mem('a')]);
    expect((await app.inject({ method: 'GET', url: `/api/admin/namespaces/${NS}/export` })).statusCode).toBe(401);
  });

  it('404s an unknown namespace', async () => {
    await build([mem('a')]);
    const sessionId = await setup();
    expect((await authGet('/api/admin/namespaces/nope/export', sessionId)).statusCode).toBe(404);
  });

  it('streams NDJSON: content-type, Content-Disposition, one manifest + one line per record', async () => {
    await build([mem('a'), mem('b'), mem('c')]);
    const sessionId = await setup();
    const res = await authGet(`/api/admin/namespaces/${NS}/export`, sessionId);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-ndjson');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="${NS}-export-${FIXED_NOW.getTime()}.ndjson"`,
    );

    const lines = res.body.split('\n').filter(Boolean);
    // Every line must be valid JSON.
    const parsed = lines.map((l) => JSON.parse(l));
    // First line is the manifest, rest are memory records.
    expect(parsed[0]).toMatchObject({
      type: 'manifest',
      include_deleted: false,
      schema_version: 1,
      exported_at: FIXED_NOW.toISOString(),
    });
    expect(parsed[0].exported_by).toMatch(/^operator:/);
    expect(parsed[0].namespace.id).toBe(NS);
    const memories = parsed.slice(1);
    expect(memories.every((m) => m.type === 'memory')).toBe(true);
    expect(memories.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    // Record projection matches the console view (id/content/agent_id present).
    expect(memories[0]).toMatchObject({ id: 'a', content: 'content a', agent_id: 'agent-a' });
  });

  it('excludes soft-deleted by default; include_deleted=true opts them in', async () => {
    await build([mem('a'), mem('b', { deleted_at: '2026-06-05T00:00:00.000Z' })]);
    const sessionId = await setup();

    const def = await authGet(`/api/admin/namespaces/${NS}/export`, sessionId);
    const defIds = def.body
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((o) => o.type === 'memory')
      .map((o) => o.id);
    expect(defIds).toEqual(['a']);

    const inc = await authGet(`/api/admin/namespaces/${NS}/export?include_deleted=true`, sessionId);
    const incIds = inc.body
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((o) => o.type === 'memory')
      .map((o) => o.id)
      .sort();
    expect(incIds).toEqual(['a', 'b']);
  });

  it('format=json returns a single parseable {manifest, memories} object', async () => {
    await build([mem('a'), mem('b')]);
    const sessionId = await setup();
    const res = await authGet(`/api/admin/namespaces/${NS}/export?format=json`, sessionId);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="${NS}-export-${FIXED_NOW.getTime()}.json"`,
    );

    const body = JSON.parse(res.body);
    expect(body.manifest).toMatchObject({ schema_version: 1 });
    expect(body.manifest.exported_by).toMatch(/^operator:/);
    expect(body.memories.map((m: { id: string }) => m.id)).toEqual(['a', 'b']);
  });

  it('format=json with an empty namespace is still valid JSON', async () => {
    await build([]);
    const sessionId = await setup();
    const res = await authGet(`/api/admin/namespaces/${NS}/export?format=json`, sessionId);
    const body = JSON.parse(res.body);
    expect(body.memories).toEqual([]);
    expect(body.manifest.schema_version).toBe(1);
  });

  it('audits namespace.exported with record_count + include_deleted after the stream', async () => {
    await build([mem('a'), mem('b'), mem('c')]);
    const sessionId = await setup();
    await authGet(`/api/admin/namespaces/${NS}/export?include_deleted=true`, sessionId);

    const exported = (await readAuditLines()).find((l) => l.event === 'namespace.exported');
    expect(exported).toBeDefined();
    expect(exported!.details).toMatchObject({
      namespace_id: NS,
      record_count: 3,
      include_deleted: true,
    });
    expect(exported!.details.exported_by).toMatch(/^operator:/);
  });
});
