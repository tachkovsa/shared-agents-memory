import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSetupTokenStore, SETUP_TOKEN_PREFIX } from './setup-token.js';

let dir: string;
let store: FileSetupTokenStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sam-setup-'));
  store = new FileSetupTokenStore(join(dir, '_admin', '.setup_token'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FileSetupTokenStore', () => {
  it('issues a prefixed token once and does not reissue', async () => {
    const first = await store.ensureToken();
    expect(first).not.toBeNull();
    expect(first?.startsWith(SETUP_TOKEN_PREFIX)).toBe(true);
    expect(await store.ensureToken()).toBeNull();
  });

  it('verifies the issued token and rejects others', async () => {
    const token = await store.ensureToken();
    expect(await store.verify(token!)).toBe(true);
    expect(await store.verify('sam_setup_wrong')).toBe(false);
  });

  it('returns false before any token is issued', async () => {
    expect(await store.verify('anything')).toBe(false);
  });

  it('rejects the token once consumed, but can issue a fresh one', async () => {
    const token = await store.ensureToken();
    await store.consume();
    expect(await store.verify(token!)).toBe(false);
    const reissued = await store.ensureToken();
    expect(reissued).not.toBeNull();
    expect(reissued).not.toBe(token);
  });
});
