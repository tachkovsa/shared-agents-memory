/**
 * Prometheus metrics registry — single source of truth for all mem_* metrics.
 *
 * All metric names are defined here as named exports so they can be imported
 * and incremented from wherever instrumentation is needed.
 *
 * ADR references:
 *   ADR-0003 §6.2 — transport metrics
 *   ADR-0004 §6.2 — auth metrics
 *   ADR-0005 §6   — embedding metrics
 *   ADR-0002 §6.2 — namespace metrics
 */
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

export const register = new Registry();

// Enable process + nodejs default metrics (cpu, memory, event loop, etc.)
collectDefaultMetrics({ register });

// ── Transport: HTTP (ADR-0003 §6.2) ─────────────────────────────────────────

/** Number of currently active HTTP sessions. */
export const httpSessionsActive = new Gauge({
  name: 'mem_http_sessions_active',
  help: 'Number of active HTTP MCP sessions',
  registers: [register],
});

/**
 * Total HTTP requests by outcome.
 * outcome ∈ 2xx | 4xx | 5xx | auth_failure | origin_mismatch |
 *           session_expired | inflight_limit | session_limit
 */
export const httpRequestsTotal = new Counter({
  name: 'mem_http_requests_total',
  help: 'Total HTTP MCP requests by outcome',
  labelNames: ['outcome'] as const,
  registers: [register],
});

/**
 * HTTP session duration histogram.
 * Observed when a session is removed (by idle sweep, SDK close, or shutdown).
 * Buckets: 1s, 10s, 1m, 5m, 15m, 1h
 */
export const httpSessionDurationSeconds = new Histogram({
  name: 'mem_http_session_duration_seconds',
  help: 'HTTP MCP session lifetime in seconds',
  buckets: [1, 10, 60, 300, 900, 3600],
  registers: [register],
});

/**
 * Total stdio messages by direction.
 * direction ∈ inbound | outbound
 */
export const stdioMessagesTotal = new Counter({
  name: 'mem_stdio_messages_total',
  help: 'Total stdio MCP messages by direction',
  labelNames: ['direction'] as const,
  registers: [register],
});

// ── Auth (ADR-0004 §6.2) ─────────────────────────────────────────────────────

/**
 * Total PAT lookup outcomes.
 * outcome ∈ success | malformed | unknown | revoked | expired
 */
export const patLookupsTotal = new Counter({
  name: 'mem_pat_lookups_total',
  help: 'Total PAT lookup attempts by outcome',
  labelNames: ['outcome'] as const,
  registers: [register],
});

/** Number of active (non-revoked, non-expired) PATs in the store. */
export const patActiveCount = new Gauge({
  name: 'mem_pat_active_count',
  help: 'Number of active PATs in the store',
  registers: [register],
});

/**
 * Total auth failures by reason.
 * reason from AuthError.reason
 */
export const authFailuresTotal = new Counter({
  name: 'mem_auth_failures_total',
  help: 'Total authentication/authorisation failures by reason',
  labelNames: ['reason'] as const,
  registers: [register],
});

// ── Embeddings (ADR-0005 §6) ──────────────────────────────────────────────────

/**
 * Total embedding call outcomes.
 * outcome ∈ success | rate_limit | server_error | invalid | retried | breaker_open
 */
export const embeddingCallsTotal = new Counter({
  name: 'mem_embedding_calls_total',
  help: 'Total embedding API calls by outcome',
  labelNames: ['outcome'] as const,
  registers: [register],
});

/**
 * Embedding request latency histogram.
 * Buckets: 50ms, 100ms, 250ms, 500ms, 1s, 2.5s, 5s, 10s
 */
export const embeddingLatencySeconds = new Histogram({
  name: 'mem_embedding_latency_seconds',
  help: 'Embedding API call latency in seconds',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

/**
 * Total embedding dimension mismatches.
 * Operators must alert on non-zero values.
 */
export const embeddingDimensionMismatchesTotal = new Counter({
  name: 'mem_embedding_dimension_mismatches_total',
  help: 'Total embedding responses with wrong vector dimension (operator must alert on non-zero)',
  registers: [register],
});

// ── Namespace (ADR-0002 §6.2) ─────────────────────────────────────────────────

/**
 * Memory count per namespace (gauge; refreshed periodically in HTTP mode).
 * namespace label = namespace id
 */
export const memoryCount = new Gauge({
  name: 'mem_memory_count',
  help: 'Number of memory records in Qdrant per namespace',
  labelNames: ['namespace'] as const,
  registers: [register],
});
