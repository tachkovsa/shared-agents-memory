import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';
import { Algorithm, hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: ScryptOptions,
) => Promise<Buffer>;

const SCHEME = 'scrypt';
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

// Guards against a crafted stored value forcing a huge scrypt allocation.
const MAX_N = 1 << 20;
const MAX_R = 32;
const MAX_P = 16;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** OWASP Password Storage Cheat Sheet baseline for scrypt (2024). */
export const OWASP_SCRYPT_PARAMS: ScryptParams = { N: 1 << 17, r: 8, p: 1 };

function maxmemFor(params: ScryptParams): number {
  // scrypt needs ~128*N*r bytes; give generous headroom.
  return 256 * params.N * params.r;
}

/**
 * Password hashing behind an interface so ADR-0007 §5 Q2 (scrypt now,
 * argon2id once signed off) is a one-class swap. Cost params are stored inside
 * the hash, so a future raise re-verifies old hashes and enables rehash
 * detection. Format: scrypt$N$r$p$saltHex$hashHex.
 */
export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, stored: string): Promise<boolean>;
}

export class ScryptPasswordHasher implements PasswordHasher {
  constructor(private readonly params: ScryptParams = OWASP_SCRYPT_PARAMS) {}

  async hash(plain: string): Promise<string> {
    const { N, r, p } = this.params;
    const salt = randomBytes(SALT_LENGTH);
    const derived = await scryptAsync(plain, salt, KEY_LENGTH, {
      N,
      r,
      p,
      maxmem: maxmemFor(this.params),
    });
    return [SCHEME, N, r, p, salt.toString('hex'), derived.toString('hex')].join('$');
  }

  async verify(plain: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== SCHEME) return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (
      !Number.isInteger(N) ||
      !Number.isInteger(r) ||
      !Number.isInteger(p) ||
      N <= 1 ||
      N > MAX_N ||
      r < 1 ||
      r > MAX_R ||
      p < 1 ||
      p > MAX_P
    ) {
      return false;
    }
    const salt = Buffer.from(parts[4]!, 'hex');
    const expected = Buffer.from(parts[5]!, 'hex');
    if (salt.length === 0 || expected.length === 0) return false;
    const derived = await scryptAsync(plain, salt, expected.length, {
      N,
      r,
      p,
      maxmem: maxmemFor({ N, r, p }),
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  }
}

// OWASP argon2id baseline: 19 MiB, 2 iterations, 1 lane.
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * argon2id via @node-rs/argon2 (prebuilt binaries, no node-gyp). The signed-off
 * production default (ADR-0007 §5.1 Q2). The encoded hash carries its own
 * params, so verify reads them from the stored value.
 */
export class Argon2idPasswordHasher implements PasswordHasher {
  async hash(plain: string): Promise<string> {
    return argon2Hash(plain, ARGON2_OPTIONS);
  }

  async verify(plain: string, stored: string): Promise<boolean> {
    try {
      return await argon2Verify(stored, plain);
    } catch {
      return false;
    }
  }
}
