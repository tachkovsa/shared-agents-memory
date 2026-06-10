import type { FastifyInstance } from 'fastify';
import type { PatStore } from '../../../auth/pat-store.js';
import { PatNotFoundError } from '../../../auth/pat-store.js';
import type { AgentPat } from '../../../auth/types.js';
import { createPatSchema, revokePatSchema } from '../../shared/schemas.js';
import type { PreHandler } from '../app.js';

export interface PatAdminRoutesDeps {
  patStore: PatStore;
  requireAuth: PreHandler;
  /**
   * Called after a successful revoke with the PAT's agent_identity, mirroring the
   * MCP `pat_revoke` path: when the agent's last token is revoked, prune its now
   * orphaned namespace memberships (otherwise a later PAT for the same identity
   * would silently regain access). Omit to skip (e.g. unit tests without a dataDir).
   */
  onRevoke?: (agentIdentity: string) => Promise<void>;
}

/**
 * Operator-facing PAT (agent token) management (ADR-0008 BFF, ADR-0009 OSS scope:
 * users + namespaces + PAT). An authenticated operator is an instance admin and
 * sees/manages every PAT on the instance — this is how the first users are
 * onboarded before self-serve signup (which lives in the private SaaS repo).
 *
 * The token hash is NEVER returned. The plaintext secret is shown EXACTLY ONCE,
 * in the create response — it cannot be retrieved again (it isn't stored).
 */
export function registerPatAdminRoutes(app: FastifyInstance, deps: PatAdminRoutesDeps): void {
  const { patStore, requireAuth, onRevoke } = deps;

  app.get('/api/admin/pats', { preHandler: requireAuth }, async () => {
    return { pats: patStore.list().map(redactPat) };
  });

  app.get<{ Params: { id: string } }>(
    '/api/admin/pats/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const pat = patStore.get(req.params.id);
      if (!pat) return reply.code(404).send({ error: 'not_found' });
      return redactPat(pat);
    },
  );

  app.post('/api/admin/pats', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = createPatSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.issues });
    }
    const input = parsed.data;
    const result = await patStore.mint({
      display_name: input.display_name,
      agent_identity: input.agent_identity,
      allowed_namespaces: input.allowed_namespaces,
      scopes: input.scopes,
      created_by: `operator:${req.principal!.operatorId}`,
      expires_at: input.expires_at ?? null,
    });
    // The secret is shown ONCE — never stored, never retrievable again.
    return reply.code(201).send({ pat: redactPat(result.pat), secret: result.secret });
  });

  app.post<{ Params: { id: string } }>(
    '/api/admin/pats/:id/revoke',
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = revokePatSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.issues });
      }
      const reason =
        parsed.data.reason ?? `revoked via admin console by operator:${req.principal!.operatorId}`;
      try {
        const updated = await patStore.revoke(req.params.id, reason);
        // Parity with MCP pat_revoke: prune memberships orphaned by the last token.
        await onRevoke?.(updated.agent_identity);
        return redactPat(updated);
      } catch (err) {
        if (err instanceof PatNotFoundError) {
          return reply.code(404).send({ error: 'not_found' });
        }
        throw err;
      }
    },
  );
}

/** Project an AgentPat to the operator-safe view — the token hash never leaves the server. */
function redactPat(p: AgentPat) {
  return {
    id: p.id,
    display_name: p.display_name,
    token_prefix: p.token_prefix,
    agent_identity: p.agent_identity,
    allowed_namespaces: p.allowed_namespaces,
    scopes: p.scopes,
    created_at: p.created_at,
    created_by: p.created_by,
    expires_at: p.expires_at,
    last_used_at: p.last_used_at,
    is_revoked: p.is_revoked,
    revoked_at: p.revoked_at,
    revoked_reason: p.revoked_reason,
  };
}
