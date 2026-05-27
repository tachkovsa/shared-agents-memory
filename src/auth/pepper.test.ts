import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadOrInitPepper,
  PepperMismatchError,
  PEPPER_BYTES,
} from './pepper.js';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'sam-pepper-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function hex(byte: number): string {
  return Buffer.alloc(PEPPER_BYTES, byte).toString('hex');
}

describe('loadOrInitPepper', () => {
  it('generates a fresh pepper when neither file nor env exists', async () => {
    const path = join(workDir, '_auth', '.pepper');
    const pepper = await loadOrInitPepper({ pepperFilePath: path, envValue: undefined });

    expect(pepper).toHaveLength(PEPPER_BYTES);
    const raw = await readFile(path, 'utf8');
    expect(raw.trim()).toBe(pepper.toString('hex'));

    if (process.platform !== 'win32') {
      const st = await stat(path);
      expect(st.mode & 0o777).toBe(0o600);
    }
  });

  it('returns the file pepper when env is absent', async () => {
    const path = join(workDir, '.pepper');
    const stored = hex(0x42);
    await writeFile(path, stored, { mode: 0o600 });

    const pepper = await loadOrInitPepper({ pepperFilePath: path, envValue: undefined });
    expect(pepper.toString('hex')).toBe(stored);
  });

  it('writes env pepper to disk when file is missing', async () => {
    const path = join(workDir, '_auth', '.pepper');
    const env = hex(0x07);

    const pepper = await loadOrInitPepper({ pepperFilePath: path, envValue: env });
    expect(pepper.toString('hex')).toBe(env);

    const onDisk = (await readFile(path, 'utf8')).trim();
    expect(onDisk).toBe(env);
  });

  it('accepts file + env when they match', async () => {
    const path = join(workDir, '.pepper');
    const value = hex(0x11);
    await writeFile(path, value, { mode: 0o600 });

    const pepper = await loadOrInitPepper({ pepperFilePath: path, envValue: value });
    expect(pepper.toString('hex')).toBe(value);
  });

  it('throws PepperMismatchError when file and env disagree', async () => {
    const path = join(workDir, '.pepper');
    await writeFile(path, hex(0x11), { mode: 0o600 });

    await expect(
      loadOrInitPepper({ pepperFilePath: path, envValue: hex(0x22) }),
    ).rejects.toBeInstanceOf(PepperMismatchError);
  });

  it('rejects malformed pepper in env', async () => {
    const path = join(workDir, '.pepper');
    await expect(
      loadOrInitPepper({ pepperFilePath: path, envValue: 'not-hex' }),
    ).rejects.toBeInstanceOf(PepperMismatchError);
  });

  it('rejects malformed pepper in file', async () => {
    const path = join(workDir, '.pepper');
    await writeFile(path, 'too-short', { mode: 0o600 });
    await expect(
      loadOrInitPepper({ pepperFilePath: path, envValue: undefined }),
    ).rejects.toBeInstanceOf(PepperMismatchError);
  });
});
