import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthAuditWriter } from './audit.js';
import {
  canonicalJsonHash,
  ConsumedConfirmations,
  DEFAULT_CONFIRMATION_TTL_MS,
  makeConfirmation,
  verifyConfirmation,
} from './confirmation.js';
import {
  PatNotFoundError,
  PatRotationStateError,
  PatStore,
} from './pat-store.js';
import { AuthError } from './request-context.js';
import { authorizeServiceAccess } from './resolve-request.js';
import { ALL_SCOPES, type AgentPat, type AgentScope } from './types.js';

export interface PatToolDeps {
  patStore: PatStore;
  sessionPat: AgentPat;
  auditor: AuthAuditWriter;
  sessionId: string;
  pepper: Buffer;
  consumed?: ConsumedConfirmations;
  confirmationTtlMs?: number;
  now?: () => Date;
  /**
   * Optional hook called after a successful pat.revoke. Receives the
   * agent_identity of the revoked PAT. Used by the namespace tools layer to
   * prune orphaned _members.json entries when a PAT is the last token for
   * that identity (ADR-0002 §5 Q3).
   */
  onPatRevoked?: (revokedAgentIdentity: string) => Promise<void>;
}

const scopeSchema = z.enum(ALL_SCOPES as readonly [AgentScope, ...AgentScope[]]);

interface PublicPatRecord {
  id: string;
  display_name: string;
  token_prefix: string;
  agent_identity: string;
  allowed_namespaces: string[];
  scopes: AgentScope[];
  created_at: string;
  created_by: string;
  expires_at: string | null;
  last_used_at: string | null;
  is_revoked: boolean;
  revoked_at: string | null;
  revoked_reason: string | null;
}

function toPublicRecord(pat: AgentPat): PublicPatRecord {
  const {
    id,
    display_name,
    token_prefix,
    agent_identity,
    allowed_namespaces,
    scopes,
    created_at,
    created_by,
    expires_at,
    last_used_at,
    is_revoked,
    revoked_at,
    revoked_reason,
  } = pat;
  return {
    id,
    display_name,
    token_prefix,
    agent_identity,
    allowed_namespaces: [...allowed_namespaces],
    scopes: [...scopes],
    created_at,
    created_by,
    expires_at,
    last_used_at,
    is_revoked,
    revoked_at,
    revoked_reason,
  };
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

function notFoundResponse(patId: string) {
  return jsonResponse({ error: 'not_found', pat_id: patId }, true);
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

export function registerPatTools(server: McpServer, deps: PatToolDeps): void {
  const {
    patStore,
    sessionPat,
    auditor,
    sessionId,
    pepper,
    consumed = new ConsumedConfirmations(deps.now),
    confirmationTtlMs = DEFAULT_CONFIRMATION_TTL_MS,
    now = () => new Date(),
    onPatRevoked,
  } = deps;

  const isServiceAdmin = sessionPat.scopes.includes('service:admin');

  async function requireServiceAdmin(toolName: string) {
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

  async function recordAuthSuccess(toolName: string, scope: AgentScope) {
    await auditor.record('auth.success', {
      agent_identity: sessionPat.agent_identity,
      scope,
      tool_or_resource: toolName,
      pat_id: sessionPat.id,
    });
  }

  function canActOnPat(target: AgentPat): boolean {
    return (
      isServiceAdmin || target.agent_identity === sessionPat.agent_identity
    );
  }

  function buildPending(toolId: string, inputForHash: unknown, summary: string, willDo: Record<string, unknown>) {
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

  server.tool(
    'pat.create',
    'Mint a new PAT for an agent identity. Two-call confirmation ceremony (ADR-0004 §3.5).',
    {
      display_name: z.string().min(1).describe('Human-readable label, e.g. "Codex CLI on laptop"'),
      agent_identity: z.string().min(1).describe('Stable agent identity (cuid or operator-chosen handle)'),
      allowed_namespaces: z.array(z.string().min(1)).min(1).describe('Namespaces this token may operate in'),
      scopes: z.array(scopeSchema).min(1).describe('Scopes granted to this token'),
      expires_in_days: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe('Expiry in days. null = no expiry. Default: 365 per ADR-0004 §5.1 Q2.'),
      confirmation_token: z
        .string()
        .optional()
        .describe('Pass the token from the pending envelope to actually mint.'),
    },
    async (input) => {
      const adminErr = await requireServiceAdmin('pat.create');
      if (adminErr) return authErrorResponse(adminErr);

      const expiresInDays =
        input.expires_in_days === undefined ? 365 : input.expires_in_days;
      const willExpireAt =
        expiresInDays === null
          ? null
          : new Date(now().getTime() + expiresInDays * 86_400_000).toISOString();

      const inputForHash = {
        display_name: input.display_name,
        agent_identity: input.agent_identity,
        allowed_namespaces: [...input.allowed_namespaces],
        scopes: [...input.scopes],
        expires_in_days: expiresInDays,
      };

      if (!input.confirmation_token) {
        return buildPending(
          'pat.create',
          inputForHash,
          `Mint a PAT for agent "${input.agent_identity}" (${input.display_name}).`,
          {
            agent_identity: input.agent_identity,
            display_name: input.display_name,
            allowed_namespaces: inputForHash.allowed_namespaces,
            scopes: inputForHash.scopes,
            expires_at: willExpireAt,
          },
        );
      }

      const verified = verifyAndConsume('pat.create', input.confirmation_token, inputForHash);
      if (!verified.ok) return verified.response;

      const minted = await patStore.mint({
        display_name: input.display_name,
        agent_identity: input.agent_identity,
        allowed_namespaces: inputForHash.allowed_namespaces,
        scopes: inputForHash.scopes as AgentScope[],
        created_by: sessionPat.agent_identity,
        expires_at: willExpireAt,
      });
      await recordAuthSuccess('pat.create', 'service:admin');
      await auditor.record('pat.minted', {
        pat_id: minted.pat.id,
        agent_identity: minted.pat.agent_identity,
        allowed_namespaces: minted.pat.allowed_namespaces,
        scopes: minted.pat.scopes,
        expires_at: minted.pat.expires_at,
        by: sessionPat.agent_identity,
      });

      return jsonResponse({
        pat_id: minted.pat.id,
        secret: minted.secret,
        agent_identity: minted.pat.agent_identity,
        allowed_namespaces: minted.pat.allowed_namespaces,
        scopes: minted.pat.scopes,
        expires_at: minted.pat.expires_at,
        warning: 'This secret is shown ONCE. Save it now.',
      });
    },
  );

  server.tool(
    'pat.list',
    'List PATs visible to the caller. Non-admins see only their own.',
    {
      agent_identity: z
        .string()
        .optional()
        .describe('Filter by agent identity. Non-admins are always restricted to their own.'),
    },
    async (input) => {
      await recordAuthSuccess('pat.list', isServiceAdmin ? 'service:admin' : 'memory:read');
      const all = patStore.list();
      const visible = isServiceAdmin
        ? all
        : all.filter((p) => p.agent_identity === sessionPat.agent_identity);
      const filtered = input.agent_identity
        ? visible.filter((p) => p.agent_identity === input.agent_identity)
        : visible;
      return jsonResponse({ pats: filtered.map(toPublicRecord) });
    },
  );

  server.tool(
    'pat.revoke',
    'Revoke a PAT. Caller must be the owning agent or hold service:admin.',
    {
      pat_id: z.string().min(1).describe('PAT id to revoke'),
      reason: z.string().min(1).describe('Reason recorded in the audit log'),
    },
    async (input) => {
      const target = patStore.get(input.pat_id);
      if (!target) return notFoundResponse(input.pat_id);

      if (!canActOnPat(target)) {
        const err = new AuthError(
          'scope_insufficient',
          `agent ${sessionPat.agent_identity} cannot revoke PATs owned by ${target.agent_identity}`,
          sessionPat.token_prefix,
        );
        await auditor.record('auth.failure', {
          reason: err.reason,
          token_prefix: err.tokenPrefix,
          tool_or_resource: 'pat.revoke',
          target_pat_id: input.pat_id,
        });
        return authErrorResponse(err);
      }

      try {
        const revoked = await patStore.revoke(input.pat_id, input.reason);
        await recordAuthSuccess('pat.revoke', isServiceAdmin ? 'service:admin' : 'memory:read');
        await auditor.record('pat.revoked', {
          pat_id: revoked.id,
          reason: revoked.revoked_reason,
          by: sessionPat.agent_identity,
        });
        // Prune orphaned namespace memberships if this was the last PAT for
        // the agent identity (ADR-0002 §5 Q3). The check for "last PAT" is
        // performed inside onPatRevoked (via makeOrphanPruneCallback).
        if (onPatRevoked) {
          await onPatRevoked(revoked.agent_identity);
        }
        return jsonResponse({
          pat_id: revoked.id,
          revoked_at: revoked.revoked_at,
          revoked_reason: revoked.revoked_reason,
        });
      } catch (err) {
        if (err instanceof PatNotFoundError) return notFoundResponse(input.pat_id);
        throw err;
      }
    },
  );

  server.tool(
    'pat.rotate',
    'Rotate a PAT: mint new with same scopes, revoke old, atomically. Two-call confirmation (ADR-0004 §3.5).',
    {
      pat_id: z.string().min(1).describe('PAT id to rotate'),
      confirmation_token: z
        .string()
        .optional()
        .describe('Pass the token from the pending envelope to perform the rotation.'),
    },
    async (input) => {
      const target = patStore.get(input.pat_id);
      if (!target) return notFoundResponse(input.pat_id);

      if (!canActOnPat(target)) {
        const err = new AuthError(
          'scope_insufficient',
          `agent ${sessionPat.agent_identity} cannot rotate PATs owned by ${target.agent_identity}`,
          sessionPat.token_prefix,
        );
        await auditor.record('auth.failure', {
          reason: err.reason,
          token_prefix: err.tokenPrefix,
          tool_or_resource: 'pat.rotate',
          target_pat_id: input.pat_id,
        });
        return authErrorResponse(err);
      }

      if (target.is_revoked) {
        return jsonResponse(
          { error: 'already_revoked', pat_id: target.id },
          true,
        );
      }

      const inputForHash = { pat_id: target.id };

      if (!input.confirmation_token) {
        return buildPending(
          'pat.rotate',
          inputForHash,
          `Rotate PAT ${target.id} (${target.display_name}). The old token will be revoked.`,
          {
            replaced_pat_id: target.id,
            agent_identity: target.agent_identity,
            allowed_namespaces: target.allowed_namespaces,
            scopes: target.scopes,
            expires_at: target.expires_at,
          },
        );
      }

      const verified = verifyAndConsume('pat.rotate', input.confirmation_token, inputForHash);
      if (!verified.ok) return verified.response;

      try {
        const minted = await patStore.rotate(target.id, {
          display_name: target.display_name,
          agent_identity: target.agent_identity,
          allowed_namespaces: target.allowed_namespaces,
          scopes: target.scopes,
          created_by: sessionPat.agent_identity,
          expires_at: target.expires_at,
        });
        await recordAuthSuccess('pat.rotate', isServiceAdmin ? 'service:admin' : 'memory:read');
        await auditor.record('pat.minted', {
          pat_id: minted.pat.id,
          agent_identity: minted.pat.agent_identity,
          allowed_namespaces: minted.pat.allowed_namespaces,
          scopes: minted.pat.scopes,
          expires_at: minted.pat.expires_at,
          by: sessionPat.agent_identity,
          replaced_pat_id: target.id,
        });
        await auditor.record('pat.revoked', {
          pat_id: target.id,
          reason: `rotated; replaced by ${minted.pat.id}`,
          by: sessionPat.agent_identity,
        });
        return jsonResponse({
          new_pat_id: minted.pat.id,
          secret: minted.secret,
          replaced_pat_id: target.id,
          expires_at: minted.pat.expires_at,
          warning: 'This secret is shown ONCE. Save it now.',
        });
      } catch (err) {
        if (err instanceof PatNotFoundError) return notFoundResponse(input.pat_id);
        if (err instanceof PatRotationStateError) {
          return jsonResponse({ error: 'invalid_state', message: err.message }, true);
        }
        throw err;
      }
    },
  );
}
