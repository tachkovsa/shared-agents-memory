import { QdrantClient } from '@qdrant/js-client-rest';
import type { Config } from './config.js';

const VECTOR_SIZE = 4096;
const DISTANCE = 'Cosine' as const;

export function createQdrantClient(config: Config): QdrantClient {
  return new QdrantClient({
    url: config.qdrant.url,
    apiKey: config.qdrant.apiKey,
  });
}

/**
 * Ensure the memory collection exists with the correct vector configuration.
 * Idempotent: skips creation if collection already exists with compatible schema.
 * Throws on incompatible existing schema.
 */
export async function initCollection(
  client: QdrantClient,
  collectionName: string,
): Promise<void> {
  const collections = await client.getCollections();
  const exists = collections.collections.some(
    (c) => c.name === collectionName,
  );

  if (exists) {
    const info = await client.getCollection(collectionName);
    const vectorParams = info.config.params.vectors;

    // Handle both named and unnamed vector configs
    if (
      typeof vectorParams === 'object' &&
      'size' in vectorParams &&
      'distance' in vectorParams
    ) {
      if (vectorParams.size !== VECTOR_SIZE || vectorParams.distance !== DISTANCE) {
        throw new Error(
          `Collection "${collectionName}" exists with incompatible config: ` +
            `size=${vectorParams.size}, distance=${vectorParams.distance}. ` +
            `Expected size=${VECTOR_SIZE}, distance=${DISTANCE}.`,
        );
      }
    }

    return;
  }

  await client.createCollection(collectionName, {
    vectors: {
      size: VECTOR_SIZE,
      distance: DISTANCE,
    },
  });

  // Create payload indexes for fields used in filters
  await Promise.all([
    client.createPayloadIndex(collectionName, {
      field_name: 'namespace',
      field_schema: 'keyword',
    }),
    client.createPayloadIndex(collectionName, {
      field_name: 'agent_id',
      field_schema: 'keyword',
    }),
    client.createPayloadIndex(collectionName, {
      field_name: 'tags',
      field_schema: 'keyword',
    }),
    client.createPayloadIndex(collectionName, {
      field_name: 'created_at',
      field_schema: 'datetime',
    }),
    client.createPayloadIndex(collectionName, {
      field_name: 'updated_at',
      field_schema: 'datetime',
    }),
  ]);
}
