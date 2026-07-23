import { once } from 'node:events';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AuthAuditWriter } from '../../../auth/audit.js';
import {
  exportNamespaceLines,
  type ExportItem,
  type ExportManifest,
} from '../../../memory/export.js';
import type { MemoryService } from '../../../memory/service.js';
import { isValidNamespaceId, loadNamespace } from '../../../namespaces/store.js';
import type { PreHandler } from '../app.js';
import { view } from './memories.js';

export interface ExportAdminRoutesDeps {
  memoryService: MemoryService;
  /** Engine data dir — used to load the namespace config (manifest) and 404 unknown ids. */
  dataDir: string;
  requireAuth: PreHandler;
  /** Shared auth auditor — records the `namespace.exported` receipt after the stream. */
  auditor: AuthAuditWriter;
  /** Injected clock for the export timestamp (manifest + filename). Defaults to wall clock. */
  now?: () => Date;
}

/**
 * Operator-only per-namespace data export ("download my memory", FEAT-1 #111).
 *
 * `GET /api/admin/namespaces/:id/export?format=ndjson&include_deleted=false`
 *
 * Streams the namespace's live records (soft-deleted excluded unless opted in)
 * as NDJSON — a manifest line then one line per record — paging through
 * `memoryService.list()` so it stays memory-bounded for large namespaces. A
 * `format=json` convenience emits a single `{"manifest":{…},"memories":[…]}`
 * object, stitched from the same page loop (still streamed, never buffered).
 * GET → no CSRF; rate-limited like the semantic-search route (expensive scan).
 */
export function registerExportAdminRoutes(
  app: FastifyInstance,
  deps: ExportAdminRoutesDeps,
): void {
  const { memoryService, dataDir, requireAuth, auditor } = deps;
  const now = deps.now ?? (() => new Date());

  app.get<{ Params: { id: string }; Querystring: { format?: string; include_deleted?: string } }>(
    '/api/admin/namespaces/:id/export',
    // Full-namespace scroll over Qdrant — throttle so a session can't DoS it.
    { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id } = req.params;
      // Validate before touching the filesystem — an unchecked id with encoded
      // slashes / `..` could otherwise escape dataDir/namespaces/.
      if (!isValidNamespaceId(id)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const namespace = await loadNamespace(dataDir, id);
      if (!namespace) {
        return reply.code(404).send({ error: 'not_found' });
      }

      const format = req.query.format === 'json' ? 'json' : 'ndjson';
      const includeDeleted = req.query.include_deleted === 'true';
      const stamp = now();
      const manifest: ExportManifest = {
        namespace,
        exported_at: stamp.toISOString(),
        exported_by: `operator:${req.principal!.operatorId}`,
        include_deleted: includeDeleted,
        schema_version: 1,
      };

      const filename = `${id}-export-${stamp.getTime()}.${format === 'json' ? 'json' : 'ndjson'}`;
      const contentType = format === 'json' ? 'application/json' : 'application/x-ndjson';

      // Take over the socket: we write the stream ourselves so we can page
      // through Qdrant while respecting backpressure (memory-bounded for 100k
      // records) and audit the final record_count once the body is flushed.
      reply.hijack();
      reply.raw.setHeader('Content-Type', contentType);
      reply.raw.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      const items = exportNamespaceLines(memoryService, id, {
        includeDeleted,
        manifest,
        project: view,
      });

      let recordCount = 0;
      try {
        recordCount =
          format === 'json' ? await writeJson(reply, items) : await writeNdjson(reply, items);
      } catch {
        // Headers/body already committed — we cannot switch to a JSON error, so
        // tear the socket down; the client sees a truncated (invalid) download.
        reply.raw.destroy();
        return reply;
      }

      // The full body is written; record the receipt BEFORE closing the socket so
      // the export is auditable even under a caller that disconnects on `end`. A
      // failed audit is best-effort — it must not corrupt an otherwise-complete
      // download.
      try {
        await auditor.record('namespace.exported', {
          namespace_id: id,
          exported_by: manifest.exported_by,
          record_count: recordCount,
          include_deleted: includeDeleted,
        });
      } catch {
        // best-effort audit
      }
      reply.raw.end();
      return reply;
    },
  );
}

/** Write `chunk` respecting backpressure — resolve once the buffer can take more. */
async function writeChunk(reply: FastifyReply, chunk: string): Promise<void> {
  if (!reply.raw.write(chunk)) {
    await once(reply.raw, 'drain');
  }
}

/** NDJSON: manifest line, then one `{"type":"memory",…}` line per record. */
async function writeNdjson(
  reply: FastifyReply,
  items: AsyncGenerator<ExportItem>,
): Promise<number> {
  let count = 0;
  for await (const item of items) {
    if (item.kind === 'memory') count++;
    await writeChunk(reply, `${JSON.stringify({ type: item.kind, ...item.data })}\n`);
  }
  return count;
}

/**
 * JSON convenience: `{"manifest":{…},"memories":[…]}`. Chosen over a top-level
 * array because it is self-describing (the manifest is not masquerading as a
 * record) and still a single `JSON.parse`. Stitched by hand from the same page
 * loop so it stays streamed rather than buffering the whole array.
 */
async function writeJson(
  reply: FastifyReply,
  items: AsyncGenerator<ExportItem>,
): Promise<number> {
  let count = 0;
  let firstMemory = true;
  for await (const item of items) {
    if (item.kind === 'manifest') {
      await writeChunk(reply, `{"manifest":${JSON.stringify(item.data)},"memories":[`);
    } else {
      count++;
      await writeChunk(reply, `${firstMemory ? '' : ','}${JSON.stringify(item.data)}`);
      firstMemory = false;
    }
  }
  await writeChunk(reply, ']}');
  return count;
}
