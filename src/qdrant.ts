import { QdrantClient } from '@qdrant/js-client-rest'
import type { Schemas } from '@qdrant/js-client-rest'
import type { Config, QdrantQuantizationConfig } from './config.js'

const DISTANCE = 'Cosine' as const

/** Options controlling collection creation (ADR-0010 §3.3/§3.4). */
export interface InitCollectionOptions {
  /** Vector dimension — provider-driven, immutable once the collection exists. */
  dimension: number
  /** Quantization config; omit or `mode: 'none'` to store full-precision vectors. */
  quantization?: QdrantQuantizationConfig
}

/**
 * Build the Qdrant `search` `params` for quantized collections (ADR-0010 §3.4):
 * oversample by quantized distance, then rescore the top candidates against the
 * on-disk originals. Returns `undefined` when quantization is off (no rescore).
 */
export function quantizationSearchParams(
  quantization: QdrantQuantizationConfig | undefined,
): Schemas['SearchParams'] | undefined {
  if (!quantization || quantization.mode === 'none') return undefined
  return {
    quantization: {
      rescore: quantization.rescore,
      oversampling: quantization.oversampling,
    },
  }
}

/**
 * Payload index descriptor — single source of truth for all indexes created on
 * the memory collection.  Re-exported so lifecycle tooling can reference it.
 */
export interface PayloadIndexSpec {
  field_name: string
  field_schema: Schemas['PayloadFieldSchema']
}

export const PAYLOAD_INDEXES: readonly PayloadIndexSpec[] = [
  { field_name: 'namespace', field_schema: 'keyword' },
  { field_name: 'agent_id', field_schema: 'keyword' },
  { field_name: 'tags', field_schema: 'keyword' },
  { field_name: 'created_at', field_schema: 'datetime' },
  { field_name: 'updated_at', field_schema: 'datetime' },
  // ADR-0006 lifecycle additions
  { field_name: 'last_retrieved_at', field_schema: 'datetime' },
  { field_name: 'staleness_signal', field_schema: 'keyword' },
  { field_name: 'superseded_by', field_schema: 'keyword' },
  { field_name: 'deleted_at', field_schema: 'datetime' },
] as const

/**
 * Thrown when the Qdrant collection already exists but its vector
 * configuration does not match the expected schema (size 4096, Cosine).
 * The service must not auto-migrate; the operator must resolve the conflict.
 */
export class QdrantSchemaMismatchError extends Error {
  constructor(
    collectionName: string,
    field: string,
    expected: string | number,
    actual: string | number,
  ) {
    super(
      `Collection "${collectionName}" has incompatible vector config: ` +
        `${field} is ${String(actual)}, expected ${String(expected)}. ` +
        `Drop or rename the existing collection before restarting the service.`,
    )
    this.name = 'QdrantSchemaMismatchError'
  }
}

export function createQdrantClient(config: Config): QdrantClient {
  return new QdrantClient({
    url: config.qdrant.url,
    apiKey: config.qdrant.apiKey,
  })
}

/**
 * Resolve the scalar VectorParams from a VectorsConfig value.
 *
 * Qdrant supports two formats:
 *   - unnamed vectors: VectorParams directly (has `size` + `distance`)
 *   - named vectors:   Record<string, VectorParams> (keyed by name)
 *
 * We only create unnamed collections, so receiving a named-vector collection
 * where the default key is present is handled; any other shape is treated as
 * incompatible.
 */
function resolveVectorParams(
  vectors: Schemas['VectorsConfig'] | undefined,
): Schemas['VectorParams'] | null {
  if (!vectors) return null
  if ('size' in vectors && 'distance' in vectors) {
    // Unnamed VectorParams
    return vectors as Schemas['VectorParams']
  }
  // Named vectors map — check the unnamed/default key
  const named = vectors as Record<string, Schemas['VectorParams'] | undefined>
  return named[''] ?? null
}

/**
 * Return true if the error looks like Qdrant's "field index already exists"
 * response, so we can treat idempotent index creation as success.
 *
 * Qdrant's REST API returns HTTP 400 with a body containing the substring
 * "already exists" when an index is re-created.  The JS client wraps this in
 * a QdrantClientUnexpectedResponseError whose message contains the body text.
 */
function isAlreadyExistsError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return (
    msg.includes('already exists') ||
    // Qdrant sometimes returns "Bad request: field index already exists"
    msg.includes('field index')
  )
}

/**
 * Ensure the memory collection exists with the correct vector configuration
 * and all required payload indexes.
 *
 * Behaviour:
 * - Fresh Qdrant: creates the collection then creates all payload indexes.
 * - Existing compatible collection: validates schema, then idempotently
 *   re-applies all payload indexes (treats "already exists" as success).
 * - Existing incompatible collection: throws QdrantSchemaMismatchError.
 *
 * This function is idempotent and safe to call on every service startup.
 */
export async function initCollection(
  client: QdrantClient,
  collectionName: string,
  opts: InitCollectionOptions,
): Promise<void> {
  const dimension = opts.dimension
  const quantize = opts.quantization?.mode === 'int8'

  const collections = await client.getCollections()
  const exists = collections.collections.some((c) => c.name === collectionName)

  if (exists) {
    const info = await client.getCollection(collectionName)
    const vectorParams = resolveVectorParams(info.config.params.vectors)

    if (vectorParams === null) {
      throw new QdrantSchemaMismatchError(
        collectionName,
        'vectors',
        `size=${dimension}, distance=${DISTANCE}`,
        'no unnamed vector config found',
      )
    }

    if (vectorParams.size !== dimension) {
      throw new QdrantSchemaMismatchError(
        collectionName,
        'size',
        dimension,
        vectorParams.size,
      )
    }

    if (vectorParams.distance !== DISTANCE) {
      throw new QdrantSchemaMismatchError(
        collectionName,
        'distance',
        DISTANCE,
        vectorParams.distance,
      )
    }
  } else {
    // ADR-0010 §3.4: quantized vectors resident, originals + payload on disk.
    await client.createCollection(collectionName, {
      vectors: {
        size: dimension,
        distance: DISTANCE,
        ...(quantize ? { on_disk: true } : {}),
      },
      on_disk_payload: true,
      ...(quantize
        ? {
            quantization_config: {
              scalar: { type: 'int8', always_ram: true },
            },
          }
        : {}),
    })
  }

  // Create payload indexes — idempotent: ignore "already exists" responses.
  await Promise.all(
    PAYLOAD_INDEXES.map(({ field_name, field_schema }) =>
      client
        .createPayloadIndex(collectionName, { field_name, field_schema })
        .catch((err: unknown) => {
          if (isAlreadyExistsError(err)) return
          throw err
        }),
    ),
  )
}
