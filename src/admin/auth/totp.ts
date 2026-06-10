import { Secret, TOTP } from 'otpauth';

const ISSUER = 'SAM';

function totp(secret: string, label: string): TOTP {
  return new TOTP({ issuer: ISSUER, label, secret: Secret.fromBase32(secret) });
}

/** Generate a fresh base32 TOTP secret for operator enrolment. */
export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

/** otpauth:// URI for QR enrolment in an authenticator app. */
export function totpKeyUri(username: string, secret: string): string {
  return totp(secret, username).toString();
}

/**
 * Verify a 6-digit code against the operator's secret, allowing ±1 step for
 * clock skew. `timestampMs` is injectable for deterministic tests.
 */
export function verifyTotp(
  secret: string,
  token: string,
  timestampMs?: number,
): boolean {
  const delta = totp(secret, '').validate({
    token,
    window: 1,
    timestamp: timestampMs,
  });
  return delta !== null;
}
