import { open } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { auditPathForDataDir } from '../../../auth/audit.js';
import type { PreHandler } from '../app.js';

export interface AuditAdminRoutesDeps {
  dataDir: string;
  requireAuth: PreHandler;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
/**
 * Cap how much of the (append-only, unbounded) audit log we ever read into
 * memory. We only need the newest entries, so we read at most this many bytes
 * from the END of the file — bounding memory regardless of total log size.
 */
const TAIL_READ_BYTES = 1024 * 1024; // 1 MiB

/**
 * Read-only operator view over the auth audit log (ADR-0008 BFF, #68). The log is
 * a single append-only JSONL file (`_auth/audit.jsonl`); this returns the most
 * recent entries, newest first, optionally filtered by event.
 *
 * Bounded tail read: at most the last 1 MiB of the file is loaded, so a log that
 * grows without bound can't exhaust memory. `truncated` signals that older
 * entries exist beyond the read window. A rotating/indexed reader is a
 * post-launch concern.
 */
export function registerAuditAdminRoutes(app: FastifyInstance, deps: AuditAdminRoutesDeps): void {
  const { dataDir, requireAuth } = deps;

  app.get<{ Querystring: { limit?: string; event?: string } }>(
    '/api/admin/audit',
    { preHandler: requireAuth },
    async (req, reply) => {
      const rawLimit = req.query.limit ? Number(req.query.limit) : DEFAULT_LIMIT;
      if (!Number.isFinite(rawLimit) || rawLimit < 1) {
        return reply.code(400).send({ error: 'invalid_input', field: 'limit' });
      }
      const limit = Math.min(Math.floor(rawLimit), MAX_LIMIT);

      const tail = await readTail(auditPathForDataDir(dataDir));
      if (tail === null) return { entries: [], count: 0, truncated: false };

      const lines = tail.text.split('\n');
      // If we started mid-file, the first line is probably a partial record — drop it.
      if (tail.truncated && lines.length > 0) lines.shift();

      const entries: Array<Record<string, unknown>> = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (req.query.event && parsed['event'] !== req.query.event) continue;
          entries.push(parsed);
        } catch {
          // Skip a malformed line rather than failing the whole view.
        }
      }

      // Newest first, capped.
      const recent = entries.slice(-limit).reverse();
      return { entries: recent, count: entries.length, truncated: tail.truncated };
    },
  );
}

/** Read at most the last TAIL_READ_BYTES of a file. Returns null if it doesn't exist. */
async function readTail(path: string): Promise<{ text: string; truncated: boolean } | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_READ_BYTES);
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    await handle.read(buf, 0, length, start);
    return { text: buf.toString('utf8'), truncated: start > 0 };
  } finally {
    await handle.close();
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
