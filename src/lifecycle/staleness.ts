/**
 * Staleness auditor (ADR-0006 §3.6).
 *
 * Nightly sweep: for each namespace with `staleness_audit_enabled`, scroll up
 * to `staleness_audit_batch_size` non-deleted, non-immortal points that carry a
 * `verifies_against` reference, re-check the external reference, and write back
 * `staleness_signal` + `verifies_against.captured_at = now`.
 *
 * The audit WARNS; it never gates or deletes.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { QdrantClient } from '@qdrant/js-client-rest';
import { resolveLifecycle } from '../namespaces/defaults.js';
import { listNamespaceIds, loadNamespace } from '../namespaces/store.js';
import { payloadToMemory } from '../memory/service.js';
import type { StalenessSignal, VerifiesAgainst } from '../memory/types.js';
import { stalenessAuditTotal } from '../metrics/registry.js';

const execFileAsync = promisify(execFile);

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 h

// ── Checker interface ─────────────────────────────────────────────────────────

/**
 * Side-effecting checks for each verifies_against kind.
 * Injectable for deterministic tests.
 *
 * Return value semantics:
 *   - A concrete StalenessSignal: write it back to Qdrant.
 *   - null: leave the existing signal unchanged (e.g. network error, repo unreachable).
 */
export interface StalenessCheckers {
  file(
    ref: string,
    root: string,
    lastKnownValue?: string,
  ): Promise<StalenessSignal | null>;
  url(ref: string): Promise<StalenessSignal | null>;
  gitCommit(ref: string, root: string): Promise<StalenessSignal | null>;
}

// ── Default real checkers ─────────────────────────────────────────────────────

export const defaultStalenessCheckers: StalenessCheckers = {
  async file(ref, root, lastKnownValue) {
    // Guard against path traversal: resolved path must stay inside root.
    const resolvedRoot = resolve(root);
    const resolvedPath = resolve(root, ref);
    if (!resolvedPath.startsWith(resolvedRoot + '/') && resolvedPath !== resolvedRoot) {
      // Path traversal detected — treat as a skip (leave signal unchanged).
      return null;
    }

    let contents: Buffer;
    try {
      contents = await readFile(resolvedPath);
    } catch (err: unknown) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: unknown }).code === 'ENOENT'
      ) {
        return 'broken_ref';
      }
      // Other IO error — leave signal unchanged.
      return null;
    }

    if (lastKnownValue !== undefined) {
      const sha = 'sha256:' + createHash('sha256').update(contents).digest('hex');
      return sha === lastKnownValue ? 'fresh' : 'stale';
    }

    // No digest to compare — mark fresh (file exists, no drift check possible).
    return 'fresh';
  },

  async url(ref) {
    try {
      const res = await fetch(ref, { method: 'HEAD' });
      if (res.status === 200) return 'fresh';
      if (res.status === 404) return 'broken_ref';
      // Anything else (5xx, rate-limit, etc.) — leave unchanged.
      return null;
    } catch {
      return null;
    }
  },

  async gitCommit(ref, root) {
    // Check if the commit is an ancestor of HEAD but not HEAD itself → stale.
    // - `git merge-base --is-ancestor <ref> HEAD` exits 0 if ref is ancestor, 1 if not.
    // - If they are equal (ref IS HEAD) we treat as fresh.
    try {
      // First, check if they are the same commit.
      const { stdout: headOut } = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD']);
      const head = headOut.trim();
      const { stdout: refOut } = await execFileAsync('git', ['-C', root, 'rev-parse', ref]);
      const refResolved = refOut.trim();
      if (head === refResolved) return 'fresh';

      // Is ref an ancestor of HEAD?
      try {
        await execFileAsync('git', ['-C', root, 'merge-base', '--is-ancestor', ref, 'HEAD']);
        // Exit 0 → ref is ancestor of HEAD → HEAD has moved past it → stale.
        return 'stale';
      } catch {
        // Exit 1 → ref is NOT an ancestor — not in history (unknown commit or diverged).
        // Leave signal unchanged.
        return null;
      }
    } catch {
      // Repo unreachable or commit unknown — leave signal unchanged.
      return null;
    }
  },
};

// ── Stats ─────────────────────────────────────────────────────────────────────

export interface StalenessStats {
  namespacesSwept: number;
  checked: number;
  byResult: Record<StalenessSignal | 'skipped', number>;
}

function emptyStalenessStats(): StalenessStats {
  return {
    namespacesSwept: 0,
    checked: 0,
    byResult: { fresh: 0, stale: 0, broken_ref: 0, unverified: 0, skipped: 0 },
  };
}

// ── Auditor class ─────────────────────────────────────────────────────────────

export interface StalenessAuditorDeps {
  qdrant: QdrantClient;
  collection: string;
  dataDir: string;
  now?: () => Date;
  intervalMs?: number;
  checkers?: StalenessCheckers;
}

export class StalenessAuditor {
  private readonly qdrant: QdrantClient;
  private readonly collection: string;
  private readonly dataDir: string;
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private readonly checkers: StalenessCheckers;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: StalenessAuditorDeps) {
    this.qdrant = deps.qdrant;
    this.collection = deps.collection;
    this.dataDir = deps.dataDir;
    this.now = deps.now ?? (() => new Date());
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.checkers = deps.checkers ?? defaultStalenessCheckers;
  }

  /** Start the periodic audit timer. Unref'd so it never keeps the process alive. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Stop the timer. Does NOT flush a final run — the audit is best-effort. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run a single audit sweep across all namespaces.
   * Called by the timer AND directly from tests.
   */
  async runOnce(): Promise<StalenessStats> {
    const stats = emptyStalenessStats();
    const nowIso = this.now().toISOString();

    let nsIds: string[];
    try {
      nsIds = await listNamespaceIds(this.dataDir);
    } catch {
      return stats;
    }

    for (const nsId of nsIds) {
      let ns;
      try {
        ns = await loadNamespace(this.dataDir, nsId);
      } catch {
        continue;
      }
      if (!ns) continue;

      const lifecycle = resolveLifecycle(ns);
      if (!lifecycle.staleness_audit_enabled) continue;

      stats.namespacesSwept++;

      const batchSize = lifecycle.staleness_audit_batch_size;
      const filesystemRoot = lifecycle.filesystem_audit_root;

      // Scroll points: has verifies_against set, not soft-deleted, not immortal.
      let points: Array<{
        id: string | number;
        payload?: Record<string, unknown> | null;
      }>;
      try {
        const result = await this.qdrant.scroll(this.collection, {
          filter: {
            must: [
              { key: 'namespace', match: { value: nsId } },
            ],
            must_not: [
              { is_null: { key: 'verifies_against' } },
              { is_empty: { key: 'verifies_against' } },
            ],
          },
          limit: batchSize,
          with_payload: true,
          with_vector: false,
        });
        points = result.points;
      } catch {
        continue;
      }

      for (const point of points) {
        const id = point.id as string;
        const payload = (point.payload ?? {}) as Record<string, unknown>;

        // Skip soft-deleted points.
        if (payload['deleted_at'] !== null && payload['deleted_at'] !== undefined) {
          stats.byResult['skipped']++;
          continue;
        }

        // Skip immortal points.
        const metadata = payload['metadata'];
        if (
          typeof metadata === 'object' &&
          metadata !== null &&
          (metadata as Record<string, unknown>)['immortal'] === true
        ) {
          stats.byResult['skipped']++;
          continue;
        }

        let memory;
        try {
          memory = payloadToMemory(id, payload);
        } catch {
          stats.byResult['skipped']++;
          continue;
        }

        const va = memory.verifiesAgainst;
        if (!va) {
          stats.byResult['skipped']++;
          continue;
        }

        stats.checked++;

        let newSignal: StalenessSignal | null = null;
        try {
          newSignal = await this.dispatchCheck(va, filesystemRoot);
        } catch {
          // Defensive: any uncaught error leaves signal unchanged.
          newSignal = null;
        }

        if (newSignal !== null) {
          // Write back signal and bump captured_at.
          try {
            const updatedVerifiesAgainst = {
              kind: va.kind,
              ref: va.ref,
              captured_at: nowIso,
              ...(va.lastKnownValue !== undefined
                ? { last_known_value: va.lastKnownValue }
                : {}),
            };
            await this.qdrant.setPayload(this.collection, {
              wait: false,
              payload: {
                staleness_signal: newSignal,
                verifies_against: updatedVerifiesAgainst,
              },
              points: [id],
            });
          } catch {
            // Best-effort; skip write-back failures.
          }

          stats.byResult[newSignal] = (stats.byResult[newSignal] ?? 0) + 1;
          stalenessAuditTotal.inc({ result: newSignal });
        } else {
          stats.byResult['skipped']++;
          stalenessAuditTotal.inc({ result: 'skipped' });
        }
      }
    }

    return stats;
  }

  private async dispatchCheck(
    va: VerifiesAgainst,
    filesystemRoot: string | null,
  ): Promise<StalenessSignal | null> {
    switch (va.kind) {
      case 'file': {
        if (filesystemRoot === null) return null; // no root configured — skip
        return this.checkers.file(va.ref, filesystemRoot, va.lastKnownValue);
      }
      case 'url': {
        return this.checkers.url(va.ref);
      }
      case 'git_commit': {
        if (filesystemRoot === null) return null; // no repo root configured — skip
        return this.checkers.gitCommit(va.ref, filesystemRoot);
      }
    }
  }
}
