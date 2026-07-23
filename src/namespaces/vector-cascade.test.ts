import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listDeletedNamespaceIds,
  purgeNamespaceVectors,
  sweepOrphanedNamespaceVectors,
} from './vector-cascade.js';

const COLLECTION = 'agent_memories';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'sam-ns-cascade-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Create the `_deleted/<name>` directory a soft-delete would have produced. */
async function seedDeletedDir(name: string): Promise<void> {
  await mkdir(join(workDir, '_deleted', name), { recursive: true });
}

describe('purgeNamespaceVectors', () => {
  it('issues a namespace-filtered delete against the collection', async () => {
    const del = vi.fn(async () => ({ status: 'completed' }));

    await purgeNamespaceVectors({ delete: del } as never, COLLECTION, 'team-alpha');

    expect(del).toHaveBeenCalledTimes(1);
    const [collection, body] = del.mock.calls[0]!;
    expect(collection).toBe(COLLECTION);
    expect(body).toEqual({
      wait: true,
      filter: { must: [{ key: 'namespace', match: { value: 'team-alpha' } }] },
    });
  });
});

describe('listDeletedNamespaceIds', () => {
  it('returns [] when _deleted/ does not exist', async () => {
    expect(await listDeletedNamespaceIds(workDir)).toEqual([]);
  });

  it('strips the trailing -<unix_ms> timestamp to recover the namespace id', async () => {
    await seedDeletedDir('team-alpha-1700000000000');
    await seedDeletedDir('personal-1699999999999');

    const ids = await listDeletedNamespaceIds(workDir);
    expect(ids.sort()).toEqual(['personal', 'team-alpha']);
  });

  it('preserves hyphenated ids and collapses duplicate deletions of the same id', async () => {
    // An id that itself ends in digits, deleted twice at different timestamps.
    await seedDeletedDir('team-2024-1700000000000');
    await seedDeletedDir('team-2024-1700000009999');

    const ids = await listDeletedNamespaceIds(workDir);
    expect(ids).toEqual(['team-2024']);
  });

  it('ignores hidden / partial directories', async () => {
    await seedDeletedDir('.tmp-partial');
    await seedDeletedDir('real-1700000000000');

    const ids = await listDeletedNamespaceIds(workDir);
    expect(ids).toEqual(['real']);
  });
});

describe('sweepOrphanedNamespaceVectors', () => {
  it('purges vectors for every already-orphaned _deleted/ namespace', async () => {
    await seedDeletedDir('team-alpha-1700000000000');
    await seedDeletedDir('personal-1699999999999');
    const del = vi.fn(async () => ({ status: 'completed' }));

    const swept = await sweepOrphanedNamespaceVectors(
      { delete: del } as never,
      COLLECTION,
      workDir,
    );

    expect(swept.sort()).toEqual(['personal', 'team-alpha']);
    expect(del).toHaveBeenCalledTimes(2);
    const purgedNamespaces = del.mock.calls.map(
      (c) => (c[1] as { filter: { must: { match: { value: string } }[] } }).filter.must[0]!.match.value,
    );
    expect(purgedNamespaces.sort()).toEqual(['personal', 'team-alpha']);
  });

  it('is a no-op when there are no orphaned namespaces', async () => {
    const del = vi.fn(async () => ({ status: 'completed' }));

    const swept = await sweepOrphanedNamespaceVectors(
      { delete: del } as never,
      COLLECTION,
      workDir,
    );

    expect(swept).toEqual([]);
    expect(del).not.toHaveBeenCalled();
  });
});
