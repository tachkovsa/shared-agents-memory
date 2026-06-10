import { z } from 'zod';

/** Validation schemas shared between the Fastify routes and the React SPA. */

export const usernameSchema = z.string().trim().min(3).max(64);
export const passwordSchema = z.string().min(8).max(256);

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
