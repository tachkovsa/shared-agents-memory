/**
 * scripts/reembed-collection.test.ts
 *
 * Tests for the re-embed migration core. Uses in-memory fake Qdrant clients and
 * a fake embedder so nothing touches a real Qdrant or embedding provider.
 */

import { describe, expect, it, vi } from 'vitest';
import { parseCliArgs, reembedCollection, ReembedError } from './reembed-collection.js';

interface FakePoint {
  id: string | number;
  payload: Record<string, unknown>;
}

/** Minimal Qdrant scroll/upsert fake backed by an array, with pagination. */
function makeSource(points: FakePoint[]) {
  return {
    async scroll(
      _collection: string,
      opts: { limit: number; offset?: number },
    ): Promise<{ points: FakePoint[]; next_page_offset: number | null }> {
      const start = typeof opts.offset === 'number' ? opts.offset : 0;
      const slice = points.slice(start, start + opts.limit);
      const nextStart = start + opts.limit;
      return {
        points: slice,
        next_page_offset: nextStart < points.length ? nextStart : null,
      };
    },
  };
}

function makeTarget() {
  const upserted: { id: string | number; vector: number[]; payload: Record<string, unknown> }[] =
    [];
  return {
    upserted,
    async upsert(
      _collection: string,
      args: { points: { id: string | number; vector: number[]; payload: Record<string, unknown> }[] },
    ): Promise<void> {
      upserted.push(...args.points);
    },
  };
}

/** Fake embedder: returns a deterministic 1024-dim-ish vector per input. */
function makeEmbedder(dim = 4) {
  return {
    embedBatch: vi.fn(async (inputs: string[]): Promise<number[][]> =>
      inputs.map((s) => Array.from({ length: dim }, (_, i) => s.length + i)),
    ),
  };
}

const P = (id: string, content: string, extra: Record<string, unknown> = {}): FakePoint => ({
  id,
  payload: { namespace: 'personal', content, ...extra },
});

describe('reembedCollection', () => {
  it('re-embeds every point and preserves id + payload', async () => {
    const source = makeSource([P('a', 'alpha'), P('b', 'beta')]);
    const target = makeTarget();
    const embeddings = makeEmbedder();

    const summary = await reembedCollection({
      source: source as never,
      target: target as never,
      embeddings,
      sourceCollection: 'src',
      targetCollection: 'dst',
      batchSize: 10,
      dryRun: false,
      skipDeleted: false,
    });

    expect(summary).toMatchObject({ scanned: 2, upserted: 2, skipped: 0 });
    expect(summary.errors).toHaveLength(0);
    expect(target.upserted.map((p) => p.id)).toEqual(['a', 'b']);
    // Payload copied verbatim (re-embed changes only the vector).
    expect(target.upserted[0].payload).toEqual({ namespace: 'personal', content: 'alpha' });
    expect(target.upserted[0].vector).toHaveLength(4);
  });

  it('paginates across multiple scroll pages', async () => {
    const points = Array.from({ length: 25 }, (_, i) => P(`p${i}`, `content ${i}`));
    const source = makeSource(points);
    const target = makeTarget();

    const summary = await reembedCollection({
      source: source as never,
      target: target as never,
      embeddings: makeEmbedder(),
      sourceCollection: 'src',
      targetCollection: 'dst',
      batchSize: 10,
      dryRun: false,
      skipDeleted: false,
    });

    expect(summary.scanned).toBe(25);
    expect(summary.upserted).toBe(25);
    expect(target.upserted).toHaveLength(25);
  });

  it('skips empty-content points', async () => {
    const source = makeSource([P('a', 'alpha'), P('b', ''), { id: 'c', payload: { namespace: 'x' } }]);
    const target = makeTarget();

    const summary = await reembedCollection({
      source: source as never,
      target: target as never,
      embeddings: makeEmbedder(),
      sourceCollection: 'src',
      targetCollection: 'dst',
      batchSize: 10,
      dryRun: false,
      skipDeleted: false,
    });

    expect(summary).toMatchObject({ scanned: 3, upserted: 1, skipped: 2 });
    expect(target.upserted.map((p) => p.id)).toEqual(['a']);
  });

  it('honours --skip-deleted', async () => {
    const source = makeSource([
      P('a', 'alpha'),
      P('b', 'beta', { deleted_at: '2026-01-01T00:00:00Z' }),
    ]);
    const target = makeTarget();

    const summary = await reembedCollection({
      source: source as never,
      target: target as never,
      embeddings: makeEmbedder(),
      sourceCollection: 'src',
      targetCollection: 'dst',
      batchSize: 10,
      dryRun: false,
      skipDeleted: true,
    });

    expect(summary).toMatchObject({ scanned: 2, upserted: 1, skipped: 1 });
    expect(target.upserted.map((p) => p.id)).toEqual(['a']);
  });

  it('copies tombstones by default (no --skip-deleted)', async () => {
    const source = makeSource([P('b', 'beta', { deleted_at: '2026-01-01T00:00:00Z' })]);
    const target = makeTarget();

    const summary = await reembedCollection({
      source: source as never,
      target: target as never,
      embeddings: makeEmbedder(),
      sourceCollection: 'src',
      targetCollection: 'dst',
      batchSize: 10,
      dryRun: false,
      skipDeleted: false,
    });

    expect(summary.upserted).toBe(1);
    expect(target.upserted[0].payload['deleted_at']).toBe('2026-01-01T00:00:00Z');
  });

  it('dry-run embeds but does not upsert', async () => {
    const source = makeSource([P('a', 'alpha'), P('b', 'beta')]);
    const target = makeTarget();
    const embeddings = makeEmbedder();

    const summary = await reembedCollection({
      source: source as never,
      target: target as never,
      embeddings,
      sourceCollection: 'src',
      targetCollection: 'dst',
      batchSize: 10,
      dryRun: true,
      skipDeleted: false,
    });

    expect(summary.upserted).toBe(2);
    expect(embeddings.embedBatch).toHaveBeenCalled();
    expect(target.upserted).toHaveLength(0);
  });

  it('throws ReembedError when the embedder fails (dimension guard)', async () => {
    const source = makeSource([P('a', 'alpha')]);
    const target = makeTarget();
    const embeddings = {
      embedBatch: vi.fn(async () => {
        throw new Error('Embedding dimension mismatch: expected 1024, got 4096');
      }),
    };

    await expect(
      reembedCollection({
        source: source as never,
        target: target as never,
        embeddings,
        sourceCollection: 'src',
        targetCollection: 'dst',
        batchSize: 10,
        dryRun: false,
        skipDeleted: false,
      }),
    ).rejects.toThrow(ReembedError);
  });
});

describe('parseCliArgs', () => {
  it('requires --source-collection', () => {
    expect(() => parseCliArgs([])).toThrow(ReembedError);
  });

  it('parses flags and clamps batch size', () => {
    const opts = parseCliArgs([
      '--source-collection',
      'agent_memories_src',
      '--batch',
      '999',
      '--dry-run',
      '--skip-deleted',
    ]);
    expect(opts.sourceCollection).toBe('agent_memories_src');
    expect(opts.batchSize).toBe(256); // clamped
    expect(opts.dryRun).toBe(true);
    expect(opts.skipDeleted).toBe(true);
  });

  it('defaults batch size to 32 when omitted', () => {
    const opts = parseCliArgs(['--source-collection', 'src']);
    expect(opts.batchSize).toBe(32);
  });
});
