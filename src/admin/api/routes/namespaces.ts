import type { FastifyInstance } from 'fastify';
import {
  createNamespaceSkeleton,
  isValidNamespaceId,
  listNamespaceIds,
  loadMembers,
  loadNamespace,
  NamespaceExistsError,
  removeMember,
  upsertMember,
} from '../../../namespaces/store.js';
import type { AgentScope } from '../../../auth/types.js';
import { createNamespaceSchema, shareNamespaceSchema } from '../../shared/schemas.js';
import type { PreHandler } from '../app.js';

export interface NamespaceAdminRoutesDeps {
  dataDir: string;
  requireAuth: PreHandler;
}

/** Scopes the owner (creator) receives on a new namespace — full control sans service:admin. */
const OWNER_SCOPES: AgentScope[] = [
  'memory:read',
  'memory:write',
  'memory:delete',
  'rules:read',
  'rules:write',
  'namespace:admin',
];

/**
 * Read-only operator views over namespaces (ADR-0008 BFF, ADR-0009 OSS scope:
 * users + namespaces + PAT, no orgs). An authenticated operator is an instance
 * admin and sees every namespace on the instance.
 */
export function registerNamespaceAdminRoutes(
  app: FastifyInstance,
  deps: NamespaceAdminRoutesDeps,
): void {
  const { dataDir, requireAuth } = deps;

  app.get('/api/admin/namespaces', { preHandler: requireAuth }, async () => {
    const ids = await listNamespaceIds(dataDir);
    const namespaces = [];
    for (const id of ids) {
      const ns = await loadNamespace(dataDir, id);
      if (!ns) continue;
      namespaces.push({
        id: ns.id,
        display_name: ns.display_name,
        owner_agent_id: ns.owner_agent_id,
        retention_policy: ns.retention_policy,
        dedup_threshold: ns.dedup_threshold,
        quota: ns.quota,
        created_at: ns.created_at,
        updated_at: ns.updated_at,
      });
    }
    return { namespaces };
  });

  app.get<{ Params: { id: string } }>(
    '/api/admin/namespaces/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!isValidNamespaceId(req.params.id)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const ns = await loadNamespace(dataDir, req.params.id);
      if (!ns) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const members = (await loadMembers(dataDir, ns.id)) ?? [];
      return {
        id: ns.id,
        display_name: ns.display_name,
        owner_agent_id: ns.owner_agent_id,
        visibility: ns.visibility,
        retention_policy: ns.retention_policy,
        dedup_threshold: ns.dedup_threshold,
        quota: ns.quota,
        created_at: ns.created_at,
        updated_at: ns.updated_at,
        members: members.map((m) => ({
          agent_id: m.agent_id,
          scopes: m.scopes,
          added_by: m.added_by,
          added_at: m.added_at,
        })),
      };
    },
  );

  // Create a namespace (operator-driven onboarding; mirrors MCP namespace_create).
  app.post('/api/admin/namespaces', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = createNamespaceSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.issues });
    }
    try {
      const ns = await createNamespaceSkeleton(dataDir, {
        id: parsed.data.id,
        display_name: parsed.data.display_name,
        owner_agent_id: parsed.data.owner_agent_id,
        owner_scopes: OWNER_SCOPES,
        added_by: `operator:${req.principal!.operatorId}`,
      });
      return reply.code(201).send({
        id: ns.id,
        display_name: ns.display_name,
        owner_agent_id: ns.owner_agent_id,
        retention_policy: ns.retention_policy,
        dedup_threshold: ns.dedup_threshold,
        quota: ns.quota,
        created_at: ns.created_at,
        updated_at: ns.updated_at,
      });
    } catch (err) {
      if (err instanceof NamespaceExistsError) {
        return reply.code(409).send({ error: 'namespace_exists' });
      }
      throw err;
    }
  });

  // Share access: add (or update the scopes of) a member.
  app.post<{ Params: { id: string } }>(
    '/api/admin/namespaces/:id/members',
    { preHandler: requireAuth },
    async (req, reply) => {
      const ns = isValidNamespaceId(req.params.id) ? await loadNamespace(dataDir, req.params.id) : null;
      if (!ns) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const parsed = shareNamespaceSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.issues });
      }
      // The owner's membership is set at creation; sharing must never overwrite or
      // downgrade it (SHAREABLE_SCOPES omits namespace:admin → would lock the owner out).
      if (parsed.data.agent_id === ns.owner_agent_id) {
        return reply.code(400).send({ error: 'cannot_modify_owner' });
      }
      // Locked read-modify-write — concurrent share/unshare can't clobber each other.
      const member = await upsertMember(dataDir, req.params.id, {
        agent_id: parsed.data.agent_id,
        scopes: parsed.data.scopes,
        addedBy: `operator:${req.principal!.operatorId}`,
      });
      return reply.code(201).send(member);
    },
  );

  // Revoke a member's access.
  app.delete<{ Params: { id: string; agentId: string } }>(
    '/api/admin/namespaces/:id/members/:agentId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const ns = isValidNamespaceId(req.params.id) ? await loadNamespace(dataDir, req.params.id) : null;
      if (!ns) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (req.params.agentId === ns.owner_agent_id) {
        return reply.code(400).send({ error: 'cannot_modify_owner' });
      }
      const removed = await removeMember(dataDir, req.params.id, req.params.agentId);
      return { removed, agent_id: req.params.agentId };
    },
  );
}
