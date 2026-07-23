import { randomUUID } from 'node:crypto';
import type { QdrantClient } from '@qdrant/js-client-rest';
import type { EmbeddingProvider } from '../embeddings.js';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DECAY_DEFAULT_SCORE,
  DEFAULT_DECAY_WEIGHT,
  DEDUP_DEFAULT_THRESHOLD,
  DEDUP_DISABLED_THRESHOLD,
  DEDUP_HISTORY_CAP,
  DEDUP_REINFORCE_THRESHOLD,
  MEMORY_KIND,
  MEMORY_LIST_DEFAULT_LIMIT,
  MEMORY_LIST_MAX_LIMIT,
  MEMORY_MAX_CONTENT_LENGTH,
  MEMORY_MAX_METADATA_BYTES,
  MEMORY_MAX_SOURCE_LENGTH,
  MEMORY_MAX_SUMMARY_LENGTH,
  MEMORY_MAX_TAG_LENGTH,
  MEMORY_MAX_TAGS,
  type DeleteMemoryInput,
  type GetMemoryInput,
  type ListMemoryInput,
  type ListMemoryResult,
  type MemoryRecord,
  type RestoreMemoryInput,
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
  embeddings: EmbeddingProvider;
  collection: string;
  now?: () => Date;
  /**
   * Resolves the per-namespace dedup threshold (ADR-0006 §3.2). When absent, the
   * default (0.95) is used. Returning 1.0 disables dedup for that namespace.
   */
  loadDedupThreshold?: (namespaceId: string) => Promise<number>;
  /**
   * Resolves the per-namespace search-time decay weight (ADR-0006 §3.4). When
   * absent or throwing, DEFAULT_DECAY_WEIGHT (0.5) is used.
   */
  loadDecayWeight?: (namespaceId: string) => Promise<number>;
  /**
   * Qdrant search `params` for quantized collections (ADR-0010 §3.4 rescore +
   * oversampling). Applied to every vector search; omitted when quantization is off.
   */
  searchParams?: Record<string, unknown>;
  /**
   * Data root for the lifecycle audit log (`data/namespaces/<ns>/audit/lifecycle.jsonl`).
   * Required for `restore` audit lines; when absent the audit write is skipped.
   */
  dataDir?: string;
}

export class MemoryService {
  private readonly qdrant: QdrantClient;
  private readonly embeddings: EmbeddingProvider;
  private readonly collection: string;
  private readonly now: () => Date;
  private readonly loadDedupThreshold?: (namespaceId: string) => Promise<number>;
  private readonly loadDecayWeight?: (namespaceId: string) => Promise<number>;
  private readonly searchParams?: Record<string, unknown>;
  private readonly dataDir?: string;

  constructor(deps: MemoryServiceDeps) {
    this.qdrant = deps.qdrant;
    this.embeddings = deps.embeddings;
    this.collection = deps.collection;
    this.now = deps.now ?? (() => new Date());
    this.loadDedupThreshold = deps.loadDedupThreshold;
    this.loadDecayWeight = deps.loadDecayWeight;
    this.searchParams = deps.searchParams;
    this.dataDir = deps.dataDir;
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
    this.validateSummary(input.summary);
    this.validateSource(input.source);
    this.validateMetadata(input.metadata);

    const nowIso = this.now().toISOString();
    const vector = await this.embeddings.embed(input.content);

    // Caller-supplied id → idempotent upsert; dedup branch skipped (ADR-0006 §3.2).
    if (input.id) {
      const record = this.insertRecord(input, input.id, nowIso);
      await this.upsertPoint(record, vector);
      const supersededIds = await this.markSuperseded(input, record.id);
      return { record, outcome: 'inserted', matchedExistingId: null, supersededIds };
    }

    const threshold = await this.resolveDedupThreshold(input.namespace);

    if (threshold < DEDUP_DISABLED_THRESHOLD) {
      const top = await this.searchTopOne(input.namespace, vector);
      if (top && top.score > threshold) {
        if (top.score > DEDUP_REINFORCE_THRESHOLD) {
          const record = await this.reinforceExisting(top.record, nowIso);
          return {
            record,
            outcome: 'reinforced',
            matchedExistingId: top.record.id,
            supersededIds: [],
          };
        }
        const record = await this.mergeIntoExisting(top.record, input, nowIso);
        return {
          record,
          outcome: 'merged',
          matchedExistingId: top.record.id,
          supersededIds: [],
        };
      }
    }

    const record = this.insertRecord(input, randomUUID(), nowIso);
    await this.upsertPoint(record, vector);
    const supersededIds = await this.markSuperseded(input, record.id);
    return { record, outcome: 'inserted', matchedExistingId: null, supersededIds };
  }

  /**
   * ADR-0006 §3.5 — mark each `input.supersedes` point in the same namespace with
   * `superseded_by = newId`. Ids that don't exist or belong to another namespace
   * are silently skipped (a supersession claim never fails a store). Returns the
   * ids actually marked.
   */
  private async markSuperseded(
    input: StoreMemoryInput,
    newId: string,
  ): Promise<string[]> {
    const ids = input.supersedes;
    if (!ids || ids.length === 0) return [];
    const targets = ids.filter((id) => id !== newId);
    if (targets.length === 0) return [];

    const points = await this.qdrant.retrieve(this.collection, {
      ids: targets,
      with_payload: true,
    });
    const marked: string[] = [];
    for (const point of points) {
      const payload = (point.payload ?? {}) as Record<string, unknown>;
      if (payload['namespace'] !== input.namespace) continue;
      const id = point.id as string;
      try {
        await this.qdrant.setPayload(this.collection, {
          wait: true,
          payload: { superseded_by: newId },
          points: [id],
        });
        marked.push(id);
      } catch {
        // best-effort: a failed mark does not fail the store
      }
    }
    return marked;
  }

  /**
   * Semantic search with lifecycle filtering + decay re-rank (ADR-0006 §3.4/§3.5).
   *
   * Qdrant null-filtering is awkward, so we over-fetch (`limit * 3`, min 30),
   * decode, drop soft-deleted (always) and superseded (unless `includeSuperseded`)
   * points in code, then re-rank by blending cosine with the point's decay_score:
   * `ranked = cosine*(1-w) + cosine*decay*w`, sort desc, truncate to `limit`.
   */
  async search(input: SearchMemoryInput): Promise<SearchResult[]> {
    const vector = await this.embeddings.embed(input.query);
    const limit = input.limit ?? 10;

    const must: Array<Record<string, unknown>> = [
      { key: 'namespace', match: { value: input.namespace } },
      { key: 'kind', match: { value: MEMORY_KIND } },
    ];

    if (input.tags && input.tags.length > 0) {
      for (const tag of input.tags) {
        must.push({ key: 'tags', match: { value: tag } });
      }
    }

    const fetchLimit = Math.max(limit * 3, 30);
    const results = await this.qdrant.search(this.collection, {
      vector,
      limit: fetchLimit,
      filter: { must },
      with_payload: true,
      ...(this.searchParams ? { params: this.searchParams } : {}),
    });

    const weight = await this.resolveDecayWeight(input.namespace);

    const ranked = results
      .map((r) => ({
        memory: payloadToMemory(r.id as string, r.payload as Record<string, unknown>),
        cosine: r.score,
      }))
      .filter(({ memory }) => {
        if (memory.deletedAt != null) return false; // never return tombstones
        if (!input.includeSuperseded && memory.supersededBy != null) return false;
        return true;
      })
      .map(({ memory, cosine }) => ({
        memory,
        score: cosine * (1 - weight) + cosine * memory.decayScore * weight,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return ranked;
  }

  async get(input: GetMemoryInput): Promise<MemoryRecord> {
    return this.fetchOwned(input.namespace, input.id, input.includeDeleted ?? false);
  }

  /**
   * Cursor-paginated namespace listing for the operator console (#67). Uses
   * Qdrant `scroll` (no vector) filtered by namespace + kind; soft-deleted points
   * are excluded unless `includeDeleted`. The returned `nextCursor` is the opaque
   * Qdrant page offset — pass it back to fetch the next page (null when done).
   */
  async list(input: ListMemoryInput): Promise<ListMemoryResult> {
    const limit = Math.min(
      Math.max(1, Math.floor(input.limit ?? MEMORY_LIST_DEFAULT_LIMIT)),
      MEMORY_LIST_MAX_LIMIT,
    );
    const result = await this.qdrant.scroll(this.collection, {
      filter: {
        must: [
          { key: 'namespace', match: { value: input.namespace } },
          { key: 'kind', match: { value: MEMORY_KIND } },
        ],
      },
      limit,
      offset: input.cursor ?? undefined,
      with_payload: true,
      with_vector: false,
    });
    let memories = result.points.map((p) =>
      payloadToMemory(p.id as string, p.payload as Record<string, unknown>),
    );
    if (!input.includeDeleted) {
      memories = memories.filter((m) => m.deletedAt == null);
    }
    return { memories, nextCursor: result.next_page_offset ?? null };
  }

  /**
   * ADR-0006 §3.4 — restore a soft-deleted memory by clearing `deleted_at`.
   * Idempotent: a live point is returned unchanged. Throws MemoryNotFoundError
   * if the point is absent or belongs to another namespace.
   */
  async restore(input: RestoreMemoryInput): Promise<MemoryRecord> {
    const existing = await this.fetchOwned(input.namespace, input.id, true);
    if (existing.deletedAt == null) return existing; // idempotent

    await this.qdrant.setPayload(this.collection, {
      wait: true,
      payload: { deleted_at: null, deleted_by: null },
      points: [input.id],
    });
    await this.appendLifecycleAudit(input.namespace, {
      event: 'memory.restored',
      point_id: input.id,
    });
    return { ...existing, deletedAt: null, deletedBy: null };
  }

  private async appendLifecycleAudit(
    namespace: string,
    entry: Record<string, unknown>,
  ): Promise<void> {
    if (!this.dataDir) return;
    const path = join(this.dataDir, 'namespaces', namespace, 'audit', 'lifecycle.jsonl');
    const line = `${JSON.stringify({ ...entry, ts: this.now().toISOString() })}\n`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, line);
    } catch {
      // best-effort audit; a restore must not fail because the log is unwritable
    }
  }

  async updateMetadata(input: UpdateMemoryMetadataInput): Promise<MemoryRecord> {
    this.validateTags(input.tags);
    this.validateSummary(input.summary);
    this.validateSource(input.source);
    this.validateMetadata(input.metadata);
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

  /**
   * Delete a memory. Two callers share this method, keyed on `includeDeleted`
   * (issue #105 / SEC-4):
   *
   * - Operator console (`includeDeleted: true`) — HARD purge: the point is
   *   physically removed via `qdrant.delete`. `includeDeleted` also lets it act
   *   on a tombstone it is browsing via include_deleted. This is the only path
   *   that can irreversibly destroy a record.
   * - MCP `memory_delete` (`includeDeleted` false/undefined) — SOFT delete: set
   *   the same `deleted_at` tombstone the decay sweep uses (ADR-0006 §3.4). The
   *   record drops out of search/get (both already filter `deleted_at`) yet stays
   *   restorable via `memory_restore`. The MCP path can never hard-purge.
   */
  async delete(input: DeleteMemoryInput): Promise<void> {
    const hardPurge = input.includeDeleted ?? false;
    const record = await this.fetchOwned(input.namespace, input.id, hardPurge);

    if (hardPurge) {
      await this.qdrant.delete(this.collection, {
        wait: true,
        points: [input.id],
      });
      return;
    }

    // Soft-delete: mirror the decay tombstone (partial setPayload of deleted_at)
    // so memory_restore, which only understands deleted_at, covers user deletes.
    const nowIso = this.now().toISOString();
    await this.qdrant.setPayload(this.collection, {
      wait: true,
      payload: { deleted_at: nowIso, deleted_by: input.deletedBy ?? null },
      points: [input.id],
    });
    await this.appendLifecycleAudit(input.namespace, {
      event: 'memory.soft_deleted',
      point_id: input.id,
      reason: 'user_delete',
      deleted_by: input.deletedBy ?? null,
      last_retrieved_at: record.lastRetrievedAt,
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

  private async resolveDecayWeight(namespace: string): Promise<number> {
    if (!this.loadDecayWeight) return DEFAULT_DECAY_WEIGHT;
    try {
      return await this.loadDecayWeight(namespace);
    } catch {
      return DEFAULT_DECAY_WEIGHT;
    }
  }

  private async searchTopOne(
    namespace: string,
    vector: number[],
  ): Promise<{ record: MemoryRecord; score: number } | null> {
    // Over-fetch so we can skip soft-deleted/superseded points in code (Qdrant
    // null-filtering is awkward); dedup must never land on a tombstone (§3.4/§3.5).
    const results = await this.qdrant.search(this.collection, {
      vector,
      limit: 10,
      filter: {
        must: [
          { key: 'namespace', match: { value: namespace } },
          { key: 'kind', match: { value: MEMORY_KIND } },
        ],
      },
      with_payload: true,
      ...(this.searchParams ? { params: this.searchParams } : {}),
    });
    for (const r of results) {
      const record = payloadToMemory(r.id as string, r.payload as Record<string, unknown>);
      if (record.deletedAt != null || record.supersededBy != null) continue;
      return { record, score: r.score };
    }
    return null;
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

    // SEC-6 (#107) — dedup_history stacks up to DEDUP_HISTORY_CAP prior bodies
    // (each ≤ MEMORY_MAX_CONTENT_LENGTH), which can push the effective stored
    // metadata past MEMORY_MAX_METADATA_BYTES. This path is system-managed
    // (not caller input) and a merge must never fail, so trim the oldest history
    // entries until the serialized metadata fits the cap.
    const base = { ...(existing.metadata ?? {}) };
    const metadata = this.capMetadataForMerge(base, dedupHistory);

    const updated: MemoryRecord = {
      ...existing,
      tags,
      metadata,
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

  /**
   * SEC-6 (#107) — assemble the merged metadata object (existing keys minus the
   * stale `dedup_history`, plus the freshly-capped `dedupHistory`) and trim the
   * oldest history entries until the serialized size is within
   * MEMORY_MAX_METADATA_BYTES. If it still doesn't fit with zero history (the
   * base metadata is already oversized — should not happen, as store/update cap
   * incoming metadata), the base is returned as-is rather than failing the merge.
   */
  private capMetadataForMerge(
    base: Record<string, unknown>,
    dedupHistory: unknown[],
  ): Record<string, unknown> {
    const rest = { ...base };
    delete rest['dedup_history'];
    let history = [...dedupHistory];
    while (
      history.length > 0 &&
      Buffer.byteLength(JSON.stringify({ ...rest, dedup_history: history })) >
        MEMORY_MAX_METADATA_BYTES
    ) {
      history = history.slice(1); // drop the oldest entry
    }
    if (history.length === 0) {
      // Nothing left to trim: keep the surviving keys without dedup_history.
      return rest;
    }
    return { ...rest, dedup_history: history };
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
      deletedBy: null,
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

  private async fetchOwned(
    namespaceId: string,
    id: string,
    includeDeleted = false,
  ): Promise<MemoryRecord> {
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
    const record = payloadToMemory(points[0].id as string, payload);
    // Soft-deleted points are hidden by default (ADR-0006 §3.4); restore opts in.
    if (!includeDeleted && record.deletedAt != null) {
      throw new MemoryNotFoundError(namespaceId, id);
    }
    return record;
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
    for (const tag of tags) {
      if (tag.length > MEMORY_MAX_TAG_LENGTH) {
        throw new MemoryValidationError(
          `Tag exceeds maximum length of ${MEMORY_MAX_TAG_LENGTH}`,
          'tags',
        );
      }
    }
  }

  private validateSummary(summary: string | undefined): void {
    if (summary === undefined) return;
    if (summary.length > MEMORY_MAX_SUMMARY_LENGTH) {
      throw new MemoryValidationError(
        `Memory summary exceeds maximum length of ${MEMORY_MAX_SUMMARY_LENGTH}`,
        'summary',
      );
    }
  }

  private validateSource(source: string | undefined): void {
    if (source === undefined) return;
    if (source.length > MEMORY_MAX_SOURCE_LENGTH) {
      throw new MemoryValidationError(
        `Memory source exceeds maximum length of ${MEMORY_MAX_SOURCE_LENGTH}`,
        'source',
      );
    }
  }

  /**
   * SEC-6 (#107) — bound the serialized byte size of caller-supplied metadata so
   * it cannot bloat the Qdrant payload or evade the token budget. The at-rest
   * `dedup_history` growth is bounded separately by `capMetadataForMerge` (the
   * merge path is system-managed, not caller input, so it trims rather than throws).
   */
  private validateMetadata(metadata: Record<string, unknown> | undefined): void {
    if (metadata === undefined) return;
    const bytes = Buffer.byteLength(JSON.stringify(metadata));
    if (bytes > MEMORY_MAX_METADATA_BYTES) {
      throw new MemoryValidationError(
        `Memory metadata exceeds maximum serialized size of ${MEMORY_MAX_METADATA_BYTES} bytes`,
        'metadata',
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
    deleted_by: memory.deletedBy ?? null,
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
    deletedBy: (payload['deleted_by'] as string | null) ?? null,
    stalenessSignal: ((payload['staleness_signal'] as StalenessSignal) ?? 'unverified'),
    verifiesAgainst: payloadToVerifiesAgainst(payload['verifies_against']),
  };
}
