import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AuthAuditWriter } from '../auth/audit.js';
import { AuthError } from '../auth/request-context.js';
import { authorizeNamespaceAccess } from '../auth/resolve-request.js';
import type { AgentPat, AgentScope } from '../auth/types.js';
import { listNamespaceIds } from '../namespaces/store.js';
import { serializeRuleFile } from './frontmatter.js';
import {
  deleteRule,
  InvalidRuleIdError,
  listRules,
  loadRule,
  RuleNotFoundError,
  upsertRule,
} from './store.js';
import {
  RULE_ID_REGEX,
  ruleSeveritySchema,
  ruleUri,
  rulesIndexUri,
  type RuleSeverity,
} from './types.js';

export interface RuleToolDeps {
  sessionPat: AgentPat;
  auditor: AuthAuditWriter;
  dataDir: string;
}

const ruleIdSchema = z
  .string()
  .regex(RULE_ID_REGEX, 'Rule ID must be kebab-case, 3-64 chars')
  .describe('Kebab-case rule id (matches the filename without .md)');

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

function notFoundResponse(namespaceId: string, ruleId: string) {
  return jsonResponse(
    { error: 'not_found', namespace_id: namespaceId, rule_id: ruleId },
    true,
  );
}

export function registerRuleTools(server: McpServer, deps: RuleToolDeps): void {
  const { sessionPat, auditor, dataDir } = deps;
  const isServiceAdmin = sessionPat.scopes.includes('service:admin');

  async function authorize(
    toolOrResource: string,
    namespaceId: string,
    requiredScope: AgentScope,
  ): Promise<AuthError | null> {
    try {
      await authorizeNamespaceAccess({
        pat: sessionPat,
        requestedNamespace: namespaceId,
        requiredScope,
        dataDir,
      });
      await auditor.record('auth.success', {
        agent_identity: sessionPat.agent_identity,
        namespace: namespaceId,
        scope: requiredScope,
        tool_or_resource: toolOrResource,
        pat_id: sessionPat.id,
      });
      return null;
    } catch (err) {
      if (err instanceof AuthError) {
        await auditor.record('auth.failure', {
          reason: err.reason,
          token_prefix: err.tokenPrefix,
          tool_or_resource: toolOrResource,
          requested_namespace: namespaceId,
          required_scope: requiredScope,
          ...err.details,
        });
        return err;
      }
      throw err;
    }
  }

  async function readableNamespaces(): Promise<string[]> {
    const all = await listNamespaceIds(dataDir);
    const allowed: string[] = [];
    for (const ns of all) {
      try {
        await authorizeNamespaceAccess({
          pat: sessionPat,
          requestedNamespace: ns,
          requiredScope: 'rules:read',
          dataDir,
        });
        allowed.push(ns);
      } catch (err) {
        if (err instanceof AuthError) continue;
        throw err;
      }
    }
    return allowed;
  }

  // ---------- MCP Resources surface ----------
  const template = new ResourceTemplate('mem://{namespace}/rules/{ruleId}', {
    list: async () => {
      const namespaces = isServiceAdmin
        ? await listNamespaceIds(dataDir)
        : await readableNamespaces();
      const resources: {
        uri: string;
        name: string;
        description?: string;
        mimeType: string;
      }[] = [];
      for (const ns of namespaces) {
        try {
          const rules = await listRules(dataDir, ns);
          for (const r of rules) {
            resources.push({
              uri: ruleUri(ns, r.id),
              name: r.title,
              description: `severity:${r.severity}${
                r.tags.length > 0 ? ` tags:${r.tags.join(',')}` : ''
              }`,
              mimeType: 'text/markdown',
            });
          }
        } catch {
          // Skip namespaces whose rules dir is unreadable; don't fail the whole list.
          continue;
        }
      }
      return { resources };
    },
  });

  // Declare subscribe capability + acknowledge subscribe requests. The v1 stdio
  // transport has a single client, so sendResourceUpdated reaches it
  // regardless of per-URI tracking — handlers just return success. A
  // multi-session HTTP transport will need to track subscribers per session.
  server.server.registerCapabilities({ resources: { subscribe: true } });
  server.server.setRequestHandler(SubscribeRequestSchema, async () => ({}));
  server.server.setRequestHandler(UnsubscribeRequestSchema, async () => ({}));

  server.registerResource(
    'rule',
    template,
    {
      title: 'Rule',
      description:
        'Markdown rule with YAML frontmatter. Read via mem://<namespace>/rules/<rule-id>.',
      mimeType: 'text/markdown',
    },
    async (uri, variables) => {
      const ns = String(variables['namespace']);
      const ruleId = String(variables['ruleId']);
      const err = await authorize(
        `resource:${uri.toString()}`,
        ns,
        'rules:read',
      );
      if (err) {
        throw new Error(`access denied: ${err.reason}`);
      }
      let rule;
      try {
        rule = await loadRule(dataDir, ns, ruleId);
      } catch (loadErr) {
        if (loadErr instanceof InvalidRuleIdError) {
          throw new Error(`invalid rule id: ${ruleId}`);
        }
        throw loadErr;
      }
      if (!rule) {
        throw new Error(`rule not found: ${ns}/${ruleId}`);
      }
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'text/markdown',
            text: serializeRuleFile(rule),
          },
        ],
      };
    },
  );

  // ---------- Tool: rules.list (shim) ----------
  server.tool(
    'rules.list',
    'List rules visible to the caller (shim for clients with weak Resource UX).',
    {
      namespace: z
        .string()
        .optional()
        .describe('Restrict to a single namespace. Omit to list all readable namespaces.'),
    },
    async (input) => {
      const namespaces: string[] = input.namespace
        ? [input.namespace]
        : isServiceAdmin
          ? await listNamespaceIds(dataDir)
          : await readableNamespaces();

      const results: {
        namespace: string;
        uri: string;
        id: string;
        title: string;
        severity: RuleSeverity;
        tags: string[];
        updated_at: string;
      }[] = [];

      for (const ns of namespaces) {
        if (input.namespace) {
          const err = await authorize('rules.list', ns, 'rules:read');
          if (err) return authErrorResponse(err);
        }
        try {
          const rules = await listRules(dataDir, ns);
          for (const r of rules) {
            results.push({
              namespace: ns,
              uri: ruleUri(ns, r.id),
              id: r.id,
              title: r.title,
              severity: r.severity,
              tags: r.tags,
              updated_at: r.updated_at,
            });
          }
        } catch {
          continue;
        }
      }
      return jsonResponse({ rules: results });
    },
  );

  // ---------- Tool: rules.read (shim) ----------
  server.tool(
    'rules.read',
    'Read a single rule by namespace + id (shim for resources/read).',
    {
      namespace: z.string().min(1).describe('Namespace the rule belongs to'),
      id: ruleIdSchema,
    },
    async (input) => {
      const err = await authorize('rules.read', input.namespace, 'rules:read');
      if (err) return authErrorResponse(err);
      try {
        const rule = await loadRule(dataDir, input.namespace, input.id);
        if (!rule) return notFoundResponse(input.namespace, input.id);
        return jsonResponse({
          uri: ruleUri(input.namespace, input.id),
          frontmatter: rule.frontmatter,
          body: rule.body,
        });
      } catch (loadErr) {
        if (loadErr instanceof InvalidRuleIdError) {
          return jsonResponse({ error: 'invalid_id', message: loadErr.message }, true);
        }
        throw loadErr;
      }
    },
  );

  // ---------- Tool: rules.upsert (rules:write) ----------
  server.tool(
    'rules.upsert',
    'Create or replace a rule. Writes are atomic (tmp + fsync + rename) and serialized per namespace.',
    {
      namespace: z.string().min(1).describe('Namespace the rule belongs to'),
      id: ruleIdSchema,
      title: z.string().min(1).max(200).describe('Human-readable title'),
      body: z.string().describe('Markdown body of the rule'),
      tags: z.array(z.string().min(1)).optional().describe('Free-form tags'),
      applies_to: z
        .array(z.string().min(1))
        .optional()
        .describe('Optional scoping hints, e.g. "agent:claude-code"'),
      severity: ruleSeveritySchema.optional().describe('hard (default) or soft'),
    },
    async (input) => {
      const err = await authorize('rules.upsert', input.namespace, 'rules:write');
      if (err) return authErrorResponse(err);
      try {
        const rule = await upsertRule(dataDir, input.namespace, {
          ruleId: input.id,
          title: input.title,
          body: input.body,
          tags: input.tags,
          applies_to: input.applies_to,
          severity: input.severity,
          createdBy: sessionPat.agent_identity,
        });
        await server.server.sendResourceUpdated({
          uri: ruleUri(input.namespace, input.id),
        });
        await server.server.sendResourceUpdated({
          uri: rulesIndexUri(input.namespace),
        });
        return jsonResponse({
          uri: ruleUri(input.namespace, input.id),
          frontmatter: rule.frontmatter,
        });
      } catch (writeErr) {
        if (writeErr instanceof InvalidRuleIdError) {
          return jsonResponse({ error: 'invalid_id', message: writeErr.message }, true);
        }
        throw writeErr;
      }
    },
  );

  // ---------- Tool: rules.delete (rules:write) ----------
  server.tool(
    'rules.delete',
    'Delete a rule. Removes the file and regenerates the namespace INDEX.md.',
    {
      namespace: z.string().min(1).describe('Namespace the rule belongs to'),
      id: ruleIdSchema,
    },
    async (input) => {
      const err = await authorize('rules.delete', input.namespace, 'rules:write');
      if (err) return authErrorResponse(err);
      try {
        await deleteRule(dataDir, input.namespace, input.id);
        await server.server.sendResourceUpdated({
          uri: ruleUri(input.namespace, input.id),
        });
        await server.server.sendResourceUpdated({
          uri: rulesIndexUri(input.namespace),
        });
        return jsonResponse({ deleted: true, namespace: input.namespace, id: input.id });
      } catch (delErr) {
        if (delErr instanceof RuleNotFoundError) {
          return notFoundResponse(input.namespace, input.id);
        }
        if (delErr instanceof InvalidRuleIdError) {
          return jsonResponse({ error: 'invalid_id', message: delErr.message }, true);
        }
        throw delErr;
      }
    },
  );
}
