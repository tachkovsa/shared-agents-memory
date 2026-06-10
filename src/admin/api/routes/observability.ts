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

/** Bound the per-metric series so a high-cardinality label (e.g. per-namespace
 * gauges) can't grow the response without limit. */
const MAX_SERIES_PER_METRIC = 100;

/**
 * Flatten the `mem_*` metrics into a name→{type,values} map for the UI. Each value
 * keeps its `series` (prom-client `metricName`, e.g. `<base>_bucket/_sum/_count`)
 * so histogram series stay unambiguous, and the series list is capped so the
 * payload/cost stays bounded as namespaces grow.
 */
async function metricsSummary(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const m of await register.getMetricsAsJSON()) {
    if (!m.name.startsWith('mem_')) continue;
    // Drop per-namespace series (e.g. mem_memory_count{namespace}): they belong to
    // the namespaces screen, not the instance dashboard, and keeping them here only
    // adds cardinality + repeats namespace IDs. Instance-level series (labelled by
    // outcome/kind/limit/result) stay.
    const all = (m.values ?? []).filter(
      (v) => !(v.labels && Object.prototype.hasOwnProperty.call(v.labels, 'namespace')),
    );
    if (all.length === 0 && (m.values?.length ?? 0) > 0) continue;
    const values = all.slice(0, MAX_SERIES_PER_METRIC).map((v) => {
      // prom-client tags histogram/summary sub-series with `metricName`
      // (e.g. <base>_bucket/_sum/_count) at runtime, though it's absent from the type.
      const series = (v as { metricName?: string }).metricName;
      return {
        labels: v.labels,
        value: v.value,
        ...(series && series !== m.name ? { series } : {}),
      };
    });
    out[m.name] = {
      type: m.type,
      values,
      ...(all.length > MAX_SERIES_PER_METRIC ? { truncated: true } : {}),
    };
  }
  return out;
}
