import { describe, expect, it } from 'vitest';
import type { Namespace } from '../namespaces/types.js';
import {
  exportNamespaceLines,
  type ExportItem,
  type ExportManifest,
  type ExportMemorySource,
} from './export.js';
import type { ListMemoryInput, ListMemoryResult, MemoryRecord } from './types.js';

function record(id: string, deletedAt: string | null = null): MemoryRecord {
  return {
    id,
    namespace: 'team-alpha',
    agentId: 'agent-a',
    kind: 'episodic',
    content: `content ${id}`,
    summary: undefined,
    metadata: undefined,
    tags: [],
    source: undefined,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    retrievalCount: 0,
    lastRetrievedAt: null,
    decayScore: 1,
    supersededBy: null,
    deletedAt,
    deletedBy: null,
    stalenessSignal: 'unverified',
    verifiesAgainst: null,
  };
}

/**
 * Stub MemoryService.list that serves fixed-size pages from an in-memory array,
 * returning the id of the first row of the NEXT page as the opaque cursor (null
 * at exhaustion) — the same contract MemoryService.list honours after #110.
 */
function pagedSource(all: MemoryRecord[]): ExportMemorySource & { calls: ListMemoryInput[] } {
  const calls: ListMemoryInput[] = [];
  return {
    calls,
    async list(input: ListMemoryInput): Promise<ListMemoryResult> {
      calls.push(input);
      const visible = input.includeDeleted ? all : all.filter((r) => r.deletedAt == null);
      const start = input.cursor ? visible.findIndex((r) => r.id === input.cursor) : 0;
      const limit = input.limit ?? visible.length;
      const page = visible.slice(start, start + limit);
      const nextIdx = start + limit;
      return { memories: page, nextCursor: nextIdx < visible.length ? visible[nextIdx].id : null };
    },
  };
}

const NS_CONFIG = { id: 'team-alpha', display_name: 'Team Alpha' } as unknown as Namespace;

function manifest(includeDeleted: boolean): ExportManifest {
  return {
    namespace: NS_CONFIG,
    exported_at: '2026-07-23T00:00:00.000Z',
    exported_by: 'operator:op-1',
    include_deleted: includeDeleted,
    schema_version: 1,
  };
}

async function collect(gen: AsyncGenerator<ExportItem>): Promise<ExportItem[]> {
  const out: ExportItem[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe('exportNamespaceLines', () => {
  it('emits the manifest first, then one memory item per record', async () => {
    const source = pagedSource([record('a'), record('b')]);
    const items = await collect(
      exportNamespaceLines(source, 'team-alpha', {
        includeDeleted: false,
        manifest: manifest(false),
        project: (m) => ({ id: m.id }),
      }),
    );
    expect(items[0]).toEqual({ kind: 'manifest', data: manifest(false) });
    const memories = items.filter((i) => i.kind === 'memory');
    expect(memories.map((m) => m.data.id)).toEqual(['a', 'b']);
    // record_count is the number of memory items.
    expect(memories).toHaveLength(2);
  });

  it('paginates across MULTIPLE list() pages following nextCursor', async () => {
    const all = ['a', 'b', 'c', 'd', 'e'].map((id) => record(id));
    const source = pagedSource(all); // → pages [a,b] [c,d] [e]
    const items = await collect(
      exportNamespaceLines(source, 'team-alpha', {
        includeDeleted: false,
        manifest: manifest(false),
        project: (m) => ({ id: m.id }),
        pageLimit: 2,
      }),
    );
    const memories = items.filter((i) => i.kind === 'memory');
    expect(memories.map((m) => m.data.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    // Three page fetches were required (the loop followed the cursor to exhaustion).
    expect(source.calls).toHaveLength(3);
    expect(source.calls.map((c) => c.cursor)).toEqual([undefined, 'c', 'e']);
  });

  it('excludes soft-deleted by default and includes them with include_deleted', async () => {
    const all = [record('a'), record('b', '2026-06-05T00:00:00.000Z'), record('c')];

    const excluded = await collect(
      exportNamespaceLines(pagedSource(all), 'team-alpha', {
        includeDeleted: false,
        manifest: manifest(false),
        project: (m) => ({ id: m.id }),
      }),
    );
    expect(excluded.filter((i) => i.kind === 'memory').map((m) => m.data.id)).toEqual(['a', 'c']);

    const included = await collect(
      exportNamespaceLines(pagedSource(all), 'team-alpha', {
        includeDeleted: true,
        manifest: manifest(true),
        project: (m) => ({ id: m.id }),
      }),
    );
    expect(included.filter((i) => i.kind === 'memory').map((m) => m.data.id)).toEqual(['a', 'b', 'c']);
  });

  it('threads includeDeleted into every list() call', async () => {
    const source = pagedSource([record('a')]);
    await collect(
      exportNamespaceLines(source, 'team-alpha', {
        includeDeleted: true,
        manifest: manifest(true),
        project: (m) => ({ id: m.id }),
      }),
    );
    expect(source.calls.every((c) => c.includeDeleted === true)).toBe(true);
  });
});
