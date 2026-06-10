import type { FastifyInstance } from 'fastify';
import {
  listNamespaceIds,
  loadMembers,
  loadNamespace,
} from '../../../namespaces/store.js';
import type { PreHandler } from '../app.js';

export interface NamespaceAdminRoutesDeps {
  dataDir: string;
  requireAuth: PreHandler;
}

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
}
