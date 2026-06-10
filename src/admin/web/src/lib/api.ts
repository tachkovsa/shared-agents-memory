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
  method?: 'GET' | 'POST';
  body?: unknown;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;

  const res = await fetch(`${BASE}${path}`, {
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

function rememberCsrf<T extends { csrf_token: string }>(res: T): T {
  setCsrfToken(res.csrf_token);
  return res;
}

export const api = {
  async setupStatus(): Promise<{ needs_setup: boolean }> {
    return request('/setup/status');
  },
  async setup(input: {
    username: string;
    password: string;
    setup_token: string;
  }): Promise<SessionResponse> {
    return rememberCsrf(await request<SessionResponse>('/setup', { method: 'POST', body: input }));
  },
  async login(input: {
    username: string;
    password: string;
    totp?: string;
  }): Promise<SessionResponse> {
    return rememberCsrf(
      await request<SessionResponse>('/auth/login', { method: 'POST', body: input }),
    );
  },
  async me(): Promise<SessionResponse> {
    return rememberCsrf(await request<SessionResponse>('/auth/me'));
  },
  async logout(): Promise<void> {
    await request('/auth/logout', { method: 'POST' });
    setCsrfToken(null);
  },
};
