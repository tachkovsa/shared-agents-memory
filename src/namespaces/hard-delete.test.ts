import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthAuditWriter } from '../auth/audit.js';
import { createNamespaceSkeleton } from './store.js';
import { hardDeleteNamespace } from './hard-delete.js';
import { listDeletedNamespaceDirs } from './vector-cascade.js';

const COLLECTION = 'agent_memories';

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sam-hard-delete-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** Create a `_deleted/<name>` dir a soft-delete would have produced. */
async function seedDeletedDir(name: string): Promise<void> {
  await mkdir(join(dataDir, '_deleted', name), { recursive: true });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A Qdrant stub whose count/delete are spies; count returns the queued values. */
function stubQdrant(counts: number[], del?: () => Promise<unknown>) {
  const queue = [...counts];
  return {
    count: vi.fn(async () => ({ count: queue.shift() ?? 0 })),
    delete: vi.fn(del ?? (async () => ({ status: 'completed' }))),
  };
}

function stubAuditor() {
  const record = vi.fn(async () => true);
  return { auditor: { record } as unknown as AuthAuditWriter, record };
}

describe('hardDeleteNamespace', () => {
  it('purges vectors, removes the _deleted dirs, and returns a verified receipt', async () => {
    await seedDeletedDir('team-alpha-1700000000000');
    const qdrant = stubQdrant([5, 0]); // before=5, after=0
    const { auditor, record } = stubAuditor();

    const result = await hardDeleteNamespace({
      qdrant: qdrant as never,
      collection: COLLECTION,
      dataDir,
      namespaceId: 'team-alpha',
      operatorId: 'op-1',
      auditor,
    });

    expect(result).toEqual({
      status: 'purged',
      receipt: {
        namespace_id: 'team-alpha',
        vectors: { points_before: 5, points_after: 0, purged: 5 },
        filesystem: { removed_dirs: ['team-alpha-1700000000000'] },
        verified: true,
        purged_by: 'operator:op-1',
      },
    });
    // Vectors were purged with the namespace filter.
    expect(qdrant.delete).toHaveBeenCalledWith(COLLECTION, {
      wait: true,
      filter: { must: [{ key: 'namespace', match: { value: 'team-alpha' } }] },
    });
    // The dir is gone.
    expect(await exists(join(dataDir, '_deleted', 'team-alpha-1700000000000'))).toBe(false);
    // The receipt was audited.
    expect(record).toHaveBeenCalledWith('namespace.hard_deleted', expect.objectContaining({
      namespace_id: 'team-alpha',
      verified: true,
      purged_by: 'operator:op-1',
    }));
  });

  it('removes every <id>-<ts> dir for the id and leaves other namespaces untouched', async () => {
    await seedDeletedDir('team-alpha-100');
    await seedDeletedDir('team-alpha-200');
    await seedDeletedDir('team-beta-300');
    const qdrant = stubQdrant([2, 0]);
    const { auditor } = stubAuditor();

    const result = await hardDeleteNamespace({
      qdrant: qdrant as never,
      collection: COLLECTION,
      dataDir,
      namespaceId: 'team-alpha',
      operatorId: 'op-1',
      auditor,
    });

    expect(result.status).toBe('purged');
    if (result.status === 'purged') {
      expect(result.receipt.filesystem.removed_dirs.sort()).toEqual([
        'team-alpha-100',
        'team-alpha-200',
      ]);
    }
    expect(await exists(join(dataDir, '_deleted', 'team-alpha-100'))).toBe(false);
    expect(await exists(join(dataDir, '_deleted', 'team-alpha-200'))).toBe(false);
    // The unrelated namespace's _deleted dir survives.
    expect(await exists(join(dataDir, '_deleted', 'team-beta-300'))).toBe(true);
  });

  it('is idempotent: a purge finding 0 vectors verifies, and re-running 404s', async () => {
    await seedDeletedDir('team-alpha-1700000000000');
    const qdrant = stubQdrant([0, 0]); // vectors already purged by the soft-delete cascade
    const { auditor } = stubAuditor();

    const first = await hardDeleteNamespace({
      qdrant: qdrant as never,
      collection: COLLECTION,
      dataDir,
      namespaceId: 'team-alpha',
      operatorId: 'op-1',
      auditor,
    });
    expect(first).toMatchObject({
      status: 'purged',
      receipt: { vectors: { points_before: 0, points_after: 0, purged: 0 }, verified: true },
    });

    // Second run: nothing left under _deleted/ and no live dir → 404.
    const second = await hardDeleteNamespace({
      qdrant: stubQdrant([0, 0]) as never,
      collection: COLLECTION,
      dataDir,
      namespaceId: 'team-alpha',
      operatorId: 'op-1',
      auditor,
    });
    expect(second).toEqual({ status: 'not_found' });
  });

  it('refuses the protected bootstrap namespace without touching Qdrant or the FS', async () => {
    await seedDeletedDir('personal-1700000000000');
    const qdrant = stubQdrant([9]);
    const { auditor, record } = stubAuditor();

    const result = await hardDeleteNamespace({
      qdrant: qdrant as never,
      collection: COLLECTION,
      dataDir,
      namespaceId: 'personal',
      operatorId: 'op-1',
      auditor,
    });

    expect(result).toEqual({ status: 'protected' });
    expect(qdrant.count).not.toHaveBeenCalled();
    expect(qdrant.delete).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    // The soft-deleted dir is left in place.
    expect(await exists(join(dataDir, '_deleted', 'personal-1700000000000'))).toBe(true);
  });

  it('refuses an invalid namespace id with no filesystem or Qdrant touch', async () => {
    const qdrant = stubQdrant([1]);
    const { auditor } = stubAuditor();

    const result = await hardDeleteNamespace({
      qdrant: qdrant as never,
      collection: COLLECTION,
      dataDir,
      namespaceId: '../escape',
      operatorId: 'op-1',
      auditor,
    });

    expect(result).toEqual({ status: 'invalid_id' });
    expect(qdrant.count).not.toHaveBeenCalled();
    expect(qdrant.delete).not.toHaveBeenCalled();
  });

  it('rejects a LIVE namespace with 409 (soft-delete first) and never purges', async () => {
    await createNamespaceSkeleton(dataDir, {
      id: 'team-live',
      display_name: 'Live',
      owner_agent_id: 'agent_owner',
      owner_scopes: ['memory:read'],
    });
    const qdrant = stubQdrant([3]);
    const { auditor } = stubAuditor();

    const result = await hardDeleteNamespace({
      qdrant: qdrant as never,
      collection: COLLECTION,
      dataDir,
      namespaceId: 'team-live',
      operatorId: 'op-1',
      auditor,
    });

    expect(result).toEqual({ status: 'live' });
    expect(qdrant.count).not.toHaveBeenCalled();
    expect(qdrant.delete).not.toHaveBeenCalled();
  });

  it('404s a wholly unknown namespace (no live dir, no _deleted dir)', async () => {
    const result = await hardDeleteNamespace({
      qdrant: stubQdrant([0]) as never,
      collection: COLLECTION,
      dataDir,
      namespaceId: 'ghost-ns',
      operatorId: 'op-1',
      auditor: stubAuditor().auditor,
    });
    expect(result).toEqual({ status: 'not_found' });
  });

  it('on PARTIAL purge (no throw, points remain): keeps the dirs as the sweep backstop', async () => {
    await seedDeletedDir('team-alpha-1700000000000');
    // delete() resolves cleanly, but the AFTER count still shows points (e.g. an
    // eventually-consistent Qdrant delete). before=5, after=5.
    const qdrant = stubQdrant([5, 5]);
    const { auditor, record } = stubAuditor();

    const result = await hardDeleteNamespace({
      qdrant: qdrant as never,
      collection: COLLECTION,
      dataDir,
      namespaceId: 'team-alpha',
      operatorId: 'op-1',
      auditor,
    });

    expect(result).toEqual({
      status: 'purged',
      receipt: {
        namespace_id: 'team-alpha',
        vectors: { points_before: 5, points_after: 5, purged: 0 },
        filesystem: { removed_dirs: [] },
        verified: false,
        purged_by: 'operator:op-1',
      },
    });
    // The dir MUST survive so `sweepOrphanedNamespaceVectors` can retry — removing
    // it here would orphan the remaining vectors forever with no recovery path.
    expect(await exists(join(dataDir, '_deleted', 'team-alpha-1700000000000'))).toBe(true);
    expect(await listDeletedNamespaceDirs(dataDir, 'team-alpha')).toHaveLength(1);
    // The unverified outcome is audited as a purge failure, NOT as hard_deleted.
    expect(record).toHaveBeenCalledWith('namespace.vector_purge_failed', expect.objectContaining({
      namespace_id: 'team-alpha',
      purged_by: 'operator:op-1',
      points_before: 5,
      points_after: 5,
    }));
    expect(record).not.toHaveBeenCalledWith('namespace.hard_deleted', expect.anything());
  });

  it('on purge failure: leaves the dirs, audits vector_purge_failed, reports verified:false', async () => {
    await seedDeletedDir('team-alpha-1700000000000');
    const qdrant = stubQdrant([4], async () => {
      throw new Error('qdrant down');
    });
    const { auditor, record } = stubAuditor();

    const result = await hardDeleteNamespace({
      qdrant: qdrant as never,
      collection: COLLECTION,
      dataDir,
      namespaceId: 'team-alpha',
      operatorId: 'op-1',
      auditor,
    });

    expect(result).toEqual({
      status: 'purged',
      receipt: {
        namespace_id: 'team-alpha',
        vectors: { points_before: 4, points_after: 4, purged: 0 },
        filesystem: { removed_dirs: [] },
        verified: false,
        purged_by: 'operator:op-1',
      },
    });
    // The dir survives so the startup orphan sweep can retry.
    expect(await exists(join(dataDir, '_deleted', 'team-alpha-1700000000000'))).toBe(true);
    // The failure was audited; no hard_deleted receipt was written.
    expect(record).toHaveBeenCalledWith('namespace.vector_purge_failed', expect.objectContaining({
      namespace_id: 'team-alpha',
      purged_by: 'operator:op-1',
    }));
    expect(record).not.toHaveBeenCalledWith('namespace.hard_deleted', expect.anything());
  });
});
