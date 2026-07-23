import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { purgeNamespaceVectors, type NamespaceVectorPurger } from './vector-cascade.js';
import type { AuthAuditWriter } from '../auth/audit.js';
import {
  canonicalJsonHash,
  ConsumedConfirmations,
  DEFAULT_CONFIRMATION_TTL_MS,
  makeConfirmation,
  verifyConfirmation,
} from '../auth/confirmation.js';
import type { PatStore } from '../auth/pat-store.js';
import { AuthError } from '../auth/request-context.js';
import { authorizeNamespaceAccess, authorizeServiceAccess } from '../auth/resolve-request.js';
import { ALL_SCOPES, type AgentPat, type AgentScope } from '../auth/types.js';
import { DEDUP_DISABLED_THRESHOLD, DEDUP_MIN_THRESHOLD } from '../memory/index.js';
import {
  createNamespaceSkeleton,
  listNamespaceIds,
  loadMembers,
  loadNamespace,
  namespaceIdSchema as sharedNamespaceIdSchema,
  NamespaceExistsError,
  NamespaceNotFoundError,
  pruneOrphanedMembers,
  saveMembers,
  saveNamespace,
  softDeleteNamespace,
  withMembersLock,
} from './store.js';
import type { NamespaceQuota, RetentionPolicy } from './types.js';
import { BOOTSTRAP_NAMESPACE_ID } from './types.js';

export interface NamespaceToolDeps {
  patStore: PatStore;
  sessionPat: AgentPat;
  auditor: AuthAuditWriter;
  sessionId: string;
  pepper: Buffer;
  dataDir: string;
  /**
   * Qdrant client + collection so `namespace_delete` can cascade a
   * namespace-filtered vector purge (issue #102). Threaded from the same
   * composition root that builds MemoryService; kept to the minimal `delete`
   * surface so tests can stub it.
   */
  qdrant: NamespaceVectorPurger;
  collection: string;
  consumed?: ConsumedConfirmations;
  confirmationTtlMs?: number;
  now?: () => Date;
}

// Reuse the single canonical namespace-id validator (SEC-9 / N3, #110); the
// kebab-case regex lives once in ../namespaces/store.ts.
const namespaceIdSchema = sharedNamespaceIdSchema.describe(
  'Kebab-case namespace ID, e.g. "personal" or "team-alpha"',
);

const retentionSchema = z
  .enum(['keep-forever', 'decay-90d', 'decay-180d', 'decay-365d'] as const)
  .describe('Retention policy for memories in this namespace (ADR-0006 §3.7)');

const dedupThresholdSchema = z
  .number()
  .refine(
    (v) =>
      v === DEDUP_DISABLED_THRESHOLD ||
      (v >= DEDUP_MIN_THRESHOLD && v < DEDUP_DISABLED_THRESHOLD),
    `dedup_threshold must be in [${DEDUP_MIN_THRESHOLD}, ${DEDUP_DISABLED_THRESHOLD}) or exactly ${DEDUP_DISABLED_THRESHOLD} to disable dedup`,
  )
  .describe('Semantic dedup threshold (ADR-0006 §3.2); [0.85, 0.99] or 1.0 to disable');

const lifecycleSchema = z
  .object({
    decay_weight: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Blend of cosine vs decay at search re-rank, [0,1] (ADR-0006 §3.4)'),
    soft_delete_after_days: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe('Days untouched before an unretrieved point is soft-deleted; null = rank-only (§3.4)'),
    hard_delete_grace_days: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Days a soft-deleted point is kept before physical removal (§3.4)'),
    staleness_audit_enabled: z
      .boolean()
      .optional()
      .describe('Whether the nightly staleness audit sweeps this namespace (§3.6)'),
    staleness_audit_batch_size: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Max points the staleness audit checks per sweep (§3.6)'),
    filesystem_audit_root: z
      .string()
      .nullable()
      .optional()
      .describe('Read-only repo root for verifies_against.kind=file audits; null disables (§3.6)'),
  })
  .describe('Lifecycle policy override for this namespace (ADR-0006 §3.4/§3.6)');

const quotaSchema = z
  .object({
    daily_embedding_tokens: z.number().int().positive().optional().describe('Daily embedding token budget (default 1_000_000)'),
    daily_writes: z.number().int().positive().optional().describe('Daily write operations budget (default 5_000)'),
    daily_searches: z.number().int().positive().optional().describe('Daily search operations budget (default 20_000)'),
    max_memories: z.number().int().positive().optional().describe('Maximum memories stored (default 100_000)'),
  })
  .describe('Quota override for this namespace');

const scopeSchema = z.enum(ALL_SCOPES as readonly [AgentScope, ...AgentScope[]]);

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

function notFoundResponse(namespaceId: string) {
  return jsonResponse({ error: 'not_found', namespace_id: namespaceId }, true);
}

function confirmReplayResponse() {
  return jsonResponse(
    { error: 'MCP_CONFIRM_REPLAY', message: 'confirmation token already consumed' },
    true,
  );
}

function confirmInvalidResponse(reason: string) {
  return jsonResponse(
    { error: 'MCP_CONFIRM_INVALID', reason },
    true,
  );
}

/**
 * Build a prune-on-revoke callback that the pat.revoke tool handler can call.
 * The callback checks whether the revoked PAT was the last PAT for the
 * agent_identity; if so, it removes that agent from all namespace member files
 * and emits an audit line per affected namespace.
 */
export function makeOrphanPruneCallback(
  patStore: PatStore,
  dataDir: string,
  auditor: AuthAuditWriter,
): (revokedAgentIdentity: string) => Promise<void> {
  return async (revokedAgentIdentity: string) => {
    // Check whether any non-revoked PATs still exist for this identity.
    const remaining = patStore.list().filter(
      (p) => p.agent_identity === revokedAgentIdentity && !p.is_revoked,
    );
    if (remaining.length > 0) {
      // Agent still has valid tokens — memberships remain valid.
      return;
    }

    const pruned = await pruneOrphanedMembers(dataDir, revokedAgentIdentity);
    for (const { namespaceId, removed } of pruned) {
      await auditor.record('namespace.member_removed', {
        agent_identity: revokedAgentIdentity,
        namespace_id: namespaceId,
        removed_count: removed,
        reason: 'pat_revoked_last_token',
      });
    }
  };
}

export function registerNamespaceTools(server: McpServer, deps: NamespaceToolDeps): void {
  const {
    sessionPat,
    auditor,
    sessionId,
    pepper,
    dataDir,
    qdrant,
    collection,
    consumed = new ConsumedConfirmations(deps.now),
    confirmationTtlMs = DEFAULT_CONFIRMATION_TTL_MS,
    now = () => new Date(),
  } = deps;

  const isServiceAdmin = sessionPat.scopes.includes('service:admin');

  async function requireServiceAdmin(toolName: string): Promise<AuthError | null> {
    try {
      authorizeServiceAccess(sessionPat, 'service:admin');
      return null;
    } catch (err) {
      if (err instanceof AuthError) {
        await auditor.record('auth.failure', {
          reason: err.reason,
          token_prefix: err.tokenPrefix,
          tool_or_resource: toolName,
          required_scope: 'service:admin',
          ...err.details,
        });
        return err;
      }
      throw err;
    }
  }

  async function requireNamespaceAdmin(
    toolName: string,
    namespaceId: string,
  ): Promise<AuthError | null> {
    try {
      await authorizeNamespaceAccess({
        pat: sessionPat,
        requestedNamespace: namespaceId,
        requiredScope: 'namespace:admin',
        dataDir,
      });
      return null;
    } catch (err) {
      if (err instanceof AuthError) {
        await auditor.record('auth.failure', {
          reason: err.reason,
          token_prefix: err.tokenPrefix,
          tool_or_resource: toolName,
          required_scope: 'namespace:admin',
          namespace_id: namespaceId,
          ...err.details,
        });
        return err;
      }
      throw err;
    }
  }

  async function recordAuthSuccess(toolName: string, scope: AgentScope) {
    await auditor.record('auth.success', {
      agent_identity: sessionPat.agent_identity,
      scope,
      tool_or_resource: toolName,
      pat_id: sessionPat.id,
    });
  }

  function buildPending(
    toolId: string,
    inputForHash: unknown,
    summary: string,
    willDo: Record<string, unknown>,
  ) {
    const expiresAt = now().getTime() + confirmationTtlMs;
    const inputHash = canonicalJsonHash(inputForHash);
    const confirmationToken = makeConfirmation(
      { session_id: sessionId, tool_id: toolId, input_hash: inputHash, expires_at: expiresAt },
      pepper,
    );
    return jsonResponse({
      pending: {
        confirmation_token: confirmationToken,
        expires_at_ms: expiresAt,
        summary,
        will_do: willDo,
      },
    });
  }

  function verifyAndConsume(
    toolId: string,
    confirmationToken: string,
    inputForHash: unknown,
  ): { ok: true } | { ok: false; response: ReturnType<typeof jsonResponse> } {
    const inputHash = canonicalJsonHash(inputForHash);
    const result = verifyConfirmation(
      confirmationToken,
      { session_id: sessionId, tool_id: toolId, input_hash: inputHash },
      pepper,
      now,
    );
    if (!result.ok) {
      return { ok: false, response: confirmInvalidResponse(result.reason) };
    }
    if (consumed.has(confirmationToken)) {
      return { ok: false, response: confirmReplayResponse() };
    }
    consumed.consume(confirmationToken, result.payload.expires_at);
    return { ok: true };
  }

  // --------------------------------------------------------------------------
  // namespace.create — requires service:admin; two-call confirmation ceremony
  // --------------------------------------------------------------------------
  server.tool(
    'namespace_create',
    'Create a new namespace with the given ID and owner. Two-call confirmation ceremony (ADR-0004 §3.5). Requires service:admin.',
    {
      id: namespaceIdSchema,
      display_name: z.string().min(1).describe('Human-readable label, e.g. "Team Alpha"'),
      owner_agent_id: z.string().min(1).describe('Agent identity that will have admin rights on the namespace'),
      retention_policy: retentionSchema.optional().describe('Defaults to keep-forever'),
      quota: quotaSchema.optional(),
      confirmation_token: z
        .string()
        .optional()
        .describe('Pass the token from the pending envelope to actually create.'),
    },
    async (input) => {
      const adminErr = await requireServiceAdmin('namespace_create');
      if (adminErr) return authErrorResponse(adminErr);

      const inputForHash = {
        id: input.id,
        display_name: input.display_name,
        owner_agent_id: input.owner_agent_id,
        retention_policy: input.retention_policy ?? 'keep-forever',
        quota: input.quota ?? null,
      };

      if (!input.confirmation_token) {
        return buildPending(
          'namespace_create',
          inputForHash,
          `Create namespace "${input.id}" (${input.display_name}) owned by "${input.owner_agent_id}". A new directory will be created under data/namespaces/${input.id}/.`,
          {
            namespace_id: input.id,
            display_name: input.display_name,
            owner_agent_id: input.owner_agent_id,
            retention_policy: inputForHash.retention_policy,
            quota: input.quota ?? 'defaults',
          },
        );
      }

      const verified = verifyAndConsume('namespace_create', input.confirmation_token, inputForHash);
      if (!verified.ok) return verified.response;

      try {
        const quotaOverride = input.quota
          ? ({
              daily_embedding_tokens: input.quota.daily_embedding_tokens ?? 1_000_000,
              daily_writes: input.quota.daily_writes ?? 5_000,
              daily_searches: input.quota.daily_searches ?? 20_000,
              max_memories: input.quota.max_memories ?? 100_000,
            } satisfies NamespaceQuota)
          : undefined;

        const ns = await createNamespaceSkeleton(dataDir, {
          id: input.id,
          display_name: input.display_name,
          owner_agent_id: input.owner_agent_id,
          owner_scopes: [...ALL_SCOPES],
          added_by: sessionPat.agent_identity,
          retention_policy: inputForHash.retention_policy as RetentionPolicy,
          quota: quotaOverride,
          now,
        });

        await recordAuthSuccess('namespace_create', 'service:admin');
        return jsonResponse({
          namespace_id: ns.id,
          display_name: ns.display_name,
          owner_agent_id: ns.owner_agent_id,
          retention_policy: ns.retention_policy,
          quota: ns.quota,
          created_at: ns.created_at,
        });
      } catch (err) {
        if (err instanceof NamespaceExistsError) {
          return jsonResponse(
            { error: 'namespace_exists', namespace_id: input.id, message: err.message },
            true,
          );
        }
        throw err;
      }
    },
  );

  // --------------------------------------------------------------------------
  // namespace.list — any authenticated caller; admins see all, non-admins
  //                  see only namespaces they are a member of (or owner of)
  // --------------------------------------------------------------------------
  server.tool(
    'namespace_list',
    'List namespaces. Admins (service:admin) see all. Others see only namespaces they are a member of.',
    {},
    async () => {
      await recordAuthSuccess('namespace_list', isServiceAdmin ? 'service:admin' : 'memory:read');

      const allIds = await listNamespaceIds(dataDir);
      const result: {
        id: string;
        display_name: string;
        owner_agent_id: string;
        retention_policy: string;
        created_at: string;
        updated_at: string;
      }[] = [];

      for (const id of allIds) {
        const ns = await loadNamespace(dataDir, id);
        if (!ns) continue;

        if (isServiceAdmin) {
          result.push({
            id: ns.id,
            display_name: ns.display_name,
            owner_agent_id: ns.owner_agent_id,
            retention_policy: ns.retention_policy,
            created_at: ns.created_at,
            updated_at: ns.updated_at,
          });
          continue;
        }

        // Non-admin: include only if the caller is owner or explicit member.
        const agentId = sessionPat.agent_identity;
        const isOwner = ns.owner_agent_id === agentId;
        if (!isOwner) {
          const members = await loadMembers(dataDir, id);
          const isMember = members?.some((m) => m.agent_id === agentId) ?? false;
          if (!isMember) continue;
        }

        result.push({
          id: ns.id,
          display_name: ns.display_name,
          owner_agent_id: ns.owner_agent_id,
          retention_policy: ns.retention_policy,
          created_at: ns.created_at,
          updated_at: ns.updated_at,
        });
      }

      return jsonResponse({ namespaces: result });
    },
  );

  // --------------------------------------------------------------------------
  // namespace.update — requires namespace:admin on the target namespace
  // --------------------------------------------------------------------------
  server.tool(
    'namespace_update',
    'Update namespace display_name, retention_policy, dedup_threshold, lifecycle policy, or quota. Requires namespace:admin on the target namespace.',
    {
      id: namespaceIdSchema,
      display_name: z.string().min(1).optional().describe('New display name'),
      retention_policy: retentionSchema.optional(),
      dedup_threshold: dedupThresholdSchema.optional(),
      lifecycle: lifecycleSchema
        .optional()
        .describe('Lifecycle fields to merge with existing policy (ADR-0006 §3.4/§3.6)'),
      quota: quotaSchema.optional().describe('Quota fields to merge with existing quota'),
    },
    async (input) => {
      const nsAdminErr = await requireNamespaceAdmin('namespace_update', input.id);
      if (nsAdminErr) return authErrorResponse(nsAdminErr);

      const ns = await loadNamespace(dataDir, input.id);
      if (!ns) return notFoundResponse(input.id);

      const lc = input.lifecycle;
      const updated = {
        ...ns,
        display_name: input.display_name ?? ns.display_name,
        retention_policy: input.retention_policy ?? ns.retention_policy,
        dedup_threshold: input.dedup_threshold ?? ns.dedup_threshold,
        // Lifecycle merge: each field overrides only when supplied. `null` is a
        // meaningful value for soft_delete_after_days/filesystem_audit_root, so
        // distinguish undefined (leave) from null (clear).
        decay_weight: lc?.decay_weight ?? ns.decay_weight,
        soft_delete_after_days:
          lc?.soft_delete_after_days !== undefined
            ? lc.soft_delete_after_days
            : ns.soft_delete_after_days,
        hard_delete_grace_days: lc?.hard_delete_grace_days ?? ns.hard_delete_grace_days,
        staleness_audit_enabled:
          lc?.staleness_audit_enabled ?? ns.staleness_audit_enabled,
        staleness_audit_batch_size:
          lc?.staleness_audit_batch_size ?? ns.staleness_audit_batch_size,
        filesystem_audit_root:
          lc?.filesystem_audit_root !== undefined
            ? lc.filesystem_audit_root
            : ns.filesystem_audit_root,
        quota: input.quota
          ? {
              daily_embedding_tokens:
                input.quota.daily_embedding_tokens ?? ns.quota.daily_embedding_tokens,
              daily_writes: input.quota.daily_writes ?? ns.quota.daily_writes,
              daily_searches: input.quota.daily_searches ?? ns.quota.daily_searches,
              max_memories: input.quota.max_memories ?? ns.quota.max_memories,
            }
          : ns.quota,
        updated_at: now().toISOString(),
      };

      await saveNamespace(dataDir, updated);
      await recordAuthSuccess('namespace_update', 'namespace:admin');

      return jsonResponse({
        namespace_id: updated.id,
        display_name: updated.display_name,
        retention_policy: updated.retention_policy,
        dedup_threshold: updated.dedup_threshold,
        lifecycle: {
          decay_weight: updated.decay_weight,
          soft_delete_after_days: updated.soft_delete_after_days,
          hard_delete_grace_days: updated.hard_delete_grace_days,
          staleness_audit_enabled: updated.staleness_audit_enabled,
          staleness_audit_batch_size: updated.staleness_audit_batch_size,
          filesystem_audit_root: updated.filesystem_audit_root,
        },
        quota: updated.quota,
        updated_at: updated.updated_at,
      });
    },
  );

  // --------------------------------------------------------------------------
  // namespace.add_member — requires namespace:admin on the target namespace
  // --------------------------------------------------------------------------
  server.tool(
    'namespace_add_member',
    'Add an agent as a member of a namespace with the given scopes. Requires namespace:admin.',
    {
      id: namespaceIdSchema,
      agent_id: z.string().min(1).describe('Agent identity to add'),
      scopes: z.array(scopeSchema).min(1).describe('Scopes to grant to the agent in this namespace'),
    },
    async (input) => {
      const nsAdminErr = await requireNamespaceAdmin('namespace_add_member', input.id);
      if (nsAdminErr) return authErrorResponse(nsAdminErr);

      const ns = await loadNamespace(dataDir, input.id);
      if (!ns) return notFoundResponse(input.id);

      // Serialize with the admin BFF / prune writers on the same lock. Built
      // inside the lock so an update preserves the original added_by/added_at
      // (only scopes change), matching upsertMember in store.ts — provenance of
      // a membership must not be rewritten every time its scopes are edited.
      const entry = await withMembersLock(input.id, async () => {
        const members = (await loadMembers(dataDir, input.id)) ?? [];
        const existing = members.findIndex((m) => m.agent_id === input.agent_id);
        const member = {
          agent_id: input.agent_id,
          scopes: [...input.scopes] as AgentScope[],
          added_by: existing >= 0 ? members[existing].added_by : sessionPat.agent_identity,
          added_at: existing >= 0 ? members[existing].added_at : now().toISOString(),
        };
        if (existing >= 0) {
          members[existing] = member; // update existing member's scopes
        } else {
          members.push(member);
        }
        await saveMembers(dataDir, input.id, members);
        return member;
      });
      await recordAuthSuccess('namespace_add_member', 'namespace:admin');

      return jsonResponse({
        namespace_id: input.id,
        agent_id: input.agent_id,
        scopes: entry.scopes,
        added_by: entry.added_by,
        added_at: entry.added_at,
      });
    },
  );

  // --------------------------------------------------------------------------
  // namespace.remove_member — requires namespace:admin on the target namespace
  // --------------------------------------------------------------------------
  server.tool(
    'namespace_remove_member',
    'Remove an agent from a namespace. Requires namespace:admin.',
    {
      id: namespaceIdSchema,
      agent_id: z.string().min(1).describe('Agent identity to remove'),
    },
    async (input) => {
      const nsAdminErr = await requireNamespaceAdmin('namespace_remove_member', input.id);
      if (nsAdminErr) return authErrorResponse(nsAdminErr);

      const ns = await loadNamespace(dataDir, input.id);
      if (!ns) return notFoundResponse(input.id);

      const didRemove = await withMembersLock(input.id, async () => {
        const members = (await loadMembers(dataDir, input.id)) ?? [];
        const before = members.length;
        const filtered = members.filter((m) => m.agent_id !== input.agent_id);
        if (filtered.length === before) return false;
        await saveMembers(dataDir, input.id, filtered);
        return true;
      });

      if (!didRemove) {
        return jsonResponse(
          { error: 'not_found', namespace_id: input.id, agent_id: input.agent_id },
          true,
        );
      }

      await recordAuthSuccess('namespace_remove_member', 'namespace:admin');

      return jsonResponse({
        namespace_id: input.id,
        agent_id: input.agent_id,
        removed: true,
      });
    },
  );

  // --------------------------------------------------------------------------
  // namespace.delete — requires service:admin; two-call confirmation ceremony
  //                    refuses to delete the bootstrap "personal" namespace
  // --------------------------------------------------------------------------
  server.tool(
    'namespace_delete',
    'Soft-delete a namespace (move to data/_deleted/<id>-<ts>/, 30-day grace before hard delete). Requires service:admin. Two-call confirmation ceremony. Cannot delete "personal".',
    {
      id: namespaceIdSchema,
      confirmation_token: z
        .string()
        .optional()
        .describe('Pass the token from the pending envelope to actually delete.'),
    },
    async (input) => {
      const adminErr = await requireServiceAdmin('namespace_delete');
      if (adminErr) return authErrorResponse(adminErr);

      // Guard: never delete the bootstrap namespace via MCP.
      if (input.id === BOOTSTRAP_NAMESPACE_ID) {
        return jsonResponse(
          {
            error: 'protected_namespace',
            namespace_id: input.id,
            message: `The "${BOOTSTRAP_NAMESPACE_ID}" namespace is protected and cannot be deleted via MCP tools. If you really need to remove it, do so manually on the filesystem.`,
          },
          true,
        );
      }

      const ns = await loadNamespace(dataDir, input.id);
      if (!ns) return notFoundResponse(input.id);

      const inputForHash = { id: input.id };

      if (!input.confirmation_token) {
        return buildPending(
          'namespace_delete',
          inputForHash,
          `Soft-delete namespace "${input.id}" (${ns.display_name}). The directory will be moved to data/_deleted/${input.id}-<timestamp>/. Grace period: 30 days before hard delete.`,
          {
            namespace_id: input.id,
            display_name: ns.display_name,
            action: 'soft_delete',
            grace_days: 30,
          },
        );
      }

      const verified = verifyAndConsume('namespace_delete', input.confirmation_token, inputForHash);
      if (!verified.ok) return verified.response;

      try {
        const deletedPath = await softDeleteNamespace(dataDir, input.id, now().getTime());

        // Cascade a namespace-filtered Qdrant purge so the tenant's vectors are
        // physically removed, not just access-gated by the moved directory
        // (issue #102 — the privacy/account-deletion promise). Best-effort: the
        // directory now lives under _deleted/, so `sweepOrphanedNamespaceVectors`
        // is the guaranteed backstop if this immediate purge fails (e.g. Qdrant
        // is transiently down). We never report vectors gone unless they are.
        let vectorsPurged = true;
        try {
          await purgeNamespaceVectors(qdrant, collection, input.id);
        } catch (purgeErr) {
          vectorsPurged = false;
          await auditor.record('namespace.vector_purge_failed', {
            namespace_id: input.id,
            error: purgeErr instanceof Error ? purgeErr.message : String(purgeErr),
          });
        }

        await recordAuthSuccess('namespace_delete', 'service:admin');
        return jsonResponse({
          namespace_id: input.id,
          deleted: true,
          moved_to: deletedPath,
          grace_days: 30,
          vectors_purged: vectorsPurged,
          note: vectorsPurged
            ? 'Namespace soft-deleted and its vectors purged from Qdrant. Hard delete of the directory after the 30-day grace period is a manual ops task.'
            : 'Namespace soft-deleted, but the immediate Qdrant vector purge failed. The orphan sweep will retry it. Hard delete of the directory after the 30-day grace period is a manual ops task.',
        });
      } catch (err) {
        if (err instanceof NamespaceNotFoundError) return notFoundResponse(input.id);
        throw err;
      }
    },
  );
}
