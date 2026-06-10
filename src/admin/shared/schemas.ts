import { z } from 'zod';
import { ALL_SCOPES, type AgentScope } from '../../auth/types.js';

/** Validation schemas shared between the Fastify routes and the React SPA. */

export const usernameSchema = z.string().trim().min(3).max(64);
export const passwordSchema = z.string().min(8).max(256);

// ── PAT management (operator BFF; ADR-0009 OSS scope = users + namespaces + PAT) ─

export const createPatSchema = z.object({
  display_name: z.string().trim().min(1).max(128),
  agent_identity: z.string().trim().min(1).max(128),
  allowed_namespaces: z.array(z.string().min(1)).min(1),
  scopes: z.array(z.enum(ALL_SCOPES as readonly [AgentScope, ...AgentScope[]])).min(1),
  expires_at: z.string().datetime().nullable().optional(),
});

export const revokePatSchema = z.object({
  reason: z.string().trim().max(256).optional(),
});

export type CreatePatInput = z.infer<typeof createPatSchema>;

export const setupSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  // Required when the server runs the setup-token gate (ADR-0007 §3.4).
  setup_token: z.string().min(1).optional(),
});

export const loginSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  totp: z.string().trim().min(6).max(8).optional(),
});

export type SetupInput = z.infer<typeof setupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

// ── namespace + memory mutations (operator BFF) ──────────────────────────────

/**
 * Scopes an operator may grant to a *shared* member. Excludes the privileged
 * `namespace:admin` and `service:admin` — sharing must never be an escalation
 * vector that hands an agent token instance- or namespace-admin rights.
 */
export const SHAREABLE_SCOPES = [
  'memory:read',
  'memory:write',
  'memory:delete',
  'rules:read',
  'rules:write',
] as const satisfies readonly AgentScope[];

const shareableScopesSchema = z
  .array(z.enum(SHAREABLE_SCOPES as unknown as readonly [AgentScope, ...AgentScope[]]))
  .min(1);

/** kebab-case, 3–64 chars — mirrors NAMESPACE_ID_REGEX in namespaces/store.ts. */
export const namespaceIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,62}[a-z0-9]$/, 'namespace id must be kebab-case (3–64 chars)');

export const createNamespaceSchema = z.object({
  id: namespaceIdSchema,
  display_name: z.string().trim().min(1).max(128),
  owner_agent_id: z.string().trim().min(1).max(128),
});

export const shareNamespaceSchema = z.object({
  agent_id: z.string().trim().min(1).max(128),
  scopes: shareableScopesSchema,
});

export const writeMemorySchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  agent_id: z.string().trim().min(1).max(128),
  tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
  summary: z.string().trim().max(2_000).optional(),
  source: z.string().trim().max(512).optional(),
});

export const searchMemoryQuerySchema = z.object({
  q: z.string().trim().min(1).max(1_000),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export type CreateNamespaceInput = z.infer<typeof createNamespaceSchema>;
export type ShareNamespaceInput = z.infer<typeof shareNamespaceSchema>;
export type WriteMemoryInput = z.infer<typeof writeMemorySchema>;
