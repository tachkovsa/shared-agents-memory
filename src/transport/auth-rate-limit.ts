/**
 * Per-IP auth-failure rate limiter (issue #108, SEC-7).
 *
 * The /mcp auth path runs a full HMAC over prefix-colliding PAT candidates on
 * every attempt (src/auth/pat-store.ts). Tokens are 135-bit, so this is not a
 * credential-guessing risk — but an unauthenticated peer can still drive a cheap
 * CPU auth-flood, and there was previously no per-IP throttle or alerting signal.
 *
 * This is a rate limit, not a lockout: a sliding window of *failed* auths per
 * client IP. Once an IP reaches `max` failures within `windowMs`, further
 * requests from it are short-circuited with 429 *before* the expensive PAT
 * resolution runs. A successful auth clears the IP's counter, so a well-behaved
 * client is never penalised for a neighbour's noise or its own past typo.
 *
 * In-memory and self-contained: a `Map<ip, number[]>` of failure timestamps with
 * per-IP pruning on access plus a periodic full `sweep()` to bound memory. No
 * external dependency (the project's @fastify/rate-limit does not apply — /mcp is
 * a raw node:http server, not a Fastify app).
 */

export interface AuthFailureLimiterOptions {
  /** Max failed auths per IP within the window before requests are throttled. */
  max: number;
  /** Sliding-window length in milliseconds. */
  windowMs: number;
  /** Injectable clock (ms since epoch); defaults to Date.now (tests override). */
  now?: () => number;
}

export interface LimitDecision {
  /** True when the IP has reached the failure cap within the current window. */
  limited: boolean;
  /** Seconds until the window frees a slot (0 when not limited). */
  retryAfterSec: number;
}

export class AuthFailureLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  /** ip → ascending list of failure timestamps still within the window. */
  private readonly hits = new Map<string, number[]>();

  constructor(opts: AuthFailureLimiterOptions) {
    this.max = opts.max;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Reports whether `ip` has reached the failure cap within the window. Prunes
   * that IP's expired timestamps as a side effect, but does NOT record a new
   * failure — call this at the gate, then `recordFailure` only when auth fails.
   */
  check(ip: string): LimitDecision {
    const arr = this.hits.get(ip);
    if (!arr || arr.length === 0) return { limited: false, retryAfterSec: 0 };

    const now = this.now();
    const cutoff = now - this.windowMs;
    const live = arr.filter((t) => t > cutoff);
    if (live.length === 0) {
      this.hits.delete(ip);
      return { limited: false, retryAfterSec: 0 };
    }
    this.hits.set(ip, live);

    if (live.length >= this.max) {
      // Oldest live failure is live[0] (timestamps pushed in clock order).
      const retryAfterSec = Math.max(1, Math.ceil((live[0] + this.windowMs - now) / 1000));
      return { limited: true, retryAfterSec };
    }
    return { limited: false, retryAfterSec: 0 };
  }

  /** Records a failed auth from `ip` (pruning that IP's expired entries first). */
  recordFailure(ip: string): void {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const arr = this.hits.get(ip);
    const live = arr ? arr.filter((t) => t > cutoff) : [];
    live.push(now);
    this.hits.set(ip, live);
  }

  /** Clears the IP's failure history — a successful auth must not be penalised. */
  recordSuccess(ip: string): void {
    this.hits.delete(ip);
  }

  /** Periodic prune of expired/empty entries to bound memory across all IPs. */
  sweep(): void {
    const cutoff = this.now() - this.windowMs;
    for (const [ip, arr] of this.hits) {
      const live = arr.filter((t) => t > cutoff);
      if (live.length === 0) this.hits.delete(ip);
      else this.hits.set(ip, live);
    }
  }

  /** Number of IPs currently tracked (introspection / tests). */
  size(): number {
    return this.hits.size;
  }
}
