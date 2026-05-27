import { describe, expect, it } from 'vitest';
import {
  generateSecret,
  generateToken,
  hashSecret,
  parseToken,
  safeEqualHex,
  TOKEN_NAMESPACE,
  TOKEN_PREFIX_LENGTH,
  TOKEN_SECRET_LENGTH,
} from './hash.js';

const CROCKFORD = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/;

describe('generateSecret', () => {
  it('produces a 27-char Crockford base32 string', () => {
    for (let i = 0; i < 100; i++) {
      const s = generateSecret();
      expect(s).toHaveLength(TOKEN_SECRET_LENGTH);
      expect(s).toMatch(CROCKFORD);
    }
  });

  it('does not collide across many invocations', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateSecret());
    expect(seen.size).toBe(1000);
  });
});

describe('generateToken', () => {
  it('starts with the sam_pat_ namespace', () => {
    const t = generateToken();
    expect(t.startsWith(TOKEN_NAMESPACE)).toBe(true);
    expect(t).toHaveLength(TOKEN_NAMESPACE.length + TOKEN_SECRET_LENGTH);
  });
});

describe('parseToken', () => {
  it('extracts secret and 12-char prefix from a valid token', () => {
    const token = generateToken();
    const parsed = parseToken(token);
    expect(parsed).not.toBeNull();
    expect(parsed!.secret).toHaveLength(TOKEN_SECRET_LENGTH);
    expect(parsed!.prefix).toHaveLength(TOKEN_PREFIX_LENGTH);
    expect(token.endsWith(parsed!.secret)).toBe(true);
  });

  it('rejects tokens without the sam_pat_ prefix', () => {
    expect(parseToken('xxx_pat_ABCDEFGHJKMNPQRSTVWXYZ12345')).toBeNull();
  });

  it('rejects tokens with wrong secret length', () => {
    expect(parseToken('sam_pat_SHORT')).toBeNull();
    expect(parseToken(`sam_pat_${'A'.repeat(28)}`)).toBeNull();
  });

  it('rejects tokens with non-Crockford characters', () => {
    // 'I', 'L', 'O', 'U' are excluded from Crockford
    expect(parseToken(`sam_pat_${'I'.repeat(27)}`)).toBeNull();
    expect(parseToken(`sam_pat_${'i'.repeat(27)}`)).toBeNull();
  });
});

describe('hashSecret', () => {
  it('produces deterministic HMAC-SHA-256 output', () => {
    const pepper = Buffer.alloc(32, 0x42);
    expect(hashSecret('hello', pepper)).toBe(hashSecret('hello', pepper));
  });

  it('differs when pepper differs', () => {
    const p1 = Buffer.alloc(32, 0x01);
    const p2 = Buffer.alloc(32, 0x02);
    expect(hashSecret('same', p1)).not.toBe(hashSecret('same', p2));
  });

  it('differs when secret differs', () => {
    const pepper = Buffer.alloc(32, 0x42);
    expect(hashSecret('a', pepper)).not.toBe(hashSecret('b', pepper));
  });

  it('emits 64-char hex (256 bits)', () => {
    const pepper = Buffer.alloc(32, 0x42);
    expect(hashSecret('x', pepper)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('safeEqualHex', () => {
  it('returns true for identical hex strings', () => {
    const h = hashSecret('x', Buffer.alloc(32, 0x01));
    expect(safeEqualHex(h, h)).toBe(true);
  });

  it('returns false for different hex strings of same length', () => {
    const p = Buffer.alloc(32, 0x01);
    expect(safeEqualHex(hashSecret('a', p), hashSecret('b', p))).toBe(false);
  });

  it('returns false for different lengths without throwing', () => {
    expect(safeEqualHex('aa', 'aabb')).toBe(false);
  });

  it('returns false for empty inputs', () => {
    expect(safeEqualHex('', '')).toBe(false);
  });
});
