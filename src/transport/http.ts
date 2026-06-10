/**
 * Streamable HTTP transport (Mode B — shared / multi-agent / production).
 *
 * ADR-0003 §3.3: POST /mcp + GET /mcp (SSE) via StreamableHTTPServerTransport.
 * Per-request Bearer PAT resolution. Session table with Mcp-Session-Id.
 * Origin header validation (issue #23). Concurrency caps.
 *
 * Design choice: one McpServer + one StreamableHTTPServerTransport per session
 * (Option A from the brief). Each session gets its own McpServer instance
 * constructed with the resolved PAT from the initialize request. This is the
 * simplest correct approach for v1: no shared mutable state, clear isolation
 * per agent connection, and it maps cleanly to how the SDK manages session
 * state internally (each transport instance is its own state machine).
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createId } from '@paralleldrive/cuid2';
import type { QdrantClient } from '@qdrant/js-client-rest';
import {
  AuthAuditWriter,
  AuthError,
  PatStore,
  auditPathForDataDir,
  registerPatTools,
  resolvePat,
  resolveSampleRate,
} from '../auth/index.js';
import type { AgentPat } from '../auth/types.js';
import type { Config } from '../config.js';
import { EmbeddingClient } from '../embeddings.js';
import {
  DEDUP_DEFAULT_THRESHOLD,
  DEFAULT_DECAY_WEIGHT,
  DecaySweeper,
  MemoryService,
  ReinforcementBuffer,
  registerMemoryTools,
} from '../memory/index.js';
import { StalenessAuditor } from '../lifecycle/staleness.js';
import {
  authFailuresTotal,
  httpRequestsTotal,
  httpSessionDurationSeconds,
  httpSessionsActive,
  memoryCount,
  patActiveCount,
  patLookupsTotal,
} from '../metrics/registry.js';
import { resolveLifecycle } from '../namespaces/defaults.js';
import { makeOrphanPruneCallback, registerNamespaceTools } from '../namespaces/tools.js';
import { listNamespaceIds, loadNamespace } from '../namespaces/store.js';
import { initCollection, quantizationSearchParams } from '../qdrant.js';
import { registerRuleTools } from '../rules/index.js';
import { omitDefaultForbiddenToolExecution } from './codex-compat.js';

// ── Error types ──────────────────────────────────────────────────────────────

export class HttpTransportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpTransportError';
  }
}

// ── Session record ────────────────────────────────────────────────────────────

interface SessionRecord {
  sessionId: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  pat: AgentPat;
  /** Monotonic ms timestamp of last request to this session. */
  lastActivityAt: number;
  /** Number of currently in-flight tool calls. */
  inflight: number;
  /** Monotonic ms timestamp of when the session was created (for duration histogram). */
  startedAt: number;
}

// ── Healthz cache (avoid hammering Qdrant per probe) ─────────────────────────

interface HealthzCache {
  ok: boolean;
  reason?: string;
  at: number;
}

const HEALTHZ_CACHE_TTL_MS = 5_000;

// ── HTTP transport deps ───────────────────────────────────────────────────────

export interface HttpTransportDeps {
  config: Config;
  patStore: PatStore;
  pepper: Buffer;
  qdrant: QdrantClient;
  embeddings: EmbeddingClient;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true if the value looks like a JWT (three base64url segments
 * separated by dots starting with "eyJ"). We reject these because we only
 * accept sam_pat_* PATs — a JWT indicates a misrouted client using a
 * different credential model.
 */
function looksLikeJwt(value: string): boolean {
  // JWT header always base64-encodes to "eyJ..."
  return /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(value.trim());
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Methods the MCP Streamable HTTP endpoint accepts.
 *
 * POST   — JSON-RPC request/response (initialize, tools/list, tools/call …)
 * GET    — open the server→client SSE stream for an existing session
 * DELETE — terminate a session (MCP spec §Streamable HTTP; handled by the SDK)
 * HEAD   — liveness/capability probe (answered without auth)
 * OPTIONS — CORS preflight / capability probe (answered without auth)
 *
 * Advertised via the `Allow` header on 405 responses and on HEAD/OPTIONS so
 * clients that probe the endpoint before the handshake (e.g. the Codex CLI,
 * `codex doctor`, browsers) don't see a bare 405 and give up. RFC 9110 §10.2.1
 * requires the `Allow` header on every 405.
 */
const MCP_ALLOWED_METHODS = 'GET, POST, DELETE, HEAD, OPTIONS';

/**
 * Applies CORS headers to a /mcp response. The `Access-Control-Allow-Origin`
 * value is only echoed when the request Origin matches the configured public
 * origin — we never reflect an arbitrary Origin, preserving the anti-DNS-
 * rebinding guarantee from issue #23. Non-browser clients (Codex, Claude Code)
 * send no Origin and are unaffected; these headers exist purely so browser-based
 * MCP clients can complete a preflight.
 */
function applyMcpCorsHeaders(
  res: ServerResponse,
  requestOrigin: string | undefined,
  publicOrigin: string | undefined,
): void {
  if (requestOrigin && publicOrigin && requestOrigin === publicOrigin) {
    res.setHeader('Access-Control-Allow-Origin', publicOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', MCP_ALLOWED_METHODS);
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
  );
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  res.setHeader('Access-Control-Max-Age', '600');
}

// ── Session factory ───────────────────────────────────────────────────────────

/**
 * Creates a fully-wired McpServer + StreamableHTTPServerTransport pair for the
 * given PAT. The session ID is generated here and stored on the transport.
 */
function createSession(
  sessionId: string,
  pat: AgentPat,
  deps: HttpTransportDeps,
  auditor: AuthAuditWriter,
  reinforcement: ReinforcementBuffer,
  onSessionClosed: (sessionId: string) => void,
): SessionRecord {
  const { config, patStore, pepper, qdrant, embeddings } = deps;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    onsessioninitialized: () => {
      /* session was already registered before connect() */
    },
    onsessionclosed: () => {
      onSessionClosed(sessionId);
    },
  });

  const server = new McpServer({
    name: 'shared-agents-memory',
    version: '0.1.0',
  });

  const memoryService = new MemoryService({
    qdrant,
    embeddings,
    collection: config.qdrant.collectionName,
    dataDir: config.storage.dataDir,
    loadDedupThreshold: async (ns) =>
      (await loadNamespace(config.storage.dataDir, ns))?.dedup_threshold ??
      DEDUP_DEFAULT_THRESHOLD,
    loadDecayWeight: async (ns) => {
      const namespace = await loadNamespace(config.storage.dataDir, ns);
      return namespace ? resolveLifecycle(namespace).decay_weight : DEFAULT_DECAY_WEIGHT;
    },
    searchParams: quantizationSearchParams(config.qdrant.quantization),
  });

  registerMemoryTools(server, {
    service: memoryService,
    sessionPat: pat,
    auditor,
    dataDir: config.storage.dataDir,
    reinforcement,
  });

  const mcpSessionId = createId();

  registerPatTools(server, {
    patStore,
    sessionPat: pat,
    auditor,
    sessionId: mcpSessionId,
    pepper,
    onPatRevoked: makeOrphanPruneCallback(patStore, config.storage.dataDir, auditor),
  });

  registerNamespaceTools(server, {
    patStore,
    sessionPat: pat,
    auditor,
    sessionId: mcpSessionId,
    pepper,
    dataDir: config.storage.dataDir,
  });

  registerRuleTools(server, {
    sessionPat: pat,
    auditor,
    dataDir: config.storage.dataDir,
  });

  omitDefaultForbiddenToolExecution(server);

  // Connect is async but we fire it without awaiting — the transport.handleRequest
  // call for the initialize request will queue correctly because the SDK transport
  // buffers messages until start() completes (which is a no-op for StreamableHTTP).
  server.connect(transport).catch((err: unknown) => {
    process.stderr.write(`[http-transport] session ${sessionId} connect error: ${String(err)}\n`);
  });

  return {
    sessionId,
    transport,
    server,
    pat,
    lastActivityAt: Date.now(),
    startedAt: Date.now(),
    inflight: 0,
  };
}

// ── Main entry ────────────────────────────────────────────────────────────────

export async function runHttpTransport(deps: HttpTransportDeps): Promise<void> {
  const { config, patStore, qdrant } = deps;
  const { http } = config;

  await initCollection(qdrant, config.qdrant.collectionName, {
    dimension: config.embeddings.embeddingDimension,
    quantization: config.qdrant.quantization,
  });

  const auditor = new AuthAuditWriter({
    path: auditPathForDataDir(config.storage.dataDir),
    successSampleRate: resolveSampleRate(process.env),
  });

  // Shared reinforcement buffer (ADR-0006 §3.3) — one per process, not per session.
  const reinforcement = new ReinforcementBuffer({
    qdrant,
    collection: config.qdrant.collectionName,
  });
  reinforcement.start();

  // Per-namespace decay sweep (ADR-0006 §3.4) — one daily cron per process.
  const decaySweeper = new DecaySweeper({
    qdrant,
    collection: config.qdrant.collectionName,
    dataDir: config.storage.dataDir,
  });
  decaySweeper.start();

  // Shared staleness auditor (ADR-0006 §3.6) — one per process, nightly sweep.
  const stalenessAuditor = new StalenessAuditor({
    qdrant,
    collection: config.qdrant.collectionName,
    dataDir: config.storage.dataDir,
  });
  stalenessAuditor.start();

  // ── Session table ──────────────────────────────────────────────────────────

  const sessions = new Map<string, SessionRecord>();

  function removeSession(sessionId: string): void {
    const rec = sessions.get(sessionId);
    if (rec) {
      sessions.delete(sessionId);
      // Record session lifetime in the histogram.
      const durationSec = (Date.now() - rec.startedAt) / 1000;
      httpSessionDurationSeconds.observe(durationSec);
      httpSessionsActive.dec();
      rec.transport.close().catch(() => { /* best-effort */ });
    }
  }

  // ── Healthz cache ──────────────────────────────────────────────────────────

  let healthzCache: HealthzCache | null = null;

  async function checkHealth(): Promise<HealthzCache> {
    const now = Date.now();
    if (healthzCache && now - healthzCache.at < HEALTHZ_CACHE_TTL_MS) {
      return healthzCache;
    }

    // Check Qdrant (cheap: getCollection call)
    try {
      await qdrant.getCollection(config.qdrant.collectionName);
    } catch (err) {
      const result: HealthzCache = {
        ok: false,
        reason: `qdrant_unreachable: ${String(err)}`,
        at: now,
      };
      healthzCache = result;
      return result;
    }

    // Check embedding circuit breaker state via the EmbeddingClient
    const embeddingsStatus = deps.embeddings.getBreakerState?.() ?? 'unknown';
    if (embeddingsStatus === 'open') {
      const result: HealthzCache = {
        ok: false,
        reason: 'embeddings_breaker_open',
        at: now,
      };
      healthzCache = result;
      return result;
    }

    const result: HealthzCache = { ok: true, at: now };
    healthzCache = result;
    return result;
  }

  // Idle-expiry sweeper: runs every minute.
  const idleSweepInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, rec] of sessions) {
      if (now - rec.lastActivityAt > http.sessionIdleMs) {
        process.stderr.write(`[http-transport] session ${id} expired (idle)\n`);
        removeSession(id);
      }
    }
  }, 60_000);
  idleSweepInterval.unref(); // don't keep the process alive

  // ── SSE keepalive ──────────────────────────────────────────────────────────
  // Individual SSE keepalives are sent per GET /mcp connection via sseClients.

  const sseClients = new Set<ServerResponse>();

  const keepaliveInterval = setInterval(() => {
    for (const res of sseClients) {
      try {
        res.write(':ping\n\n');
      } catch {
        sseClients.delete(res);
      }
    }
  }, http.keepaliveSec * 1000);
  keepaliveInterval.unref();

  // ── Request handler ────────────────────────────────────────────────────────

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // ── /healthz — no auth, no origin check ────────────────────────────────
    if (req.url === '/healthz' && req.method?.toUpperCase() === 'GET') {
      const health = await checkHealth();
      if (health.ok) {
        const embeddingsBreakerState = deps.embeddings.getBreakerState?.() ?? 'unknown';
        const embeddingsStatus =
          embeddingsBreakerState === 'open'
            ? 'breaker_open'
            : embeddingsBreakerState === 'half-open'
              ? 'ok'
              : embeddingsBreakerState === 'closed'
                ? 'ok'
                : 'untested';
        sendJson(res, 200, { status: 'ok', qdrant: 'ok', embeddings: embeddingsStatus });
      } else {
        const qdrantStatus = health.reason?.startsWith('qdrant') ? 'unreachable' : 'ok';
        const embeddingsStatus = health.reason?.startsWith('embeddings') ? 'breaker_open' : 'ok';
        sendJson(res, 503, {
          status: 'degraded',
          qdrant: qdrantStatus,
          embeddings: embeddingsStatus,
          reason: health.reason,
        });
      }
      return;
    }

    // ── /metrics — no auth, no origin check ───────────────────────────────
    if (req.url === '/metrics' && req.method?.toUpperCase() === 'GET') {
      const { register } = await import('../metrics/registry.js');
      const metricsText = await register.metrics();
      const contentType = register.contentType;
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': Buffer.byteLength(metricsText),
      });
      res.end(metricsText);
      return;
    }

    // Only handle /mcp path for all other requests.
    if (req.url !== '/mcp') {
      sendJson(res, 404, { error: 'NOT_FOUND' });
      return;
    }

    const method = req.method?.toUpperCase();
    const origin = req.headers['origin'];

    // ── OPTIONS — CORS preflight / capability probe (no auth) ─────────────────
    // Browsers preflight before the MCP handshake; some MCP clients (and
    // `codex doctor`) probe the endpoint before sending `initialize`. Answer
    // with the allowed methods so they never see a bare 405.
    if (method === 'OPTIONS') {
      applyMcpCorsHeaders(res, origin, http.publicOrigin);
      res.writeHead(204, { 'Allow': MCP_ALLOWED_METHODS });
      res.end();
      return;
    }

    // ── HEAD — liveness/capability probe (no auth, no body) ───────────────────
    // Advertises that /mcp exists and which methods it accepts. Without this a
    // HEAD probe falls through to 405 and clients like the Codex CLI treat the
    // server as incompatible before ever attempting `initialize`.
    if (method === 'HEAD') {
      applyMcpCorsHeaders(res, origin, http.publicOrigin);
      res.writeHead(200, { 'Allow': MCP_ALLOWED_METHODS, 'Content-Type': 'application/json' });
      res.end();
      return;
    }

    if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
      res.setHeader('Allow', MCP_ALLOWED_METHODS);
      sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      return;
    }

    // ── Origin validation (issue #23) ────────────────────────────────────────
    if (origin !== undefined) {
      if (!http.publicOrigin || origin !== http.publicOrigin) {
        httpRequestsTotal.inc({ outcome: 'origin_mismatch' });
        sendJson(res, 403, { error: 'MCP_ORIGIN_MISMATCH' });
        return;
      }
    }

    // Echo CORS headers on the real POST/GET/DELETE responses so browser-based
    // MCP clients can read them (no-op for header-less CLI clients).
    applyMcpCorsHeaders(res, origin, http.publicOrigin);

    // ── Authorization ────────────────────────────────────────────────────────
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      httpRequestsTotal.inc({ outcome: 'auth_failure' });
      authFailuresTotal.inc({ reason: 'missing' });
      sendJson(res, 401, { error: 'MCP_UNAUTHORIZED', message: 'Authorization header required' });
      return;
    }

    // Reject JWT-shaped tokens (defence vs credential misrouting, ADR-0003 §3.3).
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
    const rawSecret = bearerMatch ? bearerMatch[1].trim() : '';

    if (!rawSecret) {
      httpRequestsTotal.inc({ outcome: 'auth_failure' });
      authFailuresTotal.inc({ reason: 'malformed' });
      sendJson(res, 401, { error: 'MCP_UNAUTHORIZED', message: 'Bearer token missing' });
      return;
    }

    if (looksLikeJwt(rawSecret)) {
      httpRequestsTotal.inc({ outcome: 'auth_failure' });
      authFailuresTotal.inc({ reason: 'malformed' });
      sendJson(res, 401, { error: 'MCP_TOKEN_AUDIENCE_MISMATCH', message: 'JWT credentials are not accepted; use a sam_pat_* token' });
      return;
    }

    let pat: AgentPat;
    try {
      pat = resolvePat(patStore, rawSecret);
      patLookupsTotal.inc({ outcome: 'success' });
    } catch (err) {
      if (err instanceof AuthError) {
        patLookupsTotal.inc({ outcome: err.reason });
        httpRequestsTotal.inc({ outcome: 'auth_failure' });
        authFailuresTotal.inc({ reason: err.reason });
        sendJson(res, 401, { error: 'MCP_UNAUTHORIZED', message: err.message, reason: err.reason });
        return;
      }
      throw err;
    }

    // ── Session routing ───────────────────────────────────────────────────────
    const sessionIdHeader = req.headers['mcp-session-id'] as string | undefined;

    // GET requests open SSE streams and must reference an existing session.
    if (method === 'GET') {
      if (!sessionIdHeader) {
        httpRequestsTotal.inc({ outcome: '4xx' });
        sendJson(res, 400, { error: 'MCP_SESSION_REQUIRED', message: 'Mcp-Session-Id header required for GET' });
        return;
      }
      const rec = sessions.get(sessionIdHeader);
      if (!rec) {
        httpRequestsTotal.inc({ outcome: 'session_expired' });
        sendJson(res, 404, { error: 'MCP_SESSION_EXPIRED', message: 'Session not found or expired' });
        return;
      }
      rec.lastActivityAt = Date.now();
      sseClients.add(res);
      res.on('close', () => sseClients.delete(res));
      httpRequestsTotal.inc({ outcome: '2xx' });
      await rec.transport.handleRequest(req, res);
      return;
    }

    // DELETE terminates a session (MCP Streamable HTTP spec). The SDK transport
    // performs the teardown; our onsessionclosed hook then prunes the record.
    if (method === 'DELETE') {
      if (!sessionIdHeader) {
        httpRequestsTotal.inc({ outcome: '4xx' });
        sendJson(res, 400, { error: 'MCP_SESSION_REQUIRED', message: 'Mcp-Session-Id header required for DELETE' });
        return;
      }
      const rec = sessions.get(sessionIdHeader);
      if (!rec) {
        httpRequestsTotal.inc({ outcome: 'session_expired' });
        sendJson(res, 404, { error: 'MCP_SESSION_EXPIRED', message: 'Session not found or expired' });
        return;
      }
      rec.lastActivityAt = Date.now();
      httpRequestsTotal.inc({ outcome: '2xx' });
      await rec.transport.handleRequest(req, res);
      return;
    }

    // POST: if a session ID is provided, route to the existing session.
    if (sessionIdHeader) {
      const rec = sessions.get(sessionIdHeader);
      if (!rec) {
        httpRequestsTotal.inc({ outcome: 'session_expired' });
        sendJson(res, 404, { error: 'MCP_SESSION_EXPIRED', message: 'Session not found or expired' });
        return;
      }

      // Concurrency cap: max in-flight tool calls per session.
      if (rec.inflight >= http.maxInflightPerSession) {
        httpRequestsTotal.inc({ outcome: 'inflight_limit' });
        res.setHeader('Retry-After', '5');
        sendJson(res, 429, {
          error: 'MCP_INFLIGHT_LIMIT',
          message: `Max ${http.maxInflightPerSession} in-flight calls per session`,
        });
        return;
      }

      rec.lastActivityAt = Date.now();
      rec.inflight++;
      try {
        await rec.transport.handleRequest(req, res);
        httpRequestsTotal.inc({ outcome: '2xx' });
      } finally {
        rec.inflight--;
      }
      return;
    }

    // POST without session ID: this must be an initialize request.
    // Check session concurrency cap before creating a new session.
    if (sessions.size >= http.maxSessions) {
      httpRequestsTotal.inc({ outcome: 'session_limit' });
      res.setHeader('Retry-After', '30');
      sendJson(res, 429, {
        error: 'MCP_SESSION_LIMIT',
        message: `Max ${http.maxSessions} concurrent sessions`,
      });
      return;
    }

    // Create a new session.
    const newSessionId = randomUUID();
    const rec = createSession(
      newSessionId,
      pat,
      deps,
      auditor,
      reinforcement,
      (id) => {
        removeSession(id);
      },
    );
    sessions.set(newSessionId, rec);
    httpSessionsActive.inc();

    rec.inflight++;
    try {
      await rec.transport.handleRequest(req, res);
      httpRequestsTotal.inc({ outcome: '2xx' });
    } finally {
      rec.inflight--;
    }
  }

  // ── Namespace memory-count refresher ──────────────────────────────────────
  // Periodically updates mem_memory_count{namespace} gauges.
  // Runs every 60s; unref'd so it doesn't keep the process alive.

  async function refreshMemoryCountGauges(): Promise<void> {
    try {
      const nsIds = await listNamespaceIds(config.storage.dataDir);
      for (const nsId of nsIds) {
        try {
          const result = await qdrant.count(config.qdrant.collectionName, {
            filter: {
              must: [{ key: 'namespace', match: { value: nsId } }],
            },
          });
          memoryCount.set({ namespace: nsId }, result.count);
        } catch {
          // Best-effort; skip this namespace if Qdrant is unavailable.
        }
      }
    } catch {
      // Best-effort; skip if dataDir is unreadable.
    }
  }

  const memCountRefreshInterval = setInterval(() => {
    refreshMemoryCountGauges().catch(() => { /* best-effort */ });
  }, 60_000);
  memCountRefreshInterval.unref();

  // ── Active PAT count gauge ───────────────────────────────────────────────
  function refreshPatActiveCount(): void {
    const nowMs = Date.now();
    const active = patStore.list().filter((pat) => {
      if (pat.is_revoked) return false;
      if (pat.expires_at && Date.parse(pat.expires_at) <= nowMs) return false;
      return true;
    }).length;
    patActiveCount.set(active);
  }
  refreshPatActiveCount();
  const patCountRefreshInterval = setInterval(refreshPatActiveCount, 60_000);
  patCountRefreshInterval.unref();

  // ── HTTP server ────────────────────────────────────────────────────────────

  return new Promise<void>((resolve, reject) => {
    const httpServer = createServer((req, res) => {
      handleRequest(req, res).catch((err: unknown) => {
        process.stderr.write(`[http-transport] unhandled error: ${String(err)}\n`);
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'INTERNAL_ERROR' });
        }
      });
    });

    httpServer.on('error', reject);

    httpServer.listen(http.bindPort, http.bindHost, () => {
      process.stderr.write(
        `[http-transport] listening on http://${http.bindHost}:${http.bindPort}/mcp\n`,
      );
      resolve();
    });

    // Graceful shutdown on SIGTERM / SIGINT.
    // Increase max listeners to avoid spurious warnings when multiple server
    // instances exist in the same process (e.g. test suite with many describe blocks).
    const currentMax = process.getMaxListeners();
    process.setMaxListeners(currentMax + 2);

    const shutdown = () => {
      clearInterval(idleSweepInterval);
      clearInterval(keepaliveInterval);
      clearInterval(memCountRefreshInterval);
      clearInterval(patCountRefreshInterval);
      void reinforcement.stop();
      void decaySweeper.stop();
      void stalenessAuditor.stop();
      for (const [id] of sessions) {
        removeSession(id);
      }
      httpServer.close();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  });
}
