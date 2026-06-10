import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * One-time token gating first-operator creation (ADR-0007 §3.4). Mirrors the
 * PAT bootstrap pattern: generated + printed once on first start, required by
 * /setup, consumed once the first operator exists. Without it, whoever reaches
 * an empty admin first could claim the owner account.
 */
export interface SetupTokenVerifier {
  verify(token: string): Promise<boolean>;
  consume(): Promise<void>;
}

export const SETUP_TOKEN_PREFIX = 'sam_setup_';

export class FileSetupTokenStore implements SetupTokenVerifier {
  private readonly tokenPath: string;

  constructor(tokenPath: string) {
    this.tokenPath = tokenPath;
  }

  /**
   * Persist a fresh token if none exists yet; return the plaintext to print.
   * Returns null when a token was already issued (don't reprint on restart).
   */
  async ensureToken(): Promise<string | null> {
    if ((await this.read()) !== null) return null;
    const token = `${SETUP_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
    await mkdir(dirname(this.tokenPath), { recursive: true });
    await writeFile(this.tokenPath, token, { mode: 0o600 });
    return token;
  }

  async verify(token: string): Promise<boolean> {
    const stored = await this.read();
    if (!stored) return false;
    const a = Buffer.from(token);
    const b = Buffer.from(stored);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async consume(): Promise<void> {
    await rm(this.tokenPath, { force: true });
  }

  private async read(): Promise<string | null> {
    try {
      return (await readFile(this.tokenPath, 'utf8')).trim();
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }
}

/** Default location of the setup-token file under the data directory. */
export function setupTokenPath(dataDir: string): string {
  return join(dataDir, '_admin', '.setup_token');
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
