/**
 * Prometheus-backed implementation of EmbeddingMetrics.
 *
 * Wire this into EmbeddingClient via opts.metrics.
 * The mapping from EmbeddingMetrics hooks → mem_embedding_* labels:
 *
 *   onAttempt()           — no metric (attempt counting is implicit via other hooks)
 *   onRetry(reason)       — mem_embedding_calls_total{outcome="retried"}
 *   onSuccess(latencyMs)  — mem_embedding_calls_total{outcome="success"}
 *                           mem_embedding_latency_seconds (observe)
 *   onFailure(reason)     — mem_embedding_calls_total{outcome=<mapped>}
 *                           mem_embedding_dimension_mismatches_total (on dimension_mismatch)
 *   onBreakerOpen()       — mem_embedding_calls_total{outcome="breaker_open"}
 *   onBreakerClose()      — no metric (state transition, not an outcome)
 */
import type { EmbeddingMetrics } from '../embeddings.js';
import {
  embeddingCallsTotal,
  embeddingDimensionMismatchesTotal,
  embeddingLatencySeconds,
} from './registry.js';

/** Maps a failure reason string to a catalogue outcome label. */
function mapFailureReason(reason: string): string {
  // Retry-exhausted HTTP reasons
  if (reason === 'http_429') return 'rate_limit';
  if (reason.startsWith('http_5') || reason === 'server_error') return 'server_error';
  // Non-retryable HTTP 4xx (e.g. http_400, http_401, http_402, http_404)
  if (reason.startsWith('http_4')) return 'invalid';
  // Dimension mismatch — counts separately but also as invalid
  if (reason === 'dimension_mismatch') return 'invalid';
  // Breaker already open
  if (reason === 'breaker_open') return 'breaker_open';
  // Network errors, retry exhausted, etc.
  return 'server_error';
}

export const promEmbeddingMetrics: EmbeddingMetrics = {
  onAttempt(): void {
    // No per-attempt metric; success/failure/retry hooks cover the outcomes.
  },

  onRetry(_reason: string): void {
    embeddingCallsTotal.inc({ outcome: 'retried' });
  },

  onSuccess(latencyMs: number): void {
    embeddingCallsTotal.inc({ outcome: 'success' });
    embeddingLatencySeconds.observe(latencyMs / 1000);
  },

  onFailure(reason: string): void {
    if (reason === 'dimension_mismatch') {
      embeddingDimensionMismatchesTotal.inc();
    }
    if (reason === 'breaker_open') {
      embeddingCallsTotal.inc({ outcome: 'breaker_open' });
    } else {
      embeddingCallsTotal.inc({ outcome: mapFailureReason(reason) });
    }
  },

  onBreakerOpen(): void {
    // The breaker tripped — record an outcome counter so the alert fires.
    embeddingCallsTotal.inc({ outcome: 'breaker_open' });
  },

  onBreakerClose(): void {
    // State transition only; no catalogue metric for close.
  },
};
