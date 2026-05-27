import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { namespaceDir } from '../namespaces/store.js';
import type { Namespace, NamespaceMembers } from '../namespaces/types.js';
import {
  BootstrapStateError,
  deriveBootstrapPaths,
  runBootstrapIfNeeded,
  type BootstrapLogger,
} from './bootstrap.js';
import { PatStore } from './pat-store.js';

const PEPPER = Buffer.alloc(32, 0x42);

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'sam-boot-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function makeLogger(): BootstrapLogger & { logs: string[]; warns: string[] } {
  const logs: string[] = [];
  const warns: string[] = [];
  return {
    log: (line) => logs.push(line),
    warn: (line) => warns.push(line),
    logs,
    warns,
  };
}

async function openStore(paths = deriveBootstrapPaths(workDir)): Promise<PatStore> {
  return PatStore.open({ storePath: paths.patsJsonlPath, pepper: PEPPER });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('runBootstrapIfNeeded (first boot)', () => {
  it('mints a service:admin PAT, creates the personal namespace, and prints the banner', async () => {
    const paths = deriveBootstrapPaths(workDir);
    const patStore = await openStore(paths);
    const logger = makeLogger();

    const result = await runBootstrapIfNeeded({
      dataDir: workDir,
      patStore,
      paths,
      logger,
    });

    expect(result.bootstrapped).toBe(true);
    if (!result.bootstrapped) return;

    expect(result.namespaceId).toBe('personal');
    expect(result.secret.startsWith('sam_pat_')).toBe(true);

    const mintedPat = patStore.get(result.patId);
    expect(mintedPat?.scopes).toContain('service:admin');
    expect(mintedPat?.scopes).toContain('memory:read');
    expect(mintedPat?.allowed_namespaces).toEqual(['personal']);
    expect(mintedPat?.created_by).toBe(result.agentId);

    // Token resolves back through the store.
    const lookup = patStore.lookup(result.secret);
    expect(lookup.ok).toBe(true);

    // Namespace skeleton on disk.
    const ns: Namespace = JSON.parse(
      await readFile(join(namespaceDir(workDir, 'personal'), '_namespace.json'), 'utf8'),
    );
    expect(ns.owner_agent_id).toBe(result.agentId);

    const members: NamespaceMembers = JSON.parse(
      await readFile(join(namespaceDir(workDir, 'personal'), '_members.json'), 'utf8'),
    );
    expect(members.members[0]!.agent_id).toBe(result.agentId);

    // Banner + token file + done marker.
    expect(logger.logs.some((l) => l.includes('FIRST-BOOT BOOTSTRAP TOKEN'))).toBe(true);
    expect(logger.logs.some((l) => l.includes(result.secret))).toBe(true);
    expect(await fileExists(paths.bootstrapTokenPath)).toBe(true);
    expect(await fileExists(paths.bootstrapDonePath)).toBe(true);

    const tokenFile = await readFile(paths.bootstrapTokenPath, 'utf8');
    expect(tokenFile.trim()).toBe(result.secret);

    if (process.platform !== 'win32') {
      const tokenStat = await stat(paths.bootstrapTokenPath);
      expect(tokenStat.mode & 0o777).toBe(0o600);
    }
  });
});

describe('runBootstrapIfNeeded (restart)', () => {
  it('does not re-mint or re-emit the banner on the next boot', async () => {
    const paths = deriveBootstrapPaths(workDir);
    const firstStore = await openStore(paths);
    const firstLogger = makeLogger();
    const first = await runBootstrapIfNeeded({
      dataDir: workDir,
      patStore: firstStore,
      paths,
      logger: firstLogger,
    });
    expect(first.bootstrapped).toBe(true);

    // Simulate the operator deleting the lingering token file (proper hygiene).
    await rm(paths.bootstrapTokenPath);

    const secondStore = await openStore(paths);
    const secondLogger = makeLogger();
    const second = await runBootstrapIfNeeded({
      dataDir: workDir,
      patStore: secondStore,
      paths,
      logger: secondLogger,
    });

    expect(second.bootstrapped).toBe(false);
    expect(secondStore.list()).toHaveLength(1);
    expect(secondLogger.logs).toHaveLength(0);
    expect(secondLogger.warns).toHaveLength(0);
  });

  it('warns when .bootstrap_token is still on disk after bootstrap', async () => {
    const paths = deriveBootstrapPaths(workDir);
    const firstStore = await openStore(paths);
    await runBootstrapIfNeeded({
      dataDir: workDir,
      patStore: firstStore,
      paths,
      logger: makeLogger(),
    });

    const secondStore = await openStore(paths);
    const logger = makeLogger();
    const result = await runBootstrapIfNeeded({
      dataDir: workDir,
      patStore: secondStore,
      paths,
      logger,
    });

    expect(result.bootstrapped).toBe(false);
    if (!result.bootstrapped) {
      expect(result.bootstrapTokenLingering).toBe(true);
    }
    expect(logger.warns.some((w) => w.includes('still exists'))).toBe(true);
  });

  it('restores a missing .bootstrap_done marker when PATs exist', async () => {
    const paths = deriveBootstrapPaths(workDir);
    const firstStore = await openStore(paths);
    await runBootstrapIfNeeded({
      dataDir: workDir,
      patStore: firstStore,
      paths,
      logger: makeLogger(),
    });

    await rm(paths.bootstrapDonePath);
    await rm(paths.bootstrapTokenPath);

    const secondStore = await openStore(paths);
    const result = await runBootstrapIfNeeded({
      dataDir: workDir,
      patStore: secondStore,
      paths,
      logger: makeLogger(),
    });

    expect(result.bootstrapped).toBe(false);
    expect(await fileExists(paths.bootstrapDonePath)).toBe(true);
  });
});

describe('runBootstrapIfNeeded (corrupt state)', () => {
  it('refuses to start when .bootstrap_done exists but PATs are missing', async () => {
    const paths = deriveBootstrapPaths(workDir);
    // Open the store first — its initialiser creates the _auth/ directory.
    const patStore = await openStore(paths);
    await writeFile(paths.bootstrapDonePath, '', { mode: 0o600 });

    await expect(
      runBootstrapIfNeeded({
        dataDir: workDir,
        patStore,
        paths,
        logger: makeLogger(),
      }),
    ).rejects.toBeInstanceOf(BootstrapStateError);
  });
});
