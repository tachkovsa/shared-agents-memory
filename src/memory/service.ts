import { randomUUID } from 'node:crypto';
import type { QdrantClient } from '@qdrant/js-client-rest';
import type { EmbeddingClient } from '../embeddings.js';
import {
  DECAY_DEFAULT_SCORE,
  DEDUP_DEFAULT_THRESHOLD,
  DEDUP_DISABLED_THRESHOLD,
  DEDUP_HISTORY_CAP,
  DEDUP_REINFORCE_THRESHOLD,
  MEMORY_KIND,
  MEMORY_MAX_CONTENT_LENGTH,
  MEMORY_MAX_TAGS,
  type DeleteMemoryInput,
  type GetMemoryInput,
  type MemoryRecord,
  type SearchMemoryInput,
  type SearchResult,
  type StalenessSignal,
  type StoreMemoryInput,
  type StoreResult,
  type UpdateMemoryMetadataInput,
  type VerifiesAgainst,
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
  /**
   * Resolves the per-namespace dedup threshold (ADR-0006 §3.2). When absent, the
   * default (0.95) is used. Returning 1.0 disables dedup for that namespace.
   */
  loadDedupThreshold?: (namespaceId: string) => Promise<number>;
  /**
   * Qdrant search `params` for quantized collections (ADR-0010 §3.4 rescore +
   * oversampling). Applied to every vector search; omitted when quantization is off.
   */
  searchParams?: Record<string, unknown>;
}

export class MemoryService {
  private readonly qdrant: QdrantClient;
  private readonly embeddings: EmbeddingClient;
  private readonly collection: string;
  private readonly now: () => Date;
  private readonly loadDedupThreshold?: (namespaceId: string) => Promise<number>;
  private readonly searchParams?: Record<string, unknown>;

  constructor(deps: MemoryServiceDeps) {
    this.qdrant = deps.qdrant;
    this.embeddings = deps.embeddings;
    this.collection = deps.collection;
    this.now = deps.now ?? (() => new Date());
    this.loadDedupThreshold = deps.loadDedupThreshold;
    this.searchParams = deps.searchParams;
  }

  /**
   * Store an episodic memory with semantic dedup (ADR-0006 §3.2).
   *
   * - A caller-supplied `id` is an explicit idempotent upsert — dedup is skipped.
   * - Otherwise the new content is embedded and matched against the top-1 in the
   *   same namespace. Above the reinforce threshold (0.99) it reinforces the
   *   existing point; between the dedup threshold and 0.99 it merges; below, it
   *   inserts a new point.
   */
  async store(input: StoreMemoryInput): Promise<StoreResult> {
    this.validateContent(input.content);
    this.validateTags(input.tags);

    const nowIso = this.now().toISOString();
    const vector = await this.embeddings.embed(input.content);

    // Caller-supplied id → idempotent upsert; dedup branch skipped (ADR-0006 §3.2).
    if (input.id) {
      const record = this.insertRecord(input, input.id, nowIso);
      await this.upsertPoint(record, vector);
      return { record, outcome: 'inserted', matchedExistingId: null };
    }

    const threshold = await this.resolveDedupThreshold(input.namespace);

    if (threshold < DEDUP_DISABLED_THRESHOLD) {
      const top = await this.searchTopOne(input.namespace, vector);
      if (top && top.score > threshold) {
        if (top.score > DEDUP_REINFORCE_THRESHOLD) {
          const record = await this.reinforceExisting(top.record, nowIso);
          return { record, outcome: 'reinforced', matchedExistingId: top.record.id };
        }
        const record = await this.mergeIntoExisting(top.record, input, nowIso);
        return { record, outcome: 'merged', matchedExistingId: top.record.id };
      }
    }

    const record = this.insertRecord(input, randomUUID(), nowIso);
    await this.upsertPoint(record, vector);
    return { record, outcome: 'inserted', matchedExistingId: null };
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
      ...(this.searchParams ? { params: this.searchParams } : {}),
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

  // ── dedup helpers ──────────────────────────────────────────────────────────

  private async resolveDedupThreshold(namespace: string): Promise<number> {
    if (!this.loadDedupThreshold) return DEDUP_DEFAULT_THRESHOLD;
    try {
      return await this.loadDedupThreshold(namespace);
    } catch {
      return DEDUP_DEFAULT_THRESHOLD;
    }
  }

  private async searchTopOne(
    namespace: string,
    vector: number[],
  ): Promise<{ record: MemoryRecord; score: number } | null> {
    const results = await this.qdrant.search(this.collection, {
      vector,
      limit: 1,
      filter: {
        must: [
          { key: 'namespace', match: { value: namespace } },
          { key: 'kind', match: { value: MEMORY_KIND } },
        ],
      },
      with_payload: true,
      ...(this.searchParams ? { params: this.searchParams } : {}),
    });
    if (results.length === 0) return null;
    const r = results[0];
    return {
      record: payloadToMemory(r.id as string, r.payload as Record<string, unknown>),
      score: r.score,
    };
  }

  /** Reinforce an existing point: bump retrieval_count + last_retrieved_at (ADR-0006 §3.2). */
  private async reinforceExisting(
    existing: MemoryRecord,
    nowIso: string,
  ): Promise<MemoryRecord> {
    const updated: MemoryRecord = {
      ...existing,
      retrievalCount: existing.retrievalCount + 1,
      lastRetrievedAt: nowIso,
    };
    await this.qdrant.setPayload(this.collection, {
      wait: true,
      payload: memoryToPayload(updated),
      points: [updated.id],
    });
    return updated;
  }

  /**
   * Merge a near-duplicate into an existing point: bump counter, union tags,
   * append the new content to `metadata.dedup_history` (cap 5), bump updated_at.
   * The body is NOT changed — Q2 owner sign-off keeps merges out of the body to
   * avoid embedding drift (ADR-0006 §5.1).
   */
  private async mergeIntoExisting(
    existing: MemoryRecord,
    input: StoreMemoryInput,
    nowIso: string,
  ): Promise<MemoryRecord> {
    const tags = Array.from(new Set([...existing.tags, ...(input.tags ?? [])]));

    const priorHistory = existing.metadata?.['dedup_history'];
    const history = Array.isArray(priorHistory) ? [...priorHistory] : [];
    history.push(input.content);
    const dedupHistory = history.slice(-DEDUP_HISTORY_CAP);

    const updated: MemoryRecord = {
      ...existing,
      tags,
      metadata: { ...(existing.metadata ?? {}), dedup_history: dedupHistory },
      retrievalCount: existing.retrievalCount + 1,
      updatedAt: nowIso,
    };
    await this.qdrant.setPayload(this.collection, {
      wait: true,
      payload: memoryToPayload(updated),
      points: [updated.id],
    });
    return updated;
  }

  private insertRecord(input: StoreMemoryInput, id: string, nowIso: string): MemoryRecord {
    return {
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
      retrievalCount: 0,
      lastRetrievedAt: null,
      // ADR-0006 §3.1 lifecycle defaults (locked by #27 foundation).
      decayScore: DECAY_DEFAULT_SCORE,
      supersededBy: null,
      deletedAt: null,
      stalenessSignal: 'unverified',
      verifiesAgainst: input.verifiesAgainst ?? null,
    };
  }

  private async upsertPoint(record: MemoryRecord, vector: number[]): Promise<void> {
    await this.qdrant.upsert(this.collection, {
      wait: true,
      points: [{ id: record.id, vector, payload: memoryToPayload(record) }],
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
    retrieval_count: memory.retrievalCount ?? 0,
    last_retrieved_at: memory.lastRetrievedAt ?? null,
    // ADR-0006 §3.1 lifecycle fields.
    decay_score: memory.decayScore ?? DECAY_DEFAULT_SCORE,
    superseded_by: memory.supersededBy ?? null,
    deleted_at: memory.deletedAt ?? null,
    staleness_signal: memory.stalenessSignal ?? 'unverified',
    verifies_against: verifiesAgainstToPayload(memory.verifiesAgainst),
    ...(memory.expiresAt ? { expires_at: memory.expiresAt } : {}),
  };
}

function verifiesAgainstToPayload(
  v: VerifiesAgainst | null | undefined,
): Record<string, unknown> | null {
  if (!v) return null;
  return {
    kind: v.kind,
    ref: v.ref,
    captured_at: v.capturedAt,
    ...(v.lastKnownValue !== undefined ? { last_known_value: v.lastKnownValue } : {}),
  };
}

function payloadToVerifiesAgainst(raw: unknown): VerifiesAgainst | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = r['kind'];
  if (kind !== 'file' && kind !== 'url' && kind !== 'git_commit') return null;
  return {
    kind,
    ref: String(r['ref'] ?? ''),
    capturedAt: String(r['captured_at'] ?? ''),
    ...(typeof r['last_known_value'] === 'string'
      ? { lastKnownValue: r['last_known_value'] }
      : {}),
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
    retrievalCount: (payload['retrieval_count'] as number) ?? 0,
    lastRetrievedAt: (payload['last_retrieved_at'] as string | null) ?? null,
    // ADR-0006 §3.1 lifecycle fields — default for pre-#27 points.
    decayScore: (payload['decay_score'] as number) ?? DECAY_DEFAULT_SCORE,
    supersededBy: (payload['superseded_by'] as string | null) ?? null,
    deletedAt: (payload['deleted_at'] as string | null) ?? null,
    stalenessSignal: ((payload['staleness_signal'] as StalenessSignal) ?? 'unverified'),
    verifiesAgainst: payloadToVerifiesAgainst(payload['verifies_against']),
  };
}
