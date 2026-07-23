import { rm, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { AuthAuditWriter } from '../auth/audit.js';
import {
  isValidNamespaceId,
  namespaceDir,
} from './store.js';
import { BOOTSTRAP_NAMESPACE_ID } from './types.js';
import {
  countNamespaceVectors,
  listDeletedNamespaceDirs,
  purgeNamespaceVectors,
  type NamespaceVectorPurger,
} from './vector-cascade.js';

/** Verifiable receipt returned by a hard-delete that reached the purge stage. */
export interface PurgeReceipt {
  namespace_id: string;
  vectors: {
    /** Points owned by the namespace before the purge. */
    points_before: number;
    /** Points still owned after the purge — expected 0. */
    points_after: number;
    /** points_before - points_after (0 when the purge could not run). */
    purged: number;
  };
  filesystem: {
    /** Basenames of the `_deleted/<id>-<ts>/` dirs removed (empty when none / purge failed). */
    removed_dirs: string[];
  };
  /** True only when points_after === 0 — a partial purge must not read as success. */
  verified: boolean;
  /** `operator:<operatorId>` — who authorised the purge. */
  purged_by: string;
}

/**
 * Outcome of {@link hardDeleteNamespace}. Pre-flight rejections are distinct
 * statuses the route maps to HTTP codes; `purged` carries the receipt (which may
 * itself be `verified: false` → the route answers 500 so a partial purge is
 * visible rather than a false success).
 */
export type HardDeleteResult =
  | { status: 'purged'; receipt: PurgeReceipt }
  | { status: 'invalid_id' }
  | { status: 'protected' }
  | { status: 'live' }
  | { status: 'not_found' };

export interface HardDeleteNamespaceInput {
  /** Qdrant surface — needs `count` (verification) + `delete` (purge). */
  qdrant: NamespaceVectorPurger;
  collection: string;
  dataDir: string;
  namespaceId: string;
  /** Operator performing the purge; recorded as `purged_by: operator:<id>`. */
  operatorId: string;
  auditor: AuthAuditWriter;
}

/**
 * Operator-only, verifiable HARD-delete of an ALREADY soft-deleted namespace
 * (FEAT-1, #111). This is the destructive companion to the MCP soft-delete: it
 * physically purges the tenant's Qdrant vectors AND removes the `_deleted/`
 * directories, returning a receipt that proves the vectors are gone.
 *
 * Fail-safe ordering (each step guards the next):
 *  1. Validate the id BEFORE any filesystem touch (path-traversal guard), and
 *     refuse the protected bootstrap namespace — mirrors the MCP delete guard.
 *  2. Require the namespace to be soft-deleted: at least one
 *     `data/_deleted/<id>-<ts>/` dir. A still-LIVE namespace is rejected (409) so
 *     the 30-day grace promise is never short-circuited; a wholly unknown id 404s.
 *  3. Count points BEFORE the purge.
 *  4. Purge the vectors BEFORE removing the dirs — a purge failure leaves
 *     `_deleted/` in place so the startup `sweepOrphanedNamespaceVectors` backstop
 *     can retry; it is audited (`namespace.vector_purge_failed`) and reported
 *     `verified: false` (never a silent partial success).
 *  5. Count points AFTER → verification.
 *  6. Remove every matching `_deleted/` dir.
 *  7. Audit `namespace.hard_deleted` with the full receipt.
 */
export async function hardDeleteNamespace(
  input: HardDeleteNamespaceInput,
): Promise<HardDeleteResult> {
  const { qdrant, collection, dataDir, namespaceId, operatorId, auditor } = input;
  const purgedBy = `operator:${operatorId}`;

  // 1. Validate + protect BEFORE touching the filesystem.
  if (!isValidNamespaceId(namespaceId)) {
    return { status: 'invalid_id' };
  }
  if (namespaceId === BOOTSTRAP_NAMESPACE_ID) {
    return { status: 'protected' };
  }

  // 2. Must be soft-deleted; a live namespace is rejected (grace intact), an
  //    unknown id is a 404.
  const deletedDirs = await listDeletedNamespaceDirs(dataDir, namespaceId);
  if (deletedDirs.length === 0) {
    return (await dirExists(namespaceDir(dataDir, namespaceId)))
      ? { status: 'live' }
      : { status: 'not_found' };
  }

  // 3. Count before.
  const pointsBefore = await countNamespaceVectors(qdrant, collection, namespaceId);

  // 4. Purge vectors BEFORE removing dirs — a failure keeps the _deleted/ backstop.
  try {
    await purgeNamespaceVectors(qdrant, collection, namespaceId);
  } catch (err) {
    await auditor.record('namespace.vector_purge_failed', {
      namespace_id: namespaceId,
      purged_by: purgedBy,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      status: 'purged',
      receipt: {
        namespace_id: namespaceId,
        vectors: { points_before: pointsBefore, points_after: pointsBefore, purged: 0 },
        filesystem: { removed_dirs: [] },
        verified: false,
        purged_by: purgedBy,
      },
    };
  }

  // 5. Count after → verification.
  const pointsAfter = await countNamespaceVectors(qdrant, collection, namespaceId);

  // 5a. Partial purge (delete returned without throwing, but points remain — e.g.
  //     an eventually-consistent Qdrant). Do NOT remove the dirs: keeping
  //     `_deleted/<id>-<ts>/` is what lets the startup `sweepOrphanedNamespaceVectors`
  //     retry, so a partial purge is recoverable rather than an orphaned-forever
  //     leak. Audit the failure and report verified:false (route → 500). This
  //     mirrors the throw path: dirs are removed and `namespace.hard_deleted` is
  //     recorded ONLY on a fully-verified purge.
  if (pointsAfter !== 0) {
    await auditor.record('namespace.vector_purge_failed', {
      namespace_id: namespaceId,
      purged_by: purgedBy,
      points_before: pointsBefore,
      points_after: pointsAfter,
    });
    return {
      status: 'purged',
      receipt: {
        namespace_id: namespaceId,
        vectors: { points_before: pointsBefore, points_after: pointsAfter, purged: pointsBefore - pointsAfter },
        filesystem: { removed_dirs: [] },
        verified: false,
        purged_by: purgedBy,
      },
    };
  }

  // 6. Verified (points_after === 0) — remove every soft-deleted dir for this namespace.
  for (const dir of deletedDirs) {
    await rm(dir, { recursive: true, force: true });
  }

  // 7. Audit the receipt (only reached on a fully-verified purge).
  const receipt: PurgeReceipt = {
    namespace_id: namespaceId,
    vectors: {
      points_before: pointsBefore,
      points_after: pointsAfter,
      purged: pointsBefore - pointsAfter,
    },
    filesystem: { removed_dirs: deletedDirs.map((d) => basename(d)) },
    verified: true,
    purged_by: purgedBy,
  };
  await auditor.record('namespace.hard_deleted', { ...receipt });

  return { status: 'purged', receipt };
}

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: unknown }).code === 'ENOENT'
    ) {
      return false;
    }
    throw err;
  }
}
