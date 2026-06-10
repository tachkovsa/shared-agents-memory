import type { QdrantClient } from '@qdrant/js-client-rest';

/**
 * Best-effort reinforcement counter (ADR-0006 §3.3).
 *
 * `memory.get` and `memory.search` hits call `record(pointId)`. Updates are
 * buffered in-process and flushed to Qdrant every `flushIntervalMs` (default
 * 60 s), coalescing repeated hits on the same point into one write. A crash
 * mid-window loses at most one interval of counter updates — explicitly
 * acceptable per the ADR.
 *
 * One buffer is shared per server process (a singleton), not per MCP session.
 */
export interface ReinforcementBufferDeps {
  qdrant: QdrantClient;
  collection: string;
  now?: () => Date;
  flushIntervalMs?: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 60_000;

interface PendingHit {
  delta: number;
  lastRetrievedAt: string;
}

export class ReinforcementBuffer {
  private readonly qdrant: QdrantClient;
  private readonly collection: string;
  private readonly now: () => Date;
  private readonly flushIntervalMs: number;
  private readonly pending = new Map<string, PendingHit>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: ReinforcementBufferDeps) {
    this.qdrant = deps.qdrant;
    this.collection = deps.collection;
    this.now = deps.now ?? (() => new Date());
    this.flushIntervalMs = deps.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  }

  /** Buffer a retrieval hit on a point. Cheap and synchronous. */
  record(pointId: string): void {
    const nowIso = this.now().toISOString();
    const existing = this.pending.get(pointId);
    if (existing) {
      existing.delta += 1;
      existing.lastRetrievedAt = nowIso;
    } else {
      this.pending.set(pointId, { delta: 1, lastRetrievedAt: nowIso });
    }
  }

  /** Number of distinct points currently buffered (for tests/metrics). */
  get pendingSize(): number {
    return this.pending.size;
  }

  /**
   * Flush buffered hits: read each point's current counter, add the buffered
   * delta, and write back retrieval_count + last_retrieved_at. Best-effort —
   * a Qdrant error drops the current window rather than retrying indefinitely.
   */
  async flush(): Promise<void> {
    if (this.pending.size === 0) return;

    const batch = new Map(this.pending);
    this.pending.clear();
    const ids = [...batch.keys()];

    let points;
    try {
      points = await this.qdrant.retrieve(this.collection, { ids, with_payload: true });
    } catch {
      return; // best-effort: drop this window
    }

    for (const point of points) {
      const id = point.id as string;
      const entry = batch.get(id);
      if (!entry) continue;
      const payload = (point.payload ?? {}) as Record<string, unknown>;
      const current = (payload['retrieval_count'] as number) ?? 0;
      try {
        await this.qdrant.setPayload(this.collection, {
          wait: false,
          payload: {
            retrieval_count: current + entry.delta,
            last_retrieved_at: entry.lastRetrievedAt,
          },
          points: [id],
        });
      } catch {
        // best-effort per point
      }
    }
  }

  /** Start the periodic flush timer. Unref'd so it never keeps the process alive. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  /** Stop the timer and flush any remaining buffered hits. Call on shutdown. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
