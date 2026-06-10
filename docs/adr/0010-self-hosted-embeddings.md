# ADR-0010: Self-hosted embeddings — local multilingual model + int8 quantization, per-region deployment

**Status:** Accepted
**Date:** 2026-06-10
**Authors:** Claude (architect pass), owner (tachkovsa) — CIS self-host direction
**Related issues:** #70 (int8 quantization), #71 (region residency), and new issues in §6
**Depends on:** ADR-0001 (episodic memory), ADR-0002 (per-namespace quotas), ADR-0005 (embeddings)
**Amends:** ADR-0005 §3.1 (OpenRouter-only) and activates its reserved §3.6 (self-hostable local model); the retry/breaker/dimension-guard decisions of ADR-0005 (§3.2, §3.4) stay in force.

---

## 1. Context

ADR-0005 locked OpenRouter (`qwen/qwen3-embedding-8b`, 4096-dim) as the only embedding provider in v1, rejecting a local sidecar because that *specific* 8B model is too large for a single VDS (§4.1). It reserved a self-hostable smaller-model path as future work (§3.6, naming `bge-large` 1024-dim as an example).

The open-core + SaaS direction targets **CIS first** (see [[project-opencore-saas-direction]]). The competitor analysis ([[project-competitor-claude-mem]]) identified **BYO-model / data residency** as the #1 differentiator. We first scoped cloud CIS adapters (YandexGPT, GigaChat). On reflection, a **self-hosted local embedding model** is a strictly stronger fit for the CIS strategy:

- **Data never leaves the box** — the best possible residency story; beats even CIS-cloud providers.
- **No external dependency** — no API keys, no card payment (a real CIS friction), no sanctions exposure, no per-call cost, no OAuth/IAM/Минцифры-CA plumbing.
- **Cheaper and simpler to operate** — one self-contained box.

Embedding models are encoder-only and *small* (100M–600M params) — unlike generative LLMs they run fine on CPU. A good multilingual model (e.g. **bge-m3**, 1024-dim, 8k context, strong Russian) is ~2.3 GB and serves on CPU at ~50–150 ms/text. Any local embedding server (HF **TEI**, **Infinity**, **Ollama**) exposes an **OpenAI-compatible `/embeddings`** endpoint — which SAM already supports via `EMBEDDINGS_BASE_URL` (ADR-0005 changelog 2026-05-27). So pointing SAM at a local server is a config change, not an adapter project.

**Owner's deployment vision (2026-06-10):** three independent stands — one in **KG**, one in **KZ**, one in **RU** — each fully self-contained in its jurisdiction. This collapses the region-residency axis (#71) from an engine feature into "deploy another independent box": each instance is single-region, single-model, fixed-dimension.

**Sizing (reference box: 8 GB RAM / 4 vCPU / 80 GB NVMe, ~$42/mo):** the model is ~2.3 GB (constant); Qdrant RAM scales with vector count × dimension. At 1024-dim int8 ≈ ~1.5 KB/vector resident (quantized vector + HNSW graph links); originals + payload on disk. After model (~2.5–3 GB) + OS/Qdrant overhead (~1 GB), ~4 GB remains → **~2.5–2.7 M vectors** resident. Multi-tenancy is cheap (one Qdrant collection + namespace payload filter, ADR-0002).

**Bottleneck order (corrected after Codex/Kimi review 2026-06-10):** the first practical ceiling is **CPU (embedding throughput), not RAM**. bge-m3 on CPU does ~5–15 seq/s at batch=1; a 4 vCPU box saturates at roughly **~8–15 in-flight embedding requests** before p99 latency degrades. So the "many tenants" claim holds ONLY for **low-intensity** tenants — defined here as **avg < ~1 embed/sec/tenant** (agent loops are bursty, not chat-QPS). Second ceiling: disk IOPS for rescore reads under high search QPS. Third: RAM (vector count). All three scale independently (vertical to 16/32 GB before any sharding). A bulk-ingesting tenant pegs all 4 vCPU — ingestion must batch (§3.8).

## 2. Constraints already locked (do not re-litigate)

1. **A Qdrant collection's vector dimension is immutable at creation** (ADR-0005 §1.1). Mixing dimensions/models in one collection is forbidden — cosine across mixed embedding spaces is meaningless. Switching the model later means a new collection + re-embed (mechanical: we hold the source text).
2. **Retry + circuit breaker + dimension guard stay** (ADR-0005 §3.2, §3.4). They are provider-agnostic and load-bearing.
3. **Multi-tenancy = single Qdrant collection + `namespace` payload filter** (ADR-0002). Not per-tenant collections.
4. **Per-namespace embedding quotas** (ADR-0002 §3.4) still apply.
5. **The OpenAI-compatible HTTP path is the integration surface.** We do not add model-specific in-process inference code; the model runs as a sidecar process/container.

## 3. Decisions

### 3.1 Local OpenAI-compatible server is the default embedding provider for CIS deployments

The recommended/default deployment runs a local embedding server (sidecar container) and points SAM at it via `EMBEDDINGS_BASE_URL=http://embedder:PORT/v1`. The existing OpenAI-compatible client path is reused unchanged. Cloud OpenAI-compatible endpoints (OpenRouter, OpenAI, Together, vLLM) remain fully supported via the same config — this ADR changes the **default**, it does not remove the cloud path.

### 3.2 Default model: `bge-m3` (1024-dim, multilingual)

`bge-m3` (BAAI) — multilingual, 1024-dim, 8192-token context, strong Russian, dense + (future) sparse capable. The model is operator-configurable via `EMBEDDINGS_MODEL`; `deepvk/USER-bge-m3` (Russian-tuned) is the documented RU-leaning alternative.

### 3.3 Vector dimension becomes configurable; default 4096 → 1024

A new `EMBEDDINGS_DIMENSION` env var (default **1024** for the self-host profile) replaces the hardcoded 4096 in `src/config.ts`. The collection is created at this dimension (`src/qdrant.ts`) and the client's dimension guard validates against it. The constant-4096 assumption is removed. (A deployment that still uses cloud qwen3 sets `EMBEDDINGS_DIMENSION=4096`.)

### 3.4 int8 scalar quantization + rescoring, on by default (#70)

The collection is created with Qdrant scalar **int8** quantization, original vectors `on_disk`, and search uses oversampling + rescoring against the on-disk originals:

- `quantization_config: { scalar: { type: "int8", always_ram: true } }` — quantized vectors resident, ~4× smaller.
- Original vectors `on_disk: true`; payload `on_disk: true` (content text does not need to be RAM-resident).
- Search: `params: { quantization: { rescore: true, oversampling: 2.0 } }` — fetch ~2× candidates by quantized distance, re-rank the top by full-precision originals.

Env knobs: `QDRANT_QUANTIZATION` (`int8`|`none`, default `int8`), `QDRANT_RESCORE` (default `true`), `QDRANT_OVERSAMPLING` (default `2.0`). This makes the reference box hold millions of vectors with near-lossless recall.

"Near-lossless" is a claim, not a guarantee — quantization recall depends on the embedding distribution (bge-m3 vectors are anisotropic). Therefore: a held-out **recall@k judgment set is a production requirement**, monitored over time to catch quantization/model drift (see §3.8). Binary quantization is rejected at 1024-dim (Qdrant flags BQ as risky below ~1536-dim). **TurboQuant 4-bit** (Qdrant ≥1.18) — ~half the RAM of int8 at ~1–2 pp recall cost — is a deferred follow-up to evaluate once int8 is proven, not a launch default.

### 3.5 `purpose` hint retained in the embed interface

The embed path carries `purpose: 'document' | 'query'` (owner decision 2026-06-10): `memory.store` embeds as `document`, `memory.search` as `query`. Single-model providers (bge-m3 and OpenAI-compat) ignore it; the seam is kept for asymmetric models (e.g. a future YandexGPT `text-search-doc`/`-query` cloud fallback). No behavioural change for the default model.

### 3.6 Per-region independent deployment

Each region (KG / KZ / RU) is a standalone instance: its own box, its own model, its own Qdrant, its own data — nothing crosses regions. The region-residency axis (#71) is satisfied by deployment topology, not engine code; #71 is reduced to a deploy/runbook note, not a code feature.

### 3.7 Serving runtime (deploy/runbook, not code-locked)

The embedding sidecar is one of TEI / Infinity / Ollama, added to `docker-compose` with a healthcheck and model warm-up. SAM only depends on the OpenAI-compatible `/embeddings` contract, so the runtime is swappable. The runbook documents the chosen one and its resource reservation. **Ollama is documented as an easy-start dev option only — for production the runtime must do real dynamic batching and backpressure (TEI's ONNX CPU backend or Infinity); Ollama does neither well.**

### 3.8 Operational requirements (from Codex/Kimi review, 2026-06-10)

These are launch requirements, not nice-to-haves — they address the failure modes the adversarial review surfaced:

1. **Model baked into the image.** The embedder container ships with the model weights pre-baked — NO runtime download (CIS datacenter bandwidth is variable; a cold pull of 2.3 GB on first start = first-request timeout). Warm-up probe before the sidecar is marked healthy.
2. **Embedding throughput is the bottleneck → batch.** Ingestion paths (bulk store, future hook-ingestion, migration) MUST batch into the provider's batch endpoint rather than one HTTP call per item. Single-item synchronous embedding on 4 vCPU saturates at ~10–15 concurrent calls. The existing `embedBatch` seam (ADR-0005 §3.5) is the vehicle.
3. **Qdrant segment-optimization headroom.** At ~2 M vectors, Qdrant segment optimization spikes CPU and can transiently ~double RAM → OOM risk on an 8 GB box. Tune `optimizers_config` (segment number, `memmap_threshold`, `indexing_threshold`) and document the resident-set ceiling at which the operator should move to 16 GB. Set vectors/payload `on_disk` to keep the resident set quantized-only.
4. **Embed-failure behaviour is explicit.** When the embedder is down, the breaker opens (ADR-0005 §3.2) and `memory.store`/`search` surface a typed degraded error to the agent — they do not hang. Reads (`memory.get`) do not require the embedder and stay available.
5. **Recall@k eval + monitoring** (see §3.4) — a held-out judgment set, evaluated against a **non-quantized reference collection** and on a schedule (alerts on quantization/model drift). The judgment set must reflect real agent-memory: Russian + Kazakh/Kyrgyz, **code/identifier/stack-trace-heavy**, code-switched, transliterated, typo-noisy, short queries, and stale memories (Codex). This same harness settles the Q1 model bake-off (§5).
6. **Model-migration runbook** (the dimension one-way-door, §2). Changing the model/dimension is blue/green: stand up a second collection at the new dimension, backfill by re-embedding from stored `content` (CPU-hours per million vectors — schedule it), define cutover semantics (query-old / dual-read-during-backfill / query-new; how writes and quotas behave mid-migration), cut tenants over incrementally, then drop the old collection. Ships with the deploy docs so the lock-in is operationally survivable, not a surprise.
7. **Noisy-tenant fairness + backpressure contract.** A single tenant's bulk ingest must not starve embedding CPU for everyone (Codex). Ingestion runs through a bounded queue with per-tenant fairness; when the queue is full, `memory.store` returns a typed, retryable "embedder busy" error (an explicit backpressure contract), not an unbounded hang. Reads stay unaffected.
8. **Filtered-ANN sharp edge.** SAM searches are always namespace-filtered (ADR-0002). HNSW + a selective payload filter can degrade recall/latency badly (Codex). Use Qdrant payload indexing on `namespace` (already present) and validate filtered recall in the eval (§3.8.5) — small tenants especially. Tune `hnsw_config` / `ef` if filtered recall is weak.
9. **Pin Qdrant version.** Quantization behaviour and defaults shift across Qdrant releases; pin the image and gate upgrades behind migration tests. Snapshot/restore of millions of on-disk vectors + quantized indexes on a small box has non-trivial downtime — document it in the backup runbook.

## 4. Alternatives considered

### 4.1 Cloud CIS adapters (YandexGPT, GigaChat) — *deferred, not rejected*

Originally the plan (provider-abstraction + adapters; working reference exists in `hcm.guru`, see [[reference-cis-llm-adapters-hcmguru]]). **Why deferred:** self-host gives better residency, zero external dependency/cost, and far less code. The adapters stay in the backlog as an optional **cloud fallback** for operators who prefer managed inference; the `hcm.guru` auth/endpoint/TLS details are captured so the work is cheap if revived.

### 4.2 Self-host the big 4096-dim qwen3-embedding-8b

**Why rejected.** ~16 GB fp16 / ~8 GB int8, slow on CPU, wants a GPU — exactly what ADR-0005 §4.1 rejected. A 1024-dim model is a different, viable proposition.

### 4.3 No quantization (fp32 vectors)

**Why rejected as default.** fp32 caps the reference box at ~0.5–1 M vectors; int8 + rescore lifts it to ~2–3 M near-losslessly. Quantization is the lever that makes the cheap box hold a real tenant base. `QDRANT_QUANTIZATION=none` remains available.

### 4.4 Hybrid dense + sparse search (bge-m3 supports it) — near-launch priority, not in the first bundle

**Why not in bundle 1.** Sparse vectors mean Qdrant named-vectors, a second index, and search-fusion code — a meaningful change that would delay the first deploy.

**Why it is elevated (both reviewers, esp. Codex).** Dense-only retrieval is **weak exactly where agent memory is strong**: identifiers, filenames, stack traces, API symbols, ticket IDs, exact product names — lexical/code tokens a dense encoder blurs. bge-m3 already emits a sparse vector for free, so the marginal model cost is zero. So hybrid is **near-launch priority, evaluated against the recall eval (§3.8.5)** — not a "casual follow-up." If the eval shows dense-only materially underperforms on code/identifier queries, hybrid becomes a launch blocker for the code-heavy tenant segment.

### 4.5 Keep cloud qwen3 (4096) as the default

**Why rejected for CIS.** External dependency, card payment, no residency, per-call cost — the exact frictions the CIS strategy removes. Cloud stays supported, just not the default.

## 5. Open questions / owner sign-off

| # | Question | Author recommendation |
|---|----------|----------------------|
| Q1 | Default model — `bge-m3` (general multilingual) or `deepvk/USER-bge-m3` (RU-tuned)? | **Close call.** Kimi's review argued for USER-bge-m3 (CIS = Russian-dominant; +3–5% R@10 on Russian legal/business text). Counter-point: this is a **coding-agent memory** store — content is heavily English/code-mixed (identifiers, stack traces, library names) even for Russian-speaking users, and RU-tuned models regress on English/code. So the legal/business benchmark is the wrong distribution. **Recommendation: ship `bge-m3` as default, settle by a recall bake-off** on realistic agent-memory data (§3.8.5). Codex agreed bge-m3 (weakly) and endorsed the anti-USER-bge-m3 reasoning; both reviewers want a bake-off, not a guess. Candidate set: `bge-m3`, `deepvk/USER-bge-m3`, `Qwen3-Embedding-0.6B`, `jina-embeddings-v3` (Matryoshka), `multilingual-e5-large`. Configurable either way. Owner decides the shipped default. |
| Q2 | Default `EMBEDDINGS_DIMENSION` = 1024? | Yes — bge-m3 is 1024. Configurable; cloud qwen3 deployments set 4096. |
| Q3 | Serving runtime — TEI, Infinity, or Ollama? | **TEI** for production (purpose-built for embeddings, fastest, OpenAI-compatible route); Ollama documented as the easy-start option. Swappable — not ADR-locked. |
| Q4 | Quantization on-by-default with rescore + 2.0 oversampling? | Yes. Near-lossless with rescore; it is the capacity lever. `QDRANT_QUANTIZATION=none` opt-out stays. |
| Q5 | Hybrid (dense+sparse) in this bundle or deferred? | Not in bundle 1, but **elevated to near-launch priority** (both reviewers; Codex mildly disagreed with deferral). Dense-only is weak for code/identifier/stack-trace content, which agent memory is full of; bge-m3 emits sparse for free. Evaluate against the recall eval right after the first deploy; may become a launch blocker for code-heavy tenants. |
| Q6 | Keep the cloud OpenAI-compatible path (OpenRouter/OpenAI/vLLM) supported? | Yes — config-only; we change the default, not the capability. |

### 5.1 Owner sign-off (2026-06-10)

Owner deferred to the architect + dual-CLI review (Codex + Kimi) and signed off on all six as recommended:

| # | Decision |
|---|----------|
| Q1 | Ship **`bge-m3`** as default; settle by recall bake-off (bge-m3 / USER-bge-m3 / Qwen3-Embedding-0.6B / jina-v3 / multilingual-e5-large) on realistic agent-memory data. |
| Q2 | `EMBEDDINGS_DIMENSION` default **1024**, configurable; dimension treated as collection-versioned infra + migration runbook. |
| Q3 | **TEI** is the single blessed production runtime; Ollama dev-only. |
| Q4 | **int8 + rescore + oversampling 2.0 on by default**, with a non-quantized recall canary and `QDRANT_QUANTIZATION=none` opt-out. Binary quantization: no. |
| Q5 | Hybrid not in bundle 1 but **near-launch priority** (dense-only weak on code/identifier content); evaluate right after first deploy. |
| Q6 | Keep the cloud OpenAI-compatible path supported (config-only). |

Status → Accepted.

## 6. Consequences

**New issues to file:**
- Make `EMBEDDINGS_DIMENSION` configurable; default 1024; remove the hardcoded 4096 (§3.3). Thread `purpose` hint (§3.5).
- Deploy: add the embedding sidecar (TEI default, **model baked into image**, warm-up probe) to `docker-compose` + healthcheck; runbook entry (§3.7, §3.8).
- Ingestion **batching** via `embedBatch` for bulk/migration paths (§3.8.2).
- Qdrant **segment-optimization tuning** + on-disk vectors/payload + documented resident-set ceiling (§3.8.3).
- **Recall@k eval harness** on realistic agent-memory data — also settles Q1 (bge-m3 vs USER-bge-m3) and validates int8 quantization recall (§3.4, §3.8.5).
- **Model-migration runbook** (blue/green collection, incremental tenant cutover, re-embed from `content`) for the dimension one-way-door (§3.8.6).
- (Follow-up) Hybrid dense+sparse search with bge-m3 + Qdrant sparse vectors (§4.4); evaluate **TurboQuant 4-bit** once int8 is proven (§3.4).
- (Backlog) Cloud CIS adapters (YandexGPT/GigaChat) as optional fallback (§4.1).

**Existing issues to amend:**
- **#70 int8 quantization** — implement per §3.4 (collection `quantization_config`, on-disk originals/payload, search rescore+oversampling, env knobs). No longer "RAM economy nice-to-have"; it is the default for the self-host profile.
- **#71 region residency** — reduced to a deploy/runbook note (§3.6); not an engine feature.

**Code areas affected:** `src/config.ts` (dimension + quantization env), `src/qdrant.ts` (collection `quantization_config`, `on_disk`, dimension from config), `src/embeddings.ts` (dimension from config; `purpose` already planned), search params for rescore/oversampling, `docker-compose*.yml` + `deploy/` (embedder sidecar), `.env.example`, `docs/ops/` runbook.

**ADR-0005** status updated to note §3.1 amended and §3.6 activated by this ADR.

**Explicitly NOT shipping here:** hybrid search (§4.4), cloud CIS adapters (§4.1), multi-region engine logic (§3.6 — topology, not code).

## 7. Changelog

| Date | Change | By |
|------|--------|----|
| 2026-06-10 | Initial draft — pivot from cloud CIS adapters to self-hosted local embedding model + int8 quantization; per-region independent deployment | Claude (architect) + owner |
| 2026-06-10 | Kimi CLI review folded in (Codex CLI initially crashed on a V8 fault). Added: CPU-first bottleneck reframe + "low-intensity" definition (§1), §3.8 operational requirements (baked image, batching, segment-opt headroom, embed-failure behaviour, recall monitoring, migration runbook), recall@k + TurboQuant notes (§3.4), Q1 reframed as a close call | Claude + Kimi review |
| 2026-06-10 | Codex CLI review folded in (after downgrade to 0.136). Convergent with Kimi; added: hybrid elevated to near-launch priority (§4.4, Q5) — dense-only weak for code/identifier content; Q1 bake-off candidate set incl. Qwen3-Embedding-0.6B + jina-v3 (both reviewers want a bake-off; Codex endorsed the anti-USER-bge-m3 reasoning); §3.8 items 7–9 (tenant fairness + backpressure contract, filtered-ANN sharp edge, Qdrant version pin + snapshot downtime); recall-eval data spec broadened to code/code-switched/transliterated/noisy | Claude + Codex review |
