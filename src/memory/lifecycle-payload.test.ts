import { describe, expect, it } from 'vitest';
import { memoryToPayload, payloadToMemory } from './service.js';
import { DECAY_DEFAULT_SCORE, type MemoryRecord } from './types.js';

/**
 * Foundation guard (#27): the ADR-0006 §3.1 lifecycle fields must round-trip
 * through the Qdrant payload mappers, and pre-#27 payloads (missing the keys)
 * must resolve to safe defaults so the decay sweep (#27) and staleness audit
 * (#28) can treat every point uniformly.
 */
describe('lifecycle payload round-trip', () => {
  const base: MemoryRecord = {
    id: '11111111-1111-1111-1111-111111111111',
    namespace: 'personal',
    agentId: 'agent-a',
    kind: 'episodic',
    content: 'use FOR UPDATE locks',
    summary: 'row locking',
    metadata: { topic: 'db' },
    source: 'session-1',
    tags: ['db'],
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    retrievalCount: 3,
    lastRetrievedAt: '2026-06-10T01:00:00.000Z',
    decayScore: 0.42,
    supersededBy: '22222222-2222-2222-2222-222222222222',
    deletedAt: '2026-06-09T00:00:00.000Z',
    deletedBy: 'agent-a',
    stalenessSignal: 'stale',
    verifiesAgainst: {
      kind: 'file',
      ref: 'src/db.ts',
      capturedAt: '2026-06-01T00:00:00.000Z',
      lastKnownValue: 'sha256:abc',
    },
  };

  it('preserves all lifecycle fields through payload conversion', () => {
    const round = payloadToMemory(base.id, memoryToPayload(base));
    expect(round).toEqual(base);
  });

  it('defaults missing lifecycle keys for pre-#27 payloads', () => {
    const legacy = {
      namespace: 'personal',
      agent_id: 'agent-a',
      kind: 'episodic',
      content: 'old memory',
      tags: [],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    const m = payloadToMemory('id-1', legacy);
    expect(m.decayScore).toBe(DECAY_DEFAULT_SCORE);
    expect(m.supersededBy).toBeNull();
    expect(m.deletedAt).toBeNull();
    expect(m.deletedBy).toBeNull();
    expect(m.stalenessSignal).toBe('unverified');
    expect(m.verifiesAgainst).toBeNull();
  });

  it('does not emit a dead expires_at key and ignores a stray one (C4/C2 #110)', () => {
    // C2 (#110): `expires_at` had no producer (nothing ever set it) and no
    // sweeper (the decay/staleness sweeps never read it), so the dead field was
    // removed. The mapper must not write it, and a legacy payload carrying one
    // must round-trip cleanly without resurrecting the field.
    const payload = memoryToPayload(base);
    expect(payload).not.toHaveProperty('expires_at');

    const round = payloadToMemory(base.id, {
      ...memoryToPayload(base),
      expires_at: '2030-01-01T00:00:00.000Z',
    });
    expect(round).not.toHaveProperty('expiresAt');
    expect(round).toEqual(base);
  });

  it('drops a malformed verifies_against rather than throwing', () => {
    const m = payloadToMemory('id-2', {
      namespace: 'personal',
      agent_id: 'a',
      kind: 'episodic',
      content: 'x',
      tags: [],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      verifies_against: { kind: 'nonsense', ref: 'y' },
    });
    expect(m.verifiesAgainst).toBeNull();
  });
});
