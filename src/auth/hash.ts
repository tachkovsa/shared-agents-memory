import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOKEN_NAMESPACE = 'sam_pat_';
export const TOKEN_SECRET_LENGTH = 27;
export const TOKEN_PREFIX_LENGTH = 12;

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateSecret(): string {
  const bytes = randomBytes(17);
  let bits = 0;
  let buffer = 0;
  let out = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < TOKEN_SECRET_LENGTH) {
      bits -= 5;
      const index = (buffer >>> bits) & 0x1f;
      out += CROCKFORD_ALPHABET[index];
    }
    if (out.length === TOKEN_SECRET_LENGTH) break;
  }
  return out;
}

export function generateToken(): string {
  return `${TOKEN_NAMESPACE}${generateSecret()}`;
}

export function parseToken(raw: string): { secret: string; prefix: string } | null {
  if (!raw.startsWith(TOKEN_NAMESPACE)) return null;
  const secret = raw.slice(TOKEN_NAMESPACE.length);
  if (secret.length !== TOKEN_SECRET_LENGTH) return null;
  for (let i = 0; i < secret.length; i++) {
    if (CROCKFORD_ALPHABET.indexOf(secret[i]!) === -1) return null;
  }
  return { secret, prefix: secret.slice(0, TOKEN_PREFIX_LENGTH) };
}

export function hashSecret(secret: string, pepper: Buffer): string {
  return createHmac('sha256', pepper).update(secret, 'utf8').digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}
