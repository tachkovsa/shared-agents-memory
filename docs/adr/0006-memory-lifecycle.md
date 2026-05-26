# ADR-0006: Memory lifecycle — dedup, reinforcement, per-namespace decay

**Status:** Proposed
**Date:** 2026-05-27
**Authors:** Claude (architect pass), Codex review pass (rejected aggressive default decay; decay must lower ranking before delete)
**Related issues:** #5 (amend), and new issues in §6
**Depends on:** ADR-0001 (this concerns episodic memory only, not rules), ADR-0002 (per-namespace policy)

---

## 1. Context

The 13 founding issues frame `memory` as create / search / get / update / delete with an optional `expiresAt`. They do not address what happens to memories that nobody reads. They do not address what happens when two near-identical memories are stored — there is no deduplication. They do not capture the fact that a stored fact may become wrong (the file it described was changed, the decision it recorded was reversed).

For a personal Claude Code session over a few weeks, this is fine — the memory is small and the human curates. For a shared service running for months across multiple agents and humans, three problems compound:

1. **Duplication.** Two agents on similar tasks store similar conclusions. Over time, search returns ten near-identical points instead of one strong one.
2. **Rot.** A memory captured six months ago references a function that no longer exists, a service that was renamed, a decision that was overturned. The memory is not "wrong" by content — it has lost truth-correspondence.
3. **Stale-but-relevant.** A memory was useful once, has never been retrieved, but cosine-similar searches return it ahead of newer, fresher memories.

My initial draft proposed aggressive defaults: dedup on write, decay to soft-delete after 180 days untouched. Codex pushed back: *"180d soft-delete is too aggressive for shared team memory. Make lifecycle per-namespace policy. Decay should lower ranking first; deletion should require explicit policy."* This ADR adopts that framing.

### 1.1 Three lifecycle concerns, three separate mechanisms

| Concern | Mechanism | When it runs |
|---|---|---|
| Duplication | Semantic dedup on write | Per `memory.store` call (synchronous) |
| Rot (truth-correspondence) | Optional `verifies_against` payload + staleness audit | On read (lazy) + periodic cron (eager) |
| Stale-but-relevant ranking | Per-namespace decay policy | Nightly cron |

These are independent. A namespace can disable any of them.

---

## 2. Constraints already locked (do not re-litigate)

1. **Per-namespace policy.** Lifecycle decisions are namespace-level, not global. (ADR-0002 §3.1, `retention_policy` field.)
2. **Decay lowers ranking before deletion.** No silent data loss. (Codex review.)
3. **Qdrant point ID is the durable handle.** Reinforcement and decay update payload fields; they do not change the ID.
4. **`updatedAt` is the human-edit timestamp; reinforcement updates a separate counter.** We do not conflate "human touched it" with "agent retrieved it."

---

## 3. Decisions

### 3.1 Payload additions

```ts
interface EpisodicMemoryPayload {
  // existing (scaffold + ADR-0001):
  namespace: string;
  agent_id: string;
  content: string;
  summary: string;
  metadata: Record<string, unknown>;
  tags: string[];
  source: string;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  // expires_at: ISODateTime | null;  // already in scaffold types

  // new — this ADR:
  kind: "episodic";                              // ADR-0001 — locked to "episodic" in v1
  last_retrieved_at: ISODateTime | null;         // null when never retrieved
  retrieval_count: number;                       // monotonic; ADR-0006 §3.3
  decay_score: number;                           // 0.0..1.0, applied as a search multiplier (ADR-0006 §3.4)
  superseded_by: string | null;                  // optional point ID of a newer memory that replaces this one (ADR-0006 §3.5)
  verifies_against: {
    kind: "file" | "url" | "git_commit";
    ref: string;                                 // path / URL / commit SHA
    captured_at: ISODateTime;                    // when the reference was last checked
    last_known_value?: string;                   // optional digest/version captured at write time
  } | null;
  staleness_signal: "fresh" | "unverified" | "stale" | "broken_ref";  // ADR-0006 §3.6
}
```

Payload indexes for fields used in cron sweeps and filters:
- `last_retrieved_at` (datetime) — driven by decay cron.
- `decay_score` (float) — payload index NOT created (Qdrant filters poorly on continuous values); used as a re-rank multiplier on the search result, not as a filter clause.
- `staleness_signal` (keyword) — searchable filter.
- `superseded_by` (keyword) — searchable filter; `memory.search` excludes `superseded_by != null` by default.

### 3.2 Semantic dedup on write

When `memory.store` is called:

1. Embed the new content.
2. Run a same-namespace cosine search with `limit: 1`.
3. If top-1 score > `dedup_threshold` (default 0.95, per-namespace tunable):
   - **Same content (cosine > 0.99):** treat as no-op idempotent reinforcement. Bump `retrieval_count` and `last_retrieved_at` on the existing point. Return the existing point's id.
   - **Near-duplicate (0.95 < cosine ≤ 0.99):** merge:
     - Bump `retrieval_count` on existing.
     - Union `tags`.
     - Append the new `content` to the existing point's `metadata.dedup_history[]` (truncated at 5 entries).
     - Set `updated_at = now`.
     - Return the existing point's id.
4. If top-1 score ≤ threshold: insert as a new point.

The caller is informed via the response shape:

```jsonc
{
  "id": "mem_abc123",
  "outcome": "inserted" | "reinforced" | "merged",
  "matched_existing_id": null | "mem_xyz789"
}
```

This makes the dedup behaviour visible to the agent — important so an agent doesn't store the same conclusion ten times and notice none of the IDs match what it stored.

**Threshold tuning.** The default 0.95 is conservative — Qwen3-embedding-8b is high-quality, so near-paraphrases score in the 0.92-0.98 range. Per-namespace override via `namespace.update`: `dedup_threshold ∈ [0.85, 0.99]`. A namespace can disable dedup entirely with `dedup_threshold = 1.0`.

**Idempotent caller-supplied ID.** If the caller supplies an `id` on `memory.store` AND the id already exists, the dedup branch is skipped — the existing point is upserted with the new content (caller is asserting "this is the same memory, just updated"). This is the existing scaffold behaviour and is preserved.

### 3.3 Reinforcement counter

`memory.get` and `memory.search` both increment `retrieval_count` and update `last_retrieved_at = now` on each hit. The update is best-effort (eventually-consistent batched flush every 60 s); a crash mid-window loses at most 60 s of counter updates. Acceptable.

`retrieval_count` is exposed to the caller in the search result payload — agents can sort or filter by "most-retrieved" if they want a recall-stable ranking.

### 3.4 Per-namespace decay policy

`RetentionPolicy` (referenced in ADR-0002 §3.1):

```ts
type RetentionPolicy =
  | { mode: "keep-forever" }
  | { mode: "decay-rank-only"; half_life_days: number }
  | { mode: "decay-and-soft-delete"; half_life_days: number; soft_delete_after_days: number };
```

Default per namespace: **`keep-forever`** (Codex: "default `keep-forever` or `decay-365d` for team knowledge"). Owner picks per-namespace.

Decay sweep runs nightly (single cron in the MCP server process; no separate worker). For each non-immune point in a namespace with `mode != "keep-forever"`:

```
days_since_retrieved = days_between(now, last_retrieved_at ?? created_at)
decay_score = 0.5 ** (days_since_retrieved / half_life_days)
```

The `decay_score` is written to the payload (one Qdrant upsert per point). Search results multiply the cosine score by `decay_score` at re-rank time:

```
ranked_score = cosine_score * (1 - decay_weight) + cosine_score * decay_score * decay_weight
            where decay_weight = 0.5 by default (per-namespace tunable [0, 1])
```

Points with `retrieval_count > 0` get a floor at `decay_score = 0.5` regardless of age — a memory that has ever been useful is not silenced.

**Soft delete** (only when `mode == "decay-and-soft-delete"` AND `days_since_retrieved > soft_delete_after_days` AND `retrieval_count == 0`):
- Set `deleted_at = now` on the point payload.
- Search filters exclude `deleted_at != null` by default.
- The Qdrant point is NOT physically removed for an additional 30 days (per-namespace `hard_delete_grace_days`) — allows undelete via `memory.restore`.
- After grace, a separate sweep hard-deletes.

**Soft-delete audit.** Every soft-delete writes a line to `data/namespaces/<ns>/audit/lifecycle.jsonl`: `{ event: "memory.soft_deleted", point_id, last_retrieved_at, reason: "decay" }`. The owner can grep this if a useful memory was lost.

Hard-delete (Qdrant point removal) also audits.

**Operator override.** A namespace member with `namespace:admin` can immortalise a point via `memory.update_metadata` setting `metadata.immortal = true` — the decay sweep skips these. Used for foundational memories ("our team naming convention", "the standing decision on X") that should never decay regardless of retrieval pattern.

### 3.5 Supersession

Newer memories may explicitly replace older ones. `memory.store` accepts an optional `supersedes: string[]` argument; on success, the new point is inserted AND each `supersedes[i]` point has its payload updated with `superseded_by = <new id>`.

By default, `memory.search` filters out `superseded_by != null` results (the chain head is what callers want). An optional `include_superseded: true` argument exposes the history (debugging, audit).

Supersession is a soft graph — a point can be superseded by multiple newer points, and a newer point can supersede multiple older ones. We do not build a transitive-closure index in v1; the chains stay shallow in practice (>3 hops is a smell).

### 3.6 Staleness — `verifies_against` and the staleness audit

If a memory references something the world could change (a file path, a URL, a git commit), the writer SHOULD include `verifies_against`:

```jsonc
{
  "kind": "file",
  "ref": "web-app/src/lib/prisma.ts",
  "captured_at": "2026-05-27T03:00:00Z",
  "last_known_value": "sha256:abc..."   // optional content digest at write time
}
```

A nightly **staleness audit** sweeps non-immortal memories with `verifies_against != null`:

| `verifies_against.kind` | Check |
|---|---|
| `file` | If the service has filesystem read access to the referenced path (configured per-namespace), compare the current `sha256` to `last_known_value`. Mismatch → `staleness_signal = "stale"`. Path missing → `staleness_signal = "broken_ref"`. |
| `git_commit` | HEAD of the configured repo has moved past the commit → `staleness_signal = "stale"`. Repo unreachable → leave at current signal. |
| `url` | HEAD request. 200 → no change. 404 → `broken_ref`. Other → leave at current signal. |

`staleness_signal` defaults to `"unverified"` when `verifies_against == null` and `"fresh"` immediately after a successful audit pass. Search results include `staleness_signal` in the payload; the agent receiving a `"stale"` or `"broken_ref"` hit decides whether to trust it.

The audit is **opt-in per namespace** (`staleness_audit_enabled: bool`, default `true`) and rate-limited (sweep at most `staleness_audit_batch_size` points per night, default 100). On a large namespace the sweep is eventually-consistent; staleness signals lag reality by days, not seconds. Acceptable for a feature whose purpose is "warn the agent, don't gate."

Configuration of filesystem read access for `kind: "file"` is operator-level — the service mounts a read-only volume (or set of volumes) that maps namespace IDs to repo roots. Out-of-scope namespaces simply do not get filesystem audits.

### 3.7 Per-namespace policy summary

A namespace's lifecycle configuration (extending ADR-0002 §3.1 `Namespace`):

```ts
interface NamespaceLifecyclePolicy {
  retention_policy: RetentionPolicy;             // §3.4
  dedup_threshold: number;                       // §3.2, default 0.95
  decay_weight: number;                          // §3.4, default 0.5
  staleness_audit_enabled: boolean;              // §3.6, default true
  staleness_audit_batch_size: number;            // §3.6, default 100
  filesystem_audit_root: string | null;          // §3.6 kind=file
  hard_delete_grace_days: number;                // §3.4, default 30
}
```

Tuned via `namespace.update` (requires `namespace:admin`). All values have safe defaults — a namespace owner can ignore this ADR entirely and get reasonable behaviour.

---

## 4. Alternatives considered

### 4.1 No lifecycle in v1 — defer all of this

**Why tempting.** Smallest scope. Faster ship.
**Why rejected.** Dedup is the most-felt one — at v1 scale a single agent storing a similar conclusion three times in one week tanks search quality. Even a half-implementation (just §3.2) earns its keep on day 1.

### 4.2 Aggressive default decay (180d soft-delete, my initial proposal)

**Why rejected.** Codex caught it: shared memory often holds decisions from a year+ ago that ARE the answer to a recurring question. Aggressive deletion punishes the long-tail by-design.

### 4.3 Decay implemented as a Qdrant payload filter (`decay_score > X`)

**Why tempting.** Cheap filter at search time.
**Why rejected.** Qdrant payload index on a continuous score requires bucketing; bucket boundaries become arbitrary. Re-rank multiplication at result time gives smooth degradation without an index dependency.

### 4.4 Content-hash dedup instead of semantic dedup

**What.** Hash the input text; reject duplicates by hash.
**Why tempting.** Cheap, deterministic.
**Why rejected.** Misses paraphrases — "use FOR UPDATE locks" and "lock the rows with FOR UPDATE" hash to different values. Semantic dedup is the load-bearing one; content-hash is at most a fast-path inside it (we have the embedding already, so the second check is free).

### 4.5 Hard delete on TTL (no soft-delete grace)

**Why rejected.** No undo for an over-aggressive policy. Soft-delete + 30-day grace is a cheap insurance.

### 4.6 Service-side `verifies_against` enforcement (refuse the search hit if stale)

**Why tempting.** "Don't let the agent see broken memories."
**Why rejected.** The agent is better placed to decide whether a stale memory is still useful — sometimes a stale memory about a renamed file is still 90% applicable, sometimes the rename invalidates it. Service warns; agent decides.

---

## 5. Open questions / owner sign-off

| # | Question | Author recommendation |
|---|----------|----------------------|
| Q1 | Default `RetentionPolicy` — `keep-forever` or `decay-rank-only` with 365d half-life? | `keep-forever`. Codex's stronger framing; safer surprise-free default. Owner picks `decay-rank-only` consciously per namespace. |
| Q2 | Should the dedup `merge` branch (§3.2) include the new `content` in the merged point's body, or just track it in `metadata.dedup_history`? | Metadata-only by default; opt-in `merge_into_body: true` per namespace if the owner wants accumulating bodies. Reason: accumulating bodies degrade search quality (embedding drifts). |
| Q3 | Staleness audit — opt-in or opt-out by default? | Opt-IN per namespace AND opt-in per memory (the writer sets `verifies_against`). The cron sweep is enabled-by-default but does nothing for memories without `verifies_against`. Cost-of-being-on is near-zero. |
| Q4 | `memory.restore` (undelete) — admin-only or any namespace member? | Any namespace member with `memory:write`. Restoration is not destructive. The 30-day grace window is the safety net; making restoration admin-gated adds friction without security benefit. |

---

## 6. Consequences

### 6.1 New issues to file

- **#26 Semantic dedup on write + reinforcement counter.** Combines: dedup branch in `memory.store` with `outcome` discriminator + per-namespace threshold + batched-flush reinforcement updater on `memory.get`/`memory.search` + `last_retrieved_at` index.
- **#27 Per-namespace decay sweep + supersession.** Combines: nightly decay cron with `decay_score` payload field, search-time re-rank multiplier + `supersedes[]` arg on `memory.store` with default-exclude filter + `memory.restore` undelete within grace.
- **#28 Staleness audit (file/url/git_commit).** Opt-in per namespace; opt-in per memory via `verifies_against`. File-kind requires mounted read-only volume.

### 6.2 Existing issues to amend

- **#5 Memory domain service.** Scope is augmented: dedup, reinforcement counter, decay metadata, supersession, staleness payload. The lifecycle cron is part of the domain layer, not a separate worker.
- **#9 Observability.** Add: `mem_dedup_outcomes_total{outcome}` counter, `mem_decay_sweep_duration_seconds` histogram, `mem_staleness_signals{signal}` gauge.

### 6.3 Code impact (scaffold)

- `src/types.ts` — add the payload fields from §3.1.
- `src/tools.ts` — `memory.store` gains dedup branch + `supersedes[]` arg; response shape gains `outcome`. `memory.get`/`memory.search` increment reinforcement (batched).
- `src/qdrant.ts` — payload indexes for `last_retrieved_at`, `staleness_signal`, `superseded_by`, `deleted_at`.
- `src/lifecycle/` (new) — decay cron, staleness audit, soft-delete sweep, hard-delete sweep.
- `src/namespaces/` (ADR-0002) — extended config schema.

### 6.4 What we are explicitly NOT shipping in v1

- Transitive supersession closure (multi-hop chains; v1 keeps it flat).
- Automatic supersession inference (the writer must declare it).
- Cross-namespace dedup (each namespace dedups independently).
- A web UI for browsing lifecycle audits.

---

## 7. Changelog

| Date | Change | By |
|------|--------|----|
| 2026-05-27 | Initial draft after Codex review (default `keep-forever`; decay lowers ranking before delete; per-namespace policy) | Claude (architect) + Codex review |
