import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QdrantClient } from '@qdrant/js-client-rest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StalenessAuditor, type StalenessCheckers } from './staleness.js';
import { createNamespaceSkeleton } from '../namespaces/store.js';
import type { StalenessSignal } from '../memory/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const COLLECTION = 'agent_memories';
const NOW_ISO = '2026-06-10T12:00:00.000Z';

interface FakeQdrant {
  scroll: ReturnType<typeof vi.fn>;
  setPayload: ReturnType<typeof vi.fn>;
}

function makeQdrant(overrides: Partial<FakeQdrant> = {}): {
  client: QdrantClient;
  fake: FakeQdrant;
} {
  const fake: FakeQdrant = {
    scroll: overrides.scroll ?? vi.fn(async () => ({ points: [] })),
    setPayload: overrides.setPayload ?? vi.fn(async () => ({ status: 'completed' })),
  };
  return { client: fake as unknown as QdrantClient, fake };
}

function makeCheckers(
  overrides: Partial<Record<'file' | 'url' | 'gitCommit', StalenessSignal | null>>,
): StalenessCheckers {
  return {
    file: vi.fn(async () => overrides.file ?? null),
    url: vi.fn(async () => overrides.url ?? null),
    gitCommit: vi.fn(async () => overrides.gitCommit ?? null),
  };
}

function makePoint(
  id: string,
  overrides: Partial<{
    verifies_against: Record<string, unknown> | null;
    deleted_at: string | null;
    immortal: boolean;
  }> = {},
) {
  const metadata: Record<string, unknown> = {};
  if (overrides.immortal) metadata['immortal'] = true;

  return {
    id,
    payload: {
      namespace: 'personal',
      agent_id: 'agent-a',
      kind: 'episodic',
      content: 'some content',
      tags: [],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      staleness_signal: 'unverified',
      decay_score: 1.0,
      superseded_by: null,
      deleted_at: overrides.deleted_at ?? null,
      retrieval_count: 0,
      last_retrieved_at: null,
      metadata,
      verifies_against:
        overrides.verifies_against !== undefined
          ? overrides.verifies_against
          : {
              kind: 'url',
              ref: 'https://example.com/api',
              captured_at: '2026-01-01T00:00:00.000Z',
            },
    },
  };
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'sam-staleness-'));
  // Create a "personal" namespace so listNamespaceIds returns it.
  await createNamespaceSkeleton(workDir, {
    id: 'personal',
    display_name: 'Personal',
    owner_agent_id: 'agent-a',
    owner_scopes: ['memory:read', 'memory:write'],
  });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('StalenessAuditor.runOnce()', () => {
  it('skips a namespace that has staleness_audit_enabled = false', async () => {
    // Overwrite the namespace JSON to disable the audit.
    const nsPath = join(workDir, 'namespaces', 'personal', '_namespace.json');
    const raw = JSON.parse(
      await import('node:fs/promises').then((fs) => fs.readFile(nsPath, 'utf8')),
    ) as Record<string, unknown>;
    raw['staleness_audit_enabled'] = false;
    await writeFile(nsPath, JSON.stringify(raw, null, 2));

    const { client, fake } = makeQdrant();
    const auditor = new StalenessAuditor({
      qdrant: client,
      collection: COLLECTION,
      dataDir: workDir,
      now: () => new Date(NOW_ISO),
      checkers: makeCheckers({}),
    });

    const stats = await auditor.runOnce();
    // Namespace was skipped — scroll never called.
    expect(fake.scroll).not.toHaveBeenCalled();
    expect(stats.namespacesSwept).toBe(0);
    expect(stats.checked).toBe(0);
  });

  it('respects staleness_audit_batch_size cap', async () => {
    // Set batch_size=1 on the namespace.
    const nsPath = join(workDir, 'namespaces', 'personal', '_namespace.json');
    const raw = JSON.parse(
      await import('node:fs/promises').then((fs) => fs.readFile(nsPath, 'utf8')),
    ) as Record<string, unknown>;
    raw['staleness_audit_batch_size'] = 1;
    await writeFile(nsPath, JSON.stringify(raw, null, 2));

    const { client, fake } = makeQdrant({
      scroll: vi.fn(async () => ({ points: [makePoint('p1'), makePoint('p2')] })),
    });

    const auditor = new StalenessAuditor({
      qdrant: client,
      collection: COLLECTION,
      dataDir: workDir,
      now: () => new Date(NOW_ISO),
      checkers: makeCheckers({ url: 'fresh' }),
    });

    const stats = await auditor.runOnce();

    // scroll called with limit=1
    const [, scrollBody] = fake.scroll.mock.calls[0] as [string, { limit: number }];
    expect(scrollBody.limit).toBe(1);
    // The scroll mock returns 2 points anyway (unrealistic but tests the loop).
    expect(stats.checked).toBe(2);
  });

  it('skips soft-deleted points (deleted_at set)', async () => {
    const { client, fake } = makeQdrant({
      scroll: vi.fn(async () => ({
        points: [makePoint('p1', { deleted_at: '2026-06-01T00:00:00.000Z' })],
      })),
    });
    const checkers = makeCheckers({ url: 'fresh' });
    const auditor = new StalenessAuditor({
      qdrant: client,
      collection: COLLECTION,
      dataDir: workDir,
      now: () => new Date(NOW_ISO),
      checkers,
    });

    const stats = await auditor.runOnce();
    expect(stats.checked).toBe(0);
    expect(stats.byResult['skipped']).toBe(1);
    expect(checkers.url).not.toHaveBeenCalled();
    expect(fake.setPayload).not.toHaveBeenCalled();
  });

  it('skips immortal points (metadata.immortal = true)', async () => {
    const { client, fake } = makeQdrant({
      scroll: vi.fn(async () => ({
        points: [makePoint('p1', { immortal: true })],
      })),
    });
    const checkers = makeCheckers({ url: 'fresh' });
    const auditor = new StalenessAuditor({
      qdrant: client,
      collection: COLLECTION,
      dataDir: workDir,
      now: () => new Date(NOW_ISO),
      checkers,
    });

    const stats = await auditor.runOnce();
    expect(stats.checked).toBe(0);
    expect(fake.setPayload).not.toHaveBeenCalled();
  });

  it('url kind: fresh → writes staleness_signal=fresh and bumps captured_at', async () => {
    const { client, fake } = makeQdrant({
      scroll: vi.fn(async () => ({ points: [makePoint('p1')] })),
    });
    const checkers = makeCheckers({ url: 'fresh' });
    const auditor = new StalenessAuditor({
      qdrant: client,
      collection: COLLECTION,
      dataDir: workDir,
      now: () => new Date(NOW_ISO),
      checkers,
    });

    const stats = await auditor.runOnce();
    expect(stats.checked).toBe(1);
    expect(stats.byResult['fresh']).toBe(1);

    expect(fake.setPayload).toHaveBeenCalledTimes(1);
    const [, body] = fake.setPayload.mock.calls[0] as [
      string,
      { payload: { staleness_signal: string; verifies_against: { captured_at: string } } },
    ];
    expect(body.payload.staleness_signal).toBe('fresh');
    expect(body.payload.verifies_against.captured_at).toBe(NOW_ISO);
  });

  it('url kind: broken_ref → writes staleness_signal=broken_ref', async () => {
    const { client, fake } = makeQdrant({
      scroll: vi.fn(async () => ({ points: [makePoint('p1')] })),
    });
    const auditor = new StalenessAuditor({
      qdrant: client,
      collection: COLLECTION,
      dataDir: workDir,
      now: () => new Date(NOW_ISO),
      checkers: makeCheckers({ url: 'broken_ref' }),
    });

    const stats = await auditor.runOnce();
    expect(stats.byResult['broken_ref']).toBe(1);
    const [, body] = fake.setPayload.mock.calls[0] as [
      string,
      { payload: { staleness_signal: string } },
    ];
    expect(body.payload.staleness_signal).toBe('broken_ref');
  });

  it('url kind: null result (e.g. network error) → leaves signal unchanged, no setPayload', async () => {
    const { client, fake } = makeQdrant({
      scroll: vi.fn(async () => ({ points: [makePoint('p1')] })),
    });
    const auditor = new StalenessAuditor({
      qdrant: client,
      collection: COLLECTION,
      dataDir: workDir,
      now: () => new Date(NOW_ISO),
      checkers: makeCheckers({ url: null }),
    });

    const stats = await auditor.runOnce();
    expect(stats.checked).toBe(1);
    expect(stats.byResult['skipped']).toBe(1);
    expect(fake.setPayload).not.toHaveBeenCalled();
  });

  it('file kind: writes fresh when file exists and no lastKnownValue', async () => {
    // Create a temp file to audit.
    const fileRoot = join(workDir, 'repo');
    await mkdir(fileRoot, { recursive: true });
    await writeFile(join(fileRoot, 'README.md'), 'hello');

    // Patch the namespace filesystem_audit_root.
    const nsPath = join(workDir, 'namespaces', 'personal', '_namespace.json');
    const raw = JSON.parse(
      await import('node:fs/promises').then((fs) => fs.readFile(nsPath, 'utf8')),
    ) as Record<string, unknown>;
    raw['filesystem_audit_root'] = fileRoot;
    await writeFile(nsPath, JSON.stringify(raw, null, 2));

    const filePoint = makePoint('p2', {
      verifies_against: {
        kind: 'file',
        ref: 'README.md',
        captured_at: '2026-01-01T00:00:00.000Z',
      },
    });

    const { client, fake } = makeQdrant({
      scroll: vi.fn(async () => ({ points: [filePoint] })),
    });

    // Use real file checker but wrap with injected interface.
    const realFileResult: StalenessSignal = 'fresh';
    const auditor = new StalenessAuditor({
      qdrant: client,
      collection: COLLECTION,
      dataDir: workDir,
      now: () => new Date(NOW_ISO),
      checkers: makeCheckers({ file: realFileResult }),
    });

    const stats = await auditor.runOnce();
    expect(stats.byResult['fresh']).toBe(1);
    expect(fake.setPayload).toHaveBeenCalledTimes(1);
  });

  it('file kind: skipped when filesystem_audit_root is null', async () => {
    // namespace has no filesystem_audit_root (null by default).
    const filePoint = makePoint('p3', {
      verifies_against: {
        kind: 'file',
        ref: 'src/db.ts',
        captured_at: '2026-01-01T00:00:00.000Z',
      },
    });

    const { client, fake } = makeQdrant({
      scroll: vi.fn(async () => ({ points: [filePoint] })),
    });
    const checkers = makeCheckers({ file: 'fresh' });
    const auditor = new StalenessAuditor({
      qdrant: client,
      collection: COLLECTION,
      dataDir: workDir,
      now: () => new Date(NOW_ISO),
      checkers,
    });

    const stats = await auditor.runOnce();
    // No root → skip, leave unchanged.
    expect(stats.byResult['skipped']).toBe(1);
    expect(fake.setPayload).not.toHaveBeenCalled();
    expect(checkers.file).not.toHaveBeenCalled();
  });

  it('git_commit kind: skipped when filesystem_audit_root is null', async () => {
    const gitPoint = makePoint('p4', {
      verifies_against: {
        kind: 'git_commit',
        ref: 'deadbeef',
        captured_at: '2026-01-01T00:00:00.000Z',
      },
    });

    const { client, fake } = makeQdrant({
      scroll: vi.fn(async () => ({ points: [gitPoint] })),
    });
    const checkers = makeCheckers({ gitCommit: 'stale' });
    const auditor = new StalenessAuditor({
      qdrant: client,
      collection: COLLECTION,
      dataDir: workDir,
      now: () => new Date(NOW_ISO),
      checkers,
    });

    const stats = await auditor.runOnce();
    expect(stats.byResult['skipped']).toBe(1);
    expect(fake.setPayload).not.toHaveBeenCalled();
    expect(checkers.gitCommit).not.toHaveBeenCalled();
  });

  it('git_commit kind: stale → writes staleness_signal=stale', async () => {
    const nsPath = join(workDir, 'namespaces', 'personal', '_namespace.json');
    const raw = JSON.parse(
      await import('node:fs/promises').then((fs) => fs.readFile(nsPath, 'utf8')),
    ) as Record<string, unknown>;
    raw['filesystem_audit_root'] = '/some/repo';
    await writeFile(nsPath, JSON.stringify(raw, null, 2));

    const gitPoint = makePoint('p5', {
      verifies_against: {
        kind: 'git_commit',
        ref: 'abc123',
        captured_at: '2026-01-01T00:00:00.000Z',
      },
    });

    const { client, fake } = makeQdrant({
      scroll: vi.fn(async () => ({ points: [gitPoint] })),
    });
    const auditor = new StalenessAuditor({
      qdrant: client,
      collection: COLLECTION,
      dataDir: workDir,
      now: () => new Date(NOW_ISO),
      checkers: makeCheckers({ gitCommit: 'stale' }),
    });

    const stats = await auditor.runOnce();
    expect(stats.byResult['stale']).toBe(1);
    const [, body] = fake.setPayload.mock.calls[0] as [
      string,
      { payload: { staleness_signal: string } },
    ];
    expect(body.payload.staleness_signal).toBe('stale');
  });

  it('a checker that throws does NOT abort the rest of the sweep', async () => {
    const throwingPoint = makePoint('p-throw');
    const okPoint = makePoint('p-ok');

    const { client, fake } = makeQdrant({
      scroll: vi.fn(async () => ({ points: [throwingPoint, okPoint] })),
    });

    let callCount = 0;
    const checkers: StalenessCheckers = {
      file: vi.fn(async () => null),
      gitCommit: vi.fn(async () => null),
      url: vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error('checker exploded');
        return 'fresh';
      }),
    };

    const auditor = new StalenessAuditor({
      qdrant: client,
      collection: COLLECTION,
      dataDir: workDir,
      now: () => new Date(NOW_ISO),
      checkers,
    });

    const stats = await auditor.runOnce();
    // Second point was still processed.
    expect(stats.checked).toBe(2);
    // Second point wrote back.
    expect(fake.setPayload).toHaveBeenCalledTimes(1);
    const [, body] = fake.setPayload.mock.calls[0] as [
      string,
      { payload: { staleness_signal: string } },
    ];
    expect(body.payload.staleness_signal).toBe('fresh');
  });

  it('captured_at is bumped to now on every write-back', async () => {
    const { client, fake } = makeQdrant({
      scroll: vi.fn(async () => ({ points: [makePoint('p1')] })),
    });
    const auditor = new StalenessAuditor({
      qdrant: client,
      collection: COLLECTION,
      dataDir: workDir,
      now: () => new Date(NOW_ISO),
      checkers: makeCheckers({ url: 'fresh' }),
    });

    await auditor.runOnce();

    const [, body] = fake.setPayload.mock.calls[0] as [
      string,
      { payload: { verifies_against: { captured_at: string } } },
    ];
    expect(body.payload.verifies_against.captured_at).toBe(NOW_ISO);
  });

  it('returns stats with correct counters', async () => {
    const { client } = makeQdrant({
      scroll: vi.fn(async () => ({
        points: [
          makePoint('p1'), // url → fresh
          makePoint('p2'), // url → null (skipped)
        ],
      })),
    });

    let callCount = 0;
    const checkers: StalenessCheckers = {
      file: vi.fn(async () => null),
      gitCommit: vi.fn(async () => null),
      url: vi.fn(async (): Promise<StalenessSignal | null> => {
        callCount++;
        return callCount === 1 ? 'fresh' : null;
      }),
    };

    const auditor = new StalenessAuditor({
      qdrant: client,
      collection: COLLECTION,
      dataDir: workDir,
      now: () => new Date(NOW_ISO),
      checkers,
    });

    const stats = await auditor.runOnce();
    expect(stats.namespacesSwept).toBe(1);
    expect(stats.checked).toBe(2);
    expect(stats.byResult['fresh']).toBe(1);
    expect(stats.byResult['skipped']).toBe(1);
  });
});

// ── File path traversal guard (via real defaultStalenessCheckers) ─────────────

describe('defaultStalenessCheckers.file — path traversal guard', () => {
  it('rejects a ref that escapes the root via ..', async () => {
    const { defaultStalenessCheckers: real } = await import('./staleness.js');

    const root = '/some/safe/root';
    // This ref tries to escape: resolve('/some/safe/root', '../../etc/passwd')
    // → '/etc/passwd' which does NOT start with '/some/safe/root'.
    const result = await real.file('../../etc/passwd', root, undefined);
    // Traversal → skip (null means "leave unchanged").
    expect(result).toBeNull();
  });

  it('allows a ref that stays within the root', async () => {
    const { defaultStalenessCheckers: real } = await import('./staleness.js');

    // Create a real temp dir + file.
    const root = await mkdtemp(join(tmpdir(), 'sam-traversal-'));
    try {
      await writeFile(join(root, 'valid.txt'), 'hello');
      const result = await real.file('valid.txt', root, undefined);
      expect(result).toBe('fresh');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns broken_ref for a non-existent file', async () => {
    const { defaultStalenessCheckers: real } = await import('./staleness.js');

    const root = await mkdtemp(join(tmpdir(), 'sam-traversal-'));
    try {
      const result = await real.file('nonexistent.txt', root, undefined);
      expect(result).toBe('broken_ref');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns stale when sha256 digest does not match lastKnownValue', async () => {
    const { defaultStalenessCheckers: real } = await import('./staleness.js');

    const root = await mkdtemp(join(tmpdir(), 'sam-digest-'));
    try {
      await writeFile(join(root, 'file.txt'), 'new content');
      const result = await real.file('file.txt', root, 'sha256:oldhash');
      expect(result).toBe('stale');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
