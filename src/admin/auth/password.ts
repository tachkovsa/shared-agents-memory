import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: ScryptOptions,
) => Promise<Buffer>;

// scrypt cost parameters. N*128*r ≈ 16 MiB, within Node's default maxmem.
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const SCHEME = 'scrypt';

/**
 * Password hashing behind an interface so ADR-0007 §5 Q2 (scrypt now,
 * argon2id once signed off) is a one-class swap, not a refactor.
 */
export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, stored: string): Promise<boolean>;
}

/** scrypt via node:crypto — zero native dependency. Format: scrypt$<saltHex>$<hashHex>. */
export class ScryptPasswordHasher implements PasswordHasher {
  async hash(plain: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const derived = await scryptAsync(plain, salt, KEY_LENGTH, { N, r: R, p: P });
    return `${SCHEME}$${salt.toString('hex')}$${derived.toString('hex')}`;
  }

  async verify(plain: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== SCHEME) return false;
    const salt = Buffer.from(parts[1]!, 'hex');
    const expected = Buffer.from(parts[2]!, 'hex');
    if (salt.length === 0 || expected.length === 0) return false;
    const derived = await scryptAsync(plain, salt, expected.length, { N, r: R, p: P });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  }
}
