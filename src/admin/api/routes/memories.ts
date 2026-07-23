import type { FastifyInstance } from 'fastify';
import { MemoryNotFoundError, MemoryValidationError, type MemoryService } from '../../../memory/service.js';
import type { MemoryRecord } from '../../../memory/types.js';
import { isValidNamespaceId, loadNamespace } from '../../../namespaces/store.js';
import { searchMemoryQuerySchema, writeMemorySchema } from '../../shared/schemas.js';
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
    // Validate before touching the filesystem — an unchecked id with encoded
    // slashes / `..` could otherwise escape dataDir/namespaces/.
    if (!isValidNamespaceId(id)) return false;
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
        // Coerce to string: Fastify's query parser can yield arrays/objects
        // (?cursor=a&cursor=b, ?cursor[x]=y) which must not reach Qdrant raw.
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
        includeDeleted: req.query.include_deleted === 'true',
      });
      return { memories: memories.map(view), next_cursor: nextCursor };
    },
  );

  // Semantic search (Qdrant vector search; replaces the prototype's client-side ranking).
  app.get<{ Params: { id: string }; Querystring: { q?: string; limit?: string } }>(
    '/api/admin/namespaces/:id/memories/search',
    // Embeddings + Qdrant per call — throttle so a compromised session can't DoS them.
    { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!(await namespaceExists(req.params.id))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const parsed = searchMemoryQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.issues });
      }
      const started = Date.now();
      const hits = await memoryService.search({
        namespace: req.params.id,
        query: parsed.data.q,
        limit: parsed.data.limit ?? 20,
      });
      return {
        results: hits.map((h) => ({ ...view(h.memory), score: h.score })),
        latency_ms: Date.now() - started,
      };
    },
  );

  // Operator write — useful for seeding/correcting; agents normally write via MCP.
  app.post<{ Params: { id: string } }>(
    '/api/admin/namespaces/:id/memories',
    // Embedding + dedup search on every write — throttle per session.
    { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!(await namespaceExists(req.params.id))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const parsed = writeMemorySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.issues });
      }
      try {
        const result = await memoryService.store({
          namespace: req.params.id,
          agentId: parsed.data.agent_id,
          content: parsed.data.content,
          tags: parsed.data.tags,
          summary: parsed.data.summary,
          source: parsed.data.source,
        });
        return reply.code(201).send(view(result.record));
      } catch (err) {
        if (err instanceof MemoryValidationError) {
          return reply.code(400).send({ error: 'invalid_input', field: err.field });
        }
        throw err;
      }
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

/**
 * Operator-facing projection of a memory record (no secrets in episodic memory).
 * Exported so the namespace-export route emits the exact same field set as the
 * console memory browser (no divergent projection, no leaked internals).
 */
export function view(m: MemoryRecord) {
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
