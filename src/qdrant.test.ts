import { describe, expect, it, vi } from 'vitest'
import { QdrantClient } from '@qdrant/js-client-rest'
import type { Schemas } from '@qdrant/js-client-rest'
import {
  initCollection,
  PAYLOAD_INDEXES,
  QdrantSchemaMismatchError,
} from './qdrant.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COLLECTION = 'agent_memories'

/** Build a minimal CollectionInfo response for a compatible collection. */
function compatibleCollectionInfo(): Schemas['CollectionInfo'] {
  return {
    status: 'green',
    optimizer_status: 'ok',
    segments_count: 1,
    config: {
      params: {
        vectors: {
          size: 4096,
          distance: 'Cosine',
        },
      },
      hnsw_config: {
        m: 16,
        ef_construct: 100,
        full_scan_threshold: 10000,
        max_indexing_threads: 0,
      },
      optimizer_config: {
        deleted_threshold: 0.2,
        vacuum_min_vector_number: 1000,
        default_segment_number: 0,
        indexing_threshold: 20000,
        flush_interval_sec: 5,
        max_optimization_threads: null,
      },
    },
    payload_schema: {},
  }
}

/** Build a fake QdrantClient whose methods can be overridden per-test. */
function makeFakeClient(overrides: {
  getCollections?: () => Promise<Schemas['CollectionsResponse']>
  getCollection?: (name: string) => Promise<Schemas['CollectionInfo']>
  createCollection?: (name: string, args: unknown) => Promise<boolean>
  createPayloadIndex?: (name: string, args: unknown) => Promise<Schemas['UpdateResult']>
}) {
  const defaults = {
    getCollections: vi.fn(async (): Promise<Schemas['CollectionsResponse']> => ({
      collections: [],
      time: 0,
    })),
    getCollection: vi.fn(async (_name: string): Promise<Schemas['CollectionInfo']> => {
      return compatibleCollectionInfo()
    }),
    createCollection: vi.fn(async (_name: string, _args: unknown): Promise<boolean> => true),
    createPayloadIndex: vi.fn(
      async (_name: string, _args: unknown): Promise<Schemas['UpdateResult']> => ({
        operation_id: 0,
        status: 'completed',
      }),
    ),
  }
  return {
    ...defaults,
    ...Object.fromEntries(
      Object.entries(overrides).map(([k, v]) => [k, vi.fn(v as (...a: unknown[]) => unknown)]),
    ),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PAYLOAD_INDEXES', () => {
  it('contains all required index field names', () => {
    const fieldNames = PAYLOAD_INDEXES.map((i) => i.field_name)
    expect(fieldNames).toContain('namespace')
    expect(fieldNames).toContain('agent_id')
    expect(fieldNames).toContain('tags')
    expect(fieldNames).toContain('created_at')
    expect(fieldNames).toContain('updated_at')
    expect(fieldNames).toContain('last_retrieved_at')
    expect(fieldNames).toContain('staleness_signal')
    expect(fieldNames).toContain('superseded_by')
    expect(fieldNames).toContain('deleted_at')
  })

  it('has 9 entries matching the ADR-0005 + ADR-0006 spec', () => {
    expect(PAYLOAD_INDEXES).toHaveLength(9)
  })

  it('uses keyword schema for namespace, agent_id, tags, staleness_signal, superseded_by', () => {
    const keywordFields = PAYLOAD_INDEXES.filter((i) => i.field_schema === 'keyword').map(
      (i) => i.field_name,
    )
    expect(keywordFields).toContain('namespace')
    expect(keywordFields).toContain('agent_id')
    expect(keywordFields).toContain('tags')
    expect(keywordFields).toContain('staleness_signal')
    expect(keywordFields).toContain('superseded_by')
  })

  it('uses datetime schema for created_at, updated_at, last_retrieved_at, deleted_at', () => {
    const datetimeFields = PAYLOAD_INDEXES.filter((i) => i.field_schema === 'datetime').map(
      (i) => i.field_name,
    )
    expect(datetimeFields).toContain('created_at')
    expect(datetimeFields).toContain('updated_at')
    expect(datetimeFields).toContain('last_retrieved_at')
    expect(datetimeFields).toContain('deleted_at')
  })
})

describe('initCollection — fresh Qdrant (collection does not exist)', () => {
  it('calls createCollection with size=4096 and distance=Cosine', async () => {
    const client = makeFakeClient({})
    // Default getCollections returns no collections → triggers create path
    await initCollection(client as unknown as QdrantClient, COLLECTION)

    expect(client.createCollection).toHaveBeenCalledOnce()
    const [name, args] = (client.createCollection as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { vectors: { size: number; distance: string } },
    ]
    expect(name).toBe(COLLECTION)
    expect(args.vectors.size).toBe(4096)
    expect(args.vectors.distance).toBe('Cosine')
  })

  it('creates all payload indexes after collection creation', async () => {
    const client = makeFakeClient({})
    await initCollection(client as unknown as QdrantClient, COLLECTION)

    expect(client.createPayloadIndex).toHaveBeenCalledTimes(PAYLOAD_INDEXES.length)
    const calledFieldNames = (
      client.createPayloadIndex as ReturnType<typeof vi.fn>
    ).mock.calls.map(
      (call: [string, { field_name: string }]) => call[1].field_name,
    )
    for (const { field_name } of PAYLOAD_INDEXES) {
      expect(calledFieldNames).toContain(field_name)
    }
  })

  it('does not call getCollection on a fresh instance', async () => {
    const client = makeFakeClient({})
    await initCollection(client as unknown as QdrantClient, COLLECTION)
    expect(client.getCollection).not.toHaveBeenCalled()
  })
})

describe('initCollection — existing compatible collection', () => {
  it('does not call createCollection when collection already exists', async () => {
    const client = makeFakeClient({
      getCollections: async () => ({
        collections: [{ name: COLLECTION }],
        time: 0,
      }),
      getCollection: async () => compatibleCollectionInfo(),
    })
    await initCollection(client as unknown as QdrantClient, COLLECTION)
    expect(client.createCollection).not.toHaveBeenCalled()
  })

  it('still creates payload indexes idempotently on an existing compatible collection', async () => {
    const client = makeFakeClient({
      getCollections: async () => ({
        collections: [{ name: COLLECTION }],
        time: 0,
      }),
      getCollection: async () => compatibleCollectionInfo(),
    })
    await initCollection(client as unknown as QdrantClient, COLLECTION)
    expect(client.createPayloadIndex).toHaveBeenCalledTimes(PAYLOAD_INDEXES.length)
  })
})

describe('initCollection — incompatible existing schema', () => {
  it('throws QdrantSchemaMismatchError on size mismatch', async () => {
    const badInfo = compatibleCollectionInfo()
    ;(badInfo.config.params.vectors as { size: number }).size = 1536 // wrong size

    const client = makeFakeClient({
      getCollections: async () => ({
        collections: [{ name: COLLECTION }],
        time: 0,
      }),
      getCollection: async () => badInfo,
    })

    await expect(
      initCollection(client as unknown as QdrantClient, COLLECTION),
    ).rejects.toThrow(QdrantSchemaMismatchError)
  })

  it('QdrantSchemaMismatchError message names the offending field for size mismatch', async () => {
    const badInfo = compatibleCollectionInfo()
    ;(badInfo.config.params.vectors as { size: number }).size = 1536

    const client = makeFakeClient({
      getCollections: async () => ({
        collections: [{ name: COLLECTION }],
        time: 0,
      }),
      getCollection: async () => badInfo,
    })

    await expect(
      initCollection(client as unknown as QdrantClient, COLLECTION),
    ).rejects.toThrowError(/size.*1536|1536.*size/i)
  })

  it('throws QdrantSchemaMismatchError on distance mismatch', async () => {
    const badInfo = compatibleCollectionInfo()
    ;(badInfo.config.params.vectors as { distance: string }).distance = 'Euclid'

    const client = makeFakeClient({
      getCollections: async () => ({
        collections: [{ name: COLLECTION }],
        time: 0,
      }),
      getCollection: async () => badInfo,
    })

    await expect(
      initCollection(client as unknown as QdrantClient, COLLECTION),
    ).rejects.toThrow(QdrantSchemaMismatchError)
  })

  it('QdrantSchemaMismatchError message names the offending field for distance mismatch', async () => {
    const badInfo = compatibleCollectionInfo()
    ;(badInfo.config.params.vectors as { distance: string }).distance = 'Euclid'

    const client = makeFakeClient({
      getCollections: async () => ({
        collections: [{ name: COLLECTION }],
        time: 0,
      }),
      getCollection: async () => badInfo,
    })

    await expect(
      initCollection(client as unknown as QdrantClient, COLLECTION),
    ).rejects.toThrowError(/distance.*Euclid|Euclid.*distance/i)
  })

  it('does not call createPayloadIndex when schema validation fails', async () => {
    const badInfo = compatibleCollectionInfo()
    ;(badInfo.config.params.vectors as { size: number }).size = 768

    const client = makeFakeClient({
      getCollections: async () => ({
        collections: [{ name: COLLECTION }],
        time: 0,
      }),
      getCollection: async () => badInfo,
    })

    await expect(
      initCollection(client as unknown as QdrantClient, COLLECTION),
    ).rejects.toThrow(QdrantSchemaMismatchError)

    expect(client.createPayloadIndex).not.toHaveBeenCalled()
  })
})

describe('initCollection — idempotent index creation', () => {
  it('does NOT propagate an "already exists" error from createPayloadIndex', async () => {
    const alreadyExistsError = new Error(
      'Bad request: field index already exists for field "namespace"',
    )

    const client = makeFakeClient({
      getCollections: async () => ({
        collections: [{ name: COLLECTION }],
        time: 0,
      }),
      getCollection: async () => compatibleCollectionInfo(),
      // All index creation calls fail with "already exists"
      createPayloadIndex: async () => {
        throw alreadyExistsError
      },
    })

    // Should resolve without throwing
    await expect(
      initCollection(client as unknown as QdrantClient, COLLECTION),
    ).resolves.toBeUndefined()
  })

  it('propagates unexpected errors from createPayloadIndex', async () => {
    const unexpectedError = new Error('Qdrant connection refused')

    const client = makeFakeClient({
      getCollections: async () => ({
        collections: [{ name: COLLECTION }],
        time: 0,
      }),
      getCollection: async () => compatibleCollectionInfo(),
      createPayloadIndex: async () => {
        throw unexpectedError
      },
    })

    await expect(
      initCollection(client as unknown as QdrantClient, COLLECTION),
    ).rejects.toThrow('Qdrant connection refused')
  })

  it('handles mixed results: some indexes succeed, some already exist', async () => {
    let callCount = 0
    const client = makeFakeClient({
      getCollections: async () => ({
        collections: [{ name: COLLECTION }],
        time: 0,
      }),
      getCollection: async () => compatibleCollectionInfo(),
      createPayloadIndex: async () => {
        callCount++
        // Fail every other call with "already exists"
        if (callCount % 2 === 0) {
          throw new Error('already exists')
        }
        return { operation_id: callCount, status: 'completed' as const }
      },
    })

    await expect(
      initCollection(client as unknown as QdrantClient, COLLECTION),
    ).resolves.toBeUndefined()
  })
})

describe('QdrantSchemaMismatchError', () => {
  it('has name QdrantSchemaMismatchError', () => {
    const err = new QdrantSchemaMismatchError('col', 'size', 4096, 1536)
    expect(err.name).toBe('QdrantSchemaMismatchError')
  })

  it('is an instance of Error', () => {
    const err = new QdrantSchemaMismatchError('col', 'size', 4096, 1536)
    expect(err).toBeInstanceOf(Error)
  })

  it('message includes collection name, field, expected, and actual', () => {
    const err = new QdrantSchemaMismatchError('agent_memories', 'size', 4096, 1536)
    expect(err.message).toContain('agent_memories')
    expect(err.message).toContain('size')
    expect(err.message).toContain('4096')
    expect(err.message).toContain('1536')
  })
})
