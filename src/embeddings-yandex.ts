/**
 * YandexGPT (Yandex Cloud Foundation Models) embedding client.
 *
 * Brought over from hcm-guru's yandexgpt-adapter for operators who prefer Yandex
 * Cloud over GigaChat. Not on the default path — select it with
 * EMBEDDINGS_PROVIDER=yandex (see createEmbeddingClient / .env.example).
 *
 * Why a separate client rather than the OpenAI-compatible EmbeddingClient:
 * Yandex's Foundation Models API is not OpenAI-shaped. It embeds ONE text per
 * request at `/textEmbedding`, addresses the model by a `emb://<folder>/<model>`
 * URI, authorizes with an `Api-Key`/IAM `Bearer` header plus `x-folder-id`, and
 * returns `{ embedding }` (no `data[]` envelope). This client mirrors the
 * retry-with-backoff + circuit-breaker + dimension-validation behaviour of
 * EmbeddingClient by reusing the same primitives, but speaks Yandex's protocol.
 *
 * Note: Yandex text embeddings are 256-dimensional — set EMBEDDINGS_DIMENSION=256.
 */

import type { Config } from './config.js';
import {
  CircuitBreaker,
  EmbeddingBreakerOpenError,
  EmbeddingDimensionError,
  EmbeddingHttpError,
  EmbeddingRetryExhaustedError,
  type EmbeddingClientOptions,
  type EmbeddingMetrics,
  type EmbeddingProvider,
  type FetchImpl,
} from './embeddings.js';

const NO_OP_METRICS: EmbeddingMetrics = {
  onAttempt: () => undefined,
  onRetry: () => undefined,
  onSuccess: () => undefined,
  onFailure: () => undefined,
  onBreakerOpen: () => undefined,
  onBreakerClose: () => undefined,
};

/** IAM token exchange (only for authMethod=IAM_TOKEN). */
const IAM_TOKEN_URL = 'https://iam.api.cloud.yandex.net/iam/v1/tokens';
/** IAM tokens are valid 12h; refresh at 11h. */
const IAM_TOKEN_TTL_MS = 11 * 60 * 60 * 1000;

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET']);
const BACKOFF_BASE_MS = [250, 500, 1000];
const MAX_RETRIES = 3;
const FETCH_TIMEOUT_MS = 30_000;

function isRetryableCode(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as Record<string, unknown>)['code'];
  if (typeof code === 'string' && RETRYABLE_CODES.has(code)) return true;
  const cause = (err as Record<string, unknown>)['cause'];
  if (cause !== null && typeof cause === 'object') {
    const causeCode = (cause as Record<string, unknown>)['code'];
    if (typeof causeCode === 'string' && RETRYABLE_CODES.has(causeCode)) return true;
  }
  return false;
}

function jitter(baseMs: number): number {
  return baseMs + (Math.random() - 0.5) * 0.5 * baseMs;
}

interface YandexEmbeddingResponse {
  embedding?: number[];
}

/**
 * Yandex Foundation Models embedding client. Implements the shared
 * EmbeddingProvider contract so it drops into the memory service, transports and
 * the re-embed CLI interchangeably with EmbeddingClient.
 */
export class YandexEmbeddingClient implements EmbeddingProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly folderId: string;
  private readonly authMethod: string;
  private readonly expectedDimension: number;
  private readonly metrics: EmbeddingMetrics;
  private readonly fetchImpl: FetchImpl;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly breaker: CircuitBreaker;
  private iamCache: { token: string; expiresAt: number } | null = null;

  constructor(config: Config, opts: EmbeddingClientOptions = {}) {
    const folderId = config.embeddings.folderId;
    if (!folderId) {
      throw new Error(
        'EMBEDDINGS_FOLDER_ID is required when EMBEDDINGS_PROVIDER=yandex ' +
          '(needed to build the emb://<folder>/<model> URI).',
      );
    }
    this.apiKey = config.embeddings.apiKey;
    this.baseUrl = config.embeddings.baseUrl;
    this.model = config.embeddings.model;
    this.folderId = folderId;
    this.authMethod = config.embeddings.authMethod ?? 'API_KEY';
    this.expectedDimension = config.embeddings.embeddingDimension;
    this.metrics = opts.metrics ?? NO_OP_METRICS;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.breaker = new CircuitBreaker(opts.breakerConfig, this.now);
  }

  getBreakerState(): 'closed' | 'open' | 'half-open' {
    return this.breaker.getState();
  }

  async embed(input: string): Promise<number[]> {
    const vectors = await this.embedBatch([input]);
    return vectors[0];
  }

  /**
   * Yandex embeds one text per request, so a batch fans out into sequential
   * calls (keeps ordering, avoids hammering the per-request rate limit). Each
   * call goes through the same breaker; the first failure aborts the batch.
   */
  async embedBatch(inputs: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const input of inputs) {
      out.push(await this.embedOne(input));
    }
    return out;
  }

  /** Resolve the Authorization header (static Api-Key or a cached IAM token). */
  private async getAuthHeader(signal?: AbortSignal): Promise<string> {
    if (this.authMethod !== 'IAM_TOKEN') {
      return `Api-Key ${this.apiKey}`;
    }
    if (this.iamCache && this.now() < this.iamCache.expiresAt) {
      return `Bearer ${this.iamCache.token}`;
    }
    const res = await this.fetchImpl(IAM_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yandexPassportOauthToken: this.apiKey }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      throw new EmbeddingHttpError(`Yandex IAM auth failed (${res.status})`, res.status, '');
    }
    const data = (await res.json()) as { iamToken?: string };
    if (!data.iamToken) {
      throw new EmbeddingHttpError('Yandex IAM auth: response missing iamToken', res.status, '');
    }
    this.iamCache = { token: data.iamToken, expiresAt: this.now() + IAM_TOKEN_TTL_MS };
    return `Bearer ${data.iamToken}`;
  }

  private async embedOne(input: string): Promise<number[]> {
    const startMs = this.now();

    if (!this.breaker.allowRequest()) {
      this.metrics.onFailure('breaker_open');
      throw new EmbeddingBreakerOpenError();
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      this.metrics.onAttempt();

      let response: Response;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
          const auth = await this.getAuthHeader(controller.signal);
          response = await this.fetchImpl(`${this.baseUrl}/textEmbedding`, {
            method: 'POST',
            headers: {
              Authorization: auth,
              'x-folder-id': this.folderId,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              modelUri: `emb://${this.folderId}/${this.model}`,
              text: input,
            }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (fetchErr) {
        const isAbort = fetchErr instanceof Error && fetchErr.name === 'AbortError';
        if (isRetryableCode(fetchErr) || isAbort) {
          lastError = fetchErr;
          const reason = isAbort
            ? 'ETIMEDOUT'
            : String((fetchErr as Record<string, unknown>)['code'] ?? 'network_error');
          if (attempt < MAX_RETRIES) {
            this.metrics.onRetry(reason);
            await this.sleep(jitter(BACKOFF_BASE_MS[attempt] ?? 1000));
            continue;
          }
          this.breaker.recordFailure(this.metrics);
          this.metrics.onFailure(reason);
          throw new EmbeddingRetryExhaustedError(
            `Yandex embedding failed after ${MAX_RETRIES + 1} attempts: ${reason}`,
            fetchErr,
          );
        }
        this.breaker.recordFailure(this.metrics);
        this.metrics.onFailure('fetch_error');
        throw fetchErr;
      }

      if (!response.ok) {
        const status = response.status;
        const bodyExcerpt = (await response.text()).slice(0, 500);
        if (RETRYABLE_STATUSES.has(status) && attempt < MAX_RETRIES) {
          lastError = new EmbeddingHttpError(`Yandex embedding failed (${status})`, status, bodyExcerpt);
          this.metrics.onRetry(`http_${status}`);
          await this.sleep(jitter(BACKOFF_BASE_MS[attempt] ?? 1000));
          continue;
        }
        this.breaker.recordFailure(this.metrics);
        this.metrics.onFailure(`http_${status}`);
        throw new EmbeddingHttpError(`Yandex embedding failed (${status})`, status, bodyExcerpt);
      }

      const result = (await response.json()) as YandexEmbeddingResponse;
      const embedding = result.embedding;
      if (!Array.isArray(embedding)) {
        this.breaker.recordFailure(this.metrics);
        this.metrics.onFailure('invalid_response');
        throw new EmbeddingHttpError('Yandex embedding: response missing embedding[]', response.status, '');
      }
      if (embedding.length !== this.expectedDimension) {
        this.breaker.recordFailure(this.metrics);
        this.metrics.onFailure('dimension_mismatch');
        throw new EmbeddingDimensionError(this.expectedDimension, embedding.length);
      }

      this.breaker.recordSuccess(this.metrics);
      this.metrics.onSuccess(this.now() - startMs);
      return embedding;
    }

    this.breaker.recordFailure(this.metrics);
    this.metrics.onFailure('retry_exhausted');
    throw new EmbeddingRetryExhaustedError(
      `Yandex embedding failed after ${MAX_RETRIES + 1} attempts`,
      lastError,
    );
  }
}
