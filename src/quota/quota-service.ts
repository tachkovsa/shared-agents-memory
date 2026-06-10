/**
 * Per-tenant quota enforcement (issue #59).
 *
 * Persists daily counters in `data/namespaces/<ns>/_quota.json` and enforces
 * limits defined in `Namespace.quota`.  File reads/writes are serialised
 * per-namespace via a Promise-chain mutex so concurrent tool calls don't lose
 * counter increments.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NamespaceQuota } from '../namespaces/types.js';
import { namespaceDir } from '../namespaces/store.js';

// ── Error ────────────────────────────────────────────────────────────────────

export type QuotaLimitKind =
  | 'daily_writes'
  | 'daily_searches'
  | 'daily_embedding_tokens'
  | 'max_memories';

export class QuotaExceededError extends Error {
  constructor(
    public readonly namespace: string,
    public readonly limit: QuotaLimitKind,
    public readonly used: number,
    public readonly cap: number,
  ) {
    super(
      `Quota exceeded for namespace "${namespace}": ${limit} — used ${used}, cap ${cap}`,
    );
    this.name = 'QuotaExceededError';
  }
}

// ── Persisted shape ───────────────────────────────────────────────────────────

interface QuotaUsage {
  writes: number;
  searches: number;
  embedding_tokens: number;
}

interface QuotaFile {
  usage: Partial<QuotaUsage>;
  last_reset: string; // ISO-8601
}

export interface QuotaCheckOpts {
  quota: NamespaceQuota;
  estimatedTokens?: number;
  currentCount?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function quotaFilePath(dataDir: string, namespace: string): string {
  return join(namespaceDir(dataDir, namespace), '_quota.json');
}

/**
 * Throw `QuotaExceededError` if performing one `kind` op would breach a limit.
 * Pure — operates on the already-loaded usage so `check` and `reserve` share it.
 */
function assertWithinQuota(
  namespace: string,
  kind: 'write' | 'search',
  usage: QuotaUsage,
  opts: QuotaCheckOpts,
): void {
  if (kind === 'write') {
    if (usage.writes >= opts.quota.daily_writes) {
      throw new QuotaExceededError(namespace, 'daily_writes', usage.writes, opts.quota.daily_writes);
    }
    if (opts.currentCount !== undefined && opts.currentCount >= opts.quota.max_memories) {
      throw new QuotaExceededError(
        namespace,
        'max_memories',
        opts.currentCount,
        opts.quota.max_memories,
      );
    }
  } else {
    if (usage.searches >= opts.quota.daily_searches) {
      throw new QuotaExceededError(
        namespace,
        'daily_searches',
        usage.searches,
        opts.quota.daily_searches,
      );
    }
  }
  // daily_embedding_tokens applies to both writes and searches (both embed).
  if (opts.estimatedTokens !== undefined) {
    const projected = usage.embedding_tokens + opts.estimatedTokens;
    if (projected > opts.quota.daily_embedding_tokens) {
      throw new QuotaExceededError(
        namespace,
        'daily_embedding_tokens',
        usage.embedding_tokens,
        opts.quota.daily_embedding_tokens,
      );
    }
  }
}

/** Return the UTC date string (YYYY-MM-DD) for a Date instance. */
function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── QuotaService ──────────────────────────────────────────────────────────────

export interface QuotaServiceDeps {
  dataDir: string;
  /** Override the current time (useful for tests). */
  now?: () => Date;
}

export class QuotaService {
  private readonly dataDir: string;
  private readonly now: () => Date;

  /**
   * Per-namespace serialisation lock.
   * Each entry is a Promise chain — new operations append to it so that
   * reads and writes happen in strict FIFO order within a process.
   */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(deps: QuotaServiceDeps) {
    this.dataDir = deps.dataDir;
    this.now = deps.now ?? (() => new Date());
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Check whether the given operation would exceed any quota limit.
   * Throws `QuotaExceededError` if it would; returns normally otherwise.
   *
   * Does NOT increment counters — call `record` after the operation succeeds.
   */
  async check(
    namespace: string,
    kind: 'write' | 'search',
    opts?: QuotaCheckOpts,
  ): Promise<void> {
    if (!opts) return; // nothing to check without quota config
    await this.withLock(namespace, async () => {
      const usage = this.resolveUsage(await this.load(namespace));
      assertWithinQuota(namespace, kind, usage, opts);
    });
  }

  /**
   * Record that an operation succeeded — increment the appropriate counters
   * and persist to disk.
   */
  async record(
    namespace: string,
    kind: 'write' | 'search',
    opts?: { estimatedTokens?: number },
  ): Promise<void> {
    await this.withLock(namespace, async () => {
      const file = await this.load(namespace);
      const usage = this.resolveUsage(file);
      this.applyIncrement(usage, kind, opts?.estimatedTokens);
      await this.save(namespace, { usage, last_reset: file.last_reset });
    });
  }

  /**
   * Atomically check-and-consume quota for one operation under a single lock
   * acquisition (ADR-0006 abuse protection). This closes the check→record
   * TOCTOU: concurrent callers cannot all pass `check` on stale usage and then
   * each `record` past the cap. Callers invoke `reserve` BEFORE the operation;
   * on `QuotaExceededError` nothing is consumed and the operation must not run.
   *
   * Note (max_memories): the count is checked against the live point count, so
   * at the cap a dedup-reinforce/merge (which would NOT grow the count) is also
   * blocked. Acceptable for abuse protection — fail-closed at the ceiling.
   */
  async reserve(
    namespace: string,
    kind: 'write' | 'search',
    opts?: QuotaCheckOpts,
  ): Promise<void> {
    if (!opts) return;
    await this.withLock(namespace, async () => {
      const file = await this.load(namespace);
      const usage = this.resolveUsage(file);
      assertWithinQuota(namespace, kind, usage, opts);
      this.applyIncrement(usage, kind, opts.estimatedTokens);
      await this.save(namespace, { usage, last_reset: file.last_reset });
    });
  }

  private applyIncrement(
    usage: QuotaUsage,
    kind: 'write' | 'search',
    estimatedTokens?: number,
  ): void {
    if (kind === 'write') usage.writes += 1;
    else usage.searches += 1;
    if (estimatedTokens) usage.embedding_tokens += estimatedTokens;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Run `fn` while holding the per-namespace lock.
   * Errors from `fn` propagate normally; the lock is always released.
   */
  private withLock<T>(namespace: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(namespace) ?? Promise.resolve();
    const next = prev.then(() => fn());
    // Store the tail of the chain (without the error so the chain doesn't halt
    // on rejections from previous callers).
    this.locks.set(
      namespace,
      next.catch(() => undefined),
    );
    return next;
  }

  private async load(namespace: string): Promise<QuotaFile> {
    const path = quotaFilePath(this.dataDir, namespace);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if (isEnoent(err)) {
        // Namespace was created before quota tracking — return empty state.
        return { usage: {}, last_reset: this.now().toISOString() };
      }
      throw err;
    }
    let parsed: QuotaFile;
    try {
      parsed = JSON.parse(raw) as QuotaFile;
    } catch {
      // Corrupt quota file (partial write / manual edit). Reset rather than
      // throwing on every enforced store/search for this namespace.
      return { usage: {}, last_reset: this.now().toISOString() };
    }
    if (!parsed || typeof parsed.last_reset !== 'string' || typeof parsed.usage !== 'object') {
      return { usage: {}, last_reset: this.now().toISOString() };
    }
    // Roll over if the last reset was on a different UTC day.
    const todayStr = utcDateString(this.now());
    const resetStr = utcDateString(new Date(parsed.last_reset));
    if (resetStr !== todayStr) {
      return { usage: {}, last_reset: this.now().toISOString() };
    }
    return parsed;
  }

  private async save(namespace: string, file: { usage: QuotaUsage; last_reset: string }): Promise<void> {
    const path = quotaFilePath(this.dataDir, namespace);
    // Atomic write: a crash mid-write must not leave a truncated _quota.json.
    // Writes are serialised per-namespace by withLock, so a fixed tmp name is safe.
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`);
    await rename(tmp, path);
  }

  /** Normalise a potentially partial `usage` object to full counters. */
  private resolveUsage(file: QuotaFile): QuotaUsage {
    return {
      writes: file.usage.writes ?? 0,
      searches: file.usage.searches ?? 0,
      embedding_tokens: file.usage.embedding_tokens ?? 0,
    };
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
