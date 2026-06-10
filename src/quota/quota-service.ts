/**
 * Per-tenant quota enforcement (issue #59).
 *
 * Persists daily counters in `data/namespaces/<ns>/_quota.json` and enforces
 * limits defined in `Namespace.quota`.  File reads/writes are serialised
 * per-namespace via a Promise-chain mutex so concurrent tool calls don't lose
 * counter increments.
 */
import { readFile, writeFile } from 'node:fs/promises';
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function quotaFilePath(dataDir: string, namespace: string): string {
  return join(namespaceDir(dataDir, namespace), '_quota.json');
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
    opts?: {
      quota: NamespaceQuota;
      estimatedTokens?: number;
      currentCount?: number;
    },
  ): Promise<void> {
    if (!opts) return; // nothing to check without quota config

    await this.withLock(namespace, async () => {
      const file = await this.load(namespace);
      const usage = this.resolveUsage(file);

      if (kind === 'write') {
        // daily_writes
        if (usage.writes >= opts.quota.daily_writes) {
          throw new QuotaExceededError(
            namespace,
            'daily_writes',
            usage.writes,
            opts.quota.daily_writes,
          );
        }
        // max_memories
        if (
          opts.currentCount !== undefined &&
          opts.currentCount >= opts.quota.max_memories
        ) {
          throw new QuotaExceededError(
            namespace,
            'max_memories',
            opts.currentCount,
            opts.quota.max_memories,
          );
        }
        // daily_embedding_tokens
        if (opts.estimatedTokens !== undefined) {
          const projectedTokens = usage.embedding_tokens + opts.estimatedTokens;
          if (projectedTokens > opts.quota.daily_embedding_tokens) {
            throw new QuotaExceededError(
              namespace,
              'daily_embedding_tokens',
              usage.embedding_tokens,
              opts.quota.daily_embedding_tokens,
            );
          }
        }
      } else {
        // search
        // daily_searches
        if (usage.searches >= opts.quota.daily_searches) {
          throw new QuotaExceededError(
            namespace,
            'daily_searches',
            usage.searches,
            opts.quota.daily_searches,
          );
        }
        // daily_embedding_tokens
        if (opts.estimatedTokens !== undefined) {
          const projectedTokens = usage.embedding_tokens + opts.estimatedTokens;
          if (projectedTokens > opts.quota.daily_embedding_tokens) {
            throw new QuotaExceededError(
              namespace,
              'daily_embedding_tokens',
              usage.embedding_tokens,
              opts.quota.daily_embedding_tokens,
            );
          }
        }
      }
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

      if (kind === 'write') {
        usage.writes += 1;
      } else {
        usage.searches += 1;
      }
      if (opts?.estimatedTokens) {
        usage.embedding_tokens += opts.estimatedTokens;
      }

      await this.save(namespace, { usage, last_reset: file.last_reset });
    });
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
    const parsed = JSON.parse(raw) as QuotaFile;
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
    await writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
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
