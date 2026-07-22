/**
 * scripts/reembed-collection.ts
 *
 * One-shot operator CLI: re-embeds every memory point from a SOURCE Qdrant
 * collection into a TARGET collection using the embedding provider configured
 * via the `EMBEDDINGS_*` env vars, then upserts each point (same id + same
 * payload, new vector) into the target.
 *
 * Why this exists: switching embedding models (e.g. cloud qwen3 4096-dim →
 * self-hosted bge-m3 1024-dim, ADR-0010) changes both the vector dimension and
 * the vector space, so existing vectors cannot be copied — they must be
 * regenerated from the original text. Only the `content` field is embedded
 * (mirrors MemoryService.store), so the payload is preserved verbatim.
 *
 * Typical migration (re-embed on the new box):
 *   1. Restore the old Qdrant snapshot into a temp collection on the new box,
 *      e.g. `agent_memories_src`.
 *   2. Point EMBEDDINGS_* at the new provider (the new box's local TEI/bge-m3).
 *   3. Run this script: source=agent_memories_src → target=agent_memories.
 *   4. Verify counts, then drop the temp source collection.
 *
 * Usage:
 *   npx tsx scripts/reembed-collection.ts \
 *     --source-collection agent_memories_src \
 *     [--target-collection agent_memories] \
 *     [--source-url http://localhost:6333] \
 *     [--batch 32] \
 *     [--skip-deleted] \
 *     [--dry-run] \
 *     [--verbose]
 *
 * Reads from the same env the server uses (loadConfig): EMBEDDINGS_API_KEY,
 * EMBEDDINGS_BASE_URL, EMBEDDINGS_MODEL, EMBEDDINGS_DIMENSION, QDRANT_URL,
 * QDRANT_API_KEY, QDRANT_QUANTIZATION/RESCORE/OVERSAMPLING. The TARGET Qdrant is
 * always config.qdrant.url; --source-url defaults to the same instance.
 *
 * Idempotent: upsert is keyed by point id, so a re-run overwrites rather than
 * duplicates. Safe to re-run after a partial failure.
 *
 * Exit codes:
 *   0 — success (including dry-run)
 *   1 — fatal error (source collection missing, dimension mismatch, partial failure)
 */

import { parseArgs } from 'node:util';
import { QdrantClient } from '@qdrant/js-client-rest';
import { loadConfig } from '../src/config.js';
import type { EmbeddingProvider } from '../src/embeddings.js';
import { createEmbeddingClient } from '../src/embeddings-factory.js';
import { createQdrantClient, initCollection } from '../src/qdrant.js';

// ---------------------------------------------------------------------------
// Named error class (follows MigrationError pattern from migrate-claude-memory)
// ---------------------------------------------------------------------------

export class ReembedError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ReembedError';
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Qdrant scroll pagination cursor (`next_page_offset` / `scroll.offset`). */
type ScrollOffset = string | number | Record<string, unknown> | null | undefined;

export interface ReembedSummary {
  /** Points read from the source collection. */
  scanned: number;
  /** Points re-embedded and upserted into the target. */
  upserted: number;
  /** Points skipped (empty content, or soft-deleted with --skip-deleted). */
  skipped: number;
  errors: { id: string; message: string }[];
}

export interface ReembedDeps {
  source: QdrantClient;
  target: QdrantClient;
  embeddings: Pick<EmbeddingProvider, 'embedBatch'>;
  sourceCollection: string;
  targetCollection: string;
  /** Scroll/embed page size. */
  batchSize: number;
  /** Don't write to the target; just count what would happen. */
  dryRun: boolean;
  /** Skip points whose `deleted_at` payload is non-null (default: copy them). */
  skipDeleted: boolean;
  log?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Core (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Scroll the source collection page-by-page, re-embed each page's `content`,
 * and upsert into the target with the original id + payload. The vector is the
 * ONLY thing regenerated; payload is copied byte-for-byte.
 */
export async function reembedCollection(deps: ReembedDeps): Promise<ReembedSummary> {
  const log = deps.log ?? (() => undefined);
  const summary: ReembedSummary = { scanned: 0, upserted: 0, skipped: 0, errors: [] };

  let offset: ScrollOffset = undefined;

  for (;;) {
    const page = await deps.source.scroll(deps.sourceCollection, {
      limit: deps.batchSize,
      offset: offset ?? undefined,
      with_payload: true,
      with_vector: false,
    });

    const points = page.points ?? [];
    if (points.length === 0 && !page.next_page_offset) break;

    // Select embeddable points; skip empty content and (optionally) tombstones.
    const batch: { id: string | number; payload: Record<string, unknown>; content: string }[] = [];
    for (const p of points) {
      summary.scanned += 1;
      const payload = (p.payload ?? {}) as Record<string, unknown>;
      const id = p.id as string | number;
      const content = typeof payload['content'] === 'string' ? (payload['content'] as string) : '';
      if (deps.skipDeleted && payload['deleted_at'] != null) {
        summary.skipped += 1;
        continue;
      }
      if (content.length === 0) {
        summary.skipped += 1;
        log(`skip (empty content): ${String(id)}`);
        continue;
      }
      batch.push({ id, payload, content });
    }

    if (batch.length > 0) {
      try {
        const vectors = await deps.embeddings.embedBatch(batch.map((b) => b.content));
        if (vectors.length !== batch.length) {
          throw new ReembedError(
            `embedBatch returned ${vectors.length} vectors for ${batch.length} inputs`,
          );
        }
        const upsertPoints = batch.map((b, i) => ({
          id: b.id,
          vector: vectors[i],
          payload: b.payload,
        }));
        if (!deps.dryRun) {
          await deps.target.upsert(deps.targetCollection, {
            wait: true,
            points: upsertPoints,
          });
        }
        summary.upserted += batch.length;
        log(`${deps.dryRun ? '[dry-run] ' : ''}upserted ${batch.length} (total ${summary.upserted})`);
      } catch (err) {
        // A whole-batch failure (e.g. provider/dimension error) is fatal — the
        // dimension guard means a wrong model would silently mis-migrate
        // everything, so we surface it rather than logging per-point.
        throw new ReembedError(
          `Re-embed batch failed near scanned=${summary.scanned}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          err,
        );
      }
    }

    if (!page.next_page_offset) break;
    // Cast to the stable declared union, NOT `typeof offset`: control-flow
    // analysis narrows `typeof offset` to `undefined` at this point (its value on
    // the first loop pass), which would reject the assignment (TS2352).
    offset = page.next_page_offset as ScrollOffset;
  }

  return summary;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
  sourceCollection: string;
  targetCollection: string;
  sourceUrl?: string;
  batchSize: number;
  skipDeleted: boolean;
  dryRun: boolean;
  verbose: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      'source-collection': { type: 'string' },
      'target-collection': { type: 'string' },
      'source-url': { type: 'string' },
      batch: { type: 'string' },
      'skip-deleted': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (!values['source-collection']) {
    throw new ReembedError('--source-collection is required');
  }
  const batchRaw = values['batch'] ? parseInt(values['batch'], 10) : 32;
  const batchSize = Number.isFinite(batchRaw) && batchRaw > 0 ? Math.min(batchRaw, 256) : 32;

  return {
    sourceCollection: values['source-collection'],
    targetCollection: values['target-collection'] ?? '',
    sourceUrl: values['source-url'],
    batchSize,
    skipDeleted: values['skip-deleted'] ?? false,
    dryRun: values['dry-run'] ?? false,
    verbose: values['verbose'] ?? false,
  };
}

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const config = loadConfig();

  const targetCollection = cli.targetCollection || config.qdrant.collectionName;
  if (cli.sourceCollection === targetCollection && !cli.sourceUrl) {
    throw new ReembedError(
      'Source and target collection are the same on the same Qdrant instance — ' +
        'this would re-embed in place and is almost certainly a mistake. ' +
        'Restore the old data into a separate collection (e.g. agent_memories_src) first.',
    );
  }

  const target = createQdrantClient(config);
  const source = cli.sourceUrl
    ? new QdrantClient({ url: cli.sourceUrl, apiKey: config.qdrant.apiKey })
    : target;

  const embeddings = createEmbeddingClient(config);

  const log = (msg: string): void => {
    if (cli.verbose) process.stdout.write(`${msg}\n`);
  };

  process.stdout.write(
    `Re-embed: ${cli.sourceCollection}${cli.sourceUrl ? ` @ ${cli.sourceUrl}` : ''} → ` +
      `${targetCollection} @ ${config.qdrant.url}\n` +
      `  model=${config.embeddings.model} dim=${config.embeddings.embeddingDimension} ` +
      `batch=${cli.batchSize} skipDeleted=${cli.skipDeleted} dryRun=${cli.dryRun}\n`,
  );

  // Fail loud if the source collection is missing.
  const sourceCollections = await source.getCollections();
  if (!sourceCollections.collections.some((c) => c.name === cli.sourceCollection)) {
    throw new ReembedError(`Source collection "${cli.sourceCollection}" not found`);
  }

  // Ensure the target collection exists with the configured (new) dimension +
  // quantization. Idempotent; throws QdrantSchemaMismatchError on dim conflict.
  if (!cli.dryRun) {
    await initCollection(target, targetCollection, {
      dimension: config.embeddings.embeddingDimension,
      quantization: config.qdrant.quantization,
    });
  }

  const summary = await reembedCollection({
    source,
    target,
    embeddings,
    sourceCollection: cli.sourceCollection,
    targetCollection,
    batchSize: cli.batchSize,
    dryRun: cli.dryRun,
    skipDeleted: cli.skipDeleted,
    log,
  });

  process.stdout.write(
    `\nDone${cli.dryRun ? ' (dry-run)' : ''}: scanned=${summary.scanned} ` +
      `upserted=${summary.upserted} skipped=${summary.skipped} errors=${summary.errors.length}\n`,
  );
  if (summary.errors.length > 0) {
    for (const e of summary.errors) process.stderr.write(`  error ${e.id}: ${e.message}\n`);
    process.exitCode = 1;
  }
}

// Only run main when invoked directly (not when imported by tests).
const invokedDirectly =
  typeof process.argv[1] === 'string' && process.argv[1].endsWith('reembed-collection.ts');
if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(`\nFATAL: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
