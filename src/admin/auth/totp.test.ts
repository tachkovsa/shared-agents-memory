import { Secret, TOTP } from 'otpauth';
import { describe, expect, it } from 'vitest';
import { generateTotpSecret, totpKeyUri, verifyTotp } from './totp.js';

const AT = Date.parse('2026-06-08T12:00:00Z');

function codeAt(secret: string, timestampMs: number): string {
  return new TOTP({ secret: Secret.fromBase32(secret) }).generate({
    timestamp: timestampMs,
  });
}

describe('totp', () => {
  it('generates a usable base32 secret', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(secret.length).toBeGreaterThan(0);
  });

  it('verifies a code generated at the same instant', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, codeAt(secret, AT), AT)).toBe(true);
  });

  it('rejects an incorrect code', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, '000000', AT)).toBe(false);
  });

  it('builds an otpauth:// enrolment URI carrying the issuer', () => {
    const secret = generateTotpSecret();
    const uri = totpKeyUri('admin', secret);
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('issuer=SAM');
  });
});
