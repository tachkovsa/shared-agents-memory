import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { QdrantClient } from '@qdrant/js-client-rest';
import {
  DECAY_RETRIEVED_FLOOR,
  MEMORY_KIND,
  RETENTION_HALF_LIFE_DAYS,
} from '../memory/types.js';
import { payloadToMemory } from '../memory/service.js';
import { resolveLifecycle } from '../namespaces/defaults.js';
import { listNamespaceIds, loadNamespace } from '../namespaces/store.js';
import { decaySweepDurationSeconds, lifecycleDeletesTotal } from '../metrics/registry.js';

/** Decay sweep cadence — once a day (ADR-0006 §3.4: nightly single cron). */
export const DECAY_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Points scrolled per Qdrant page within a namespace. */
const SCROLL_PAGE_SIZE = 256;

const MS_PER_DAY = 86_400_000;

export interface DecaySweeperDeps {
  qdrant: QdrantClient;
  collection: string;
  dataDir: string;
  now?: () => Date;
  intervalMs?: number;
}

export interface DecaySweepStats {
  namespacesSwept: number;
  pointsScored: number;
  softDeleted: number;
  hardDeleted: number;
}

interface PendingPayloadWrite {
  id: string;
  payload: Record<string, unknown>;
}

/**
 * Per-namespace decay sweep (ADR-0006 §3.4/§3.5).
 *
 * Runs in-process on a daily timer (no separate worker). For each namespace with
 * a decaying retention policy it rescores every non-immortal episodic point by
 * its age, soft-deletes never-retrieved points past the namespace threshold, and
 * hard-deletes tombstones past their grace period. Audit lines for soft/hard
 * deletes land in `data/namespaces/<ns>/audit/lifecycle.jsonl`.
 *
 * Mirrors `ReinforcementBuffer`: a singleton per server process with start()/stop()
 * and a public runOnce() the timer calls and tests invoke directly.
 */
export class DecaySweeper {
  private readonly qdrant: QdrantClient;
  private readonly collection: string;
  private readonly dataDir: string;
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: DecaySweeperDeps) {
    this.qdrant = deps.qdrant;
    this.collection = deps.collection;
    this.dataDir = deps.dataDir;
    this.now = deps.now ?? (() => new Date());
    this.intervalMs = deps.intervalMs ?? DECAY_SWEEP_INTERVAL_MS;
  }

  /** Start the periodic sweep timer. Unref'd so it never keeps the process alive. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Stop the timer. Safe to call when not started. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one full sweep across every namespace. Re-entrancy guard: a sweep already
   * in flight (slow Qdrant) is not started again by the timer.
   */
  async runOnce(): Promise<DecaySweepStats> {
    const stats: DecaySweepStats = {
      namespacesSwept: 0,
      pointsScored: 0,
      softDeleted: 0,
      hardDeleted: 0,
    };
    if (this.running) return stats;
    this.running = true;
    const endTimer = decaySweepDurationSeconds.startTimer();

    try {
      const namespaceIds = await listNamespaceIds(this.dataDir);
      for (const id of namespaceIds) {
        const swept = await this.sweepNamespace(id);
        if (swept) {
          stats.namespacesSwept += 1;
          stats.pointsScored += swept.pointsScored;
          stats.softDeleted += swept.softDeleted;
          stats.hardDeleted += swept.hardDeleted;
        }
      }
    } finally {
      endTimer();
      this.running = false;
    }
    return stats;
  }

  /**
   * Sweep a single namespace. Returns null (skipped) for keep-forever namespaces
   * or namespaces whose file is missing.
   */
  private async sweepNamespace(
    namespaceId: string,
  ): Promise<{ pointsScored: number; softDeleted: number; hardDeleted: number } | null> {
    const ns = await loadNamespace(this.dataDir, namespaceId);
    if (!ns) return null;

    const halfLife = RETENTION_HALF_LIFE_DAYS[ns.retention_policy];
    if (halfLife === undefined) return null; // keep-forever → never decays

    const lifecycle = resolveLifecycle(ns);
    const nowMs = this.now().getTime();
    const nowIso = new Date(nowMs).toISOString();

    let pointsScored = 0;
    let softDeleted = 0;
    let hardDeleted = 0;

    const payloadWrites: PendingPayloadWrite[] = [];
    const hardDeleteIds: string[] = [];

    let offset: string | number | Record<string, unknown> | null | undefined;
    for (;;) {
      const page = await this.qdrant.scroll(this.collection, {
        filter: {
          must: [
            { key: 'namespace', match: { value: namespaceId } },
            { key: 'kind', match: { value: MEMORY_KIND } },
          ],
        },
        with_payload: true,
        limit: SCROLL_PAGE_SIZE,
        ...(offset !== undefined && offset !== null ? { offset } : {}),
      });

      const points = page.points ?? [];
      for (const point of points) {
        const payload = (point.payload ?? {}) as Record<string, unknown>;
        const record = payloadToMemory(point.id as string, payload);

        // Operator override: immortal points never decay or delete (ADR-0006 §3.4).
        if (record.metadata?.['immortal'] === true) continue;

        // Hard-delete tombstones past the grace period (§3.4).
        if (record.deletedAt != null) {
          const deletedDays = (nowMs - Date.parse(record.deletedAt)) / MS_PER_DAY;
          if (deletedDays > lifecycle.hard_delete_grace_days) {
            hardDeleteIds.push(record.id);
            hardDeleted += 1;
          }
          continue; // already tombstoned — no rescore
        }

        const reference = record.lastRetrievedAt ?? record.createdAt;
        const daysSince = (nowMs - Date.parse(reference)) / MS_PER_DAY;
        let decay = 0.5 ** (daysSince / halfLife);
        if (record.retrievalCount > 0 && decay < DECAY_RETRIEVED_FLOOR) {
          decay = DECAY_RETRIEVED_FLOOR;
        }
        pointsScored += 1;

        const write: Record<string, unknown> = { decay_score: decay };

        // Soft-delete never-retrieved points past the threshold (§3.4).
        if (
          lifecycle.soft_delete_after_days != null &&
          record.retrievalCount === 0 &&
          daysSince > lifecycle.soft_delete_after_days
        ) {
          write['deleted_at'] = nowIso;
          softDeleted += 1;
          await this.appendAudit(namespaceId, {
            event: 'memory.soft_deleted',
            point_id: record.id,
            last_retrieved_at: record.lastRetrievedAt,
            reason: 'decay',
          });
        }

        payloadWrites.push({ id: record.id, payload: write });
      }

      const next = page.next_page_offset;
      if (next === undefined || next === null) break;
      offset = next as string | number | Record<string, unknown>;
    }

    // Apply payload writes (rescore + soft-delete tombstones).
    for (const w of payloadWrites) {
      try {
        await this.qdrant.setPayload(this.collection, {
          wait: false,
          payload: w.payload,
          points: [w.id],
        });
      } catch {
        // best-effort per point
      }
    }
    if (softDeleted > 0) lifecycleDeletesTotal.inc({ kind: 'soft' }, softDeleted);

    // Physically remove tombstones past grace.
    if (hardDeleteIds.length > 0) {
      try {
        await this.qdrant.delete(this.collection, { points: hardDeleteIds });
      } catch {
        // best-effort
      }
      for (const id of hardDeleteIds) {
        await this.appendAudit(namespaceId, { event: 'memory.hard_deleted', point_id: id });
      }
      lifecycleDeletesTotal.inc({ kind: 'hard' }, hardDeleteIds.length);
    }

    return { pointsScored, softDeleted, hardDeleted };
  }

  private async appendAudit(
    namespaceId: string,
    entry: Record<string, unknown>,
  ): Promise<void> {
    const dir = join(this.dataDir, 'namespaces', namespaceId, 'audit');
    const path = join(dir, 'lifecycle.jsonl');
    const line = `${JSON.stringify({ ...entry, ts: this.now().toISOString() })}\n`;
    try {
      await mkdir(dir, { recursive: true });
      await appendFile(path, line);
    } catch {
      // best-effort audit; a write failure must not abort the sweep
    }
  }
}
