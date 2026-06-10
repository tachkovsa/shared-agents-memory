export const MEMORY_KIND = 'episodic' as const;
export type MemoryKind = typeof MEMORY_KIND;

export interface MemoryRecord {
  id: string;
  namespace: string;
  agentId: string;
  kind: MemoryKind;
  content: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  tags: string[];
  source?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  // ADR-0006 §3.3 reinforcement fields (added by #26).
  retrievalCount: number;
  lastRetrievedAt: string | null;
}

export interface SearchResult {
  memory: MemoryRecord;
  score: number;
}

/** Outcome of a `memory.store` call (ADR-0006 §3.2). */
export type StoreOutcome = 'inserted' | 'reinforced' | 'merged';

export interface StoreResult {
  record: MemoryRecord;
  outcome: StoreOutcome;
  /** Point ID of the existing memory a reinforce/merge landed on; null on insert. */
  matchedExistingId: string | null;
}

export interface StoreMemoryInput {
  namespace: string;
  agentId: string;
  content: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  source?: string;
  id?: string;
}

export interface SearchMemoryInput {
  namespace: string;
  query: string;
  limit?: number;
  tags?: string[];
}

export interface GetMemoryInput {
  namespace: string;
  id: string;
}

export interface UpdateMemoryMetadataInput {
  namespace: string;
  id: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  source?: string;
}

export interface DeleteMemoryInput {
  namespace: string;
  id: string;
}

export const MEMORY_MAX_CONTENT_LENGTH = 32_000;
export const MEMORY_MAX_TAGS = 20;

// ── Dedup thresholds (ADR-0006 §3.2) ────────────────────────────────────────
/** Default per-namespace dedup threshold; near-duplicates above this merge. */
export const DEDUP_DEFAULT_THRESHOLD = 0.95;
/** Above this cosine the store is treated as the same content (reinforce, no merge). */
export const DEDUP_REINFORCE_THRESHOLD = 0.99;
/** Lower bound for a tunable threshold; below this dedup is too aggressive. */
export const DEDUP_MIN_THRESHOLD = 0.85;
/** A threshold of exactly 1.0 disables dedup (every store inserts). */
export const DEDUP_DISABLED_THRESHOLD = 1.0;
/** Max number of merged-away contents kept in `metadata.dedup_history`. */
export const DEDUP_HISTORY_CAP = 5;
