import type { Config } from './config.js';

// ---------------------------------------------------------------------------
// Public metrics interface — no Prometheus dep; wired in #9.
// ---------------------------------------------------------------------------

export interface EmbeddingMetrics {
  onAttempt(): void;
  onRetry(reason: string): void;
  onSuccess(latencyMs: number, tokens?: number): void;
  onFailure(reason: string): void;
  onBreakerOpen(): void;
  onBreakerClose(): void;
}

const NO_OP_METRICS: EmbeddingMetrics = {
  onAttempt: () => undefined,
  onRetry: () => undefined,
  onSuccess: () => undefined,
  onFailure: () => undefined,
  onBreakerOpen: () => undefined,
  onBreakerClose: () => undefined,
};

// ---------------------------------------------------------------------------
// Typed error classes
// ---------------------------------------------------------------------------

/** Non-retryable HTTP error from OpenRouter (4xx not covered by retry set). */
export class EmbeddingHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** Redacted excerpt of the response body — never contains API keys. */
    public readonly bodyExcerpt: string,
  ) {
    super(message);
    this.name = 'EmbeddingHttpError';
  }
}

/** All retry attempts exhausted; last upstream error attached as `cause`. */
export class EmbeddingRetryExhaustedError extends Error {
  constructor(
    message: string,
    public override readonly cause: unknown,
  ) {
    super(message);
    this.name = 'EmbeddingRetryExhaustedError';
  }
}

/** OpenRouter returned a vector with the wrong number of dimensions. */
export class EmbeddingDimensionError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`Embedding dimension mismatch: expected ${expected}, got ${actual}`);
    this.name = 'EmbeddingDimensionError';
  }
}

/** Call rejected because the circuit breaker is open. */
export class EmbeddingBreakerOpenError extends Error {
  constructor() {
    super('Embedding circuit breaker is open — upstream is degraded, try again later');
    this.name = 'EmbeddingBreakerOpenError';
  }
}

// ---------------------------------------------------------------------------
// Circuit-breaker configuration (env-knob driven)
// ---------------------------------------------------------------------------

export interface BreakerConfig {
  /** Sliding window size in ms (default 60_000). */
  windowMs: number;
  /** How long to stay open after tripping (default 30_000). */
  openMs: number;
  /** Failure rate threshold to trip (default 0.5). */
  failureThreshold: number;
  /** Minimum samples in window before breaker can trip (default 20). */
  minSamples: number;
}

function loadBreakerConfig(): BreakerConfig {
  return {
    windowMs: Number(process.env['EMBEDDING_BREAKER_WINDOW_MS'] ?? '60000'),
    openMs: Number(process.env['EMBEDDING_BREAKER_OPEN_MS'] ?? '30000'),
    failureThreshold: Number(process.env['EMBEDDING_BREAKER_FAILURE_THRESHOLD'] ?? '0.5'),
    minSamples: Number(process.env['EMBEDDING_BREAKER_MIN_SAMPLES'] ?? '20'),
  };
}

// ---------------------------------------------------------------------------
// Circuit breaker — sliding window + cooldown
// ---------------------------------------------------------------------------

type Outcome = 'success' | 'failure';
type BreakerState = 'closed' | 'open' | 'half-open';

interface WindowEntry {
  outcome: Outcome;
  ts: number;
}

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private openedAt = 0;
  private window: WindowEntry[] = [];
  private readonly cfg: BreakerConfig;
  private readonly now: () => number;

  constructor(cfg?: Partial<BreakerConfig>, now: () => number = Date.now) {
    this.cfg = { ...loadBreakerConfig(), ...cfg };
    this.now = now;
  }

  /** Returns true when the caller SHOULD proceed with the upstream call. */
  allowRequest(): boolean {
    const ts = this.now();
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (ts - this.openedAt >= this.cfg.openMs) {
        this.state = 'half-open';
        return true;
      }
      return false;
    }
    // half-open: allow exactly one probe
    return true;
  }

  recordSuccess(metrics: EmbeddingMetrics): void {
    this._trim();
    this.window.push({ outcome: 'success', ts: this.now() });
    if (this.state === 'half-open') {
      this.state = 'closed';
      metrics.onBreakerClose();
    }
  }

  recordFailure(metrics: EmbeddingMetrics): void {
    this._trim();
    this.window.push({ outcome: 'failure', ts: this.now() });
    if (this.state === 'half-open') {
      // Re-open on probe failure
      this.state = 'open';
      this.openedAt = this.now();
      metrics.onBreakerOpen();
      return;
    }
    if (this.state === 'closed') {
      const total = this.window.length;
      if (total >= this.cfg.minSamples) {
        const failures = this.window.filter((e) => e.outcome === 'failure').length;
        if (failures / total >= this.cfg.failureThreshold) {
          this.state = 'open';
          this.openedAt = this.now();
          metrics.onBreakerOpen();
        }
      }
    }
  }

  private _trim(): void {
    const cutoff = this.now() - this.cfg.windowMs;
    this.window = this.window.filter((e) => e.ts > cutoff);
  }

  /** Exposed for testing. */
  getState(): BreakerState {
    return this.state;
  }
}

// ---------------------------------------------------------------------------
// Retry helpers
// ---------------------------------------------------------------------------

/** HTTP statuses that should be retried. */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 529]);

/** HTTP statuses that should NOT be retried — fail immediately. */
const NON_RETRYABLE_STATUSES = new Set([400, 401, 402, 404]);

/** Node fetch error codes that indicate transient network issues. */
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET']);

/** Base backoff delays in ms for attempts 0, 1, 2 (before jitter). */
const BACKOFF_BASE_MS = [250, 500, 1000];

/** Maximum allowed Retry-After clamp in ms. */
const RETRY_AFTER_MAX_MS = 30_000;

/** Per-attempt fetch timeout in ms. */
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
  // ±25% of baseMs
  return baseMs + (Math.random() - 0.5) * 0.5 * baseMs;
}

function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('Retry-After');
  if (!raw) return undefined;
  const seconds = parseInt(raw, 10);
  if (isNaN(seconds) || seconds <= 0) return undefined;
  return Math.min(seconds * 1000, RETRY_AFTER_MAX_MS);
}

function redactAuthFromBody(body: string): string {
  // Ensure no Bearer tokens leak through error body excerpts
  return body.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').slice(0, 500);
}

// ---------------------------------------------------------------------------
// OpenRouter response shape
// ---------------------------------------------------------------------------

interface EmbeddingResponseItem {
  embedding: number[];
}

interface EmbeddingResponse {
  data: EmbeddingResponseItem[];
  usage?: { total_tokens?: number };
}

// ---------------------------------------------------------------------------
// EmbeddingClient options
// ---------------------------------------------------------------------------

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export interface EmbeddingClientOptions {
  metrics?: EmbeddingMetrics;
  fetchImpl?: FetchImpl;
  /** Override for testing (ms since epoch) */
  now?: () => number;
  /** Override sleep for testing */
  sleep?: (ms: number) => Promise<void>;
  /** Override breaker config */
  breakerConfig?: Partial<BreakerConfig>;
}

// ---------------------------------------------------------------------------
// EmbeddingClient
// ---------------------------------------------------------------------------

export class EmbeddingClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly expectedDimension: number;
  private readonly metrics: EmbeddingMetrics;
  private readonly fetchImpl: FetchImpl;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly breaker: CircuitBreaker;

  constructor(config: Config, opts: EmbeddingClientOptions = {}) {
    this.apiKey = config.openRouter.apiKey;
    this.baseUrl = config.openRouter.baseUrl;
    this.model = config.openRouter.model;
    this.expectedDimension = config.openRouter.embeddingDimension;
    this.metrics = opts.metrics ?? NO_OP_METRICS;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.breaker = new CircuitBreaker(opts.breakerConfig, this.now);
  }

  /**
   * Generate an embedding vector for the given text.
   */
  async embed(input: string): Promise<number[]> {
    const vectors = await this.embedBatch([input]);
    return vectors[0];
  }

  /**
   * Generate embeddings for multiple inputs in a single request.
   * Implements retry-with-backoff and circuit breaker per ADR-0005 §3.2/§3.7.
   */
  async embedBatch(inputs: string[]): Promise<number[][]> {
    const startMs = this.now();

    if (!this.breaker.allowRequest()) {
      this.metrics.onFailure('breaker_open');
      throw new EmbeddingBreakerOpenError();
    }

    const MAX_RETRIES = 3; // 4 total attempts
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      this.metrics.onAttempt();

      let response: Response;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
          response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ model: this.model, input: inputs }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (fetchErr) {
        // Network / timeout error
        if (isRetryableCode(fetchErr) || (fetchErr instanceof Error && fetchErr.name === 'AbortError')) {
          lastError = fetchErr;
          const reason =
            fetchErr instanceof Error && fetchErr.name === 'AbortError'
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
            `Embedding request failed after ${MAX_RETRIES + 1} attempts: ${reason}`,
            fetchErr,
          );
        }
        // Non-retryable fetch error
        this.breaker.recordFailure(this.metrics);
        this.metrics.onFailure('fetch_error');
        throw fetchErr;
      }

      // Handle HTTP status
      if (!response.ok) {
        const status = response.status;
        const rawBody = await response.text();
        const bodyExcerpt = redactAuthFromBody(rawBody);

        if (NON_RETRYABLE_STATUSES.has(status)) {
          // Fail immediately — do not retry
          this.breaker.recordFailure(this.metrics);
          this.metrics.onFailure(`http_${status}`);
          throw new EmbeddingHttpError(
            `OpenRouter embedding failed (${status})`,
            status,
            bodyExcerpt,
          );
        }

        if (RETRYABLE_STATUSES.has(status)) {
          lastError = new EmbeddingHttpError(
            `OpenRouter embedding failed (${status})`,
            status,
            bodyExcerpt,
          );
          if (attempt < MAX_RETRIES) {
            const retryAfterMs = parseRetryAfterMs(response.headers);
            const delayMs = retryAfterMs ?? jitter(BACKOFF_BASE_MS[attempt] ?? 1000);
            this.metrics.onRetry(`http_${status}`);
            await this.sleep(delayMs);
            continue;
          }
          // All retries exhausted
          this.breaker.recordFailure(this.metrics);
          this.metrics.onFailure(`http_${status}`);
          throw new EmbeddingRetryExhaustedError(
            `Embedding request failed after ${MAX_RETRIES + 1} attempts (last status: ${status})`,
            lastError,
          );
        }

        // Any other non-200 status (e.g. 5xx not in retryable set) — fail immediately
        this.breaker.recordFailure(this.metrics);
        this.metrics.onFailure(`http_${status}`);
        throw new EmbeddingHttpError(
          `OpenRouter embedding failed (${status})`,
          status,
          bodyExcerpt,
        );
      }

      // Happy path: parse and validate
      const result = (await response.json()) as EmbeddingResponse;
      const tokens = result.usage?.total_tokens;

      for (const item of result.data) {
        if (item.embedding.length !== this.expectedDimension) {
          // Dimension mismatch — NOT a retryable error; fire before caller gets vector
          this.breaker.recordFailure(this.metrics);
          this.metrics.onFailure('dimension_mismatch');
          throw new EmbeddingDimensionError(this.expectedDimension, item.embedding.length);
        }
      }

      const latencyMs = this.now() - startMs;
      this.breaker.recordSuccess(this.metrics);
      this.metrics.onSuccess(latencyMs, tokens);
      return result.data.map((d) => d.embedding);
    }

    // Should never be reached, but TypeScript needs this
    this.breaker.recordFailure(this.metrics);
    this.metrics.onFailure('retry_exhausted');
    throw new EmbeddingRetryExhaustedError(
      `Embedding request failed after ${MAX_RETRIES + 1} attempts`,
      lastError,
    );
  }
}
