import { chmod, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createId } from '@paralleldrive/cuid2';
import {
  BOOTSTRAP_NAMESPACE_DISPLAY_NAME,
  BOOTSTRAP_NAMESPACE_ID,
  createNamespaceSkeleton,
} from '../namespaces/index.js';
import { PatStore } from './pat-store.js';
import { ALL_SCOPES, type AgentScope } from './types.js';

export interface BootstrapPaths {
  pepperFilePath: string;
  patsJsonlPath: string;
  bootstrapTokenPath: string;
  bootstrapDonePath: string;
}

export function deriveBootstrapPaths(dataDir: string): BootstrapPaths {
  const authDir = join(dataDir, '_auth');
  return {
    pepperFilePath: join(authDir, '.pepper'),
    patsJsonlPath: join(authDir, 'pats.jsonl'),
    bootstrapTokenPath: join(authDir, '.bootstrap_token'),
    bootstrapDonePath: join(authDir, '.bootstrap_done'),
  };
}

export interface BootstrapLogger {
  log: (line: string) => void;
  warn: (line: string) => void;
}

export const stderrLogger: BootstrapLogger = {
  log: (line) => process.stderr.write(`${line}\n`),
  warn: (line) => process.stderr.write(`${line}\n`),
};

export interface RunBootstrapOptions {
  dataDir: string;
  patStore: PatStore;
  paths?: BootstrapPaths;
  logger?: BootstrapLogger;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export type BootstrapResult =
  | {
      bootstrapped: true;
      agentId: string;
      patId: string;
      namespaceId: string;
      secret: string;
    }
  | {
      bootstrapped: false;
      bootstrapTokenLingering: boolean;
    };

export class BootstrapStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapStateError';
  }
}

export async function runBootstrapIfNeeded(opts: RunBootstrapOptions): Promise<BootstrapResult> {
  const paths = opts.paths ?? deriveBootstrapPaths(opts.dataDir);
  const logger = opts.logger ?? stderrLogger;

  const donePresent = await fileExists(paths.bootstrapDonePath);
  const patsPresent = opts.patStore.list().length > 0;
  const tokenPresent = await fileExists(paths.bootstrapTokenPath);

  if (donePresent && !patsPresent) {
    throw new BootstrapStateError(
      `Bootstrap marker ${paths.bootstrapDonePath} exists but no PATs were loaded ` +
        `from ${paths.patsJsonlPath}. This indicates data corruption — refusing to start. ` +
        `Either restore the PAT store from backup, or wipe both files and re-bootstrap.`,
    );
  }

  if (patsPresent) {
    if (!donePresent) {
      await writeFile(paths.bootstrapDonePath, '', { mode: 0o600 });
      await chmod(paths.bootstrapDonePath, 0o600);
    }
    if (tokenPresent) {
      logger.warn(
        `WARNING: ${paths.bootstrapTokenPath} still exists; delete it after copying the secret.`,
      );
    }
    return { bootstrapped: false, bootstrapTokenLingering: tokenPresent };
  }

  const agentId = createId();
  const minted = await opts.patStore.mint({
    display_name: 'bootstrap service:admin',
    agent_identity: agentId,
    allowed_namespaces: [BOOTSTRAP_NAMESPACE_ID],
    scopes: [...ALL_SCOPES] as AgentScope[],
    created_by: agentId,
    expires_at: null,
  });

  await createNamespaceSkeleton(opts.dataDir, {
    id: BOOTSTRAP_NAMESPACE_ID,
    display_name: BOOTSTRAP_NAMESPACE_DISPLAY_NAME,
    owner_agent_id: agentId,
    owner_scopes: [...ALL_SCOPES] as AgentScope[],
    added_by: agentId,
    env: opts.env,
    now: opts.now,
  });

  await writeFile(paths.bootstrapTokenPath, `${minted.secret}\n`, { mode: 0o600 });
  await chmod(paths.bootstrapTokenPath, 0o600);
  await writeFile(paths.bootstrapDonePath, '', { mode: 0o600 });
  await chmod(paths.bootstrapDonePath, 0o600);

  emitBanner(logger, minted.secret, paths.bootstrapTokenPath);

  return {
    bootstrapped: true,
    agentId,
    patId: minted.pat.id,
    namespaceId: BOOTSTRAP_NAMESPACE_ID,
    secret: minted.secret,
  };
}

function emitBanner(logger: BootstrapLogger, secret: string, tokenFilePath: string): void {
  const rule = '='.repeat(63);
  const lines = [
    '',
    rule,
    'FIRST-BOOT BOOTSTRAP TOKEN — SAVE THIS, IT WILL NOT BE SHOWN AGAIN',
    '',
    `    ${secret}`,
    '',
    `Also written to: ${tokenFilePath} (mode 0600).`,
    'DELETE THAT FILE AS SOON AS YOU HAVE COPIED THE TOKEN.',
    'The server will refuse to print it on later boots.',
    rule,
    '',
  ];
  for (const line of lines) logger.log(line);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}
