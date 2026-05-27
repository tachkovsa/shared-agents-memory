import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const PEPPER_BYTES = 32;
export const PEPPER_ENV_VAR = 'SERVER_PEPPER';

export interface PepperSource {
  pepperFilePath: string;
  envValue: string | undefined;
}

export class PepperMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PepperMismatchError';
  }
}

export async function loadOrInitPepper(src: PepperSource): Promise<Buffer> {
  const fromFile = await readPepperFile(src.pepperFilePath);
  const fromEnv = parseEnvPepper(src.envValue);

  if (!fromFile && !fromEnv) {
    const fresh = randomBytes(PEPPER_BYTES);
    await writePepperFile(src.pepperFilePath, fresh);
    return fresh;
  }

  if (fromFile && !fromEnv) return fromFile;

  if (!fromFile && fromEnv) {
    await writePepperFile(src.pepperFilePath, fromEnv);
    return fromEnv;
  }

  if (fromFile && fromEnv) {
    if (fromFile.length !== fromEnv.length || !fromFile.equals(fromEnv)) {
      throw new PepperMismatchError(
        `Pepper mismatch: ${src.pepperFilePath} disagrees with $${PEPPER_ENV_VAR}. ` +
          `Refusing to start. Either restore the original pepper, or wipe both ` +
          `(this invalidates every existing PAT).`,
      );
    }
    return fromFile;
  }

  throw new Error('unreachable');
}

async function readPepperFile(path: string): Promise<Buffer | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const trimmed = raw.trim();
    return decodeHex(trimmed);
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

async function writePepperFile(path: string, pepper: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, pepper.toString('hex'), { mode: 0o600 });
  await chmod(path, 0o600);
}

function parseEnvPepper(value: string | undefined): Buffer | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return decodeHex(trimmed);
}

function decodeHex(value: string): Buffer {
  if (value.length !== PEPPER_BYTES * 2 || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new PepperMismatchError(
      `Invalid pepper: expected ${PEPPER_BYTES * 2} hex chars, got ${value.length}.`,
    );
  }
  return Buffer.from(value, 'hex');
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
