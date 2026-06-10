import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AuthProvider, Principal } from '../auth/auth-provider.js';
import type { SessionService } from '../auth/session-service.js';
import type { SetupTokenVerifier } from '../auth/setup-token.js';
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
  /**
   * Trust X-Forwarded-* so rate-limit keys on the real client IP. Set true only
   * when behind the known reverse proxy (deploy/); false for direct exposure.
   */
  trustProxy?: boolean;
  loginRateLimit?: { max: number; timeWindow: string };
  /** Absolute path to the built SPA (dist/admin-public). Omit to skip static serving (tests). */
  staticDir?: string;
  /** Gate first-operator creation behind a one-time token (ADR-0007 §3.4). Omit to leave /setup open. */
  setupTokens?: SetupTokenVerifier;
}

/**
 * Build the admin BFF (ADR-0008). A separate Fastify listener from the MCP
 * node:http transport — the engine path is untouched. Routes stay thin;
 * orchestration lives in SessionService.
 */
export async function createAdminApp(opts: AdminAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: opts.trustProxy ?? false });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  const requireAuth = makeRequireAuth(opts.sessions);

  registerAuthRoutes(app, {
    sessions: opts.sessions,
    operators: opts.operators,
    requireAuth,
    cookieSecure: opts.cookieSecure ?? true,
    loginRateLimit: opts.loginRateLimit ?? { max: 10, timeWindow: '1 minute' },
    setupTokens: opts.setupTokens,
  });

  if (opts.staticDir) {
    await registerSpa(app, opts.staticDir);
  }

  return app;
}

/**
 * Serve the built SPA, with a fallback to index.html for client-side routes.
 * API paths keep returning JSON 404s — only non-API GETs fall through to the app.
 */
async function registerSpa(app: FastifyInstance, root: string): Promise<void> {
  await app.register(fastifyStatic, { root, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found' });
  });
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
