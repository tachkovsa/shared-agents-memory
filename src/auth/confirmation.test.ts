import { describe, expect, it } from 'vitest';
import {
  canonicalJsonHash,
  ConsumedConfirmations,
  makeConfirmation,
  verifyConfirmation,
} from './confirmation.js';

const PEPPER = Buffer.alloc(32, 0x42);
const OTHER_PEPPER = Buffer.alloc(32, 0x43);

function makePayload(overrides: Partial<{
  session_id: string;
  tool_id: string;
  input_hash: string;
  expires_at: number;
}> = {}) {
  return {
    session_id: 'sess_1',
    tool_id: 'pat_create',
    input_hash: canonicalJsonHash({ a: 1 }),
    expires_at: Date.now() + 60_000,
    ...overrides,
  };
}

describe('canonicalJsonHash', () => {
  it('returns the same hash regardless of key order', () => {
    const a = canonicalJsonHash({ x: 1, y: 'two', z: [3, 4] });
    const b = canonicalJsonHash({ z: [3, 4], y: 'two', x: 1 });
    expect(a).toBe(b);
  });

  it('produces different hashes for different values', () => {
    expect(canonicalJsonHash({ a: 1 })).not.toBe(canonicalJsonHash({ a: 2 }));
  });

  it('produces different hashes for nested key reordering vs value change', () => {
    const nestedA = canonicalJsonHash({ outer: { a: 1, b: 2 } });
    const nestedB = canonicalJsonHash({ outer: { b: 2, a: 1 } });
    const valueChange = canonicalJsonHash({ outer: { a: 1, b: 3 } });
    expect(nestedA).toBe(nestedB);
    expect(nestedA).not.toBe(valueChange);
  });
});

describe('makeConfirmation + verifyConfirmation', () => {
  it('round-trips a fresh token', () => {
    const payload = makePayload();
    const token = makeConfirmation(payload, PEPPER);
    const result = verifyConfirmation(
      token,
      {
        session_id: payload.session_id,
        tool_id: payload.tool_id,
        input_hash: payload.input_hash,
      },
      PEPPER,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload).toEqual(payload);
  });

  it('rejects malformed tokens', () => {
    expect(
      verifyConfirmation(
        'not-a-token',
        { session_id: 's', tool_id: 't', input_hash: 'h' },
        PEPPER,
      ).ok,
    ).toBe(false);
    expect(
      verifyConfirmation(
        'too.many.parts.here',
        { session_id: 's', tool_id: 't', input_hash: 'h' },
        PEPPER,
      ),
    ).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects expired tokens', () => {
    const payload = makePayload({ expires_at: 1_000 });
    const token = makeConfirmation(payload, PEPPER);
    const result = verifyConfirmation(
      token,
      {
        session_id: payload.session_id,
        tool_id: payload.tool_id,
        input_hash: payload.input_hash,
      },
      PEPPER,
      () => new Date(2_000),
    );
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects mismatched HMAC (different pepper)', () => {
    const payload = makePayload();
    const token = makeConfirmation(payload, PEPPER);
    const result = verifyConfirmation(
      token,
      {
        session_id: payload.session_id,
        tool_id: payload.tool_id,
        input_hash: payload.input_hash,
      },
      OTHER_PEPPER,
    );
    expect(result).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects mismatched session_id', () => {
    const payload = makePayload();
    const token = makeConfirmation(payload, PEPPER);
    const result = verifyConfirmation(
      token,
      { session_id: 'sess_2', tool_id: payload.tool_id, input_hash: payload.input_hash },
      PEPPER,
    );
    expect(result).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects mismatched tool_id', () => {
    const payload = makePayload();
    const token = makeConfirmation(payload, PEPPER);
    const result = verifyConfirmation(
      token,
      { session_id: payload.session_id, tool_id: 'pat_rotate', input_hash: payload.input_hash },
      PEPPER,
    );
    expect(result).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects mismatched input_hash (input was tampered between calls)', () => {
    const payload = makePayload();
    const token = makeConfirmation(payload, PEPPER);
    const result = verifyConfirmation(
      token,
      { session_id: payload.session_id, tool_id: payload.tool_id, input_hash: 'tampered' },
      PEPPER,
    );
    expect(result).toEqual({ ok: false, reason: 'mismatch' });
  });
});

describe('ConsumedConfirmations', () => {
  it('marks tokens consumed', () => {
    const consumed = new ConsumedConfirmations(() => new Date(0));
    expect(consumed.has('t1')).toBe(false);
    consumed.consume('t1', 60_000);
    expect(consumed.has('t1')).toBe(true);
  });

  it('evicts expired entries on lookup', () => {
    let now = new Date(0);
    const consumed = new ConsumedConfirmations(() => now);
    consumed.consume('t1', 100);
    now = new Date(200);
    expect(consumed.has('t1')).toBe(false);
  });
});
