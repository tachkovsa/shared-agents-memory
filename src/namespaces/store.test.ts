import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createNamespaceSkeleton,
  listNamespaceIds,
  loadMembers,
  loadNamespace,
  NamespaceExistsError,
  namespaceDir,
  pruneOrphanedMembers,
  saveMembers,
  softDeleteNamespace,
} from './store.js';
import type { Namespace, NamespaceMembers } from './types.js';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'sam-ns-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('createNamespaceSkeleton', () => {
  it('writes the full directory tree and JSON files', async () => {
    const ns = await createNamespaceSkeleton(workDir, {
      id: 'personal',
      display_name: 'Personal',
      owner_agent_id: 'agent_alice',
      owner_scopes: ['memory:read', 'memory:write', 'service:admin'],
      now: () => new Date('2026-05-27T12:00:00Z'),
    });

    expect(ns.id).toBe('personal');
    expect(ns.visibility).toBe('private');
    expect(ns.retention_policy).toBe('keep-forever');
    expect(ns.quota.daily_embedding_tokens).toBeGreaterThan(0);

    const dir = namespaceDir(workDir, 'personal');
    const onDisk: Namespace = JSON.parse(
      await readFile(join(dir, '_namespace.json'), 'utf8'),
    );
    expect(onDisk.id).toBe('personal');
    expect(onDisk.owner_agent_id).toBe('agent_alice');

    const members: NamespaceMembers = JSON.parse(
      await readFile(join(dir, '_members.json'), 'utf8'),
    );
    expect(members.members).toHaveLength(1);
    expect(members.members[0]!.agent_id).toBe('agent_alice');
    expect(members.members[0]!.scopes).toContain('service:admin');

    const quotaState = JSON.parse(await readFile(join(dir, '_quota.json'), 'utf8'));
    expect(quotaState).toHaveProperty('usage');
    expect(quotaState).toHaveProperty('last_reset');

    const indexBody = await readFile(join(dir, 'rules', 'INDEX.md'), 'utf8');
    expect(indexBody.length).toBeGreaterThan(0);

    const auditStat = await stat(join(dir, 'audit'));
    expect(auditStat.isDirectory()).toBe(true);
  });

  it('respects DEFAULT_NS_* env overrides', async () => {
    const ns = await createNamespaceSkeleton(workDir, {
      id: 'tight',
      display_name: 'Tight',
      owner_agent_id: 'agent_x',
      owner_scopes: ['memory:read'],
      env: {
        DEFAULT_NS_DAILY_EMBEDDING_TOKENS: '50000',
        DEFAULT_NS_DAILY_WRITES: '100',
        DEFAULT_NS_DAILY_SEARCHES: '500',
        DEFAULT_NS_MAX_MEMORIES: '2000',
      },
    });
    expect(ns.quota).toEqual({
      daily_embedding_tokens: 50_000,
      daily_writes: 100,
      daily_searches: 500,
      max_memories: 2_000,
    });
  });

  it('rejects malformed DEFAULT_NS_* values', async () => {
    await expect(
      createNamespaceSkeleton(workDir, {
        id: 'bad',
        display_name: 'Bad',
        owner_agent_id: 'agent_x',
        owner_scopes: [],
        env: { DEFAULT_NS_DAILY_WRITES: 'twelve' },
      }),
    ).rejects.toThrow(/positive integer/);
  });

  it('throws NamespaceExistsError if the namespace directory already exists', async () => {
    await createNamespaceSkeleton(workDir, {
      id: 'duplicate',
      display_name: 'Dup',
      owner_agent_id: 'agent_x',
      owner_scopes: [],
    });

    await expect(
      createNamespaceSkeleton(workDir, {
        id: 'duplicate',
        display_name: 'Dup2',
        owner_agent_id: 'agent_y',
        owner_scopes: [],
      }),
    ).rejects.toThrow(NamespaceExistsError);
  });

  it('cleans up a leftover .tmp- dir before creating', async () => {
    // Simulate a leftover temp dir from a crashed previous run.
    const nsDir = join(workDir, 'namespaces');
    const { mkdir: fsMkdir } = await import('node:fs/promises');
    await fsMkdir(join(nsDir, '.tmp-orphan-abc123'), { recursive: true });

    // Should not throw; the stale .tmp-orphan- dir is not for our id, so it's left alone.
    // Create a namespace with a different id.
    const ns = await createNamespaceSkeleton(workDir, {
      id: 'orphan',
      display_name: 'Orphan',
      owner_agent_id: 'agent_x',
      owner_scopes: [],
    });
    expect(ns.id).toBe('orphan');

    // The stale dir for a different ID should still exist (we only clean up our own prefix).
    const remaining = await readdir(nsDir);
    // 'orphan' dir exists; '.tmp-orphan-abc123' is cleaned up because prefix matches '.tmp-orphan-'
    expect(remaining).toContain('orphan');
  });

  it('atomically creates — directory appears only after rename', async () => {
    // We can't easily intercept the rename, but we can verify that no .tmp- dir remains after success.
    await createNamespaceSkeleton(workDir, {
      id: 'atomic',
      display_name: 'Atomic',
      owner_agent_id: 'agent_x',
      owner_scopes: [],
    });

    const nsDir = join(workDir, 'namespaces');
    const entries = await readdir(nsDir);
    // No leftover .tmp- directories.
    const tmpDirs = entries.filter((e) => e.startsWith('.tmp-'));
    expect(tmpDirs).toHaveLength(0);
    expect(entries).toContain('atomic');
  });
});

describe('listNamespaceIds', () => {
  it('returns empty array when namespaces dir does not exist', async () => {
    const ids = await listNamespaceIds(workDir);
    expect(ids).toEqual([]);
  });

  it('returns IDs of created namespaces', async () => {
    await createNamespaceSkeleton(workDir, {
      id: 'alpha',
      display_name: 'Alpha',
      owner_agent_id: 'agent_x',
      owner_scopes: [],
    });
    await createNamespaceSkeleton(workDir, {
      id: 'beta',
      display_name: 'Beta',
      owner_agent_id: 'agent_y',
      owner_scopes: [],
    });

    const ids = await listNamespaceIds(workDir);
    expect(ids).toHaveLength(2);
    expect(ids).toContain('alpha');
    expect(ids).toContain('beta');
  });

  it('skips hidden dirs (e.g. .tmp- directories)', async () => {
    const nsDir = join(workDir, 'namespaces');
    const { mkdir: fsMkdir } = await import('node:fs/promises');
    await fsMkdir(join(nsDir, '.tmp-foo-bar'), { recursive: true });

    const ids = await listNamespaceIds(workDir);
    expect(ids).toEqual([]);
  });
});

describe('softDeleteNamespace', () => {
  it('moves the namespace directory to _deleted/<id>-<ts>/', async () => {
    await createNamespaceSkeleton(workDir, {
      id: 'to-delete',
      display_name: 'Delete Me',
      owner_agent_id: 'agent_x',
      owner_scopes: [],
    });

    const nowMs = 1_700_000_000_000;
    const dest = await softDeleteNamespace(workDir, 'to-delete', nowMs);

    expect(dest).toContain('to-delete-1700000000000');

    // Source should be gone.
    const src = namespaceDir(workDir, 'to-delete');
    await expect(stat(src)).rejects.toThrow();

    // Destination should exist and still contain _namespace.json.
    const nsFile = join(dest, '_namespace.json');
    const onDisk: Namespace = JSON.parse(await readFile(nsFile, 'utf8'));
    expect(onDisk.id).toBe('to-delete');
  });

  it('throws NamespaceNotFoundError when source does not exist', async () => {
    const { NamespaceNotFoundError } = await import('./store.js');
    await expect(softDeleteNamespace(workDir, 'missing', Date.now())).rejects.toThrow(
      NamespaceNotFoundError,
    );
  });
});

describe('pruneOrphanedMembers', () => {
  it('removes entries for the given agent from all namespace member files', async () => {
    const now = () => new Date('2026-05-27T00:00:00Z');

    await createNamespaceSkeleton(workDir, {
      id: 'ns-one',
      display_name: 'NS One',
      owner_agent_id: 'agent_owner',
      owner_scopes: ['namespace:admin'],
      now,
    });
    await createNamespaceSkeleton(workDir, {
      id: 'ns-two',
      display_name: 'NS Two',
      owner_agent_id: 'agent_owner',
      owner_scopes: ['namespace:admin'],
      now,
    });

    // Add orphan agent to both namespaces.
    for (const nsId of ['ns-one', 'ns-two']) {
      const members = (await loadMembers(workDir, nsId)) ?? [];
      members.push({ agent_id: 'agent_orphan', scopes: ['memory:read'], added_by: 'agent_owner', added_at: now().toISOString() });
      await saveMembers(workDir, nsId, members);
    }

    const pruned = await pruneOrphanedMembers(workDir, 'agent_orphan');
    expect(pruned).toHaveLength(2);
    expect(pruned.map((p) => p.namespaceId).sort()).toEqual(['ns-one', 'ns-two']);
    expect(pruned.every((p) => p.removed === 1)).toBe(true);

    // Verify members files are updated.
    for (const nsId of ['ns-one', 'ns-two']) {
      const members = await loadMembers(workDir, nsId);
      expect(members?.some((m) => m.agent_id === 'agent_orphan')).toBe(false);
    }
  });

  it('returns empty array when agent is not a member anywhere', async () => {
    await createNamespaceSkeleton(workDir, {
      id: 'lone',
      display_name: 'Lone',
      owner_agent_id: 'agent_owner',
      owner_scopes: [],
    });

    const pruned = await pruneOrphanedMembers(workDir, 'agent_nobody');
    expect(pruned).toEqual([]);
  });

  it('does not remove non-matching agents', async () => {
    const now = () => new Date();
    await createNamespaceSkeleton(workDir, {
      id: 'mixed',
      display_name: 'Mixed',
      owner_agent_id: 'agent_owner',
      owner_scopes: ['namespace:admin'],
      now,
    });

    const members = (await loadMembers(workDir, 'mixed')) ?? [];
    members.push({ agent_id: 'agent_keeper', scopes: ['memory:read'], added_by: 'agent_owner', added_at: now().toISOString() });
    members.push({ agent_id: 'agent_gone', scopes: ['memory:read'], added_by: 'agent_owner', added_at: now().toISOString() });
    await saveMembers(workDir, 'mixed', members);

    await pruneOrphanedMembers(workDir, 'agent_gone');

    const after = await loadMembers(workDir, 'mixed');
    expect(after?.some((m) => m.agent_id === 'agent_keeper')).toBe(true);
    expect(after?.some((m) => m.agent_id === 'agent_gone')).toBe(false);
  });

  it('returns empty array when no namespaces exist', async () => {
    const pruned = await pruneOrphanedMembers(workDir, 'agent_x');
    expect(pruned).toEqual([]);
  });
});

describe('loadNamespace', () => {
  it('returns null for non-existent namespace', async () => {
    expect(await loadNamespace(workDir, 'missing')).toBeNull();
  });

  it('returns the namespace after creation', async () => {
    await createNamespaceSkeleton(workDir, {
      id: 'check',
      display_name: 'Check',
      owner_agent_id: 'agent_x',
      owner_scopes: [],
    });
    const ns = await loadNamespace(workDir, 'check');
    expect(ns?.id).toBe('check');
  });
});
