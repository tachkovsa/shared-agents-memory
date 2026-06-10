/**
 * Thin admin-API client. Holds the CSRF token in memory and attaches it to
 * mutating requests (double-submit, ADR-0007 §3.3). The session itself rides
 * in an HttpOnly cookie the browser sends automatically.
 */

const BASE = '/api/admin';

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

function qs(query?: RequestOptions['query']): string {
  if (!query) return '';
  const parts = Object.entries(query).filter(([, v]) => v !== undefined && v !== '');
  if (parts.length === 0) return '';
  return '?' + parts.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;

  const res = await fetch(`${BASE}${path}${qs(opts.query)}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const data: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const code =
      typeof data === 'object' && data !== null && 'error' in data
        ? String((data as { error: unknown }).error)
        : `http_${res.status}`;
    throw new ApiError(res.status, code);
  }
  return data as T;
}

// ── types ──────────────────────────────────────────────────────────────────

export type AgentScope =
  | 'memory:read'
  | 'memory:write'
  | 'memory:delete'
  | 'rules:read'
  | 'rules:write'
  | 'namespace:admin'
  | 'service:admin';

export interface PublicOperator {
  id: string;
  username: string;
  role: 'owner' | 'viewer';
  created_at: string;
  last_login_at: string | null;
}

interface SessionResponse {
  operator: PublicOperator;
  csrf_token: string;
}

export interface NamespaceSummary {
  id: string;
  display_name: string;
  owner_agent_id: string;
  retention_policy: Record<string, unknown>;
  dedup_threshold: number;
  quota: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface NamespaceMember {
  agent_id: string;
  scopes: AgentScope[];
  added_by: string;
  added_at: string;
}

export interface NamespaceDetail extends NamespaceSummary {
  visibility: string;
  members: NamespaceMember[];
}

export interface MemoryRecordView {
  id: string;
  namespace: string;
  agent_id: string;
  content: string;
  summary: string | null;
  tags: string[];
  source: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  retrieval_count: number;
  last_retrieved_at: string | null;
  decay_score: number;
  superseded_by: string | null;
  deleted_at: string | null;
  staleness_signal: string;
  verifies_against: Record<string, unknown> | null;
}

export interface MemorySearchHit extends MemoryRecordView {
  score: number;
}

export interface Pat {
  id: string;
  display_name: string;
  token_prefix: string;
  agent_identity: string;
  allowed_namespaces: string[];
  scopes: AgentScope[];
  created_at: string;
  created_by: string;
  expires_at: string | null;
  last_used_at: string | null;
  is_revoked: boolean;
  revoked_at: string | null;
  revoked_reason: string | null;
}

export interface RuleSummary {
  id: string;
  title: string;
  severity?: 'hard' | 'soft';
  enabled?: boolean;
  [k: string]: unknown;
}

export interface AuditEntry {
  event: string;
  ts?: string;
  [k: string]: unknown;
}

export interface Observability {
  health: { status: string; qdrant: string; embeddings_breaker: string; version: string };
  counts: { namespaces: number; memories: number | null; pats_total: number; pats_active: number };
  metrics: Record<string, { type: string; values: Array<{ labels?: Record<string, unknown>; value: number | null; series?: string }>; truncated?: boolean }>;
}

export interface Billing {
  plan: { id: string; name: string; price: string; status: string; renews_at?: string | null };
  included: string[];
  self_hosted: { name: string; price: string; note: string };
}

function rememberCsrf<T extends { csrf_token: string }>(res: T): T {
  setCsrfToken(res.csrf_token);
  return res;
}

export const api = {
  // ── auth ──
  async setupStatus(): Promise<{ needs_setup: boolean }> {
    return request('/setup/status');
  },
  async setup(input: { username: string; password: string; setup_token: string }): Promise<SessionResponse> {
    return rememberCsrf(await request<SessionResponse>('/setup', { method: 'POST', body: input }));
  },
  async login(input: { username: string; password: string; totp?: string }): Promise<SessionResponse> {
    return rememberCsrf(await request<SessionResponse>('/auth/login', { method: 'POST', body: input }));
  },
  async me(): Promise<SessionResponse> {
    return rememberCsrf(await request<SessionResponse>('/auth/me'));
  },
  async logout(): Promise<void> {
    await request('/auth/logout', { method: 'POST' });
    setCsrfToken(null);
  },

  // ── namespaces ──
  async namespaces(): Promise<{ namespaces: NamespaceSummary[] }> {
    return request('/namespaces');
  },
  async namespace(id: string): Promise<NamespaceDetail> {
    return request(`/namespaces/${encodeURIComponent(id)}`);
  },
  async createNamespace(input: { id: string; display_name: string; owner_agent_id: string }): Promise<NamespaceSummary> {
    return request('/namespaces', { method: 'POST', body: input });
  },
  async shareNamespace(id: string, input: { agent_id: string; scopes: AgentScope[] }): Promise<NamespaceMember> {
    return request(`/namespaces/${encodeURIComponent(id)}/members`, { method: 'POST', body: input });
  },
  async unshareNamespace(id: string, agentId: string): Promise<void> {
    await request(`/namespaces/${encodeURIComponent(id)}/members/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
  },

  // ── memory ──
  async memories(ns: string, opts: { limit?: number; cursor?: string; include_deleted?: boolean } = {}): Promise<{ memories: MemoryRecordView[]; next_cursor: string | null }> {
    return request(`/namespaces/${encodeURIComponent(ns)}/memories`, { query: opts });
  },
  async memory(ns: string, id: string): Promise<MemoryRecordView> {
    return request(`/namespaces/${encodeURIComponent(ns)}/memories/${encodeURIComponent(id)}`);
  },
  async searchMemories(ns: string, q: string, limit = 20): Promise<{ results: MemorySearchHit[]; latency_ms: number }> {
    return request(`/namespaces/${encodeURIComponent(ns)}/memories/search`, { query: { q, limit } });
  },
  async writeMemory(ns: string, input: { content: string; agent_id: string; tags?: string[]; summary?: string; source?: string }): Promise<MemoryRecordView> {
    return request(`/namespaces/${encodeURIComponent(ns)}/memories`, { method: 'POST', body: input });
  },
  async deleteMemory(ns: string, id: string): Promise<{ deleted: true; id: string }> {
    return request(`/namespaces/${encodeURIComponent(ns)}/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  // ── PAT ──
  async pats(): Promise<{ pats: Pat[] }> {
    return request('/pats');
  },
  async createPat(input: { display_name: string; agent_identity: string; allowed_namespaces: string[]; scopes: AgentScope[]; expires_at?: string | null }): Promise<{ pat: Pat; secret: string }> {
    return request('/pats', { method: 'POST', body: input });
  },
  async revokePat(id: string, reason?: string): Promise<Pat> {
    return request(`/pats/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: { reason } });
  },
  async rotatePat(id: string): Promise<{ pat: Pat; secret: string }> {
    return request(`/pats/${encodeURIComponent(id)}/rotate`, { method: 'POST', body: {} });
  },

  // ── rules ──
  async rules(ns: string): Promise<{ rules: RuleSummary[] }> {
    return request(`/namespaces/${encodeURIComponent(ns)}/rules`);
  },
  async rule(ns: string, ruleId: string): Promise<{ frontmatter: Record<string, unknown>; body: string }> {
    return request(`/namespaces/${encodeURIComponent(ns)}/rules/${encodeURIComponent(ruleId)}`);
  },
  async toggleRule(ns: string, ruleId: string, enabled: boolean): Promise<RuleSummary> {
    return request(`/namespaces/${encodeURIComponent(ns)}/rules/${encodeURIComponent(ruleId)}/toggle`, { method: 'POST', body: { enabled } });
  },

  // ── audit ──
  async audit(opts: { limit?: number; event?: string } = {}): Promise<{ entries: AuditEntry[]; count: number; truncated: boolean }> {
    return request('/audit', { query: opts });
  },

  // ── observability ──
  async observability(): Promise<Observability> {
    return request('/observability');
  },

  // ── billing ──
  async billing(): Promise<Billing> {
    return request('/billing');
  },
};
