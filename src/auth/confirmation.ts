import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface ConfirmationPayload {
  session_id: string;
  tool_id: string;
  input_hash: string;
  expires_at: number;
}

export const DEFAULT_CONFIRMATION_TTL_MS = 60_000;

export function canonicalJsonHash(input: unknown): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex');
}

export function makeConfirmation(
  payload: ConfirmationPayload,
  key: Buffer,
): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, 'utf8').toString('base64url');
  const hmac = createHmac('sha256', key).update(b64).digest('base64url');
  return `${b64}.${hmac}`;
}

export type VerifyConfirmationResult =
  | { ok: true; payload: ConfirmationPayload }
  | { ok: false; reason: 'malformed' | 'expired' | 'mismatch' };

export function verifyConfirmation(
  token: string,
  expected: { session_id: string; tool_id: string; input_hash: string },
  key: Buffer,
  now: () => Date = () => new Date(),
): VerifyConfirmationResult {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [b64, providedHmac] = parts as [string, string];
  if (!b64 || !providedHmac) return { ok: false, reason: 'malformed' };

  const expectedHmac = createHmac('sha256', key).update(b64).digest('base64url');
  const aBuf = Buffer.from(providedHmac);
  const bBuf = Buffer.from(expectedHmac);
  if (aBuf.length !== bBuf.length || !timingSafeEqual(aBuf, bBuf)) {
    return { ok: false, reason: 'mismatch' };
  }

  let payload: ConfirmationPayload;
  try {
    payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (
    typeof payload.session_id !== 'string' ||
    typeof payload.tool_id !== 'string' ||
    typeof payload.input_hash !== 'string' ||
    typeof payload.expires_at !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }

  if (payload.expires_at <= now().getTime()) {
    return { ok: false, reason: 'expired' };
  }

  if (
    payload.session_id !== expected.session_id ||
    payload.tool_id !== expected.tool_id ||
    payload.input_hash !== expected.input_hash
  ) {
    return { ok: false, reason: 'mismatch' };
  }

  return { ok: true, payload };
}

export class ConsumedConfirmations {
  private readonly consumed = new Map<string, number>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  has(token: string): boolean {
    this.gc();
    return this.consumed.has(token);
  }

  consume(token: string, expiresAt: number): void {
    this.gc();
    this.consumed.set(token, expiresAt);
  }

  private gc(): void {
    const t = this.now().getTime();
    for (const [key, expiry] of this.consumed) {
      if (expiry <= t) this.consumed.delete(key);
    }
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`,
  );
  return `{${parts.join(',')}}`;
}
