import type { FastifyInstance } from 'fastify';
import { isValidNamespaceId, loadNamespace } from '../../../namespaces/store.js';
import { listRules, loadRule } from '../../../rules/store.js';
import type { PreHandler } from '../app.js';

export interface RuleAdminRoutesDeps {
  dataDir: string;
  requireAuth: PreHandler;
}

/**
 * Read-only operator view over a namespace's rules (ADR-0008 BFF, #66). Rules are
 * the always-loaded, file-backed memory class (ADR-0001); editing stays on the
 * MCP `rules_*` path for now — the console only surfaces them.
 */
export function registerRuleAdminRoutes(app: FastifyInstance, deps: RuleAdminRoutesDeps): void {
  const { dataDir, requireAuth } = deps;

  app.get<{ Params: { id: string } }>(
    '/api/admin/namespaces/:id/rules',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!isValidNamespaceId(req.params.id)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if ((await loadNamespace(dataDir, req.params.id)) === null) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return { rules: await listRules(dataDir, req.params.id) };
    },
  );

  app.get<{ Params: { id: string; ruleId: string } }>(
    '/api/admin/namespaces/:id/rules/:ruleId',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!isValidNamespaceId(req.params.id)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if ((await loadNamespace(dataDir, req.params.id)) === null) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const rule = await loadRule(dataDir, req.params.id, req.params.ruleId);
      if (!rule) return reply.code(404).send({ error: 'not_found' });
      return { frontmatter: rule.frontmatter, body: rule.body };
    },
  );
}
