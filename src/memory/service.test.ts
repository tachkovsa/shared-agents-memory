import type { QdrantClient } from '@qdrant/js-client-rest';
import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingClient } from '../embeddings.js';
import {
  MemoryNotFoundError,
  MemoryService,
  MemoryValidationError,
} from './service.js';
import {
  MEMORY_KIND,
  MEMORY_MAX_CONTENT_LENGTH,
  MEMORY_MAX_TAGS,
} from './types.js';

const COLLECTION = 'agent_memories';

function makeVector(): number[] {
  return Array.from({ length: 4096 }, () => 0);
}

function makeEmbeddings(vector: number[] = makeVector()) {
  return {
    embed: vi.fn(async (_text: string) => vector),
  } as unknown as EmbeddingClient;
}

interface FakeQdrant {
  upsert: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  retrieve: ReturnType<typeof vi.fn>;
  setPayload: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function makeQdrant(overrides: Partial<FakeQdrant> = {}): {
  client: QdrantClient;
  fake: FakeQdrant;
} {
  const fake: FakeQdrant = {
    upsert: overrides.upsert ?? vi.fn(async () => ({ status: 'completed' })),
    search: overrides.search ?? vi.fn(async () => []),
    retrieve: overrides.retrieve ?? vi.fn(async () => []),
    setPayload: overrides.setPayload ?? vi.fn(async () => ({ status: 'completed' })),
    delete: overrides.delete ?? vi.fn(async () => ({ status: 'completed' })),
  };
  return { client: fake as unknown as QdrantClient, fake };
}

function makeService(opts: {
  qdrant?: QdrantClient;
  embeddings?: EmbeddingClient;
  now?: () => Date;
} = {}): MemoryService {
  return new MemoryService({
    qdrant: opts.qdrant ?? makeQdrant().client,
    embeddings: opts.embeddings ?? makeEmbeddings(),
    collection: COLLECTION,
    now: opts.now,
  });
}

describe('MemoryService.store', () => {
  it('embeds content and upserts a payload with kind=episodic', async () => {
    const { client, fake } = makeQdrant();
    const vector = Array.from({ length: 4096 }, () => 0.5);
    const embeddings = makeEmbeddings(vector);
    const service = makeService({
      qdrant: client,
      embeddings,
      now: () => new Date('2026-05-27T10:00:00.000Z'),
    });

    const record = await service.store({
      namespace: 'personal',
      agentId: 'agent_a',
      content: 'hello world',
      tags: ['note'],
    });

    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.kind).toBe(MEMORY_KIND);
    expect(record.createdAt).toBe('2026-05-27T10:00:00.000Z');
    expect(record.updatedAt).toBe('2026-05-27T10:00:00.000Z');
    expect(embeddings.embed).toHaveBeenCalledWith('hello world');
    expect(fake.upsert).toHaveBeenCalledTimes(1);
    const [, body] = (fake.upsert.mock.calls[0] ?? []) as [
      string,
      { wait: boolean; points: { id: string; vector: number[]; payload: Record<string, unknown> }[] },
    ];
    expect(body.points[0].vector).toBe(vector);
    expect(body.points[0].payload['namespace']).toBe('personal');
    expect(body.points[0].payload['kind']).toBe(MEMORY_KIND);
    expect(body.points[0].payload['agent_id']).toBe('agent_a');
  });

  it('honours a caller-supplied id (idempotent upsert)', async () => {
    const { client, fake } = makeQdrant();
    const service = makeService({ qdrant: client });
    const id = '11111111-1111-1111-1111-111111111111';

    const record = await service.store({
      namespace: 'personal',
      agentId: 'agent_a',
      content: 'idempotent',
      id,
    });

    expect(record.id).toBe(id);
    const [, body] = (fake.upsert.mock.calls[0] ?? []) as [
      string,
      { points: { id: string }[] },
    ];
    expect(body.points[0].id).toBe(id);
  });

  it('rejects empty content', async () => {
    const service = makeService();
    await expect(
      service.store({ namespace: 'personal', agentId: 'a', content: '' }),
    ).rejects.toBeInstanceOf(MemoryValidationError);
  });

  it('rejects content exceeding the maximum length', async () => {
    const service = makeService();
    await expect(
      service.store({
        namespace: 'personal',
        agentId: 'a',
        content: 'x'.repeat(MEMORY_MAX_CONTENT_LENGTH + 1),
      }),
    ).rejects.toMatchObject({ field: 'content' });
  });

  it('rejects more tags than the maximum', async () => {
    const service = makeService();
    await expect(
      service.store({
        namespace: 'personal',
        agentId: 'a',
        content: 'ok',
        tags: Array.from({ length: MEMORY_MAX_TAGS + 1 }, (_, i) => `t${i}`),
      }),
    ).rejects.toMatchObject({ field: 'tags' });
  });
});

describe('MemoryService.search', () => {
  it('filters by namespace and kind=episodic', async () => {
    const { client, fake } = makeQdrant({
      search: vi.fn(async () => [
        {
          id: 'mem-1',
          score: 0.9,
          payload: {
            namespace: 'personal',
            agent_id: 'agent_a',
            kind: MEMORY_KIND,
            content: 'hi',
            tags: [],
            created_at: 'now',
            updated_at: 'now',
          },
        },
      ]),
    });
    const service = makeService({ qdrant: client });

    const results = await service.search({
      namespace: 'personal',
      query: 'hello',
      limit: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0].memory.id).toBe('mem-1');
    expect(results[0].score).toBe(0.9);
    const [, body] = (fake.search.mock.calls[0] ?? []) as [
      string,
      { filter: { must: Record<string, unknown>[] } },
    ];
    expect(body.filter.must).toEqual(
      expect.arrayContaining([
        { key: 'namespace', match: { value: 'personal' } },
        { key: 'kind', match: { value: MEMORY_KIND } },
      ]),
    );
  });

  it('adds one AND filter per tag', async () => {
    const { client, fake } = makeQdrant();
    const service = makeService({ qdrant: client });

    await service.search({
      namespace: 'personal',
      query: 'q',
      tags: ['a', 'b'],
    });

    const [, body] = (fake.search.mock.calls[0] ?? []) as [
      string,
      { filter: { must: Record<string, unknown>[] } },
    ];
    expect(body.filter.must).toEqual(
      expect.arrayContaining([
        { key: 'tags', match: { value: 'a' } },
        { key: 'tags', match: { value: 'b' } },
      ]),
    );
  });
});

describe('MemoryService.get', () => {
  it('returns a memory belonging to the requested namespace', async () => {
    const { client } = makeQdrant({
      retrieve: vi.fn(async () => [
        {
          id: 'mem-1',
          payload: {
            namespace: 'personal',
            agent_id: 'agent_a',
            kind: MEMORY_KIND,
            content: 'hi',
            tags: [],
            created_at: 'now',
            updated_at: 'now',
          },
        },
      ]),
    });
    const service = makeService({ qdrant: client });

    const memory = await service.get({ namespace: 'personal', id: 'mem-1' });
    expect(memory.id).toBe('mem-1');
    expect(memory.namespace).toBe('personal');
  });

  it('throws MemoryNotFoundError when the point does not exist', async () => {
    const service = makeService();
    await expect(
      service.get({ namespace: 'personal', id: 'missing' }),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
  });

  it('refuses cross-namespace reads (treats as not found)', async () => {
    const { client } = makeQdrant({
      retrieve: vi.fn(async () => [
        {
          id: 'mem-1',
          payload: {
            namespace: 'other',
            agent_id: 'agent_b',
            kind: MEMORY_KIND,
            content: 'hi',
            tags: [],
            created_at: 'now',
            updated_at: 'now',
          },
        },
      ]),
    });
    const service = makeService({ qdrant: client });
    await expect(
      service.get({ namespace: 'personal', id: 'mem-1' }),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
  });
});

describe('MemoryService.updateMetadata', () => {
  it('updates metadata, tags, summary and bumps updated_at without re-embedding', async () => {
    const initialPayload = {
      namespace: 'personal',
      agent_id: 'agent_a',
      kind: MEMORY_KIND,
      content: 'hi',
      summary: 'old',
      metadata: { a: 1 },
      tags: ['x'],
      source: '',
      created_at: '2026-05-27T09:00:00.000Z',
      updated_at: '2026-05-27T09:00:00.000Z',
    };
    const embeddings = makeEmbeddings();
    const { client, fake } = makeQdrant({
      retrieve: vi.fn(async () => [{ id: 'mem-1', payload: initialPayload }]),
    });
    const service = makeService({
      qdrant: client,
      embeddings,
      now: () => new Date('2026-05-27T11:00:00.000Z'),
    });

    const updated = await service.updateMetadata({
      namespace: 'personal',
      id: 'mem-1',
      summary: 'new',
      metadata: { b: 2 },
      tags: ['y', 'z'],
    });

    expect(updated.summary).toBe('new');
    expect(updated.metadata).toEqual({ b: 2 });
    expect(updated.tags).toEqual(['y', 'z']);
    expect(updated.updatedAt).toBe('2026-05-27T11:00:00.000Z');
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(fake.setPayload).toHaveBeenCalledTimes(1);
  });

  it('throws MemoryNotFoundError when the memory does not exist', async () => {
    const service = makeService();
    await expect(
      service.updateMetadata({
        namespace: 'personal',
        id: 'missing',
        summary: 's',
      }),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
  });

  it('refuses to update a memory in a different namespace', async () => {
    const { client } = makeQdrant({
      retrieve: vi.fn(async () => [
        {
          id: 'mem-1',
          payload: {
            namespace: 'other',
            agent_id: 'agent_b',
            kind: MEMORY_KIND,
            content: 'hi',
            tags: [],
            created_at: 'now',
            updated_at: 'now',
          },
        },
      ]),
    });
    const service = makeService({ qdrant: client });
    await expect(
      service.updateMetadata({
        namespace: 'personal',
        id: 'mem-1',
        summary: 's',
      }),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
  });
});

describe('MemoryService.delete', () => {
  it('deletes a memory in the namespace', async () => {
    const { client, fake } = makeQdrant({
      retrieve: vi.fn(async () => [
        {
          id: 'mem-1',
          payload: {
            namespace: 'personal',
            agent_id: 'agent_a',
            kind: MEMORY_KIND,
            content: 'hi',
            tags: [],
            created_at: 'now',
            updated_at: 'now',
          },
        },
      ]),
    });
    const service = makeService({ qdrant: client });

    await service.delete({ namespace: 'personal', id: 'mem-1' });
    expect(fake.delete).toHaveBeenCalledTimes(1);
    const [, body] = (fake.delete.mock.calls[0] ?? []) as [
      string,
      { points: string[] },
    ];
    expect(body.points).toEqual(['mem-1']);
  });

  it('throws MemoryNotFoundError when the memory does not exist', async () => {
    const service = makeService();
    await expect(
      service.delete({ namespace: 'personal', id: 'missing' }),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
  });

  it('refuses to delete a memory belonging to another namespace', async () => {
    const { client, fake } = makeQdrant({
      retrieve: vi.fn(async () => [
        {
          id: 'mem-1',
          payload: {
            namespace: 'other',
            agent_id: 'agent_b',
            kind: MEMORY_KIND,
            content: 'hi',
            tags: [],
            created_at: 'now',
            updated_at: 'now',
          },
        },
      ]),
    });
    const service = makeService({ qdrant: client });
    await expect(
      service.delete({ namespace: 'personal', id: 'mem-1' }),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
    expect(fake.delete).not.toHaveBeenCalled();
  });
});
