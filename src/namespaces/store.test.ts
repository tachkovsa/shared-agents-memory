import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNamespaceSkeleton, namespaceDir } from './store.js';
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
});
