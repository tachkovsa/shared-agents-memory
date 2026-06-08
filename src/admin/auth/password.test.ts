import { describe, expect, it } from 'vitest';
import { ScryptPasswordHasher } from './password.js';

const hasher = new ScryptPasswordHasher();

describe('ScryptPasswordHasher', () => {
  it('hashes into the scrypt$salt$hash format', async () => {
    const hash = await hasher.hash('correct horse battery staple');
    expect(hash.split('$')).toHaveLength(3);
    expect(hash.startsWith('scrypt$')).toBe(true);
  });

  it('verifies the correct password', async () => {
    const hash = await hasher.hash('s3cret-passphrase');
    expect(await hasher.verify('s3cret-passphrase', hash)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hasher.hash('s3cret-passphrase');
    expect(await hasher.verify('wrong', hash)).toBe(false);
  });

  it('rejects a malformed stored value', async () => {
    expect(await hasher.verify('x', 'not-a-hash')).toBe(false);
    expect(await hasher.verify('x', 'bcrypt$aa$bb')).toBe(false);
    expect(await hasher.verify('x', 'scrypt$$')).toBe(false);
  });

  it('produces distinct hashes for the same password (random salt)', async () => {
    const a = await hasher.hash('same');
    const b = await hasher.hash('same');
    expect(a).not.toBe(b);
  });
});
