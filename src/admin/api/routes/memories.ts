import type { FastifyInstance } from 'fastify';
import { MemoryNotFoundError, type MemoryService } from '../../../memory/service.js';
import type { MemoryRecord } from '../../../memory/types.js';
import { loadNamespace } from '../../../namespaces/store.js';
import type { PreHandler } from '../app.js';

export interface MemoryAdminRoutesDeps {
  memoryService: MemoryService;
  /** Engine data dir — used only to 404 unknown namespaces. */
  dataDir: string;
  requireAuth: PreHandler;
}

/**
 * Operator-facing episodic memory browser (ADR-0008 BFF, #67). Read + delete only
 * — no store/search (agents own writes via the MCP path). Scoped per namespace;
 * an authenticated operator (instance admin) sees every namespace.
 */
export function registerMemoryAdminRoutes(
  app: FastifyInstance,
  deps: MemoryAdminRoutesDeps,
): void {
  const { memoryService, dataDir, requireAuth } = deps;

  async function namespaceExists(id: string): Promise<boolean> {
    return (await loadNamespace(dataDir, id)) !== null;
  }

  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string; include_deleted?: string } }>(
    '/api/admin/namespaces/:id/memories',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!(await namespaceExists(req.params.id))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      if (limit !== undefined && !Number.isFinite(limit)) {
        return reply.code(400).send({ error: 'invalid_input', field: 'limit' });
      }
      const { memories, nextCursor } = await memoryService.list({
        namespace: req.params.id,
        limit,
        cursor: req.query.cursor,
        includeDeleted: req.query.include_deleted === 'true',
      });
      return { memories: memories.map(view), next_cursor: nextCursor };
    },
  );

  app.get<{ Params: { id: string; memId: string } }>(
    '/api/admin/namespaces/:id/memories/:memId',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const memory = await memoryService.get({
          namespace: req.params.id,
          id: req.params.memId,
          includeDeleted: true,
        });
        return view(memory);
      } catch (err) {
        if (err instanceof MemoryNotFoundError) {
          return reply.code(404).send({ error: 'not_found' });
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string; memId: string } }>(
    '/api/admin/namespaces/:id/memories/:memId',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        // Operator purge: also removes soft-deleted tombstones the browser shows.
        await memoryService.delete({
          namespace: req.params.id,
          id: req.params.memId,
          includeDeleted: true,
        });
        return { deleted: true, id: req.params.memId };
      } catch (err) {
        if (err instanceof MemoryNotFoundError) {
          return reply.code(404).send({ error: 'not_found' });
        }
        throw err;
      }
    },
  );
}

/** Operator-facing projection of a memory record (no secrets in episodic memory). */
function view(m: MemoryRecord) {
  return {
    id: m.id,
    namespace: m.namespace,
    agent_id: m.agentId,
    content: m.content,
    summary: m.summary ?? null,
    tags: m.tags,
    source: m.source ?? null,
    metadata: m.metadata ?? {},
    created_at: m.createdAt,
    updated_at: m.updatedAt,
    retrieval_count: m.retrievalCount,
    last_retrieved_at: m.lastRetrievedAt,
    decay_score: m.decayScore,
    superseded_by: m.supersededBy,
    deleted_at: m.deletedAt,
    staleness_signal: m.stalenessSignal,
    verifies_against: m.verifiesAgainst,
  };
}
