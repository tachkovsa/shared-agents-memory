import type { FastifyInstance } from 'fastify';
import { isValidNamespaceId, loadNamespace } from '../../../namespaces/store.js';
import { InvalidRuleIdError, listRules, loadRule, upsertRule } from '../../../rules/store.js';
import { createRuleSchema } from '../../shared/schemas.js';
import type { PreHandler } from '../app.js';

export interface RuleAdminRoutesDeps {
  dataDir: string;
  requireAuth: PreHandler;
}

/**
 * Operator view over a namespace's rules (ADR-0008 BFF, #66). Rules are the
 * always-loaded, file-backed memory class (ADR-0001). The console can list/read
 * and now create/update rules (upsertRule); enable/disable stays on the MCP path.
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

  // Create or update a rule from the console (parity with MCP rules_upsert).
  app.post<{ Params: { id: string } }>(
    '/api/admin/namespaces/:id/rules',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!isValidNamespaceId(req.params.id) || (await loadNamespace(dataDir, req.params.id)) === null) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const parsed = createRuleSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.issues });
      }
      try {
        const rule = await upsertRule(dataDir, req.params.id, {
          ruleId: parsed.data.rule_id,
          title: parsed.data.title,
          body: parsed.data.body,
          severity: parsed.data.severity,
          tags: parsed.data.tags,
          applies_to: parsed.data.applies_to,
          createdBy: `operator:${req.principal!.operatorId}`,
        });
        return reply.code(201).send({ frontmatter: rule.frontmatter, body: rule.body });
      } catch (err) {
        if (err instanceof InvalidRuleIdError) {
          return reply.code(400).send({ error: 'invalid_rule_id' });
        }
        throw err;
      }
    },
  );
}
