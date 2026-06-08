import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AuthProvider, Principal } from '../auth/auth-provider.js';
import type { SessionService } from '../auth/session-service.js';
import type { OperatorRepository } from '../stores/types.js';
import { registerAuthRoutes } from './routes/auth.js';

export const SESSION_COOKIE = 'sam_admin_session';
export const CSRF_HEADER = 'x-csrf-token';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface AdminAppOptions {
  sessions: SessionService;
  operators: OperatorRepository;
  /** Send the session cookie with the Secure flag. Default true; tests pass false. */
  cookieSecure?: boolean;
  loginRateLimit?: { max: number; timeWindow: string };
}

/**
 * Build the admin BFF (ADR-0008). A separate Fastify listener from the MCP
 * node:http transport — the engine path is untouched. Routes stay thin;
 * orchestration lives in SessionService.
 */
export async function createAdminApp(opts: AdminAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  const requireAuth = makeRequireAuth(opts.sessions);

  registerAuthRoutes(app, {
    sessions: opts.sessions,
    operators: opts.operators,
    requireAuth,
    cookieSecure: opts.cookieSecure ?? true,
    loginRateLimit: opts.loginRateLimit ?? { max: 10, timeWindow: '1 minute' },
  });

  return app;
}

type PreHandler = (
  req: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
) => Promise<unknown>;

/**
 * preHandler: resolve the session cookie to a Principal and, for mutating
 * methods, enforce the double-submit CSRF token (ADR-0007 §3.3).
 */
function makeRequireAuth(auth: AuthProvider): PreHandler {
  return async function requireAuth(req, reply) {
    const sessionId = req.cookies[SESSION_COOKIE];
    if (!sessionId) {
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    const principal = await auth.resolveSession(sessionId);
    if (!principal) {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const header = req.headers[CSRF_HEADER.toLowerCase()];
      if (typeof header !== 'string' || header !== principal.csrfToken) {
        return reply.code(403).send({ error: 'csrf' });
      }
    }
    req.principal = principal;
    return undefined;
  };
}

export type { PreHandler };
