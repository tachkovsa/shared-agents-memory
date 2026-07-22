import { describe, expect, it, vi } from 'vitest';
import {
  CircuitBreaker,
  EmbeddingBreakerOpenError,
  EmbeddingClient,
  EmbeddingDimensionError,
  EmbeddingHttpError,
  EmbeddingRetryExhaustedError,
  type EmbeddingMetrics,
  type FetchImpl,
} from './embeddings.js';
import type { Config } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Config['embeddings']> = {}): Config {
  return {
    embeddings: {
      apiKey: 'test-key-secret',
      baseUrl: 'https://openrouter.test',
      model: 'qwen/qwen3-embedding-8b',
      embeddingDimension: 4096,
      ...overrides,
    },
    qdrant: { url: 'http://localhost:6333', collectionName: 'test' },
    server: { port: 3000 },
    storage: { dataDir: './data' },
  };
}

function make4096Vector(): number[] {
  return Array.from({ length: 4096 }, (_, i) => i * 0.0001);
}

function makeOkResponse(vectors: number[][]): Response {
  const body = JSON.stringify({
    data: vectors.map((embedding) => ({ embedding })),
    usage: { total_tokens: 42 },
  });
  return new Response(body, { status: 200 });
}

function makeErrorResponse(status: number, body = 'error', headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

/** Returns a factory that creates a fresh Response on every call (avoids "body already read" errors on retries). */
function freshErrorResponse(status: number, body = 'error', headers: Record<string, string> = {}) {
  return () => Promise.resolve(makeErrorResponse(status, body, headers));
}

function makeNoOpMetrics(): EmbeddingMetrics & { calls: Record<string, number> } {
  const calls: Record<string, number> = {
    attempt: 0, retry: 0, success: 0, failure: 0, breakerOpen: 0, breakerClose: 0,
  };
  return {
    calls,
    onAttempt() { calls['attempt']++; },
    onRetry(_r: string) { calls['retry']++; },
    onSuccess(_l: number, _t?: number) { calls['success']++; },
    onFailure(_r: string) { calls['failure']++; },
    onBreakerOpen() { calls['breakerOpen']++; },
    onBreakerClose() { calls['breakerClose']++; },
  };
}

/** Build an EmbeddingClient with fake sleep (instant) and a controllable fetch. */
function makeClient(
  fetchImpl: FetchImpl,
  config?: Partial<Config['embeddings']>,
  opts?: { breakerConfig?: Parameters<typeof CircuitBreaker>[0] },
) {
  const sleep = vi.fn().mockResolvedValue(undefined);
  const metrics = makeNoOpMetrics();
  const client = new EmbeddingClient(makeConfig(config), {
    fetchImpl,
    sleep,
    metrics,
    breakerConfig: opts?.breakerConfig,
  });
  return { client, sleep, metrics };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EmbeddingClient.embed', () => {
  it('happy path: returns 4096-dim vector from a valid 200 response', async () => {
    const vec = make4096Vector();
    const fetch = vi.fn<FetchImpl>().mockResolvedValue(makeOkResponse([vec]));
    const { client, metrics } = makeClient(fetch);

    const result = await client.embed('hello world');

    expect(result).toHaveLength(4096);
    expect(result[0]).toBe(vec[0]);
    expect(metrics.calls['attempt']).toBe(1);
    expect(metrics.calls['success']).toBe(1);
    expect(metrics.calls['failure']).toBe(0);
    expect(metrics.calls['retry']).toBe(0);
  });

  it('batch: returns multiple vectors', async () => {
    const v1 = make4096Vector();
    const v2 = make4096Vector().map((x) => x * 2);
    const fetch = vi.fn<FetchImpl>().mockResolvedValue(makeOkResponse([v1, v2]));
    const { client } = makeClient(fetch);

    const results = await client.embedBatch(['a', 'b']);

    expect(results).toHaveLength(2);
    expect(results[0]).toHaveLength(4096);
    expect(results[1]).toHaveLength(4096);
  });
});

describe('EmbeddingClient — adaptive truncation on 413', () => {
  it('shrinks the input and retries when the provider returns 413', async () => {
    const vec = make4096Vector();
    const bodies: string[] = [];
    const fetch = vi.fn<FetchImpl>().mockImplementation((_url, init) => {
      const input = JSON.parse(String((init as RequestInit).body))['input'] as string[];
      bodies.push(input[0]);
      // Emulate GigaChat: 413 until the input is short enough, then 200.
      return input[0].length > 800
        ? Promise.resolve(makeErrorResponse(413, 'payload too large'))
        : Promise.resolve(makeOkResponse([vec]));
    });
    const { client, metrics } = makeClient(fetch);

    const result = await client.embed('я'.repeat(5000));

    expect(result).toHaveLength(4096);
    expect(bodies.length).toBeGreaterThan(1); // it retried
    expect(bodies[0]).toHaveLength(5000); // first attempt = full input
    expect(bodies[bodies.length - 1].length).toBeLessThanOrEqual(800); // last = shrunk enough
    expect(metrics.calls['failure']).toBe(0); // a fixable 413 is not a fatal failure
  });

  it('applies the static maxInputChars cap before the first request', async () => {
    const vec = make4096Vector();
    let firstLen = -1;
    const fetch = vi.fn<FetchImpl>().mockImplementation((_url, init) => {
      const input = JSON.parse(String((init as RequestInit).body))['input'] as string[];
      if (firstLen < 0) firstLen = input[0].length;
      return Promise.resolve(makeOkResponse([vec]));
    });
    const { client } = makeClient(fetch, { maxInputChars: 100 });

    await client.embed('x'.repeat(5000));

    expect(firstLen).toBe(100);
  });

  it('still throws a 413 when truncation bottoms out at the floor', async () => {
    const fetch = vi.fn<FetchImpl>().mockImplementation(() => Promise.resolve(makeErrorResponse(413, 'too large')));
    const { client } = makeClient(fetch);

    await expect(client.embed('я'.repeat(5000))).rejects.toSatisfy(
      (e: unknown) => e instanceof EmbeddingHttpError && (e as EmbeddingHttpError).status === 413,
    );
  });
});

describe('EmbeddingClient — concurrency limiter', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('caps in-flight requests at maxConcurrency=1 and queues the rest', async () => {
    const vec = make4096Vector();
    let active = 0;
    let peak = 0;
    const resolvers: Array<() => void> = [];
    const fetch = vi.fn<FetchImpl>().mockImplementation(() => {
      active++;
      peak = Math.max(peak, active);
      return new Promise((resolve) => {
        resolvers.push(() => {
          active--;
          resolve(makeOkResponse([vec]));
        });
      });
    });
    const { client } = makeClient(fetch, { maxConcurrency: 1 });

    const p1 = client.embed('a');
    const p2 = client.embed('b');
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1); // second call is queued

    resolvers.shift()!(); // finish the first request
    await p1;
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2); // slot freed → second starts

    resolvers.shift()!();
    await p2;
    expect(peak).toBe(1);
  });

  it('runs requests concurrently when maxConcurrency=0 (default/unlimited)', async () => {
    const vec = make4096Vector();
    let active = 0;
    let peak = 0;
    const resolvers: Array<() => void> = [];
    const fetch = vi.fn<FetchImpl>().mockImplementation(() => {
      active++;
      peak = Math.max(peak, active);
      return new Promise((resolve) => {
        resolvers.push(() => {
          active--;
          resolve(makeOkResponse([vec]));
        });
      });
    });
    const { client } = makeClient(fetch); // maxConcurrency unset → 0

    const p1 = client.embed('a');
    const p2 = client.embed('b');
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2); // both in flight at once

    resolvers.forEach((r) => r());
    await Promise.all([p1, p2]);
    expect(peak).toBe(2);
  });
});

describe('EmbeddingClient — dimension validation', () => {
  it('throws EmbeddingDimensionError when response has wrong dimensions', async () => {
    const shortVec = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]; // 8 dims
    const fetch = vi.fn<FetchImpl>().mockResolvedValue(makeOkResponse([shortVec]));
    const { client } = makeClient(fetch);

    await expect(client.embed('test')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof EmbeddingDimensionError &&
        err.expected === 4096 &&
        err.actual === 8,
    );
  });

  it('dimension check fires before the vector is returned', async () => {
    const shortVec = new Array(100).fill(0.1);
    const fetch = vi.fn<FetchImpl>().mockResolvedValue(makeOkResponse([shortVec]));
    const { client } = makeClient(fetch);

    let resolved = false;
    const promise = client.embed('test').then((v) => {
      resolved = true;
      return v;
    });

    await expect(promise).rejects.toBeInstanceOf(EmbeddingDimensionError);
    expect(resolved).toBe(false);
  });
});

describe('EmbeddingClient — non-retryable HTTP errors', () => {
  it('throws EmbeddingHttpError immediately on 401, no retries', async () => {
    const fetch = vi.fn<FetchImpl>().mockResolvedValue(makeErrorResponse(401, 'unauthorized'));
    const { client, sleep, metrics } = makeClient(fetch);

    await expect(client.embed('x')).rejects.toSatisfy(
      (err: unknown) => err instanceof EmbeddingHttpError && err.status === 401,
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(metrics.calls['retry']).toBe(0);
  });

  it('throws EmbeddingHttpError immediately on 402', async () => {
    const fetch = vi.fn<FetchImpl>().mockResolvedValue(makeErrorResponse(402, 'payment required'));
    const { client } = makeClient(fetch);

    await expect(client.embed('x')).rejects.toSatisfy(
      (err: unknown) => err instanceof EmbeddingHttpError && err.status === 402,
    );

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('throws EmbeddingHttpError immediately on 400', async () => {
    const fetch = vi.fn<FetchImpl>().mockResolvedValue(makeErrorResponse(400, 'bad request'));
    const { client } = makeClient(fetch);

    await expect(client.embed('x')).rejects.toSatisfy(
      (err: unknown) => err instanceof EmbeddingHttpError && err.status === 400,
    );

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('throws EmbeddingHttpError immediately on 404', async () => {
    const fetch = vi.fn<FetchImpl>().mockResolvedValue(makeErrorResponse(404, 'not found'));
    const { client } = makeClient(fetch);

    await expect(client.embed('x')).rejects.toBeInstanceOf(EmbeddingHttpError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('EmbeddingClient — retryable HTTP errors', () => {
  it('retries 429 with Retry-After header and uses the header delay', async () => {
    const vec = make4096Vector();
    const fetch = vi.fn<FetchImpl>()
      .mockResolvedValueOnce(makeErrorResponse(429, 'rate limited', { 'Retry-After': '1' }))
      .mockResolvedValueOnce(makeOkResponse([vec]));
    const { client, sleep } = makeClient(fetch);

    const result = await client.embed('test');

    expect(result).toHaveLength(4096);
    expect(fetch).toHaveBeenCalledTimes(2);
    // Retry-After: 1 → 1000 ms (instant in test because sleep is mocked)
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('retries 503 three times then throws EmbeddingRetryExhaustedError', async () => {
    const fetch = vi.fn<FetchImpl>().mockImplementation(freshErrorResponse(503, 'service unavailable'));
    const { client } = makeClient(fetch);

    await expect(client.embed('test')).rejects.toBeInstanceOf(EmbeddingRetryExhaustedError);
    // 1 original + 3 retries = 4 total
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('carries the last error as cause on EmbeddingRetryExhaustedError', async () => {
    const fetch = vi.fn<FetchImpl>().mockImplementation(freshErrorResponse(503, 'svc unavailable'));
    const { client } = makeClient(fetch);

    const err = await client.embed('test').catch((e) => e) as EmbeddingRetryExhaustedError;
    expect(err).toBeInstanceOf(EmbeddingRetryExhaustedError);
    expect(err.cause).toBeInstanceOf(EmbeddingHttpError);
    expect((err.cause as EmbeddingHttpError).status).toBe(503);
  });

  it('retries 502 and 529', async () => {
    const vec = make4096Vector();
    const fetch502 = vi.fn<FetchImpl>()
      .mockImplementationOnce(freshErrorResponse(502, 'bad gateway'))
      .mockResolvedValueOnce(makeOkResponse([vec]));
    const { client: c502 } = makeClient(fetch502);
    await expect(c502.embed('test')).resolves.toHaveLength(4096);
    expect(fetch502).toHaveBeenCalledTimes(2);

    const fetch529 = vi.fn<FetchImpl>()
      .mockImplementationOnce(freshErrorResponse(529, 'overloaded'))
      .mockResolvedValueOnce(makeOkResponse([vec]));
    const { client: c529 } = makeClient(fetch529);
    await expect(c529.embed('test')).resolves.toHaveLength(4096);
    expect(fetch529).toHaveBeenCalledTimes(2);
  });

  it('respects MAX_RETRIES=3 (4 total attempts) on retryable errors', async () => {
    const fetch = vi.fn<FetchImpl>().mockImplementation(freshErrorResponse(503));
    const { client, metrics } = makeClient(fetch);

    await expect(client.embed('test')).rejects.toBeInstanceOf(EmbeddingRetryExhaustedError);

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(metrics.calls['retry']).toBe(3);
    expect(metrics.calls['attempt']).toBe(4);
  });
});

describe('EmbeddingClient — network errors (ECONNRESET)', () => {
  it('retries ECONNRESET errors', async () => {
    const vec = make4096Vector();
    const networkError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const fetch = vi.fn<FetchImpl>()
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(makeOkResponse([vec]));
    const { client } = makeClient(fetch);

    const result = await client.embed('test');
    expect(result).toHaveLength(4096);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries on repeated ECONNRESET', async () => {
    const networkError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const fetch = vi.fn<FetchImpl>().mockRejectedValue(networkError);
    const { client } = makeClient(fetch);

    await expect(client.embed('test')).rejects.toBeInstanceOf(EmbeddingRetryExhaustedError);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('retries errors where code is on cause', async () => {
    const cause = Object.assign(new Error('inner'), { code: 'ETIMEDOUT' });
    const networkError = Object.assign(new Error('outer'), { cause });
    const vec = make4096Vector();
    const fetch = vi.fn<FetchImpl>()
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(makeOkResponse([vec]));
    const { client } = makeClient(fetch);

    await expect(client.embed('test')).resolves.toHaveLength(4096);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('EmbeddingClient — API key safety', () => {
  it('does not expose the API key in EmbeddingHttpError messages', async () => {
    const apiKey = 'super-secret-api-key-12345';
    const fetch = vi.fn<FetchImpl>().mockResolvedValue(makeErrorResponse(401, 'unauthorized'));
    const { client } = makeClient(fetch, { apiKey });

    const err = await client.embed('test').catch((e) => e) as EmbeddingHttpError;
    expect(err.message).not.toContain(apiKey);
    expect(err.bodyExcerpt).not.toContain(apiKey);
  });

  it('does not expose the API key in EmbeddingRetryExhaustedError messages', async () => {
    const apiKey = 'super-secret-api-key-12345';
    const fetch = vi.fn<FetchImpl>().mockImplementation(freshErrorResponse(503, 'svc unavailable'));
    const { client } = makeClient(fetch, { apiKey });

    const err = await client.embed('test').catch((e) => e) as EmbeddingRetryExhaustedError;
    expect(err.message).not.toContain(apiKey);
  });
});

describe('EmbeddingClient — circuit breaker', () => {
  /**
   * Feed enough failures to trip the breaker (minSamples=5, threshold=0.5).
   * Uses a tiny window so we don't fight the default 20-sample floor.
   */
  function makeBreakerClient(fetchImpl: FetchImpl) {
    return makeClient(fetchImpl, undefined, {
      breakerConfig: {
        windowMs: 60_000,
        openMs: 30_000,
        failureThreshold: 0.5,
        minSamples: 5,
      },
    });
  }

  it('opens after enough failures and rejects subsequent calls without hitting fetch', async () => {
    // All 4 retried attempts fail → 4 fetch calls consumed (1 original + 3 retries).
    // We need at least 5 recorded failures in the window.
    // Each embedBatch call = 1 breaker.recordFailure (after retries exhaust).
    // So 5 consecutive exhausted calls = 5 failures → breaker trips on the 5th.
    const failFetch = vi.fn<FetchImpl>().mockImplementation(freshErrorResponse(503));
    const { client: c, metrics } = makeBreakerClient(failFetch);

    // Exhaust 5 calls to accumulate failures in the breaker window
    for (let i = 0; i < 5; i++) {
      await expect(c.embedBatch(['x'])).rejects.toBeInstanceOf(EmbeddingRetryExhaustedError);
    }

    expect(metrics.calls['breakerOpen']).toBe(1);

    // Now the breaker should be open — next call must NOT reach fetch
    const callsBefore = failFetch.mock.calls.length;
    await expect(c.embedBatch(['x'])).rejects.toBeInstanceOf(EmbeddingBreakerOpenError);
    expect(failFetch.mock.calls.length).toBe(callsBefore);
  });

  it('enters half-open after cooldown and closes on success', () => {
    let nowMs = 0;
    const now = () => nowMs;

    const noopMetrics: EmbeddingMetrics = {
      onAttempt: () => undefined,
      onRetry: () => undefined,
      onSuccess: () => undefined,
      onFailure: () => undefined,
      onBreakerOpen: () => undefined,
      onBreakerClose: () => undefined,
    };

    const breaker = new CircuitBreaker(
      { windowMs: 60_000, openMs: 5_000, failureThreshold: 0.5, minSamples: 5 },
      now,
    );

    // Trip the breaker with enough failures
    for (let i = 0; i < 6; i++) {
      breaker.recordFailure(noopMetrics);
    }
    expect(breaker.getState()).toBe('open');

    // Breaker blocks requests while open
    expect(breaker.allowRequest()).toBe(false);

    // Advance time past cooldown
    nowMs = 6_000;

    // After cooldown, should allow one probe (half-open)
    expect(breaker.allowRequest()).toBe(true);
    expect(breaker.getState()).toBe('half-open');

    // Probe succeeds → close breaker
    breaker.recordSuccess(noopMetrics);
    expect(breaker.getState()).toBe('closed');
  });

  it('re-opens on half-open probe failure', () => {
    let nowMs = 0;
    const now = () => nowMs;

    const noopMetrics: EmbeddingMetrics = {
      onAttempt: () => undefined,
      onRetry: () => undefined,
      onSuccess: () => undefined,
      onFailure: () => undefined,
      onBreakerOpen: () => undefined,
      onBreakerClose: () => undefined,
    };

    const breaker = new CircuitBreaker(
      { windowMs: 60_000, openMs: 5_000, failureThreshold: 0.5, minSamples: 5 },
      now,
    );

    // Trip the breaker
    for (let i = 0; i < 6; i++) {
      breaker.recordFailure(noopMetrics);
    }
    expect(breaker.getState()).toBe('open');

    // Advance past cooldown
    nowMs = 6_000;
    expect(breaker.allowRequest()).toBe(true); // transitions to half-open

    // Probe fails
    breaker.recordFailure(noopMetrics);
    expect(breaker.getState()).toBe('open');

    // Should block again
    expect(breaker.allowRequest()).toBe(false);
  });
});

describe('EmbeddingClient — Retry-After clamping', () => {
  it('clamps Retry-After above 30s to 30s', async () => {
    const vec = make4096Vector();
    const fetch = vi.fn<FetchImpl>()
      .mockResolvedValueOnce(makeErrorResponse(429, 'rate limit', { 'Retry-After': '9999' }))
      .mockResolvedValueOnce(makeOkResponse([vec]));
    const { client, sleep } = makeClient(fetch);

    await client.embed('test');

    expect(sleep).toHaveBeenCalledWith(30_000);
  });
});
