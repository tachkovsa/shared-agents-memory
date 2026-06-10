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
