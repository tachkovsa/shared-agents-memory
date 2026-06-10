import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthAuditWriter } from '../auth/audit.js';
import { AuthError, type RequestContext } from '../auth/request-context.js';
import { authorizeNamespaceAccess } from '../auth/resolve-request.js';
import type { AgentPat, AgentScope } from '../auth/types.js';
import { quotaRejectionsTotal } from '../metrics/registry.js';
import { loadNamespace } from '../namespaces/store.js';
import { QuotaExceededError, type QuotaService } from '../quota/quota-service.js';
import type { ReinforcementBuffer } from './reinforcement.js';
import { MemoryNotFoundError, MemoryService, MemoryValidationError } from './service.js';
import { MEMORY_MAX_CONTENT_LENGTH, MEMORY_MAX_TAGS } from './types.js';

export interface MemoryToolDeps {
  service: MemoryService;
  sessionPat: AgentPat;
  auditor: AuthAuditWriter;
  dataDir: string;
  /** Shared reinforcement buffer; get/search hits bump retrieval_count (ADR-0006 §3.3). */
  reinforcement?: ReinforcementBuffer;
  /**
   * Optional quota enforcement service (issue #59).
   * When omitted, quota enforcement is skipped — existing tests that do not
   * supply this dep continue to pass unchanged.
   */
  quota?: QuotaService;
  /**
   * Optional helper to count how many memories currently exist in a namespace.
   * Used by `memory_store` to enforce `max_memories`.  When omitted, the
   * max_memories limit is not checked (safe default for tests).
   */
  countNamespaceMemories?: (namespace: string) => Promise<number>;
}

interface AuthDecision {
  ctx: RequestContext | null;
  error: AuthError | null;
}

function jsonResponse(payload: unknown, isError = false) {
  const result: {
    content: { type: 'text'; text: string }[];
    isError?: boolean;
  } = {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
  if (isError) result.isError = true;
  return result;
}

function authErrorResponse(err: AuthError) {
  return jsonResponse({ error: err.reason, message: err.message }, true);
}

function notFoundResponse(namespaceId: string, memoryId: string) {
  return jsonResponse(
    { error: 'not_found', namespace: namespaceId, id: memoryId },
    true,
  );
}

function validationErrorResponse(err: MemoryValidationError) {
  return jsonResponse(
    { error: 'validation_failed', field: err.field, message: err.message },
    true,
  );
}

export function registerMemoryTools(server: McpServer, deps: MemoryToolDeps): void {
  const { service, sessionPat, auditor, dataDir, reinforcement, quota, countNamespaceMemories } = deps;

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

  server.tool(
    'memory_store',
    'Store an episodic memory in the shared agent memory. Returns the stored memory record.',
    {
      namespace: z.string().describe('Namespace to scope this memory'),
      content: z
        .string()
        .min(1)
        .max(MEMORY_MAX_CONTENT_LENGTH)
        .describe('Memory content text'),
      summary: z.string().optional().describe('Brief summary of the memory'),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Arbitrary metadata'),
      tags: z
        .array(z.string())
        .max(MEMORY_MAX_TAGS)
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
      const { ctx, error } = await authorize('memory_store', input.namespace, 'memory:write');
      if (!ctx) return authErrorResponse(error!);

      // ── Quota check (issue #59) ────────────────────────────────────────────
      if (quota) {
        const ns = await loadNamespace(dataDir, ctx.namespaceId);
        const nsQuota = ns?.quota;
        if (nsQuota) {
          const estimatedTokens = Math.ceil(input.content.length / 4);
          const currentCount = countNamespaceMemories
            ? await countNamespaceMemories(ctx.namespaceId)
            : undefined;
          try {
            await quota.check(ctx.namespaceId, 'write', {
              quota: nsQuota,
              estimatedTokens,
              currentCount,
            });
          } catch (err) {
            if (err instanceof QuotaExceededError) {
              quotaRejectionsTotal.inc({ limit: err.limit });
              return jsonResponse(
                { error: 'quota_exceeded', limit: err.limit, used: err.used, cap: err.cap },
                true,
              );
            }
            throw err;
          }
        }
      }

      try {
        const estimatedTokens = Math.ceil(input.content.length / 4);
        const { record, outcome, matchedExistingId } = await service.store({
          namespace: ctx.namespaceId,
          agentId: ctx.agentId,
          content: input.content,
          summary: input.summary,
          metadata: input.metadata,
          tags: input.tags,
          source: input.source,
          id: input.id,
        });

        // Record usage after successful store.
        if (quota) {
          await quota.record(ctx.namespaceId, 'write', { estimatedTokens });
        }

        return jsonResponse({
          id: record.id,
          outcome,
          matched_existing_id: matchedExistingId,
          created_at: record.createdAt,
        });
      } catch (err) {
        if (err instanceof MemoryValidationError) return validationErrorResponse(err);
        throw err;
      }
    },
  );

  server.tool(
    'memory_search',
    'Search shared episodic memory by semantic similarity with optional tag filters.',
    {
      namespace: z.string().describe('Namespace to search in'),
      query: z.string().min(1).describe('Search query text'),
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
      const { ctx, error } = await authorize('memory_search', input.namespace, 'memory:read');
      if (!ctx) return authErrorResponse(error!);

      // ── Quota check (issue #59) ────────────────────────────────────────────
      if (quota) {
        const ns = await loadNamespace(dataDir, ctx.namespaceId);
        const nsQuota = ns?.quota;
        if (nsQuota) {
          const estimatedTokens = Math.ceil(input.query.length / 4);
          try {
            await quota.check(ctx.namespaceId, 'search', {
              quota: nsQuota,
              estimatedTokens,
            });
          } catch (err) {
            if (err instanceof QuotaExceededError) {
              quotaRejectionsTotal.inc({ limit: err.limit });
              return jsonResponse(
                { error: 'quota_exceeded', limit: err.limit, used: err.used, cap: err.cap },
                true,
              );
            }
            throw err;
          }
        }
      }

      const estimatedTokens = Math.ceil(input.query.length / 4);
      const results = await service.search({
        namespace: ctx.namespaceId,
        query: input.query,
        limit: input.limit ?? 10,
        tags: input.tags,
      });

      // Record usage after successful search.
      if (quota) {
        await quota.record(ctx.namespaceId, 'search', { estimatedTokens });
      }

      for (const result of results) {
        reinforcement?.record(result.memory.id);
      }

      return jsonResponse(results);
    },
  );

  server.tool(
    'memory_get',
    'Retrieve a specific episodic memory by ID within a namespace.',
    {
      namespace: z.string().describe('Namespace the memory belongs to'),
      id: z.string().uuid().describe('Memory ID'),
    },
    async (input) => {
      const { ctx, error } = await authorize('memory_get', input.namespace, 'memory:read');
      if (!ctx) return authErrorResponse(error!);

      try {
        const memory = await service.get({ namespace: ctx.namespaceId, id: input.id });
        reinforcement?.record(memory.id);
        return jsonResponse(memory);
      } catch (err) {
        if (err instanceof MemoryNotFoundError) {
          return notFoundResponse(err.namespaceId, err.memoryId);
        }
        throw err;
      }
    },
  );

  server.tool(
    'memory_update_metadata',
    'Update an existing episodic memory\'s metadata, tags, summary, or source without re-embedding the content.',
    {
      namespace: z.string().describe('Namespace the memory belongs to'),
      id: z.string().uuid().describe('Memory ID'),
      summary: z.string().optional().describe('New summary (omit to leave unchanged)'),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('New metadata (replaces the existing object; omit to leave unchanged)'),
      tags: z
        .array(z.string())
        .max(MEMORY_MAX_TAGS)
        .optional()
        .describe('New tags (replaces existing tags; omit to leave unchanged)'),
      source: z.string().optional().describe('New source (omit to leave unchanged)'),
    },
    async (input) => {
      const { ctx, error } = await authorize(
        'memory_update_metadata',
        input.namespace,
        'memory:write',
      );
      if (!ctx) return authErrorResponse(error!);

      try {
        const updated = await service.updateMetadata({
          namespace: ctx.namespaceId,
          id: input.id,
          summary: input.summary,
          metadata: input.metadata,
          tags: input.tags,
          source: input.source,
        });
        return jsonResponse(updated);
      } catch (err) {
        if (err instanceof MemoryNotFoundError) {
          return notFoundResponse(err.namespaceId, err.memoryId);
        }
        if (err instanceof MemoryValidationError) return validationErrorResponse(err);
        throw err;
      }
    },
  );

  server.tool(
    'memory_delete',
    'Delete an episodic memory by ID within a namespace.',
    {
      namespace: z.string().describe('Namespace the memory belongs to'),
      id: z.string().uuid().describe('Memory ID to delete'),
    },
    async (input) => {
      const { ctx, error } = await authorize('memory_delete', input.namespace, 'memory:delete');
      if (!ctx) return authErrorResponse(error!);

      try {
        await service.delete({ namespace: ctx.namespaceId, id: input.id });
        return jsonResponse({ deleted: true, id: input.id });
      } catch (err) {
        if (err instanceof MemoryNotFoundError) {
          return notFoundResponse(err.namespaceId, err.memoryId);
        }
        throw err;
      }
    },
  );
}
