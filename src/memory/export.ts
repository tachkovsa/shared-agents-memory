import type { Namespace } from '../namespaces/types.js';
import {
  MEMORY_LIST_MAX_LIMIT,
  type ListMemoryInput,
  type ListMemoryResult,
  type MemoryRecord,
} from './types.js';

/**
 * The slice of {@link MemoryService} the exporter needs — a structural type so
 * unit tests can drive the page loop with a lightweight stub (no Qdrant).
 */
export interface ExportMemorySource {
  list(input: ListMemoryInput): Promise<ListMemoryResult>;
}

/** Opaque Qdrant scroll cursor carried between pages (matches ListMemoryResult). */
type ExportCursor = ListMemoryResult['nextCursor'] | undefined;

/** Manifest payload prefixing every export (schema_version pins the record shape). */
export interface ExportManifest {
  /** Full namespace config from `loadNamespace` (the console-visible settings). */
  namespace: Namespace;
  /** ISO timestamp the export was stamped with (injected clock — deterministic). */
  exported_at: string;
  /** `operator:<operatorId>` — who ran the export. */
  exported_by: string;
  include_deleted: boolean;
  schema_version: 1;
}

/**
 * One logical unit of an export stream. The route turns each item into a
 * physical line (NDJSON: `{type, ...data}`; JSON: the bare `data`). Keeping the
 * discriminator out of `data` lets both formats reuse the same generator.
 */
export type ExportItem =
  | { kind: 'manifest'; data: ExportManifest }
  | { kind: 'memory'; data: Record<string, unknown> };

export interface ExportNamespaceOptions {
  includeDeleted: boolean;
  manifest: ExportManifest;
  /** Projection applied to each record — pass the memories route's `view()`. */
  project: (m: MemoryRecord) => Record<string, unknown>;
  /** Page size for each `list()` call. Defaults to MEMORY_LIST_MAX_LIMIT. */
  pageLimit?: number;
}

/**
 * Stream a namespace export as a sequence of items: first the manifest, then one
 * `memory` item per record, paging through `source.list()` and following
 * `nextCursor` until it is null (true exhaustion — #110 guarantees full pages and
 * a null cursor only at the end, so this loop terminates and never short-pages).
 *
 * Memory-bounded: only one page of records is materialized at a time, so a
 * namespace with up to 100k records exports without buffering the whole set.
 */
export async function* exportNamespaceLines(
  source: ExportMemorySource,
  namespaceId: string,
  opts: ExportNamespaceOptions,
): AsyncGenerator<ExportItem> {
  yield { kind: 'manifest', data: opts.manifest };

  const limit = opts.pageLimit ?? MEMORY_LIST_MAX_LIMIT;
  let cursor: ExportCursor = undefined;
  do {
    const page = await source.list({
      namespace: namespaceId,
      cursor,
      limit,
      includeDeleted: opts.includeDeleted,
    });
    for (const record of page.memories) {
      yield { kind: 'memory', data: opts.project(record) };
    }
    // #110: nextCursor is null only at true exhaustion, so this terminates.
    cursor = page.nextCursor;
  } while (cursor != null);
}
