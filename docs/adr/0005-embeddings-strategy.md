# ADR-0005: Embeddings — OpenRouter primary, no local fallback in v1

**Status:** Accepted
**Date:** 2026-05-27 (signed off 2026-05-27)
**Authors:** Claude (architect pass), Codex review pass (rejected local 8B-model fallback on single VDS as unrealistic)
**Related issues:** #3 (amend), #4 (amend)
**Depends on:** ADR-0002 (per-namespace quotas drive cost containment)
**Spec reference:** OpenRouter Embeddings API; Qdrant collection vector config (fixed at creation).

---

## 1. Context

The scaffold (`src/embeddings.ts`) calls OpenRouter's `/api/v1/embeddings` with model `qwen/qwen3-embedding-8b` and validates the returned dimension is 4096. The Qdrant collection (`src/qdrant.ts`) is created with `size: 4096, distance: Cosine`. Both are fixed at collection-creation time and cannot be changed in place.

My initial draft proposed a local `sentence-transformers` sidecar as a fallback for OpenRouter outages and cost control. Codex's review rejected this on hardware grounds: *"Do not run Qwen3-embedding-8b locally on a single VDS. The model is ~16 GB in fp16; VDS would need >24 GB RAM. For MVP, choose OpenRouter-only + retry/backoff + incident playbook."*

The realistic options are:

| Option | Pros | Cons |
|---|---|---|
| (a) OpenRouter-only + retry/backoff + incident playbook | Simple. No new infra. Matches scaffold. | Downtime = service downtime. Cost scales with traffic. |
| (b) Smaller local fallback (e.g. `bge-large-en` 1024-dim) | Cheap to run. Fully local. | Different dimension → cannot share Qdrant collection with primary. |
| (c) Dual Qdrant collections (4096 OpenRouter primary, smaller local secondary) | Real fallback path. Each collection has stable dimension. | Significantly higher complexity. Dual-write or async backfill. Cross-collection search? |

Codex's verdict: **(a) for v1. Keep (c) as a reserved migration path if (a) ever proves insufficient.**

### 1.1 Why option (b) alone is a footgun

Qdrant collections have **fixed vector config at creation time**. A collection cannot be made to accept a different dimension later. Mixing dimensions in one collection is not supported. So "local fallback with a different dimension" cannot piggy-back on the primary collection — it requires its own collection, which is option (c).

The temptation to "just switch the embedding model at runtime" — what (b) alone would mean — produces a collection full of points embedded with mixed models. Cosine similarity across mixed embedding spaces is meaningless. The collection would silently degrade until search results stopped making sense.

### 1.2 Cost framing

At v1 scale (one human, 3-5 agents, ~500 writes + ~5000 searches/day), Qwen3-embedding-8b via OpenRouter is well under \$5/day. Cost is not the bottleneck; reliability is. The OpenRouter outage modes are documented:

- `429 Too Many Requests` — rate limit, retryable with backoff.
- `502 Bad Gateway` — upstream Qwen provider down, retryable.
- `503 Service Unavailable` — OpenRouter routing layer issue, retryable.
- `529 Site is overloaded` — OpenRouter-wide, retryable.
- `401 Unauthorized` — auth issue, NOT retryable (operator must rotate the key).
- `402 Payment Required` — credits exhausted, NOT retryable.
- `404 Not Found` — model or endpoint missing, NOT retryable.
- `400 Bad Request` — validation error (input too long, invalid model), NOT retryable.

The current scaffold's `EmbeddingError.isRetryable` getter (`src/embeddings.ts:78`) catches 429/502/503 but misses 529 and does not implement actual retry-with-backoff — it just exposes a flag. v1 implements the retry loop.

---

## 2. Constraints already locked (do not re-litigate)

1. **Model: `qwen/qwen3-embedding-8b` via OpenRouter.** Vector dimension 4096, distance Cosine. (Scaffold + issue #4.)
2. **Qdrant collection vector config is immutable.** (Qdrant docs; scaffold `src/qdrant.ts:38` guards mismatches at boot.)
3. **Per-namespace embedding-token quotas.** (ADR-0002 §3.4.)
4. **Single Ubuntu VDS deployment.** No GPU. Hosting an 8B model locally is off the table. (Codex review.)

---

## 3. Decisions

### 3.1 OpenRouter is the only embedding provider in v1

No local sidecar, no alternative provider. The scaffold's existing path is the v1 path.

### 3.2 Retry policy

When OpenRouter returns a retryable status (429, 502, 503, 529, or a transport-level error — `ECONNRESET`, `ETIMEDOUT`, fetch `TypeError` on socket close):

- **Attempt budget:** 3 retries (4 total attempts) per logical call.
- **Backoff:** exponential with jitter — `delay = min(base * 2^attempt, cap) + jitter(0, 200ms)`, where `base = 500ms`, `cap = 5000ms`. Sequence: ~500ms, ~1s, ~2s, ~4s.
- **Respect `Retry-After` header.** If OpenRouter sets it, use that delay instead of the computed one (clamped to `cap`).
- **Per-attempt timeout:** 30 s. The total wall clock for a logical call is therefore bounded at ~30 × 4 + sum(backoff) ≈ 130 s; a single embedding request that takes >2 minutes is a real incident, fail the caller.

Non-retryable (400, 401, 402, 404, 5xx not in the retryable set): fail immediately. The caller's MCP tool call surfaces the failure to the agent.

### 3.3 No idempotency key in v1, but write ordering matters

OpenRouter does not document an idempotency-key header for embeddings (it's not a write API). The risk Codex flagged is: a partial failure during `memory.store` — embedding succeeded, Qdrant write failed — results in a charged embedding with no stored point on retry, and a re-embed on the retry. Acceptable: the cost is one extra embedding call, the data is consistent.

The reverse failure — Qdrant write succeeded, response to caller failed, caller retries with the same payload — is mitigated by the existing caller-supplied `id` field on `memory.store` (`src/tools.ts:39`). If the caller supplies the same `id`, Qdrant upsert is idempotent. The scaffold's UUID generation on missing `id` is fine for fire-and-forget; idempotent clients SHOULD supply their own `id`.

Documented in onboarding (issue #12): "for retry safety, supply a `id` on `memory.store`."

### 3.4 Dimension validation stays at the boundary

The scaffold's `expectedDimension` check (`src/embeddings.ts:55`) is the load-bearing invariant: a dimension mismatch from OpenRouter (Qwen changes shape, OpenRouter silently switches providers) MUST fail before the malformed vector reaches Qdrant. If it slipped through, the Qdrant point would either fail on insert (good) or — if the collection were misconfigured — silently store wrong-dim points (catastrophic). Keep this check; do not optimise it away.

### 3.5 Embedding request batching

OpenRouter's embeddings endpoint accepts `input: string[]` (batched). The scaffold's `embedBatch` is already wired (`src/embeddings.ts:32`). v1 batches up to 32 inputs per request when the domain layer has more than one input to embed (bulk import, namespace migration). Single calls remain single calls — no artificial batching delay.

### 3.6 Dual-collection fallback — reserved migration path, NOT in v1

If OpenRouter reliability ever drops below acceptable, the migration path is:

1. Pick a self-hostable model with stable dimension (e.g. `bge-large-en-v1.5` at 1024-dim, ~1.3 GB fp16 — runs on a normal VDS without GPU).
2. Create a second Qdrant collection (`agent_memories_local`) with the fallback model's dimension.
3. Dual-write on `memory.store` — embed with both models, write to both collections. Doubles cost; acceptable transient.
4. Background backfill: re-embed historical memories with the local model.
5. `memory.search` queries primary; on primary failure, falls back to the secondary collection.

This is ~2 weeks of work and a significant ops increase. It is explicitly NOT v1. A separate ADR ships it if/when needed.

### 3.7 Operator runbook entries (cross-reference issues #9, #12)

Health endpoint reports OpenRouter reachability — a HEAD or trivial embedding call probe at startup and a circuit-breaker counter exposed via Prometheus:

- `mem_embedding_calls_total{outcome}` — counter (success | rate_limit | server_error | invalid | retried)
- `mem_embedding_latency_seconds` — histogram
- `mem_embedding_dimension_mismatches_total` — counter (this should be 0; non-zero = incident)

Alerting threshold (operator-tunable): if `rate(server_error[5m])` > 50% sustained for 10 minutes, page the operator with "OpenRouter degraded — consider pausing writes."

---

## 4. Alternatives considered

### 4.1 Local Qwen3-embedding-8b sidecar

**Why rejected.** ~16 GB fp16, ~8 GB int8 — neither fits on the assumed single-VDS hardware. Codex caught this; my initial draft missed the size implication.

### 4.2 Smaller local model SAME dimension (4096)

**What.** Find any 4096-dim embedding model that runs locally.
**Why rejected.** No widely-deployed 4096-dim model exists that runs on CPU at acceptable latency. 4096-dim is mostly the very-large-model space.

### 4.3 Smaller local model, DIFFERENT dimension, in the SAME collection

**Why rejected.** §1.1 — silent quality degradation, meaningless cosine across mixed embedding spaces.

### 4.4 Two embedding providers (OpenRouter + a sibling like Together / Replicate)

**What.** Same model, different vendor; failover on primary outage.
**Why tempting.** Real redundancy.
**Why rejected.** Adds a second API key, a second cost line, a second rate-limit config, a second client implementation — for a v1 with no recurring outage history. File as a deferred ADR if OpenRouter actually proves unreliable in production.

### 4.5 Cache embeddings by content hash

**What.** Hash the input text; cache `(hash) → vector`; skip OpenRouter on cache hit.
**Why tempting.** Cost savings on duplicate stores.
**Why rejected for v1.** ADR-0006 (lifecycle) handles duplicate stores via semantic dedup — the proper deduplication path, not content-hash cache. Content-hash cache is fine but premature; revisit only if cost becomes a pain point.

---

## 5. Open questions / owner sign-off

| # | Question | Author recommendation |
|---|----------|----------------------|
| Q1 | Retry attempts (§3.2) — 3 retries or 5? | 3. Beyond ~30s a slow caller is better served by surfacing the failure than by retrying invisibly. |
| Q2 | Should the OpenRouter `base_url` be env-tunable (§ scaffold `OPENROUTER_BASE_URL`) for testing against a fake server? | Yes — keep the scaffold's env override. Used in integration tests. |
| Q3 | At what failure rate does the service refuse new writes (return `EMBEDDING_PROVIDER_DEGRADED` instead of retrying)? | 50% rate of `server_error` over 60 s window → 30 s circuit breaker. Recovers automatically on a successful probe. Knob: `EMBEDDING_BREAKER_THRESHOLD` (default 0.5), `EMBEDDING_BREAKER_WINDOW_MS` (default 60000), `EMBEDDING_BREAKER_COOLDOWN_MS` (default 30000). |

### 5.1 Owner sign-off (2026-05-27)

| # | Decision | Notes |
|---|----------|-------|
| Q1 | 3 retries with exponential backoff (~30 s ceiling) | Per author recommendation. |
| Q2 | `OPENROUTER_BASE_URL` env override retained | Per author recommendation. Needed for integration tests against a mock server. |
| Q3 | Circuit breaker at 50% failures over 60 s → 30 s cooldown | Per author recommendation. Env knobs `EMBEDDING_BREAKER_THRESHOLD`/`WINDOW_MS`/`COOLDOWN_MS` ship with defaults 0.5 / 60000 / 30000. |

### 6.1 Existing issues to amend (no new issues from this ADR)

- **#3 Qdrant collection init.** Add explicit note: vector dimension is immutable at collection creation; payload indexes for `namespace`, `agent_id`, `tags`, `created_at`, `updated_at` (already in scaffold). Note future dual-collection migration as reserved (this ADR §3.6).
- **#4 OpenRouter embedding client.** Replace the bare `isRetryable` flag with the retry loop from §3.2. Honour `Retry-After`. Add the circuit breaker (§3.7, Q3). Expand the error taxonomy: retryable = {429, 502, 503, 529, ECONNRESET, ETIMEDOUT}; non-retryable = {400, 401, 402, 404, all other 4xx}. Explicitly drop the local-fallback scope. Add batch endpoint (§3.5).
- **#9 Observability.** Add the three Prometheus metrics from §3.7.

### 6.2 Code impact (scaffold)

- `src/embeddings.ts` — add `retryWithBackoff` wrapper; honour `Retry-After`; expand error taxonomy; add circuit breaker (separate file `src/embeddings/breaker.ts`).
- `src/embeddings/breaker.ts` (new) — in-memory rolling-window failure rate + cooldown.
- `.env.example` — add `EMBEDDING_BREAKER_*` knobs.

### 6.3 What we are explicitly NOT shipping in v1

- Local embedding fallback (§4.1, §4.2, §4.3).
- Multi-provider failover (§4.4).
- Content-hash embedding cache (§4.5).
- Dual-collection migration path (§3.6).

---

## 7. Changelog

| Date | Change | By |
|------|--------|----|
| 2026-05-27 | Initial draft after Codex rejection of local 8B-model fallback on single VDS | Claude (architect) + Codex review |
| 2026-05-27 | Owner sign-off on all 3 §5 questions; status Proposed → Accepted | tachkovsa |
