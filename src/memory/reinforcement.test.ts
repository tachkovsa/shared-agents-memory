import type { QdrantClient } from '@qdrant/js-client-rest';
import { describe, expect, it, vi } from 'vitest';
import { ReinforcementBuffer } from './reinforcement.js';

const COLLECTION = 'agent_memories';

function makeQdrant(overrides: {
  retrieve?: ReturnType<typeof vi.fn>;
  setPayload?: ReturnType<typeof vi.fn>;
} = {}) {
  const fake = {
    retrieve: overrides.retrieve ?? vi.fn(async () => []),
    setPayload: overrides.setPayload ?? vi.fn(async () => ({ status: 'completed' })),
  };
  return { client: fake as unknown as QdrantClient, fake };
}

function makeBuffer(client: QdrantClient, now = () => new Date('2026-06-10T00:00:00.000Z')) {
  return new ReinforcementBuffer({ qdrant: client, collection: COLLECTION, now });
}

describe('ReinforcementBuffer', () => {
  it('coalesces repeated hits on the same point', () => {
    const { client } = makeQdrant();
    const buffer = makeBuffer(client);

    buffer.record('p1');
    buffer.record('p1');
    buffer.record('p2');

    expect(buffer.pendingSize).toBe(2);
  });

  it('flush reads current counter and writes current + delta', async () => {
    const { client, fake } = makeQdrant({
      retrieve: vi.fn(async () => [{ id: 'p1', payload: { retrieval_count: 5 } }]),
    });
    const buffer = makeBuffer(client);

    buffer.record('p1');
    buffer.record('p1');
    buffer.record('p1');
    await buffer.flush();

    expect(fake.retrieve).toHaveBeenCalledTimes(1);
    expect(fake.setPayload).toHaveBeenCalledTimes(1);
    const [, body] = (fake.setPayload.mock.calls[0] ?? []) as [
      string,
      { payload: { retrieval_count: number; last_retrieved_at: string }; points: string[] },
    ];
    expect(body.payload.retrieval_count).toBe(8);
    expect(body.payload.last_retrieved_at).toBe('2026-06-10T00:00:00.000Z');
    expect(body.points).toEqual(['p1']);
  });

  it('treats a missing retrieval_count as 0', async () => {
    const { client, fake } = makeQdrant({
      retrieve: vi.fn(async () => [{ id: 'p1', payload: {} }]),
    });
    const buffer = makeBuffer(client);

    buffer.record('p1');
    await buffer.flush();

    const [, body] = (fake.setPayload.mock.calls[0] ?? []) as [
      string,
      { payload: { retrieval_count: number } },
    ];
    expect(body.payload.retrieval_count).toBe(1);
  });

  it('clears the buffer after flush', async () => {
    const { client } = makeQdrant({
      retrieve: vi.fn(async () => [{ id: 'p1', payload: { retrieval_count: 0 } }]),
    });
    const buffer = makeBuffer(client);

    buffer.record('p1');
    await buffer.flush();
    expect(buffer.pendingSize).toBe(0);
  });

  it('flush is a no-op when the buffer is empty', async () => {
    const { client, fake } = makeQdrant();
    const buffer = makeBuffer(client);

    await buffer.flush();
    expect(fake.retrieve).not.toHaveBeenCalled();
    expect(fake.setPayload).not.toHaveBeenCalled();
  });

  it('stop() flushes any remaining buffered hits', async () => {
    const { client, fake } = makeQdrant({
      retrieve: vi.fn(async () => [{ id: 'p1', payload: { retrieval_count: 1 } }]),
    });
    const buffer = makeBuffer(client);

    buffer.start();
    buffer.record('p1');
    await buffer.stop();

    expect(fake.setPayload).toHaveBeenCalledTimes(1);
  });

  it('is best-effort: a Qdrant retrieve error does not throw', async () => {
    const { client, fake } = makeQdrant({
      retrieve: vi.fn(async () => {
        throw new Error('qdrant down');
      }),
    });
    const buffer = makeBuffer(client);

    buffer.record('p1');
    await expect(buffer.flush()).resolves.toBeUndefined();
    expect(fake.setPayload).not.toHaveBeenCalled();
    expect(buffer.pendingSize).toBe(0); // window dropped
  });
});
