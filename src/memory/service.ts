import { randomUUID } from 'node:crypto';
import type { QdrantClient } from '@qdrant/js-client-rest';
import type { EmbeddingClient } from '../embeddings.js';
import {
  MEMORY_KIND,
  MEMORY_MAX_CONTENT_LENGTH,
  MEMORY_MAX_TAGS,
  type DeleteMemoryInput,
  type GetMemoryInput,
  type MemoryRecord,
  type SearchMemoryInput,
  type SearchResult,
  type StoreMemoryInput,
  type UpdateMemoryMetadataInput,
} from './types.js';

export class MemoryValidationError extends Error {
  constructor(
    message: string,
    public readonly field: string,
  ) {
    super(message);
    this.name = 'MemoryValidationError';
  }
}

export class MemoryNotFoundError extends Error {
  constructor(
    public readonly namespaceId: string,
    public readonly memoryId: string,
  ) {
    super(`Memory not found in namespace "${namespaceId}": ${memoryId}`);
    this.name = 'MemoryNotFoundError';
  }
}

export interface MemoryServiceDeps {
  qdrant: QdrantClient;
  embeddings: EmbeddingClient;
  collection: string;
  now?: () => Date;
}

export class MemoryService {
  private readonly qdrant: QdrantClient;
  private readonly embeddings: EmbeddingClient;
  private readonly collection: string;
  private readonly now: () => Date;

  constructor(deps: MemoryServiceDeps) {
    this.qdrant = deps.qdrant;
    this.embeddings = deps.embeddings;
    this.collection = deps.collection;
    this.now = deps.now ?? (() => new Date());
  }

  async store(input: StoreMemoryInput): Promise<MemoryRecord> {
    this.validateContent(input.content);
    this.validateTags(input.tags);

    const id = input.id ?? randomUUID();
    const nowIso = this.now().toISOString();
    const vector = await this.embeddings.embed(input.content);

    const record: MemoryRecord = {
      id,
      namespace: input.namespace,
      agentId: input.agentId,
      kind: MEMORY_KIND,
      content: input.content,
      summary: input.summary,
      metadata: input.metadata,
      tags: input.tags ?? [],
      source: input.source,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    await this.qdrant.upsert(this.collection, {
      wait: true,
      points: [
        {
          id,
          vector,
          payload: memoryToPayload(record),
        },
      ],
    });

    return record;
  }

  async search(input: SearchMemoryInput): Promise<SearchResult[]> {
    const vector = await this.embeddings.embed(input.query);

    const must: Array<Record<string, unknown>> = [
      { key: 'namespace', match: { value: input.namespace } },
      { key: 'kind', match: { value: MEMORY_KIND } },
    ];

    if (input.tags && input.tags.length > 0) {
      for (const tag of input.tags) {
        must.push({ key: 'tags', match: { value: tag } });
      }
    }

    const results = await this.qdrant.search(this.collection, {
      vector,
      limit: input.limit ?? 10,
      filter: { must },
      with_payload: true,
    });

    return results.map((r) => ({
      memory: payloadToMemory(r.id as string, r.payload as Record<string, unknown>),
      score: r.score,
    }));
  }

  async get(input: GetMemoryInput): Promise<MemoryRecord> {
    const memory = await this.fetchOwned(input.namespace, input.id);
    return memory;
  }

  async updateMetadata(input: UpdateMemoryMetadataInput): Promise<MemoryRecord> {
    this.validateTags(input.tags);
    const existing = await this.fetchOwned(input.namespace, input.id);

    const updated: MemoryRecord = {
      ...existing,
      summary: input.summary !== undefined ? input.summary : existing.summary,
      metadata: input.metadata !== undefined ? input.metadata : existing.metadata,
      tags: input.tags !== undefined ? input.tags : existing.tags,
      source: input.source !== undefined ? input.source : existing.source,
      updatedAt: this.now().toISOString(),
    };

    await this.qdrant.setPayload(this.collection, {
      wait: true,
      payload: memoryToPayload(updated),
      points: [updated.id],
    });

    return updated;
  }

  async delete(input: DeleteMemoryInput): Promise<void> {
    await this.fetchOwned(input.namespace, input.id);
    await this.qdrant.delete(this.collection, {
      wait: true,
      points: [input.id],
    });
  }

  private async fetchOwned(namespaceId: string, id: string): Promise<MemoryRecord> {
    const points = await this.qdrant.retrieve(this.collection, {
      ids: [id],
      with_payload: true,
    });
    if (points.length === 0) {
      throw new MemoryNotFoundError(namespaceId, id);
    }
    const payload = points[0].payload as Record<string, unknown>;
    if (payload['namespace'] !== namespaceId) {
      throw new MemoryNotFoundError(namespaceId, id);
    }
    return payloadToMemory(points[0].id as string, payload);
  }

  private validateContent(content: string): void {
    if (content.length === 0) {
      throw new MemoryValidationError('Memory content must not be empty', 'content');
    }
    if (content.length > MEMORY_MAX_CONTENT_LENGTH) {
      throw new MemoryValidationError(
        `Memory content exceeds maximum length of ${MEMORY_MAX_CONTENT_LENGTH}`,
        'content',
      );
    }
  }

  private validateTags(tags: string[] | undefined): void {
    if (!tags) return;
    if (tags.length > MEMORY_MAX_TAGS) {
      throw new MemoryValidationError(
        `Tag count exceeds maximum of ${MEMORY_MAX_TAGS}`,
        'tags',
      );
    }
  }
}

export function memoryToPayload(memory: MemoryRecord): Record<string, unknown> {
  return {
    namespace: memory.namespace,
    agent_id: memory.agentId,
    kind: memory.kind,
    content: memory.content,
    summary: memory.summary ?? '',
    metadata: memory.metadata ?? {},
    tags: memory.tags,
    source: memory.source ?? '',
    created_at: memory.createdAt,
    updated_at: memory.updatedAt,
    ...(memory.expiresAt ? { expires_at: memory.expiresAt } : {}),
  };
}

export function payloadToMemory(
  id: string,
  payload: Record<string, unknown>,
): MemoryRecord {
  return {
    id,
    namespace: payload['namespace'] as string,
    agentId: payload['agent_id'] as string,
    kind: (payload['kind'] as MemoryRecord['kind']) ?? MEMORY_KIND,
    content: payload['content'] as string,
    summary: (payload['summary'] as string) || undefined,
    metadata: payload['metadata'] as Record<string, unknown> | undefined,
    tags: (payload['tags'] as string[]) ?? [],
    source: (payload['source'] as string) || undefined,
    createdAt: payload['created_at'] as string,
    updatedAt: payload['updated_at'] as string,
    expiresAt: (payload['expires_at'] as string) || undefined,
  };
}
