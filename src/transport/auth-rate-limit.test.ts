/**
 * Unit tests for the per-IP auth-failure limiter (issue #108, SEC-7).
 *
 * The sliding window is driven by an injected clock (`now`) — matching the
 * project's convention (PatStore / QuotaService take a `now` callback rather
 * than vi.useFakeTimers) — so window expiry and different-IP isolation are
 * deterministic without wall-clock waits.
 */
import { describe, expect, it } from 'vitest';
import { AuthFailureLimiter } from './auth-rate-limit.js';

describe('AuthFailureLimiter (issue #108)', () => {
  it('(a) trips after N failures from one IP within the window', () => {
    let now = 1_000_000;
    const lim = new AuthFailureLimiter({ max: 3, windowMs: 60_000, now: () => now });
    const ip = '203.0.113.7';

    // Under the cap: not limited.
    for (let i = 0; i < 3; i++) {
      expect(lim.check(ip).limited).toBe(false);
      lim.recordFailure(ip);
      now += 1_000; // 1s between attempts, all inside the 60s window
    }

    // 3 failures now on record → the next check trips.
    const decision = lim.check(ip);
    expect(decision.limited).toBe(true);
    expect(decision.retryAfterSec).toBeGreaterThan(0);
  });

  it('(b) a successful auth clears the counter and un-trips the IP', () => {
    let now = 5_000_000;
    const lim = new AuthFailureLimiter({ max: 3, windowMs: 60_000, now: () => now });
    const ip = '198.51.100.4';

    for (let i = 0; i < 3; i++) {
      lim.recordFailure(ip);
      now += 1_000;
    }
    expect(lim.check(ip).limited).toBe(true);

    // Success resets the window for this IP.
    lim.recordSuccess(ip);
    expect(lim.check(ip).limited).toBe(false);
    expect(lim.size()).toBe(0);

    // And it takes a fresh full run of failures to trip again.
    lim.recordFailure(ip);
    lim.recordFailure(ip);
    expect(lim.check(ip).limited).toBe(false);
  });

  it('(c) a different IP is unaffected by another IP hitting the cap', () => {
    let now = 9_000_000;
    const lim = new AuthFailureLimiter({ max: 3, windowMs: 60_000, now: () => now });
    const noisy = '203.0.113.9';
    const quiet = '203.0.113.10';

    for (let i = 0; i < 5; i++) {
      lim.recordFailure(noisy);
      now += 500;
    }
    expect(lim.check(noisy).limited).toBe(true);
    expect(lim.check(quiet).limited).toBe(false);
  });

  it('(d) failures outside the window expire, allowing requests again', () => {
    let now = 2_000_000;
    const lim = new AuthFailureLimiter({ max: 3, windowMs: 60_000, now: () => now });
    const ip = '192.0.2.55';

    for (let i = 0; i < 3; i++) {
      lim.recordFailure(ip);
      now += 1_000;
    }
    expect(lim.check(ip).limited).toBe(true);

    // Advance past the window so all recorded failures fall out of it.
    now += 61_000;
    expect(lim.check(ip).limited).toBe(false);
    // The pruned IP is dropped from the map entirely.
    expect(lim.size()).toBe(0);
  });

  it('sweep() drops IPs whose failures have all expired', () => {
    let now = 3_000_000;
    const lim = new AuthFailureLimiter({ max: 5, windowMs: 10_000, now: () => now });
    lim.recordFailure('a');
    lim.recordFailure('b');
    expect(lim.size()).toBe(2);

    now += 11_000;
    lim.sweep();
    expect(lim.size()).toBe(0);
  });

  it('retryAfterSec reflects time until the oldest failure leaves the window', () => {
    let now = 4_000_000;
    const lim = new AuthFailureLimiter({ max: 2, windowMs: 60_000, now: () => now });
    const ip = '10.0.0.1';
    lim.recordFailure(ip); // oldest at t0
    now += 10_000;         // 10s later
    lim.recordFailure(ip); // now at cap (2)

    const decision = lim.check(ip);
    expect(decision.limited).toBe(true);
    // Oldest expires at t0 + 60s, i.e. 50s from "now".
    expect(decision.retryAfterSec).toBe(50);
  });
});
