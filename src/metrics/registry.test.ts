/**
 * Tests for the metrics registry and the prom-backed EmbeddingMetrics impl.
 *
 * Verifies:
 *   - All required metric names are registered.
 *   - promEmbeddingMetrics correctly increments counters/histograms.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { register } from './registry.js';
import { promEmbeddingMetrics } from './embeddings.js';

// ── Metric name catalogue ──────────────────────────────────────────────────────

const REQUIRED_METRIC_NAMES = [
  // Transport
  'mem_http_sessions_active',
  'mem_http_requests_total',
  'mem_http_session_duration_seconds',
  'mem_stdio_messages_total',
  // Auth
  'mem_pat_lookups_total',
  'mem_pat_active_count',
  'mem_auth_failures_total',
  // Embeddings
  'mem_embedding_calls_total',
  'mem_embedding_latency_seconds',
  'mem_embedding_dimension_mismatches_total',
  // Namespace
  'mem_memory_count',
];

describe('metrics registry', () => {
  it('registers all required metric names', async () => {
    const metricsText = await register.metrics();
    for (const name of REQUIRED_METRIC_NAMES) {
      expect(metricsText).toContain(name);
    }
  });

  it('includes process default metrics', async () => {
    const metricsText = await register.metrics();
    // prom-client collectDefaultMetrics adds nodejs_* and process_* metrics
    expect(metricsText).toMatch(/nodejs_|process_/);
  });
});

describe('promEmbeddingMetrics', () => {
  beforeEach(async () => {
    // Reset all counters/histograms between tests to get clean counts.
    // We use getMetricsAsJSON and look at specific metrics by querying
    // the registry getMetricsAsJSON to retrieve current values.
    register.resetMetrics();
  });

  it('increments mem_embedding_calls_total{outcome="success"} on onSuccess()', async () => {
    promEmbeddingMetrics.onSuccess(150);

    const metrics = await register.getMetricsAsJSON();
    const callsMetric = metrics.find((m) => m.name === 'mem_embedding_calls_total');
    expect(callsMetric).toBeDefined();

    const successValue = (callsMetric?.values ?? []).find(
      (v) => (v.labels as Record<string, string>)['outcome'] === 'success',
    );
    expect(successValue?.value).toBe(1);
  });

  it('observes mem_embedding_latency_seconds on onSuccess()', async () => {
    promEmbeddingMetrics.onSuccess(500); // 500ms → 0.5s

    const metrics = await register.getMetricsAsJSON();
    const latencyMetric = metrics.find((m) => m.name === 'mem_embedding_latency_seconds');
    expect(latencyMetric).toBeDefined();

    const countValue = (latencyMetric?.values ?? []).find(
      (v) => (v.labels as Record<string, string>)['quantile'] === undefined && v.metricName === 'mem_embedding_latency_seconds_count',
    );
    expect(countValue?.value).toBe(1);
  });

  it('increments mem_embedding_calls_total{outcome="retried"} on onRetry()', async () => {
    promEmbeddingMetrics.onRetry('http_429');

    const metrics = await register.getMetricsAsJSON();
    const callsMetric = metrics.find((m) => m.name === 'mem_embedding_calls_total');
    const retriedValue = (callsMetric?.values ?? []).find(
      (v) => (v.labels as Record<string, string>)['outcome'] === 'retried',
    );
    expect(retriedValue?.value).toBe(1);
  });

  it('increments mem_embedding_calls_total{outcome="rate_limit"} for http_429 failure', async () => {
    promEmbeddingMetrics.onFailure('http_429');

    const metrics = await register.getMetricsAsJSON();
    const callsMetric = metrics.find((m) => m.name === 'mem_embedding_calls_total');
    const rateLimitValue = (callsMetric?.values ?? []).find(
      (v) => (v.labels as Record<string, string>)['outcome'] === 'rate_limit',
    );
    expect(rateLimitValue?.value).toBe(1);
  });

  it('increments mem_embedding_dimension_mismatches_total on dimension_mismatch failure', async () => {
    promEmbeddingMetrics.onFailure('dimension_mismatch');

    const metrics = await register.getMetricsAsJSON();
    const mismatchMetric = metrics.find(
      (m) => m.name === 'mem_embedding_dimension_mismatches_total',
    );
    expect(mismatchMetric?.values[0]?.value).toBe(1);
  });

  it('increments mem_embedding_calls_total{outcome="breaker_open"} on onBreakerOpen()', async () => {
    promEmbeddingMetrics.onBreakerOpen();

    const metrics = await register.getMetricsAsJSON();
    const callsMetric = metrics.find((m) => m.name === 'mem_embedding_calls_total');
    const breakerValue = (callsMetric?.values ?? []).find(
      (v) => (v.labels as Record<string, string>)['outcome'] === 'breaker_open',
    );
    expect(breakerValue?.value).toBe(1);
  });
});
