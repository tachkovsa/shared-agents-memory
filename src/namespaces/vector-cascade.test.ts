import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { basename } from 'node:path';
import {
  countNamespaceVectors,
  listDeletedNamespaceDirs,
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

describe('countNamespaceVectors', () => {
  it('issues a namespace-filtered count and returns the number of points', async () => {
    const count = vi.fn(async () => ({ count: 7 }));

    const n = await countNamespaceVectors({ count } as never, COLLECTION, 'team-alpha');

    expect(n).toBe(7);
    expect(count).toHaveBeenCalledTimes(1);
    const [collection, body] = count.mock.calls[0]!;
    expect(collection).toBe(COLLECTION);
    expect(body).toEqual({
      filter: { must: [{ key: 'namespace', match: { value: 'team-alpha' } }] },
    });
  });
});

describe('listDeletedNamespaceDirs', () => {
  it('returns [] when _deleted/ does not exist', async () => {
    expect(await listDeletedNamespaceDirs(workDir, 'team-alpha')).toEqual([]);
  });

  it('returns every _deleted/<id>-<ts> dir for exactly the given id and no others', async () => {
    await seedDeletedDir('team-alpha-1700000000000');
    await seedDeletedDir('team-alpha-1700000009999');
    await seedDeletedDir('team-beta-1700000000000');

    const dirs = await listDeletedNamespaceDirs(workDir, 'team-alpha');

    expect(dirs.map((d) => basename(d)).sort()).toEqual([
      'team-alpha-1700000000000',
      'team-alpha-1700000009999',
    ]);
  });

  it('does not match a different namespace whose id shares a prefix', async () => {
    // 'team' must not sweep up 'team-alpha-<ts>' — only a literal -<digits> suffix counts.
    await seedDeletedDir('team-1700000000000');
    await seedDeletedDir('team-alpha-1700000000000');

    const dirs = await listDeletedNamespaceDirs(workDir, 'team');
    expect(dirs.map((d) => basename(d))).toEqual(['team-1700000000000']);
  });

  it('ignores hidden / partial dirs', async () => {
    await seedDeletedDir('.tmp-team-alpha-1700000000000');
    await seedDeletedDir('team-alpha-1700000000000');

    const dirs = await listDeletedNamespaceDirs(workDir, 'team-alpha');
    expect(dirs.map((d) => basename(d))).toEqual(['team-alpha-1700000000000']);
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
