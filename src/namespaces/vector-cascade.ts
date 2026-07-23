import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { QdrantClient } from '@qdrant/js-client-rest';

/**
 * Minimal Qdrant surface needed to cascade namespace deletes. `delete` powers the
 * cascade + orphan sweep; `count` powers the verifiable operator hard-delete
 * (points before/after). Kept narrow so every path can be exercised with a tiny
 * stub in tests.
 */
export type NamespaceVectorPurger = Pick<QdrantClient, 'delete' | 'count'>;

/** Directory soft-deleted namespaces are moved into (see `softDeleteNamespace`). */
const DELETED_DIR = '_deleted';

/** Namespace-scoped payload filter shared by count + delete. */
function namespaceFilter(namespaceId: string) {
  return { must: [{ key: 'namespace', match: { value: namespaceId } }] };
}

/**
 * Physically remove every Qdrant vector whose payload `namespace` equals
 * `namespaceId`.
 *
 * The payload key is `namespace` — confirmed against `PAYLOAD_INDEXES` in
 * `src/qdrant.ts` (`{ field_name: 'namespace', field_schema: 'keyword' }`) and
 * `memoryToPayload` in `src/memory/service.ts` (`namespace: memory.namespace`),
 * which is the exact key every point is upserted with.
 *
 * Idempotent: a namespace with no points is a harmless no-op, so this is safe to
 * retry and safe to run from the orphan sweep.
 */
export async function purgeNamespaceVectors(
  qdrant: NamespaceVectorPurger,
  collection: string,
  namespaceId: string,
): Promise<void> {
  await qdrant.delete(collection, {
    wait: true,
    filter: namespaceFilter(namespaceId),
  });
}

/**
 * Count the Qdrant points currently owned by `namespaceId` (same payload filter
 * the cascade deletes on). Powers the operator hard-delete receipt: the caller
 * reads this before and after the purge to prove the vectors are actually gone
 * (`points_after === 0`), rather than reporting a purge it can't verify.
 */
export async function countNamespaceVectors(
  qdrant: NamespaceVectorPurger,
  collection: string,
  namespaceId: string,
): Promise<number> {
  const result = await qdrant.count(collection, {
    filter: namespaceFilter(namespaceId),
  });
  return result.count;
}

/**
 * Enumerate the soft-deleted directories belonging to a SINGLE namespace id:
 * every `data/_deleted/<id>-<unix_ms>/` entry whose id prefix matches exactly.
 * A namespace deleted more than once yields several such dirs. Returns absolute
 * paths (for `rm`), and never matches a different namespace whose id is a prefix
 * of this one (`team` must not sweep up `team-alpha-...`) because only a literal
 * `-<digits>` suffix is accepted.
 */
export async function listDeletedNamespaceDirs(
  dataDir: string,
  namespaceId: string,
): Promise<string[]> {
  const dir = join(dataDir, DELETED_DIR);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const suffix = /-\d+$/;
  const matches: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue; // skip hidden / partial dirs
    const m = suffix.exec(entry);
    if (m && entry.slice(0, m.index) === namespaceId) {
      matches.push(join(dir, entry));
    }
  }
  return matches;
}

/**
 * Enumerate the original namespace ids that have soft-deleted directories under
 * `data/_deleted/`. Each entry is named `<id>-<unix_ms>` (see
 * `softDeleteNamespace`), so the trailing `-<digits>` timestamp is stripped to
 * recover the id. A namespace deleted more than once yields multiple directories
 * for the same id; duplicates are collapsed.
 */
export async function listDeletedNamespaceIds(dataDir: string): Promise<string[]> {
  const dir = join(dataDir, DELETED_DIR);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.startsWith('.')) continue; // skip hidden / partial dirs
    const match = /^(.+)-\d+$/.exec(entry);
    ids.add(match ? match[1]! : entry);
  }
  return [...ids];
}

/**
 * Purge Qdrant vectors for every namespace already soft-deleted into
 * `data/_deleted/`. This is the backstop that cleans up orphans the per-delete
 * cascade cannot reach: namespaces deleted before the cascade existed, and any
 * delete whose vector purge failed after the directory was moved. Safe to run
 * repeatedly (each purge is idempotent); returns the ids that were swept.
 */
export async function sweepOrphanedNamespaceVectors(
  qdrant: NamespaceVectorPurger,
  collection: string,
  dataDir: string,
): Promise<string[]> {
  const ids = await listDeletedNamespaceIds(dataDir);
  for (const id of ids) {
    await purgeNamespaceVectors(qdrant, collection, id);
  }
  return ids;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
