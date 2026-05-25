import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { QdrantClient } from '@qdrant/js-client-rest';
import { z } from 'zod';
import type { EmbeddingClient } from './embeddings.js';
import type { Config } from './config.js';
import type { MemoryRecord, SearchResult } from './types.js';

interface ToolDeps {
  qdrant: QdrantClient;
  embeddings: EmbeddingClient;
  config: Config;
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { qdrant, embeddings, config } = deps;
  const collection = config.qdrant.collectionName;

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
              namespace: input.namespace,
              agent_id: '', // set by auth layer
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
      const vector = await embeddings.embed(input.query);

      const must: Array<Record<string, unknown>> = [
        { key: 'namespace', match: { value: input.namespace } },
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
    'Retrieve a specific memory by ID.',
    {
      id: z.string().uuid().describe('Memory ID'),
    },
    async (input) => {
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

      const memory = payloadToMemory(
        points[0].id as string,
        points[0].payload as Record<string, unknown>,
      );
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(memory, null, 2) },
        ],
      };
    },
  );

  server.tool(
    'delete_memory',
    'Delete a memory by ID.',
    {
      id: z.string().uuid().describe('Memory ID to delete'),
    },
    async (input) => {
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
