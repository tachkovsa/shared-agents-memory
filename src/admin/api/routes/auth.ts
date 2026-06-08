import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SessionService, SetupClosedError } from '../../auth/session-service.js';
import { loginSchema, setupSchema } from '../../shared/schemas.js';
import type { Operator, OperatorRepository } from '../../stores/types.js';
import { SESSION_COOKIE, type PreHandler } from '../app.js';

export interface AuthRouteDeps {
  sessions: SessionService;
  operators: OperatorRepository;
  requireAuth: PreHandler;
  cookieSecure: boolean;
  loginRateLimit: { max: number; timeWindow: string };
}

interface PublicOperator {
  id: string;
  username: string;
  role: Operator['role'];
  created_at: string;
  last_login_at: string | null;
}

function publicOperator(operator: Operator): PublicOperator {
  return {
    id: operator.id,
    username: operator.username,
    role: operator.role,
    created_at: operator.created_at,
    last_login_at: operator.last_login_at,
  };
}

function sessionContext(req: FastifyRequest) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] ?? null };
}

function setSessionCookie(
  reply: FastifyReply,
  sessionId: string,
  secure: boolean,
  expiresIso: string,
): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: 'strict',
    expires: new Date(expiresIso),
  });
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { sessions, operators, requireAuth, cookieSecure, loginRateLimit } = deps;
  const rl = { config: { rateLimit: loginRateLimit } };

  app.get('/api/admin/setup/status', async () => ({
    needs_setup: await sessions.needsSetup(),
  }));

  app.post('/api/admin/setup', rl, async (req, reply) => {
    const parsed = setupSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.issues });
    }
    let operator: Operator;
    try {
      operator = await sessions.createFirstOperator(parsed.data);
    } catch (err) {
      if (err instanceof SetupClosedError) {
        return reply.code(409).send({ error: 'setup_closed' });
      }
      throw err;
    }
    const session = await sessions.createSession(operator.id, sessionContext(req));
    setSessionCookie(reply, session.id, cookieSecure, session.absolute_expires_at);
    return reply
      .code(201)
      .send({ operator: publicOperator(operator), csrf_token: session.csrf_token });
  });

  app.post('/api/admin/auth/login', rl, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input' });
    }
    const result = await sessions.login(parsed.data, sessionContext(req));
    if (!result.ok) {
      return reply.code(401).send({ error: result.reason });
    }
    setSessionCookie(reply, result.session.id, cookieSecure, result.session.absolute_expires_at);
    return reply.send({
      operator: publicOperator(result.operator),
      csrf_token: result.session.csrf_token,
    });
  });

  app.post('/api/admin/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    await sessions.logout(req.principal!.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  app.get('/api/admin/auth/me', { preHandler: requireAuth }, async (req, reply) => {
    const operator = await operators.getById(req.principal!.operatorId);
    if (!operator) {
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    return reply.send({
      operator: publicOperator(operator),
      csrf_token: req.principal!.csrfToken,
    });
  });
}
