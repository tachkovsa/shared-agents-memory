import type { QdrantClient } from '@qdrant/js-client-rest';
import type { FastifyInstance } from 'fastify';
import type { PatStore } from '../../../auth/pat-store.js';
import { register } from '../../../metrics/registry.js';
import { listNamespaceIds } from '../../../namespaces/store.js';
import type { PreHandler } from '../app.js';

export interface ObservabilityDeps {
  qdrant: QdrantClient;
  collection: string;
  version: string;
  /** Reads the embeddings circuit-breaker state ('closed' | 'open' | …). */
  getBreakerState?: () => string;
  dataDir: string;
  patStore?: PatStore;
  requireAuth: PreHandler;
}

/**
 * Operator observability summary (ADR-0008 BFF, #69): instance health + headline
 * counts + the `mem_*` Prometheus counters as JSON, so the console dashboard reads
 * one endpoint. Raw `/metrics` stays loopback-only on the MCP listener.
 */
export function registerObservabilityRoutes(app: FastifyInstance, deps: ObservabilityDeps): void {
  const { qdrant, collection, version, getBreakerState, dataDir, patStore, requireAuth } = deps;

  app.get('/api/admin/observability', { preHandler: requireAuth }, async () => {
    // Health: a cheap Qdrant probe + the embeddings breaker state.
    let qdrantStatus: 'ok' | 'down' = 'ok';
    let memoryCount: number | null = null;
    try {
      await qdrant.getCollection(collection);
      const counted = await qdrant.count(collection, { exact: false });
      memoryCount = counted.count;
    } catch {
      qdrantStatus = 'down';
    }

    const breaker = getBreakerState?.() ?? 'unknown';
    const namespaceCount = (await listNamespaceIds(dataDir)).length;
    const pats = patStore?.list() ?? [];

    return {
      health: {
        status: qdrantStatus === 'ok' && breaker !== 'open' ? 'ok' : 'degraded',
        qdrant: qdrantStatus,
        embeddings_breaker: breaker,
        version,
      },
      counts: {
        namespaces: namespaceCount,
        memories: memoryCount,
        pats_total: pats.length,
        pats_active: pats.filter((p) => !p.is_revoked).length,
      },
      metrics: await metricsSummary(),
    };
  });
}

/** Flatten the `mem_*` counters/gauges/histograms into a name→value map for the UI. */
async function metricsSummary(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const m of await register.getMetricsAsJSON()) {
    if (!m.name.startsWith('mem_')) continue;
    out[m.name] = m.values.map((v) => ({ labels: v.labels, value: v.value }));
  }
  return out;
}
