import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QdrantClient } from '@qdrant/js-client-rest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNamespaceSkeleton, saveNamespace } from '../namespaces/store.js';
import type { RetentionPolicy } from '../namespaces/types.js';
import { DECAY_RETRIEVED_FLOOR, MEMORY_KIND } from '../memory/types.js';
import { DecaySweeper } from './decay.js';

const COLLECTION = 'agent_memories';
const NOW = new Date('2026-06-10T00:00:00.000Z');

interface FakePoint {
  id: string;
  payload: Record<string, unknown>;
}

interface FakeQdrant {
  scroll: ReturnType<typeof vi.fn>;
  setPayload: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

/** A scroll mock that returns a single page (no pagination) of `points`. */
function makeQdrant(points: FakePoint[], overrides: Partial<FakeQdrant> = {}): {
  client: QdrantClient;
  fake: FakeQdrant;
} {
  const fake: FakeQdrant = {
    scroll:
      overrides.scroll ??
      vi.fn(async () => ({ points, next_page_offset: null })),
    setPayload: overrides.setPayload ?? vi.fn(async () => ({ status: 'completed' })),
    delete: overrides.delete ?? vi.fn(async () => ({ status: 'completed' })),
  };
  return { client: fake as unknown as QdrantClient, fake };
}

function payload(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    namespace: 'ns',
    agent_id: 'agent_a',
    kind: MEMORY_KIND,
    content: 'c',
    tags: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    retrieval_count: 0,
    last_retrieved_at: null,
    decay_score: 1.0,
    superseded_by: null,
    deleted_at: null,
    staleness_signal: 'unverified',
    verifies_against: null,
    ...over,
  };
}

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sam-decay-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function makeNamespace(
  id: string,
  opts: {
    retention?: RetentionPolicy;
    soft_delete_after_days?: number | null;
    hard_delete_grace_days?: number;
  } = {},
): Promise<void> {
  await createNamespaceSkeleton(dataDir, {
    id,
    display_name: id,
    owner_agent_id: 'agent_a',
    owner_scopes: ['memory:read', 'memory:write'],
    retention_policy: opts.retention ?? 'decay-90d',
  });
  if (
    opts.soft_delete_after_days !== undefined ||
    opts.hard_delete_grace_days !== undefined
  ) {
    const { loadNamespace } = await import('../namespaces/store.js');
    const ns = await loadNamespace(dataDir, id);
    if (!ns) throw new Error('ns missing');
    if (opts.soft_delete_after_days !== undefined) {
      ns.soft_delete_after_days = opts.soft_delete_after_days;
    }
    if (opts.hard_delete_grace_days !== undefined) {
      ns.hard_delete_grace_days = opts.hard_delete_grace_days;
    }
    await saveNamespace(dataDir, ns);
  }
}

function makeSweeper(client: QdrantClient): DecaySweeper {
  return new DecaySweeper({
    qdrant: client,
    collection: COLLECTION,
    dataDir,
    now: () => NOW,
  });
}

describe('DecaySweeper.runOnce', () => {
  it('decays by age: a 90-day-old never-retrieved point gets decay_score ~0.5', async () => {
    await makeNamespace('ns', { retention: 'decay-90d' });
    // last_retrieved_at null → uses created_at, 90 days before NOW.
    const created = new Date(NOW.getTime() - 90 * 86_400_000).toISOString();
    const { client, fake } = makeQdrant([
      { id: 'p1', payload: payload({ created_at: created }) },
    ]);

    const stats = await makeSweeper(client).runOnce();

    expect(stats.namespacesSwept).toBe(1);
    expect(stats.pointsScored).toBe(1);
    const [, body] = fake.setPayload.mock.calls[0] as [
      string,
      { payload: { decay_score: number }; points: string[] },
    ];
    expect(body.payload.decay_score).toBeCloseTo(0.5, 5);
    expect(body.points).toEqual(['p1']);
  });

  it('floors decay at 0.5 for points that have ever been retrieved', async () => {
    await makeNamespace('ns', { retention: 'decay-90d' });
    // 360 days old → raw decay = 0.5**4 = 0.0625, but retrieval_count>0 floors at 0.5.
    const created = new Date(NOW.getTime() - 360 * 86_400_000).toISOString();
    const { client, fake } = makeQdrant([
      {
        id: 'p1',
        payload: payload({
          created_at: created,
          retrieval_count: 3,
          last_retrieved_at: created,
        }),
      },
    ]);

    await makeSweeper(client).runOnce();

    const [, body] = fake.setPayload.mock.calls[0] as [
      string,
      { payload: { decay_score: number } },
    ];
    expect(body.payload.decay_score).toBe(DECAY_RETRIEVED_FLOOR);
  });

  it('skips keep-forever namespaces entirely', async () => {
    await makeNamespace('ns', { retention: 'keep-forever' });
    const { client, fake } = makeQdrant([{ id: 'p1', payload: payload() }]);

    const stats = await makeSweeper(client).runOnce();

    expect(stats.namespacesSwept).toBe(0);
    expect(fake.scroll).not.toHaveBeenCalled();
    expect(fake.setPayload).not.toHaveBeenCalled();
  });

  it('skips immortal points (operator override)', async () => {
    await makeNamespace('ns', { retention: 'decay-90d' });
    const created = new Date(NOW.getTime() - 365 * 86_400_000).toISOString();
    const { client, fake } = makeQdrant([
      {
        id: 'p1',
        payload: payload({ created_at: created, metadata: { immortal: true } }),
      },
    ]);

    const stats = await makeSweeper(client).runOnce();

    expect(stats.pointsScored).toBe(0);
    expect(fake.setPayload).not.toHaveBeenCalled();
  });

  it('soft-deletes an unretrieved point past the threshold and audits it', async () => {
    await makeNamespace('ns', {
      retention: 'decay-90d',
      soft_delete_after_days: 100,
    });
    const created = new Date(NOW.getTime() - 200 * 86_400_000).toISOString();
    const { client, fake } = makeQdrant([
      { id: 'p1', payload: payload({ created_at: created }) },
    ]);

    const stats = await makeSweeper(client).runOnce();

    expect(stats.softDeleted).toBe(1);
    const [, body] = fake.setPayload.mock.calls[0] as [
      string,
      { payload: { deleted_at: string } },
    ];
    expect(body.payload.deleted_at).toBe(NOW.toISOString());

    const auditPath = join(dataDir, 'namespaces', 'ns', 'audit', 'lifecycle.jsonl');
    const audit = await readFile(auditPath, 'utf8');
    const line = JSON.parse(audit.trim().split('\n')[0]);
    expect(line.event).toBe('memory.soft_deleted');
    expect(line.point_id).toBe('p1');
    expect(line.reason).toBe('decay');
  });

  it('does NOT soft-delete a point that has been retrieved even when old', async () => {
    await makeNamespace('ns', {
      retention: 'decay-90d',
      soft_delete_after_days: 100,
    });
    const created = new Date(NOW.getTime() - 200 * 86_400_000).toISOString();
    const { client } = makeQdrant([
      { id: 'p1', payload: payload({ created_at: created, retrieval_count: 1 }) },
    ]);

    const stats = await makeSweeper(client).runOnce();
    expect(stats.softDeleted).toBe(0);
  });

  it('does NOT soft-delete when soft_delete_after_days is null (rank-only decay)', async () => {
    await makeNamespace('ns', { retention: 'decay-90d', soft_delete_after_days: null });
    const created = new Date(NOW.getTime() - 500 * 86_400_000).toISOString();
    const { client } = makeQdrant([
      { id: 'p1', payload: payload({ created_at: created }) },
    ]);

    const stats = await makeSweeper(client).runOnce();
    expect(stats.softDeleted).toBe(0);
    expect(stats.pointsScored).toBe(1);
  });

  it('hard-deletes a tombstone past the grace period and audits it', async () => {
    await makeNamespace('ns', {
      retention: 'decay-90d',
      hard_delete_grace_days: 30,
    });
    const deletedAt = new Date(NOW.getTime() - 40 * 86_400_000).toISOString();
    const { client, fake } = makeQdrant([
      { id: 'p1', payload: payload({ deleted_at: deletedAt }) },
    ]);

    const stats = await makeSweeper(client).runOnce();

    expect(stats.hardDeleted).toBe(1);
    expect(fake.delete).toHaveBeenCalledTimes(1);
    const [, body] = fake.delete.mock.calls[0] as [string, { points: string[] }];
    expect(body.points).toEqual(['p1']);
    // A tombstone is not rescored.
    expect(stats.pointsScored).toBe(0);

    const auditPath = join(dataDir, 'namespaces', 'ns', 'audit', 'lifecycle.jsonl');
    const audit = await readFile(auditPath, 'utf8');
    expect(audit).toContain('memory.hard_deleted');
  });

  it('keeps a tombstone within the grace period', async () => {
    await makeNamespace('ns', {
      retention: 'decay-90d',
      hard_delete_grace_days: 30,
    });
    const deletedAt = new Date(NOW.getTime() - 10 * 86_400_000).toISOString();
    const { client, fake } = makeQdrant([
      { id: 'p1', payload: payload({ deleted_at: deletedAt }) },
    ]);

    const stats = await makeSweeper(client).runOnce();
    expect(stats.hardDeleted).toBe(0);
    expect(fake.delete).not.toHaveBeenCalled();
  });

  it('paginates via next_page_offset', async () => {
    await makeNamespace('ns', { retention: 'decay-90d' });
    const created = new Date(NOW.getTime() - 90 * 86_400_000).toISOString();
    const scroll = vi
      .fn()
      .mockResolvedValueOnce({
        points: [{ id: 'p1', payload: payload({ created_at: created }) }],
        next_page_offset: 'PAGE2',
      })
      .mockResolvedValueOnce({
        points: [{ id: 'p2', payload: payload({ created_at: created }) }],
        next_page_offset: null,
      });
    const { client, fake } = makeQdrant([], { scroll });

    const stats = await makeSweeper(client).runOnce();

    expect(stats.pointsScored).toBe(2);
    expect(fake.scroll).toHaveBeenCalledTimes(2);
    const secondCall = fake.scroll.mock.calls[1][1] as { offset?: unknown };
    expect(secondCall.offset).toBe('PAGE2');
  });
});
