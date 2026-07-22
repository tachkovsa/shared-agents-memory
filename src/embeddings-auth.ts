/**
 * Pluggable authorization for the OpenAI-compatible EmbeddingClient.
 *
 * Most providers (OpenRouter, OpenAI, vLLM, TEI, …) authenticate with a single
 * static `Authorization: Bearer <key>` header. Sber's GigaChat instead requires
 * an OAuth2 exchange: a static "Authorization key" (Basic) is traded at the NGW
 * endpoint for a short-lived access token (~30 min). The EmbeddingClient stays
 * provider-agnostic by asking an AuthProvider for the request headers on every
 * call; the token cache lives here.
 *
 * GigaChat endpoints are signed by the Russian Ministry of Digital Development
 * (Минцифры) root CA, which Node does not trust by default. The operator must
 * point NODE_EXTRA_CA_CERTS at that CA bundle (see certs/README.md); this module
 * only handles the token flow.
 *
 * Ported from hcm-guru's `lib/gigachat.ts` token manager, adapted to the
 * per-instance-cache + injectable-fetch style used across this codebase.
 */

import type { FetchImpl } from './embeddings.js';

/** Supplies the auth headers merged into each embeddings request. */
export interface EmbeddingAuthProvider {
  /**
   * Resolve the headers to attach to an embeddings request. `signal` is
   * forwarded into any cold-cache token exchange so the caller's timeout /
   * abort cancels a hung OAuth fetch too.
   */
  authHeaders(signal?: AbortSignal): Promise<Record<string, string>>;
}

/** Static `Authorization: Bearer <key>` — the default for OpenAI-compatible APIs. */
export class StaticBearerAuth implements EmbeddingAuthProvider {
  constructor(private readonly apiKey: string) {}

  authHeaders(): Promise<Record<string, string>> {
    return Promise.resolve({ Authorization: `Bearer ${this.apiKey}` });
  }
}

// ---------------------------------------------------------------------------
// GigaChat OAuth2
// ---------------------------------------------------------------------------

/** NGW OAuth endpoint that mints access tokens from the Basic authorization key. */
const GIGACHAT_OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';

/**
 * Access tokens live ~30 min; refresh at 25 to stay clear of the boundary.
 * Matches hcm-guru's margin.
 */
const GIGACHAT_TOKEN_TTL_MS = 25 * 60 * 1000;

export interface GigaChatAuthOptions {
  /** Base64 "Authorization key" from the GigaChat cabinet (used as Basic auth). */
  apiKey: string;
  /** API scope: GIGACHAT_API_PERS (personal), GIGACHAT_API_B2B, or _CORP. */
  scope?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchImpl;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * Exchanges a GigaChat Basic key for a Bearer access token and caches it until
 * shortly before expiry. The cache is per instance (per apiKey+scope), so
 * distinct provider configs never share a token.
 */
export class GigaChatAuth implements EmbeddingAuthProvider {
  private readonly apiKey: string;
  private readonly scope: string;
  private readonly fetchImpl: FetchImpl;
  private readonly now: () => number;
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(opts: GigaChatAuthOptions) {
    this.apiKey = opts.apiKey;
    this.scope = opts.scope ?? 'GIGACHAT_API_PERS';
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? (() => Date.now());
  }

  async authHeaders(signal?: AbortSignal): Promise<Record<string, string>> {
    const token = await this.getToken(signal);
    return { Authorization: `Bearer ${token}` };
  }

  /** Returns a cached token when fresh, otherwise fetches and caches a new one. */
  private async getToken(signal?: AbortSignal): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAt) {
      return this.cached.token;
    }

    const res = await this.fetchImpl(GIGACHAT_OAUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: `Basic ${this.apiKey}`,
        // RqUID must be a unique UUID per request per the GigaChat spec.
        RqUID: crypto.randomUUID(),
      },
      body: `scope=${this.scope}`,
      ...(signal ? { signal } : {}),
    });

    if (!res.ok) {
      // Body may echo the request; never surface it verbatim (could contain the
      // Basic key on a misconfigured proxy). Status alone is enough to diagnose.
      throw new GigaChatAuthError(res.status);
    }

    const data = (await res.json()) as { access_token?: string };
    if (!data.access_token) {
      throw new GigaChatAuthError(res.status, 'response missing access_token');
    }

    this.cached = {
      token: data.access_token,
      expiresAt: this.now() + GIGACHAT_TOKEN_TTL_MS,
    };
    return data.access_token;
  }
}

/** GigaChat OAuth token exchange failed. Never carries the response body. */
export class GigaChatAuthError extends Error {
  constructor(
    public readonly status: number,
    detail?: string,
  ) {
    super(`GigaChat OAuth token exchange failed (${status})${detail ? `: ${detail}` : ''}`);
    this.name = 'GigaChatAuthError';
  }
}
