import { describe, expect, it } from 'vitest';
import {
  Argon2idPasswordHasher,
  OWASP_SCRYPT_PARAMS,
  ScryptPasswordHasher,
} from './password.js';

// Fast params keep the suite snappy; cost itself isn't what's under test.
const hasher = new ScryptPasswordHasher({ N: 16384, r: 8, p: 1 });

describe('ScryptPasswordHasher', () => {
  it('hashes into the scrypt$N$r$p$salt$hash format', async () => {
    const parts = (await hasher.hash('correct horse battery staple')).split('$');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
    expect(parts.slice(1, 4)).toEqual(['16384', '8', '1']);
  });

  it('defaults to the OWASP cost parameters', async () => {
    const hash = await new ScryptPasswordHasher().hash('pw');
    expect(hash.split('$').slice(1, 4)).toEqual([
      String(OWASP_SCRYPT_PARAMS.N),
      String(OWASP_SCRYPT_PARAMS.r),
      String(OWASP_SCRYPT_PARAMS.p),
    ]);
  });

  it('verifies the correct password', async () => {
    const hash = await hasher.hash('s3cret-passphrase');
    expect(await hasher.verify('s3cret-passphrase', hash)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hasher.hash('s3cret-passphrase');
    expect(await hasher.verify('wrong', hash)).toBe(false);
  });

  it('reads cost params from the stored hash, not the verifying instance', async () => {
    const stored = await new ScryptPasswordHasher({ N: 16384, r: 8, p: 1 }).hash('pw');
    // a differently-configured instance still verifies it
    expect(await new ScryptPasswordHasher({ N: 32768, r: 8, p: 1 }).verify('pw', stored)).toBe(
      true,
    );
  });

  it('rejects malformed or out-of-range stored values', async () => {
    expect(await hasher.verify('x', 'not-a-hash')).toBe(false);
    expect(await hasher.verify('x', 'bcrypt$16384$8$1$aa$bb')).toBe(false);
    expect(await hasher.verify('x', 'scrypt$0$8$1$aa$bb')).toBe(false);
    expect(await hasher.verify('x', 'scrypt$16384$8$1$$')).toBe(false);
  });

  it('produces distinct hashes for the same password (random salt)', async () => {
    const a = await hasher.hash('same');
    const b = await hasher.hash('same');
    expect(a).not.toBe(b);
  });
});

describe('Argon2idPasswordHasher', () => {
  const argon = new Argon2idPasswordHasher();

  it('produces an argon2id-encoded hash and verifies it', async () => {
    const hash = await argon.hash('correct-passphrase-1');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await argon.verify('correct-passphrase-1', hash)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await argon.hash('correct-passphrase-1');
    expect(await argon.verify('wrong', hash)).toBe(false);
  });

  it('rejects a malformed stored value instead of throwing', async () => {
    expect(await argon.verify('pw', 'not-an-argon-hash')).toBe(false);
  });
});
