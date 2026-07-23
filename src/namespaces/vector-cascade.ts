import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { QdrantClient } from '@qdrant/js-client-rest';

/**
 * Minimal Qdrant surface needed to cascade namespace deletes. Kept narrow so the
 * delete tool and the orphan sweep can be exercised with a tiny stub in tests.
 */
export type NamespaceVectorPurger = Pick<QdrantClient, 'delete'>;

/** Directory soft-deleted namespaces are moved into (see `softDeleteNamespace`). */
const DELETED_DIR = '_deleted';

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
    filter: { must: [{ key: 'namespace', match: { value: namespaceId } }] },
  });
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
