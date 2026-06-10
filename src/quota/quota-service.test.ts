/**
 * Tests for QuotaService (issue #59).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNamespaceSkeleton } from '../namespaces/store.js';
import type { NamespaceQuota } from '../namespaces/types.js';
import { QuotaExceededError, QuotaService } from './quota-service.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sam-quota-test-'));
  // Create the 'test-ns' namespace skeleton so _quota.json exists.
  await createNamespaceSkeleton(dataDir, {
    id: 'test-ns',
    display_name: 'Test NS',
    owner_agent_id: 'agent_test',
    owner_scopes: ['memory:read', 'memory:write'],
  });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function makeQuota(overrides: Partial<NamespaceQuota> = {}): NamespaceQuota {
  return {
    daily_writes: 10,
    daily_searches: 20,
    daily_embedding_tokens: 1_000,
    max_memories: 50,
    ...overrides,
  };
}

describe('QuotaService — daily rollover', () => {
  it('resets counters when last_reset is a different UTC day', async () => {
    // Start with yesterday's date.
    const yesterday = new Date('2026-01-01T23:00:00Z');
    const svc1 = new QuotaService({ dataDir, now: () => yesterday });

    // Record writes up to the cap (leave 1 slot).
    const quota = makeQuota({ daily_writes: 2 });
    await svc1.record('test-ns', 'write');
    // First write used 1 slot, so 1 left — second should be allowed.
    await svc1.check('test-ns', 'write', { quota });

    // Advance to the next UTC day.
    const today = new Date('2026-01-02T01:00:00Z');
    const svc2 = new QuotaService({ dataDir, now: () => today });

    // After rollover the counter should be 0 — check must pass even with tight cap.
    await expect(
      svc2.check('test-ns', 'write', { quota: makeQuota({ daily_writes: 1 }) }),
    ).resolves.toBeUndefined();
  });
});

describe('QuotaService — write cap', () => {
  it('throws QuotaExceededError for daily_writes when cap reached', async () => {
    const quota = makeQuota({ daily_writes: 2 });
    const svc = new QuotaService({ dataDir });

    await svc.record('test-ns', 'write');
    await svc.record('test-ns', 'write');

    await expect(svc.check('test-ns', 'write', { quota })).rejects.toMatchObject({
      name: 'QuotaExceededError',
      limit: 'daily_writes',
      cap: 2,
      used: 2,
    });
  });

  it('carries the correct namespace in the error', async () => {
    const quota = makeQuota({ daily_writes: 0 });
    const svc = new QuotaService({ dataDir });

    const err = await svc.check('test-ns', 'write', { quota }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect((err as QuotaExceededError).namespace).toBe('test-ns');
  });
});

describe('QuotaService — search cap', () => {
  it('throws QuotaExceededError for daily_searches when cap reached', async () => {
    const quota = makeQuota({ daily_searches: 1 });
    const svc = new QuotaService({ dataDir });

    await svc.record('test-ns', 'search');

    await expect(svc.check('test-ns', 'search', { quota })).rejects.toMatchObject({
      limit: 'daily_searches',
      cap: 1,
      used: 1,
    });
  });
});

describe('QuotaService — max_memories', () => {
  it('throws QuotaExceededError for max_memories when currentCount >= cap', async () => {
    const quota = makeQuota({ max_memories: 5 });
    const svc = new QuotaService({ dataDir });

    await expect(
      svc.check('test-ns', 'write', { quota, currentCount: 5 }),
    ).rejects.toMatchObject({
      limit: 'max_memories',
      cap: 5,
      used: 5,
    });
  });

  it('allows write when currentCount < cap', async () => {
    const quota = makeQuota({ max_memories: 5 });
    const svc = new QuotaService({ dataDir });

    await expect(
      svc.check('test-ns', 'write', { quota, currentCount: 4 }),
    ).resolves.toBeUndefined();
  });
});

describe('QuotaService — token estimate', () => {
  it('throws daily_embedding_tokens when projected total exceeds cap', async () => {
    const quota = makeQuota({ daily_embedding_tokens: 10 });
    const svc = new QuotaService({ dataDir });

    // Record 8 tokens already used.
    await svc.record('test-ns', 'write', { estimatedTokens: 8 });

    // Attempt to write with 5 more tokens — 8 + 5 = 13 > 10.
    await expect(
      svc.check('test-ns', 'write', { quota, estimatedTokens: 5 }),
    ).rejects.toMatchObject({
      limit: 'daily_embedding_tokens',
      cap: 10,
    });
  });

  it('accumulates token counters across multiple records', async () => {
    const quota = makeQuota({ daily_embedding_tokens: 100 });
    const svc = new QuotaService({ dataDir });

    await svc.record('test-ns', 'write', { estimatedTokens: 30 });
    await svc.record('test-ns', 'search', { estimatedTokens: 40 });

    // 30 + 40 = 70 used; 35 more would exceed 100.
    await expect(
      svc.check('test-ns', 'write', { quota, estimatedTokens: 35 }),
    ).rejects.toMatchObject({ limit: 'daily_embedding_tokens' });

    // But 25 more is fine (70 + 25 = 95 ≤ 100).
    await expect(
      svc.check('test-ns', 'write', { quota, estimatedTokens: 25 }),
    ).resolves.toBeUndefined();
  });
});

describe('QuotaService — concurrency safety', () => {
  it('does not lose counter increments under concurrent record calls', async () => {
    const svc = new QuotaService({ dataDir });
    const N = 20;

    // Fire N concurrent writes.
    await Promise.all(
      Array.from({ length: N }, () => svc.record('test-ns', 'write')),
    );

    // Verify by checking that the cap N-1 is now exceeded.
    const quota = makeQuota({ daily_writes: N - 1 });
    await expect(svc.check('test-ns', 'write', { quota })).rejects.toMatchObject({
      limit: 'daily_writes',
      used: N,
    });
  });

  it('does not lose token increments under concurrent record calls', async () => {
    const svc = new QuotaService({ dataDir });
    const N = 10;
    const tokensEach = 3;

    await Promise.all(
      Array.from({ length: N }, () =>
        svc.record('test-ns', 'write', { estimatedTokens: tokensEach }),
      ),
    );

    // Total expected: N * tokensEach.
    const total = N * tokensEach;
    // Use a very high write cap so only the token cap triggers.
    const quota = makeQuota({ daily_embedding_tokens: total - 1, daily_writes: 10_000 });
    await expect(svc.check('test-ns', 'write', { quota, estimatedTokens: 1 })).rejects.toMatchObject({
      limit: 'daily_embedding_tokens',
    });
  });
});

describe('QuotaService — graceful missing quota file', () => {
  it('treats a namespace with no _quota.json as having zero usage', async () => {
    // Create a second namespace but remove its _quota.json to simulate a pre-existing
    // namespace that predates quota tracking.
    await createNamespaceSkeleton(dataDir, {
      id: 'legacy-ns',
      display_name: 'Legacy',
      owner_agent_id: 'agent_test',
      owner_scopes: ['memory:read', 'memory:write'],
    });

    const { rm: removeFile } = await import('node:fs/promises');
    const { join: joinPath } = await import('node:path');
    await removeFile(joinPath(dataDir, 'namespaces', 'legacy-ns', '_quota.json'));

    const svc = new QuotaService({ dataDir });
    const quota = makeQuota({ daily_writes: 5 });

    // Should not throw — zero usage.
    await expect(
      svc.check('legacy-ns', 'write', { quota }),
    ).resolves.toBeUndefined();
  });
});
