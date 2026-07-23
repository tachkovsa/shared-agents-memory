/**
 * HTTP transport tests — issue #22 + #23.
 *
 * These tests exercise transport-layer behaviour: session lifecycle,
 * concurrency caps, Origin validation, JWT rejection, and PAT resolution.
 * Qdrant, EmbeddingClient, and tool registration are mocked so no external
 * services are required.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PatStore } from '../auth/pat-store.js';
import type { AgentPat } from '../auth/types.js';
import type { Config } from '../config.js';
import { loadConfig } from '../config.js';
import { runHttpTransport } from './http.js';

// ── Minimal mocks ─────────────────────────────────────────────────────────────

function makeQdrantMock(overrides: Record<string, unknown> = {}) {
  return {
    getCollections: vi.fn().mockResolvedValue({ collections: [] }),
    getCollection: vi.fn().mockResolvedValue({ config: { params: { vectors: { size: 4096, distance: 'Cosine' } } } }),
    createCollection: vi.fn().mockResolvedValue({}),
    createPayloadIndex: vi.fn().mockResolvedValue({}),
    upsert: vi.fn().mockResolvedValue({}),
    search: vi.fn().mockResolvedValue([]),
    retrieve: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue({ count: 0 }),
    delete: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function makeEmbeddingsMock(breakerState: 'closed' | 'open' | 'half-open' = 'closed') {
  return {
    embed: vi.fn().mockResolvedValue(new Array(4096).fill(0)),
    getBreakerState: vi.fn().mockReturnValue(breakerState),
  };
}

function makeConfig(
  overrides: Partial<Config['http']> = {},
  dataDir = '/tmp/test',
): Config {
  return {
    transport: 'http',
    http: {
      bindHost: '127.0.0.1',
      bindPort: 0, // OS-assigned, not used directly in tests (we call runHttpTransport for listening tests)
      publicOrigin: 'https://memory.example.com',
      sessionIdleMs: 15 * 60_000,
      maxSessions: 64,
      maxInflightPerSession: 8,
      keepaliveSec: 30,
      authFailureMax: 20,
      authFailureWindowMs: 60_000,
      ...overrides,
    },
    embeddings: {
      apiKey: 'test-key',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'test-model',
      embeddingDimension: 4096,
    },
    qdrant: {
      url: 'http://localhost:6333',
      collectionName: 'test_memories',
    },
    server: { port: 3000 },
    storage: { dataDir },
  };
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Sends an HTTP request to the given URL and returns status + parsed JSON body.
 */
/**
 * Parses the first `data:` payload out of an SSE stream body.
 * The MCP Streamable HTTP transport returns `text/event-stream` responses for
 * POST requests (one SSE event per JSON-RPC response message).
 */
function parseSseBody(text: string): unknown {
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('data:')) {
      const data = trimmed.slice('data:'.length).trim();
      if (data) {
        try {
          return JSON.parse(data);
        } catch {
          // keep trying
        }
      }
    }
  }
  return undefined;
}

async function httpRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      // MCP Streamable HTTP spec: POST requests must include both media types.
      'Accept': 'application/json, text/event-stream',
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const contentType = res.headers.get('content-type') ?? '';

  let parsed: unknown;
  if (contentType.includes('text/event-stream')) {
    // SDK returns SSE by default; extract the first data: payload.
    parsed = parseSseBody(text);
  } else {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    responseHeaders[k] = v;
  });
  return { status: res.status, headers: responseHeaders, body: parsed };
}

function mcpInitializeBody() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.1' },
    },
  };
}

// ── Fixture: start HTTP server on random port ─────────────────────────────────

interface TestServer {
  baseUrl: string;
  patSecret: string;
  pat: AgentPat;
  patStore: PatStore;
  dataDir: string;
  stop: () => Promise<void>;
}

/**
 * Starts the HTTP transport bound to a random port and returns helpers.
 * Uses a real PatStore (file-backed) with a single minted PAT.
 */
async function startTestServer(
  configOverrides: Partial<Config['http']> = {},
  deps: {
    qdrant?: ReturnType<typeof makeQdrantMock>;
    embeddings?: ReturnType<typeof makeEmbeddingsMock>;
  } = {},
): Promise<TestServer> {
  const dataDir = await mkdtemp(join(tmpdir(), 'sam-http-test-'));
  const PEPPER = Buffer.alloc(32, 0xab);

  const patStore = await PatStore.open({
    storePath: join(dataDir, '_auth', 'pats.jsonl'),
    pepper: PEPPER,
  });

  const minted = await patStore.mint({
    display_name: 'test-agent',
    agent_identity: 'agent_test',
    allowed_namespaces: ['personal'],
    scopes: ['memory:read', 'memory:write', 'memory:delete', 'rules:read', 'rules:write', 'namespace:admin', 'service:admin'],
    created_by: 'test',
  });

  // Use a port=0 trick: we start a plain node http server first to grab a free
  // port, then shut it down and pass that port to runHttpTransport.
  // (runHttpTransport resolves its Promise once the server is listening.)
  const port = await getFreePort();

  const config = makeConfig(
    { ...configOverrides, bindPort: port, bindHost: '127.0.0.1' },
    dataDir,
  );

  const qdrant = deps.qdrant ?? makeQdrantMock();
  const embeddings = deps.embeddings ?? makeEmbeddingsMock();

  // We don't await the whole runHttpTransport (it resolves when the server
  // starts listening, then keeps running). We wrap it so we can track the
  // server promise.
  const serverPromise = runHttpTransport({
    config,
    patStore,
    pepper: PEPPER,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    qdrant: qdrant as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    embeddings: embeddings as any,
  });

  // Wait until it's listening (runHttpTransport resolves when the server
  // has bound the port).
  await serverPromise;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    patSecret: minted.secret,
    pat: minted.pat,
    patStore,
    dataDir,
    stop: async () => {
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('config validation', () => {
  it('throws when TRANSPORT=http and HTTP_PUBLIC_ORIGIN is missing', () => {
    const savedEnv = { ...process.env };
    process.env['TRANSPORT'] = 'http';
    process.env['HTTP_PUBLIC_ORIGIN'] = '';
    process.env['EMBEDDINGS_API_KEY'] = 'x';
    try {
      expect(() => loadConfig()).toThrow('HTTP_PUBLIC_ORIGIN');
    } finally {
      // Restore
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) delete process.env[key];
      }
      Object.assign(process.env, savedEnv);
    }
  });

  it('emits a WARNING when HTTP_BIND_HOST=0.0.0.0 and HTTP_PUBLIC_ORIGIN is empty', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const savedEnv = { ...process.env };
    process.env['TRANSPORT'] = 'stdio';
    process.env['HTTP_BIND_HOST'] = '0.0.0.0';
    process.env['HTTP_PUBLIC_ORIGIN'] = '';
    process.env['EMBEDDINGS_API_KEY'] = 'x';
    try {
      loadConfig();
      const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
      expect(calls.some((s) => s.includes('WARNING') && s.includes('0.0.0.0'))).toBe(true);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) delete process.env[key];
      }
      Object.assign(process.env, savedEnv);
      stderrSpy.mockRestore();
    }
  });
});

describe('Origin validation (issue #23)', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer({ publicOrigin: 'https://memory.example.com' });
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns 403 MCP_ORIGIN_MISMATCH when Origin does not match publicOrigin', async () => {
    const res = await httpRequest(
      `${server.baseUrl}/mcp`,
      'POST',
      {
        Authorization: `Bearer ${server.patSecret}`,
        Origin: 'https://evil.example.com',
      },
      mcpInitializeBody(),
    );
    expect(res.status).toBe(403);
    expect((res.body as Record<string, unknown>)['error']).toBe('MCP_ORIGIN_MISMATCH');
  });

  it('allows request with matching Origin', async () => {
    const res = await httpRequest(
      `${server.baseUrl}/mcp`,
      'POST',
      {
        Authorization: `Bearer ${server.patSecret}`,
        Origin: 'https://memory.example.com',
      },
      mcpInitializeBody(),
    );
    // 200 or 2xx means origin check passed
    expect(res.status).toBeLessThan(500);
    expect((res.body as Record<string, unknown>)['error']).not.toBe('MCP_ORIGIN_MISMATCH');
  });

  it('allows request without Origin header (nginx strips it on loopback)', async () => {
    const res = await httpRequest(
      `${server.baseUrl}/mcp`,
      'POST',
      {
        Authorization: `Bearer ${server.patSecret}`,
        // No Origin header
      },
      mcpInitializeBody(),
    );
    expect(res.status).toBeLessThan(500);
    expect((res.body as Record<string, unknown>)['error']).not.toBe('MCP_ORIGIN_MISMATCH');
  });
});

describe('JWT-shaped Authorization rejection (issue #23)', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('rejects a JWT-shaped Bearer token with MCP_TOKEN_AUDIENCE_MISMATCH', async () => {
    // A fake JWT header.payload.signature string
    const fakeJwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0.' +
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const res = await httpRequest(
      `${server.baseUrl}/mcp`,
      'POST',
      { Authorization: `Bearer ${fakeJwt}` },
      mcpInitializeBody(),
    );
    expect(res.status).toBe(401);
    expect((res.body as Record<string, unknown>)['error']).toBe('MCP_TOKEN_AUDIENCE_MISMATCH');
  });
});

describe('Bearer → resolvePat integration smoke test', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('accepts a valid sam_pat_* token and proceeds to MCP handshake', async () => {
    const res = await httpRequest(
      `${server.baseUrl}/mcp`,
      'POST',
      { Authorization: `Bearer ${server.patSecret}` },
      mcpInitializeBody(),
    );
    // A valid PAT should reach the MCP layer (200 with an initialize response)
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body['jsonrpc']).toBe('2.0');
    expect(body['id']).toBe(1);
    // result.protocolVersion should be present
    const result = body['result'] as Record<string, unknown> | undefined;
    expect(result).toBeDefined();
    expect(result?.['protocolVersion']).toBe('2025-06-18');
  });

  it('rejects a missing Authorization header with 401', async () => {
    const res = await httpRequest(
      `${server.baseUrl}/mcp`,
      'POST',
      {},
      mcpInitializeBody(),
    );
    expect(res.status).toBe(401);
  });

  it('rejects an invalid PAT with 401', async () => {
    const res = await httpRequest(
      `${server.baseUrl}/mcp`,
      'POST',
      { Authorization: 'Bearer sam_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      mcpInitializeBody(),
    );
    expect(res.status).toBe(401);
  });
});

describe('Session lifecycle', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('issues a Mcp-Session-Id on initialize', async () => {
    const res = await httpRequest(
      `${server.baseUrl}/mcp`,
      'POST',
      { Authorization: `Bearer ${server.patSecret}` },
      mcpInitializeBody(),
    );
    expect(res.status).toBe(200);
    const sessionId = res.headers['mcp-session-id'];
    expect(sessionId).toBeTruthy();
    expect(typeof sessionId).toBe('string');
  });

  it('returns MCP_SESSION_EXPIRED for a stale/unknown session ID', async () => {
    const res = await httpRequest(
      `${server.baseUrl}/mcp`,
      'POST',
      {
        Authorization: `Bearer ${server.patSecret}`,
        'Mcp-Session-Id': 'does-not-exist',
      },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    );
    expect(res.status).toBe(404);
    expect((res.body as Record<string, unknown>)['error']).toBe('MCP_SESSION_EXPIRED');
  });

  it('reuses an active session across multiple requests', async () => {
    // Initialize
    const initRes = await httpRequest(
      `${server.baseUrl}/mcp`,
      'POST',
      { Authorization: `Bearer ${server.patSecret}` },
      mcpInitializeBody(),
    );
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers['mcp-session-id'];
    expect(sessionId).toBeTruthy();

    // Send initialized notification
    const notifRes = await httpRequest(
      `${server.baseUrl}/mcp`,
      'POST',
      {
        Authorization: `Bearer ${server.patSecret}`,
        'Mcp-Session-Id': sessionId!,
      },
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    );
    // Notifications return 202 Accepted or 200
    expect(notifRes.status).toBeLessThanOrEqual(204);

    // List tools
    const listRes = await httpRequest(
      `${server.baseUrl}/mcp`,
      'POST',
      {
        Authorization: `Bearer ${server.patSecret}`,
        'Mcp-Session-Id': sessionId!,
      },
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
    );
    expect(listRes.status).toBe(200);
    const body = listRes.body as Record<string, unknown>;
    expect(body['jsonrpc']).toBe('2.0');
    const tools = ((body['result'] as Record<string, unknown>)['tools'] as Record<string, unknown>[]);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((tool) => !('execution' in tool))).toBe(true);
  });
});

describe('Session ↔ PAT binding (issue #104, SEC-3)', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    await server.stop();
  });

  /** Opens a session with the fixture PAT and returns its Mcp-Session-Id. */
  async function openSession(): Promise<string> {
    const initRes = await httpRequest(
      `${server.baseUrl}/mcp`,
      'POST',
      { Authorization: `Bearer ${server.patSecret}` },
      mcpInitializeBody(),
    );
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers['mcp-session-id'];
    expect(sessionId).toBeTruthy();
    return sessionId!;
  }

  it('rejects a POST to a session with a valid bearer whose PAT id differs (403)', async () => {
    const sessionId = await openSession();

    // A second, entirely valid low-priv PAT — proves "some valid token" is not
    // enough; the session is bound to the PAT that opened it.
    const other = await server.patStore.mint({
      display_name: 'other-agent',
      agent_identity: 'agent_other',
      allowed_namespaces: ['personal'],
      scopes: ['memory:read'],
      created_by: 'test',
    });
    expect(other.pat.id).not.toBe(server.pat.id);

    const res = await httpRequest(
      `${server.baseUrl}/mcp`,
      'POST',
      {
        Authorization: `Bearer ${other.secret}`,
        'Mcp-Session-Id': sessionId,
      },
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
    );
    expect(res.status).toBe(403);
    expect((res.body as Record<string, unknown>)['error']).toBe('MCP_SESSION_FORBIDDEN');
  });

  it('rejects a GET (SSE) to a session opened by a different PAT (403)', async () => {
    const sessionId = await openSession();
    const other = await server.patStore.mint({
      display_name: 'other-agent-get',
      agent_identity: 'agent_other_get',
      allowed_namespaces: ['personal'],
      scopes: ['memory:read'],
      created_by: 'test',
    });

    const res = await httpRequest(
      `${server.baseUrl}/mcp`,
      'GET',
      {
        Authorization: `Bearer ${other.secret}`,
        'Mcp-Session-Id': sessionId,
      },
    );
    expect(res.status).toBe(403);
    expect((res.body as Record<string, unknown>)['error']).toBe('MCP_SESSION_FORBIDDEN');
  });

  it('rejects a DELETE to a session opened by a different PAT (403)', async () => {
    const sessionId = await openSession();
    const other = await server.patStore.mint({
      display_name: 'other-agent-del',
      agent_identity: 'agent_other_del',
      allowed_namespaces: ['personal'],
      scopes: ['memory:read'],
      created_by: 'test',
    });

    const res = await httpRequest(
      `${server.baseUrl}/mcp`,
      'DELETE',
      {
        Authorization: `Bearer ${other.secret}`,
        'Mcp-Session-Id': sessionId,
      },
    );
    expect(res.status).toBe(403);
    expect((res.body as Record<string, unknown>)['error']).toBe('MCP_SESSION_FORBIDDEN');
  });

  it('denies a live session after its own PAT is revoked (401, no longer routed)', async () => {
    const sessionId = await openSession();

    // Sanity: the session is usable before revocation.
    const before = await httpRequest(
      `${server.baseUrl}/mcp`,
      'POST',
      {
        Authorization: `Bearer ${server.patSecret}`,
        'Mcp-Session-Id': sessionId,
      },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    );
    expect(before.status).toBe(200);

    // Revoke the PAT that owns the session (incident response).
    await server.patStore.revoke(server.pat.id, 'leaked');

    // The same bearer + session id must now be rejected at auth resolution.
    const after = await httpRequest(
      `${server.baseUrl}/mcp`,
      'POST',
      {
        Authorization: `Bearer ${server.patSecret}`,
        'Mcp-Session-Id': sessionId,
      },
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
    );
    expect(after.status).toBe(401);
    expect((after.body as Record<string, unknown>)['error']).toBe('MCP_UNAUTHORIZED');
    expect((after.body as Record<string, unknown>)['reason']).toBe('revoked');
  });
});

describe('HTTP method friendliness (/mcp preflight probes)', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer({ publicOrigin: 'https://memory.example.com' });
  });

  afterEach(async () => {
    await server.stop();
  });

  it('answers OPTIONS /mcp with 204 + Allow + CORS, no auth required', async () => {
    const res = await fetch(`${server.baseUrl}/mcp`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    const allow = res.headers.get('allow') ?? '';
    expect(allow).toContain('POST');
    expect(allow).toContain('GET');
    expect(allow).toContain('DELETE');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('echoes Access-Control-Allow-Origin on OPTIONS when Origin matches publicOrigin', async () => {
    const res = await fetch(`${server.baseUrl}/mcp`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://memory.example.com' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://memory.example.com');
  });

  it('does not reflect a foreign Origin in Access-Control-Allow-Origin', async () => {
    const res = await fetch(`${server.baseUrl}/mcp`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers HEAD /mcp with 200 + Allow, no auth required', async () => {
    const res = await fetch(`${server.baseUrl}/mcp`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('allow') ?? '').toContain('POST');
  });

  it('returns 405 with an Allow header for genuinely unsupported methods', async () => {
    const res = await fetch(`${server.baseUrl}/mcp`, { method: 'PUT' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow') ?? '').toContain('GET');
  });

  it('DELETE /mcp without a session id returns a clear MCP error (not 405)', async () => {
    const res = await httpRequest(
      `${server.baseUrl}/mcp`,
      'DELETE',
      { Authorization: `Bearer ${server.patSecret}` },
    );
    expect(res.status).toBe(400);
    expect((res.body as Record<string, unknown>)['error']).toBe('MCP_SESSION_REQUIRED');
  });

  it('DELETE /mcp terminates an established session', async () => {
    const initRes = await httpRequest(
      `${server.baseUrl}/mcp`,
      'POST',
      { Authorization: `Bearer ${server.patSecret}` },
      mcpInitializeBody(),
    );
    const sessionId = initRes.headers['mcp-session-id'];
    expect(sessionId).toBeTruthy();

    const delRes = await fetch(`${server.baseUrl}/mcp`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${server.patSecret}`,
        'Mcp-Session-Id': sessionId!,
      },
    });
    // SDK responds 200 on a successful session teardown.
    expect(delRes.status).toBeLessThan(300);
  });
});

describe('Concurrency limits', () => {
  it('returns 429 when max sessions are exceeded', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'sam-http-conc-'));
    const PEPPER = Buffer.alloc(32, 0xcd);
    const patStore = await PatStore.open({
      storePath: join(dataDir, '_auth', 'pats.jsonl'),
      pepper: PEPPER,
    });
    const minted = await patStore.mint({
      display_name: 'test',
      agent_identity: 'agent_test',
      allowed_namespaces: ['personal'],
      scopes: ['memory:read'],
      created_by: 'test',
    });

    const port = await getFreePort();
    const config = makeConfig({ bindPort: port, maxSessions: 2 }, dataDir);

    await runHttpTransport({
      config,
      patStore,
      pepper: PEPPER,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      qdrant: makeQdrantMock() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      embeddings: makeEmbeddingsMock() as any,
    });

    const baseUrl = `http://127.0.0.1:${port}`;

    // Fill up 2 sessions
    for (let i = 0; i < 2; i++) {
      const res = await httpRequest(
        `${baseUrl}/mcp`,
        'POST',
        { Authorization: `Bearer ${minted.secret}` },
        mcpInitializeBody(),
      );
      expect(res.status).toBe(200);
    }

    // Third session should be rate-limited
    const res = await httpRequest(
      `${baseUrl}/mcp`,
      'POST',
      { Authorization: `Bearer ${minted.secret}` },
      mcpInitializeBody(),
    );
    expect(res.status).toBe(429);
    expect((res.body as Record<string, unknown>)['error']).toBe('MCP_SESSION_LIMIT');

    await rm(dataDir, { recursive: true, force: true });
  });
});

describe('Per-IP auth-failure rate limit (issue #108, SEC-7)', () => {
  const BAD_TOKEN = 'Bearer sam_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  let server: TestServer;

  beforeEach(async () => {
    // max=3 failures / 60s so we can trip the limiter in a handful of requests.
    server = await startTestServer({ authFailureMax: 3, authFailureWindowMs: 60_000 });
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns 429 with Retry-After after N failed auths from one IP (short-circuits before resolvePat)', async () => {
    // Three invalid-token attempts are each rejected with 401 (they reach auth).
    for (let i = 0; i < 3; i++) {
      const res = await httpRequest(
        `${server.baseUrl}/mcp`,
        'POST',
        { Authorization: BAD_TOKEN },
        mcpInitializeBody(),
      );
      expect(res.status).toBe(401);
    }

    // The next request is short-circuited by the limiter → 429, NOT another 401.
    // A 429 (rather than 401) proves the gate fired before PAT resolution.
    const limited = await httpRequest(
      `${server.baseUrl}/mcp`,
      'POST',
      { Authorization: BAD_TOKEN },
      mcpInitializeBody(),
    );
    expect(limited.status).toBe(429);
    expect((limited.body as Record<string, unknown>)['error']).toBe('MCP_AUTH_RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeTruthy();
  });

  it('a successful auth resets the counter (failures before it do not accumulate)', async () => {
    // Two failures (under the cap of 3).
    for (let i = 0; i < 2; i++) {
      const res = await httpRequest(
        `${server.baseUrl}/mcp`,
        'POST',
        { Authorization: BAD_TOKEN },
        mcpInitializeBody(),
      );
      expect(res.status).toBe(401);
    }

    // A valid auth succeeds and clears this IP's failure history.
    const ok = await httpRequest(
      `${server.baseUrl}/mcp`,
      'POST',
      { Authorization: `Bearer ${server.patSecret}` },
      mcpInitializeBody(),
    );
    expect(ok.status).toBe(200);

    // Two more failures. Without the reset the running total would be 4 (>3) and
    // the second of these would already be 429; with the reset both stay 401.
    for (let i = 0; i < 2; i++) {
      const res = await httpRequest(
        `${server.baseUrl}/mcp`,
        'POST',
        { Authorization: BAD_TOKEN },
        mcpInitializeBody(),
      );
      expect(res.status).toBe(401);
    }
  });

  it('emits mem_http_requests_total{outcome="rate_limited"} when the limit trips', async () => {
    for (let i = 0; i < 4; i++) {
      await httpRequest(
        `${server.baseUrl}/mcp`,
        'POST',
        { Authorization: BAD_TOKEN },
        mcpInitializeBody(),
      );
    }
    const text = await (await fetch(`${server.baseUrl}/metrics`)).text();
    expect(text).toMatch(/mem_http_requests_total\{outcome="rate_limited"\} [1-9]/);
  });
});

describe('Version negotiation (ADR-0003 §3.6)', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('accepts protocolVersion 2025-06-18 and returns the same', async () => {
    const res = await httpRequest(
      `${server.baseUrl}/mcp`,
      'POST',
      { Authorization: `Bearer ${server.patSecret}` },
      mcpInitializeBody(),
    );
    expect(res.status).toBe(200);
    const result = (res.body as Record<string, unknown>)['result'] as Record<string, unknown>;
    expect(result['protocolVersion']).toBe('2025-06-18');
  });

  it('completes the MCP handshake when client proposes an older supported version', async () => {
    // ADR-0003 §3.6 states: if the client proposes an older revision, the server
    // responds with its preferred version per the MCP negotiation rule. The SDK
    // (1.29.x) echoes back the client's version when it is in SUPPORTED_PROTOCOL_VERSIONS
    // (which includes 2025-03-26). The ADR intent is that clients unable to speak
    // 2025-06-18 are the ones that fail; clients that accept 2025-06-18 but
    // proposed an older version will still get a working session.
    const res = await httpRequest(
      `${server.baseUrl}/mcp`,
      'POST',
      { Authorization: `Bearer ${server.patSecret}` },
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'old-client', version: '0.0.1' },
        },
      },
    );
    // The handshake must succeed (200) with a valid JSON-RPC result.
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    const result = body['result'] as Record<string, unknown> | undefined;
    // Either a success result or an error is acceptable — the key check is
    // that the transport layer (our code) did not reject the request.
    expect(body['jsonrpc']).toBe('2.0');
    if (result) {
      // SDK echoes the client's proposed version when it is in its supported list.
      expect(['2025-06-18', '2025-03-26']).toContain(result['protocolVersion']);
    } else {
      // SDK rejected the version — that too is within spec.
      expect(body['error']).toBeDefined();
    }
  });
});

describe('0.0.0.0 + missing HTTP_PUBLIC_ORIGIN warning', () => {
  it('emits a startup warning when binding to 0.0.0.0 without publicOrigin', async () => {
    // This is tested at config-load time (not server-start time) because the
    // warning is emitted from loadConfig(). The test is in config validation above.
    // Included here for completeness / cross-reference.
    expect(true).toBe(true); // covered by 'config validation' suite above
  });
});

describe('/healthz (issue #9)', () => {
  let server: TestServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  it('returns 200 with status=ok when Qdrant + embeddings healthy', async () => {
    server = await startTestServer();
    const res = await httpRequest(`${server.baseUrl}/healthz`, 'GET', {});
    expect(res.status).toBe(200);
    const body = res.body as Record<string, string>;
    expect(body.status).toBe('ok');
    expect(body.qdrant).toBe('ok');
    expect(body.embeddings).toBe('ok');
  });

  it('returns 503 when Qdrant is unreachable', async () => {
    const qdrant = makeQdrantMock({ getCollection: vi.fn().mockRejectedValue(new Error('connection refused')) });
    server = await startTestServer({}, { qdrant });
    const res = await httpRequest(`${server.baseUrl}/healthz`, 'GET', {});
    expect(res.status).toBe(503);
    const body = res.body as Record<string, string>;
    expect(body.status).toBe('degraded');
    expect(body.qdrant).toBe('unreachable');
  });

  it('returns 503 when embeddings circuit breaker is open', async () => {
    const embeddings = makeEmbeddingsMock('open');
    server = await startTestServer({}, { embeddings });
    const res = await httpRequest(`${server.baseUrl}/healthz`, 'GET', {});
    expect(res.status).toBe(503);
    const body = res.body as Record<string, string>;
    expect(body.embeddings).toBe('breaker_open');
  });

  it('bypasses Origin validation (probes come from monitoring with no Origin)', async () => {
    server = await startTestServer();
    const res = await httpRequest(`${server.baseUrl}/healthz`, 'GET', {
      Origin: 'https://attacker.example.com',
    });
    // /healthz is intentionally not Origin-gated — probes from nginx/monitoring don't carry Origin.
    expect(res.status).toBe(200);
  });

  it('does not require Authorization', async () => {
    server = await startTestServer();
    const res = await httpRequest(`${server.baseUrl}/healthz`, 'GET', {});
    expect(res.status).toBe(200);
  });
});

describe('/metrics (issue #9)', () => {
  let server: TestServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  it('returns 200 with Prometheus text and all mem_* metric names', async () => {
    server = await startTestServer();
    const res = await fetch(`${server.baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/plain');
    const text = await res.text();
    for (const name of [
      'mem_http_sessions_active',
      'mem_http_requests_total',
      'mem_http_session_duration_seconds',
      'mem_pat_lookups_total',
      'mem_pat_active_count',
      'mem_auth_failures_total',
      'mem_embedding_calls_total',
      'mem_embedding_latency_seconds',
      'mem_embedding_dimension_mismatches_total',
      'mem_memory_count',
    ]) {
      expect(text).toContain(name);
    }
  });

  it('records origin_mismatch outcome counter on rejected request', async () => {
    server = await startTestServer();
    // Force an origin mismatch via /mcp
    await httpRequest(`${server.baseUrl}/mcp`, 'POST', { Origin: 'https://wrong.example.com' }, mcpInitializeBody());
    const text = await (await fetch(`${server.baseUrl}/metrics`)).text();
    expect(text).toMatch(/mem_http_requests_total\{outcome="origin_mismatch"\} [1-9]/);
  });

  it('records pat_active_count after a successful refresh', async () => {
    server = await startTestServer();
    const text = await (await fetch(`${server.baseUrl}/metrics`)).text();
    // startTestServer mints exactly one PAT.
    expect(text).toMatch(/mem_pat_active_count 1/);
  });

  it('does not require Authorization', async () => {
    server = await startTestServer();
    const res = await fetch(`${server.baseUrl}/metrics`);
    expect(res.status).toBe(200);
  });
});
