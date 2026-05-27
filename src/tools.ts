import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { QdrantClient } from '@qdrant/js-client-rest';
import { z } from 'zod';
import { AuthAuditWriter } from './auth/audit.js';
import { authorizeNamespaceAccess } from './auth/resolve-request.js';
import { AuthError, type RequestContext } from './auth/request-context.js';
import type { AgentPat, AgentScope } from './auth/types.js';
import type { Config } from './config.js';
import type { EmbeddingClient } from './embeddings.js';
import type { MemoryRecord, SearchResult } from './types.js';

interface ToolDeps {
  qdrant: QdrantClient;
  embeddings: EmbeddingClient;
  config: Config;
  sessionPat: AgentPat;
  auditor: AuthAuditWriter;
  dataDir: string;
}

interface AuthDecision {
  ctx: RequestContext | null;
  error: AuthError | null;
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { qdrant, embeddings, config, sessionPat, auditor, dataDir } = deps;
  const collection = config.qdrant.collectionName;

  async function authorize(
    toolName: string,
    namespace: string,
    requiredScope: AgentScope,
  ): Promise<AuthDecision> {
    try {
      const ctx = await authorizeNamespaceAccess({
        pat: sessionPat,
        requestedNamespace: namespace,
        requiredScope,
        dataDir,
      });
      await auditor.record('auth.success', {
        agent_identity: ctx.agentId,
        namespace: ctx.namespaceId,
        scope: requiredScope,
        tool_or_resource: toolName,
        pat_id: ctx.patId,
      });
      return { ctx, error: null };
    } catch (err) {
      if (err instanceof AuthError) {
        await auditor.record('auth.failure', {
          reason: err.reason,
          token_prefix: err.tokenPrefix,
          tool_or_resource: toolName,
          requested_namespace: namespace,
          required_scope: requiredScope,
          ...err.details,
        });
        return { ctx: null, error: err };
      }
      throw err;
    }
  }

  function authErrorResponse(err: AuthError) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: err.reason,
            message: err.message,
          }),
        },
      ],
      isError: true,
    };
  }

  server.tool(
    'store_memory',
    'Store a memory in the shared agent memory. Returns the memory ID.',
    {
      namespace: z.string().describe('Namespace to scope this memory'),
      content: z.string().max(32_000).describe('Memory content text'),
      summary: z.string().optional().describe('Brief summary of the memory'),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Arbitrary metadata'),
      tags: z
        .array(z.string())
        .max(20)
        .optional()
        .describe('Tags for filtering'),
      source: z.string().optional().describe('Origin of this memory'),
      id: z
        .string()
        .uuid()
        .optional()
        .describe('Optional caller-supplied ID for idempotent upsert'),
    },
    async (input) => {
      const { ctx, error } = await authorize('store_memory', input.namespace, 'memory:write');
      if (!ctx) return authErrorResponse(error!);

      const id = input.id ?? randomUUID();
      const now = new Date().toISOString();
      const vector = await embeddings.embed(input.content);

      await qdrant.upsert(collection, {
        wait: true,
        points: [
          {
            id,
            vector,
            payload: {
              namespace: ctx.namespaceId,
              agent_id: ctx.agentId,
              content: input.content,
              summary: input.summary ?? '',
              metadata: input.metadata ?? {},
              tags: input.tags ?? [],
              source: input.source ?? '',
              created_at: now,
              updated_at: now,
            },
          },
        ],
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ id }) }],
      };
    },
  );

  server.tool(
    'search_memory',
    'Search shared memory by semantic similarity with optional filters.',
    {
      namespace: z.string().describe('Namespace to search in'),
      query: z.string().describe('Search query text'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe('Max results'),
      tags: z
        .array(z.string())
        .optional()
        .describe('Filter by tags (AND match)'),
    },
    async (input) => {
      const { ctx, error } = await authorize('search_memory', input.namespace, 'memory:read');
      if (!ctx) return authErrorResponse(error!);

      const vector = await embeddings.embed(input.query);

      const must: Array<Record<string, unknown>> = [
        { key: 'namespace', match: { value: ctx.namespaceId } },
      ];

      if (input.tags && input.tags.length > 0) {
        for (const tag of input.tags) {
          must.push({ key: 'tags', match: { value: tag } });
        }
      }

      const results = await qdrant.search(collection, {
        vector,
        limit: input.limit ?? 10,
        filter: { must },
        with_payload: true,
      });

      const memories: SearchResult[] = results.map((r) => ({
        memory: payloadToMemory(r.id as string, r.payload as Record<string, unknown>),
        score: r.score,
      }));

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(memories, null, 2) },
        ],
      };
    },
  );

  server.tool(
    'get_memory',
    'Retrieve a specific memory by ID within a namespace.',
    {
      namespace: z.string().describe('Namespace the memory belongs to'),
      id: z.string().uuid().describe('Memory ID'),
    },
    async (input) => {
      const { ctx, error } = await authorize('get_memory', input.namespace, 'memory:read');
      if (!ctx) return authErrorResponse(error!);

      const points = await qdrant.retrieve(collection, {
        ids: [input.id],
        with_payload: true,
      });

      if (points.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ error: 'not_found' }) },
          ],
          isError: true,
        };
      }

      const payload = points[0].payload as Record<string, unknown>;
      if (payload['namespace'] !== ctx.namespaceId) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ error: 'not_found' }) },
          ],
          isError: true,
        };
      }

      const memory = payloadToMemory(points[0].id as string, payload);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(memory, null, 2) },
        ],
      };
    },
  );

  server.tool(
    'delete_memory',
    'Delete a memory by ID within a namespace.',
    {
      namespace: z.string().describe('Namespace the memory belongs to'),
      id: z.string().uuid().describe('Memory ID to delete'),
    },
    async (input) => {
      const { ctx, error } = await authorize('delete_memory', input.namespace, 'memory:delete');
      if (!ctx) return authErrorResponse(error!);

      const points = await qdrant.retrieve(collection, {
        ids: [input.id],
        with_payload: true,
      });

      if (points.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ error: 'not_found' }) },
          ],
          isError: true,
        };
      }

      const payload = points[0].payload as Record<string, unknown>;
      if (payload['namespace'] !== ctx.namespaceId) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ error: 'not_found' }) },
          ],
          isError: true,
        };
      }

      await qdrant.delete(collection, {
        wait: true,
        points: [input.id],
      });

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ deleted: true }) },
        ],
      };
    },
  );
}

function payloadToMemory(
  id: string,
  payload: Record<string, unknown>,
): MemoryRecord {
  return {
    id,
    namespace: payload['namespace'] as string,
    agentId: payload['agent_id'] as string,
    content: payload['content'] as string,
    summary: (payload['summary'] as string) || undefined,
    metadata: payload['metadata'] as Record<string, unknown> | undefined,
    tags: (payload['tags'] as string[]) ?? [],
    source: (payload['source'] as string) || undefined,
    createdAt: payload['created_at'] as string,
    updatedAt: payload['updated_at'] as string,
  };
}
