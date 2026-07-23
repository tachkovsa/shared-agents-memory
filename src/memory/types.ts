export const MEMORY_KIND = 'episodic' as const;
export type MemoryKind = typeof MEMORY_KIND;

/** ADR-0006 §3.6 — per-memory truth-correspondence signal. */
export type StalenessSignal = 'fresh' | 'unverified' | 'stale' | 'broken_ref';

/**
 * ADR-0006 §3.6 — optional pointer to something in the world the memory
 * describes (a file, URL, or git commit). The staleness audit (#28) re-checks
 * these and updates `stalenessSignal`. Absent → the memory is never audited.
 */
export interface VerifiesAgainst {
  kind: 'file' | 'url' | 'git_commit';
  /** Path / URL / commit SHA. */
  ref: string;
  /** When the reference was last checked (ISO-8601). */
  capturedAt: string;
  /** Optional digest/version captured at write time, compared on audit. */
  lastKnownValue?: string;
}

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
  // ADR-0006 §3.1 lifecycle fields. The payload shape is locked here (#27) so
  // later mechanisms (#27 decay/supersession/soft-delete, #28 staleness) reshape
  // behaviour, not the at-rest schema.
  /** Decay multiplier in [0,1] applied at search re-rank (ADR-0006 §3.4). 1.0 = no decay. */
  decayScore: number;
  /** Point ID of a newer memory that replaces this one; excluded from search by default (§3.5). */
  supersededBy: string | null;
  /** Soft-delete tombstone (ISO-8601); excluded from search/get when set (§3.4). */
  deletedAt: string | null;
  /** Author (agent/PAT id) that soft-deleted this record; null when live or decay-deleted (issue #105). */
  deletedBy: string | null;
  /** Truth-correspondence signal (§3.6); 'unverified' until the staleness audit runs. */
  stalenessSignal: StalenessSignal;
  /** Opt-in reference the staleness audit re-checks (§3.6); null → never audited. */
  verifiesAgainst: VerifiesAgainst | null;
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
  /** ADR-0006 §3.5 — ids actually marked `superseded_by` this new point (insert only). */
  supersededIds: string[];
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
  /** ADR-0006 §3.6 — opt-in reference the staleness audit (#28) re-checks. */
  verifiesAgainst?: VerifiesAgainst;
  /**
   * ADR-0006 §3.5 — point ids this new memory replaces. On a fresh insert each
   * existing point in the same namespace gets `superseded_by = <new id>`.
   * Ids that don't exist or live in another namespace are silently skipped.
   */
  supersedes?: string[];
}

export interface SearchMemoryInput {
  namespace: string;
  query: string;
  limit?: number;
  tags?: string[];
  /** ADR-0006 §3.5 — include `superseded_by != null` points (default false). */
  includeSuperseded?: boolean;
}

export interface GetMemoryInput {
  namespace: string;
  id: string;
  /** ADR-0006 §3.4 — return a soft-deleted (tombstoned) point (default false). */
  includeDeleted?: boolean;
}

/** ADR-0006 §3.4 — restore a soft-deleted memory (clears `deleted_at`). */
export interface RestoreMemoryInput {
  namespace: string;
  id: string;
}

/** Cursor-paginated listing (operator console memory browser, #67). */
export interface ListMemoryInput {
  namespace: string;
  limit?: number;
  /** Opaque Qdrant scroll cursor from a previous page's `nextCursor`. */
  cursor?: string | number | Record<string, unknown> | null;
  /** Include soft-deleted records; default false. */
  includeDeleted?: boolean;
}

export interface ListMemoryResult {
  memories: MemoryRecord[];
  /** Pass back as `cursor` for the next page; null when exhausted. */
  nextCursor: string | number | Record<string, unknown> | null;
}

export const MEMORY_LIST_MAX_LIMIT = 200;
export const MEMORY_LIST_DEFAULT_LIMIT = 50;

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
  /**
   * Operator hard-purge switch (issue #105 / SEC-4). When true the point is
   * physically removed — this is the operator console path, which also lets it
   * purge tombstones it browses via include_deleted. When false/undefined (the
   * MCP `memory_delete` path) the delete is a SOFT delete: it sets the same
   * `deleted_at` tombstone the decay sweep uses, keeping the record restorable.
   */
  includeDeleted?: boolean;
  /** Author (agent/PAT id) recorded on the soft-delete tombstone (issue #105). */
  deletedBy?: string;
}

export const MEMORY_MAX_CONTENT_LENGTH = 32_000;
export const MEMORY_MAX_TAGS = 20;
/**
 * SEC-6 (#107) — cap the serialized byte size of `metadata` so a writer cannot
 * bloat Qdrant payloads or evade the token budget by stuffing megabytes into the
 * otherwise-unbounded `z.record(z.string(), z.unknown())`. Measured as
 * `Buffer.byteLength(JSON.stringify(metadata))`. 64 KiB is generous for genuine
 * structured metadata while killing the multi-megabyte abuse case.
 */
export const MEMORY_MAX_METADATA_BYTES = 65_536;
/** SEC-6 (#107) — cap the free-text `summary` field (a "brief summary"). */
export const MEMORY_MAX_SUMMARY_LENGTH = 4_000;
/** SEC-6 (#107) — cap the free-text `source` field (an origin path/URL/id). */
export const MEMORY_MAX_SOURCE_LENGTH = 2_000;
/** SEC-6 (#107) — cap each individual tag's length (count is MEMORY_MAX_TAGS). */
export const MEMORY_MAX_TAG_LENGTH = 128;

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

// ── Decay / lifecycle (ADR-0006 §3.4) ───────────────────────────────────────
/** A freshly-stored or never-decayed memory has full ranking weight. */
export const DECAY_DEFAULT_SCORE = 1.0;
/** A memory that has ever been retrieved never decays below this (§3.4). */
export const DECAY_RETRIEVED_FLOOR = 0.5;
/** Default blend between raw cosine and decay-adjusted score at re-rank (§3.4). */
export const DEFAULT_DECAY_WEIGHT = 0.5;
/** Days before a soft-deleted point is physically removed (§3.4). */
export const DEFAULT_HARD_DELETE_GRACE_DAYS = 30;
/** Default staleness-audit batch size per sweep (§3.6). */
export const DEFAULT_STALENESS_AUDIT_BATCH_SIZE = 100;

/**
 * Half-life (days) for each decaying retention policy (ADR-0006 §3.4). The
 * shipped `RetentionPolicy` is a string enum (decay-Nd) rather than the ADR's
 * object union; this table maps each value to its half-life. `keep-forever`
 * has no entry → never decays.
 */
export const RETENTION_HALF_LIFE_DAYS: Readonly<Record<string, number>> = {
  'decay-90d': 90,
  'decay-180d': 180,
  'decay-365d': 365,
};
