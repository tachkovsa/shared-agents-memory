import { readFile } from 'node:fs/promises';
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
 * Read-only operator view over the auth audit log (ADR-0008 BFF, #68). The log is
 * a single append-only JSONL file (`_auth/audit.jsonl`); this returns the most
 * recent entries, newest first, optionally filtered by event.
 *
 * v1 reads the whole file then tails in memory — fine at single-box launch scale;
 * a rotating/indexed reader is a post-launch concern.
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

      let raw: string;
      try {
        raw = await readFile(auditPathForDataDir(dataDir), 'utf8');
      } catch (err) {
        if (isEnoent(err)) return { entries: [], total: 0 };
        throw err;
      }

      const entries: Array<Record<string, unknown>> = [];
      for (const line of raw.split('\n')) {
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
      return { entries: recent, total: entries.length };
    },
  );
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
