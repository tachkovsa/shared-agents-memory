# ADR-0001: Hybrid memory architecture — file rules + vector episodic

**Status:** Proposed
**Date:** 2026-05-27
**Authors:** Claude (architect pass, opus tier), with critical second-opinion pass by Codex (GPT-5)
**Related issues:** #5 (amend), #6 (amend), and new issues filed in §6
**Depends on:** none (foundational)
**Spec reference:** Model Context Protocol revision **2025-06-18**, sections on Resources (§8) and Tools (§7).

---

## 1. Context

The shared-agents-memory service must hold knowledge for multiple AI agents (Claude Code, Codex CLI, Cursor, future team members) working on shared and personal projects. The 13 founding issues frame memory as a single, uniform store: semantic content → embedding → Qdrant point. Search returns top-K by cosine similarity. This is the natural shape for **episodic** memory ("how did we solve X last time", "what does this codebase typically look like").

It is a bad shape for **rules** — durable, deterministic facts that an agent must apply on every turn:

- "Never post review comments to GitHub under a bot identity."
- "When running Codex, use `--effort=medium` and pass long prompts via temp file on stdin."
- "User prefers Russian for end-user-facing copy, English for code/commits."

These belong to a separate class with different requirements:

| Property | File rules | Vector episodic |
|---|---|---|
| Retrieval model | Always-load (every session reads them) | Retrieve-when-relevant (top-K by query similarity) |
| Determinism | Deterministic — same content every read | Non-deterministic — depends on query phrasing |
| Failure mode | Loud (file missing → boot error) | Quiet (a near-miss simply doesn't surface) |
| Human editability | `git diff feedback_foo.md` | Qdrant point payload — not human-diffable |
| Provenance | Filename + git history | `source` payload + write timestamp |
| Audience | Hard constraints for the agent itself | Reference material the agent may consult |

The existing Claude Code auto-memory at `~/.claude/projects/<project>/memory/` is the working file-rule pattern: `MEMORY.md` indexes per-topic markdown files. It works *because* it is file-based — `MEMORY.md` is always in the context window. A vector store cannot replicate that property without effectively loading every memory every turn, which defeats the point.

The 13 founding issues do not draw this distinction. If we ship them as-written, rules degrade to "memories that we hope get retrieved" — and a near-miss on a hard rule = a re-broken invariant.

### 1.1 Why this matters more for a shared service

In a personal Claude Code session the agent is one consumer of one memory directory; the user is its only editor. Drift is local.

In a shared service, several agents (and eventually several humans) read and write. A rule like "do not post bot comments to GitHub" needs to apply identically to Claude Code, Codex CLI, Cursor, and any new vendor that connects tomorrow. The mechanism that gives every agent the same answer to the same question is the same content always being read — which is a file, not a similarity hit. The cost of getting this wrong scales linearly with the number of agents.

### 1.2 What MCP actually offers

MCP (revision 2025-06-18) has two top-level primitives that map cleanly to this split:

- **Resources** (§8) — addressable contextual data. Clients can `resources/list`, `resources/read`, and optionally `resources/subscribe` to updates. Resources are server-owned, server-curated, intended to be referenced (not invoked). The MCP spec frames them as "contextual data the model can choose to include in its context."
- **Tools** (§7) — action calls. Clients invoke them with arguments; the server executes side effects or returns computed results. Tools are the right shape for `store_memory`, `search_memory`, `delete_memory`.

The MCP spec authors deliberately separated these because they map to different LLM behaviours: **resources are pulled into context once and referenced**; **tools are called repeatedly with arguments**. Conflating them ("expose rules through a `rules.list` tool") works but is second-best — clients with strong resource UX (Claude Desktop, Cursor) will integrate resources more naturally than yet-another tool. (Source: Codex critical-pass review of this ADR.)

---

## 2. Constraints already locked (do not re-litigate)

1. **MCP is the only client-facing protocol.** No REST API, no direct Qdrant exposure. (Issue #6.)
2. **Vector dimension is 4096, distance is Cosine.** (Issue #3, scaffold `src/qdrant.ts`.)
3. **Namespace is the tenancy boundary.** Authorization is per-namespace. (ADR-0002.)
4. **Single Ubuntu VDS, Docker Compose.** No microservice sprawl. (Issue #8.)
5. **No anonymous access.** Every request carries an authenticated agent identity. (ADR-0004.)

---

## 3. Decisions

### 3.1 Two memory classes, both exposed over MCP, with different primitives

**Rules** (durable, deterministic, always-load):

- Stored as markdown files in a `rules/` directory inside each namespace's data root, e.g. `data/namespaces/<namespace>/rules/<rule-id>.md`.
- Each file has YAML frontmatter (`id`, `title`, `tags[]`, `applies_to[]`, `updated_at`) plus markdown body.
- An index file `data/namespaces/<namespace>/rules/INDEX.md` lists all rules in the namespace, one line per rule (`- [title](id.md) — one-line hook`), maintained by writes through the service (not hand-edited).
- Exposed over MCP as **Resources**:
  - URI scheme: `mem://<namespace>/rules/<rule-id>`
  - `resources/list` returns all rules in namespaces the caller has scope for.
  - `resources/read` returns frontmatter + body.
  - `resources/subscribe` is supported for the rules-index URI (`mem://<namespace>/rules/`) so clients are notified when a rule is added, updated, or removed.
- Mutated via MCP **Tools**: `rules.upsert`, `rules.delete`. Writes touch the filesystem and the index atomically; the service emits a `resources/updated` notification to subscribed clients.

**Episodic memories** (experiential, retrieve-when-relevant):

- Stored as Qdrant points in the existing 4096-dim Cosine collection (scaffold's `agent_memories` collection).
- Exposed over MCP as **Tools**:
  - `memory.store` (renamed from scaffold `store_memory`, see §3.4 below).
  - `memory.search`
  - `memory.get`
  - `memory.delete`
  - `memory.update_metadata` (new, see issue #5)
- Not exposed as Resources. The set is too large and too dynamic; resource lists with thousands of entries would defeat the resource model.

### 3.2 Resource compatibility shim — optional `rules.list` and `rules.read` tools

Not every MCP client has equally strong Resource UX. Some agent shells either ignore resources or present them poorly. For those clients we additionally expose:

- `rules.list` — returns the same data as `resources/list` filtered to `mem://<namespace>/rules/*` URIs.
- `rules.read` — returns the same body as `resources/read` for a given rule URI.

These are thin wrappers — same scope checks, same data, same authorization. A client that has good resource UX SHOULD use Resources; the tools exist as compatibility, not as the canonical surface.

### 3.3 Why not put rules in Qdrant with a `kind: "rule"` filter

We considered storing rules as Qdrant points with a `payload.kind = "rule"` filter and a convention "agents always `search_memory` with `kind: rule` before each turn." Rejected:

1. Retrieval is still semantic — a rule's wording does not match the query that should trigger it. The rule "don't post bot comments to GitHub" needs to fire on *any* PR-comment intent, not on a search for "GitHub bot comments". File-based always-load sidesteps this.
2. Embedding a rule turns its prose into 4096 floats — re-deriving the rule text requires re-reading the payload. Pure overhead.
3. The "always-include" semantics would force every search to merge an unfiltered `kind:rule` query with the actual user query, complicating the search contract.
4. File rules are diffable in git. Qdrant point updates are not.

### 3.4 Tool naming convention

Scaffold uses `store_memory`, `search_memory`, etc. (verb_noun). MCP conventions in the wild (`@modelcontextprotocol/server-filesystem`, `@modelcontextprotocol/server-github`) use **noun.verb** (`memory.store`, `repo.read`). The noun-first scheme groups tools by domain in `tools/list` output and reads better when the registry grows.

Decision: migrate to `<noun>.<verb>` in v1, before any external client integrates. The four scaffolded tools become:

- `store_memory` → `memory.store`
- `search_memory` → `memory.search`
- `get_memory` → `memory.get`
- `delete_memory` → `memory.delete`

Plus new from this ADR:
- `memory.update_metadata` (issue #5 scope)
- `rules.upsert`, `rules.delete`, `rules.list`, `rules.read` (this ADR §3.1, §3.2)

### 3.5 Storage layout on disk

```
data/
  namespaces/
    personal/                            # one directory per namespace (ADR-0002)
      rules/
        INDEX.md                         # auto-maintained index
        no-bot-comments-on-github.md     # individual rule files
        codex-effort-medium.md
        ...
    team-alpha/
      rules/
        INDEX.md
        team-policy-pr-review.md
        ...
  qdrant/                                # Qdrant storage volume mount
    ...
```

The Qdrant collection holds all namespaces' episodic memories with a `namespace` payload field for filtering (already in scaffold). The filesystem `rules/` tree is the source of truth for rules; it backs up by tar-snapshotting the directory (issue #10).

### 3.6 Frontmatter schema for rule files

```yaml
---
id: no-bot-comments-on-github          # kebab-case, unique per namespace, matches filename without .md
title: Do not post review comments to GitHub under bot identity
tags: [github, review, security]       # optional, free-form, indexed for search
applies_to:                            # optional, free-form scoping
  - "agent:claude-code"
  - "agent:codex"
  - "repo:tachkovsa/*"
severity: hard | soft                  # hard = must follow; soft = preference; default: hard
created_at: 2026-05-27T10:00:00Z
updated_at: 2026-05-27T10:00:00Z
created_by: agent_xyz                  # agent identity that wrote the rule
---

# Body

The "why" — usually a past incident or strong preference.

## How to apply

When this rule kicks in, what to check, what to refuse.
```

Frontmatter is validated by Zod at write time. Body is plain markdown — no parsing, no rendering, the service treats it as opaque.

### 3.7 Atomicity of rule writes

`rules.upsert` performs:
1. Write `<rule-id>.md.tmp` with new content.
2. `fsync`.
3. `rename` to `<rule-id>.md` (POSIX atomic on same filesystem).
4. Regenerate `INDEX.md` from a directory listing (`<rule-id>.md` → frontmatter title).
5. Emit `resources/updated` notification for `mem://<namespace>/rules/` to subscribed sessions.

Steps 1–3 give atomicity. Step 4 is best-effort under a write lock per namespace. If step 4 fails after step 3 succeeded, `INDEX.md` is regenerated lazily on the next read (a missing index is a soft error, not a hard one). The service NEVER returns success to the caller until step 3 completes.

`rules.delete` is symmetric: `unlink` then index regen.

---

## 4. Alternatives considered

### 4.1 Pure vector memory (original issue #5 / #6 framing)

**What.** Every piece of knowledge — rules and episodes — is a Qdrant point. Rules differentiated by `payload.kind = "rule"` and surfaced via a side-channel.
**Why tempting.** One storage path, one query path, one tool set.
**Why rejected.** Loses determinism for rules (§1, §3.3). Drifts toward "rules that hopefully get retrieved" — exactly the failure mode the user wants to avoid. The cost of getting a hard rule wrong (e.g., the bot posts a GitHub comment after we said never to) is high; the cost of carrying two storage paths is low.

### 4.2 Pure file memory — no vector store

**What.** Skip Qdrant; store everything as markdown files; serve via file-listing tools.
**Why tempting.** Simpler. No embedding costs. Full git history.
**Why rejected.** Defeats the project premise — semantic search across "how did we solve X" episodes is the load-bearing capability. File grep doesn't find "we used PostgreSQL FOR UPDATE locks to fix a race" from the query "concurrent write race in Postgres".

### 4.3 Rules as Qdrant points with a `kind: rule` filter and a side-channel "always include" query

**What.** Hybrid storage in one backend; the client gets rules via a separate query.
**Why tempting.** Single storage backend.
**Why rejected.** §3.3 enumerates the issues: semantic mismatch, embedding overhead, search-contract complexity, no git diff.

### 4.4 Rules in `~/.claude/` only, kept client-local

**What.** Don't put rules in this service at all; let each agent client keep its own rules locally.
**Why tempting.** Smaller scope for v1. No multi-agent rules contract to design.
**Why rejected.** Breaks the multi-agent premise — the whole point is that Claude Code, Codex, Cursor, and team members share knowledge. Codex flagged this explicitly in the second-opinion pass: "keeping rules only in `~/.claude/` is too Claude-specific and breaks the multi-agent premise."

### 4.5 Expose rules ONLY as tools, not as resources

**What.** Skip MCP Resources entirely; use only Tools.
**Why tempting.** Tools work in every MCP client. Resources are sometimes unevenly supported.
**Why rejected.** The MCP spec separated Resources and Tools for a reason — resources are pulled into context naturally by capable clients, tools are invoked on demand. Compatibility shims (§3.2) cover the weak-client case without losing the spec-aligned path.

---

## 5. Open questions / owner sign-off

| # | Question | Author recommendation |
|---|----------|----------------------|
| Q1 | Default `severity` if frontmatter omits it — `hard` or `soft`? | `hard`. A rule written intentionally is intended to be followed; if the author meant "soft", they say so. |
| Q2 | When a write to `rules/<id>.md` is concurrent with another write to the same file, do we serialise (per-namespace write lock) or last-writer-wins? | Per-namespace write lock. The frequency is low; the alternative is silent overwrite. |
| Q3 | Do we ship the `rules.list` / `rules.read` compatibility shim (§3.2) in v1 or wait until a client demonstrates weak Resource support? | Ship in v1. The cost is ~30 LOC; the benefit is no integration is blocked by a client's resource UX gap. |
| Q4 | `applies_to[]` is currently free-form strings (e.g. `"agent:claude-code"`, `"repo:tachkovsa/*"`). Should the service interpret these (filter `resources/list` based on the requesting agent identity) or just pass them through as metadata? | Pass through as metadata in v1. Filtering by `applies_to` is policy that lives client-side; the service emits, the client decides. v2 can move filtering server-side once the patterns settle. |

Owner signs off by replying inline with the chosen option for each Q. Once all four are resolved, status moves to Accepted.

---

## 6. Consequences

### 6.1 New issues to file

- **#17 Rule-file storage layer.** Implement `data/namespaces/<ns>/rules/` filesystem layout, atomic upsert/delete, INDEX.md regeneration, per-namespace write lock.
- **#18 MCP Resources surface for rules.** Register `mem://<namespace>/rules/...` URI handler in the MCP server (`resources/list`, `resources/read`, `resources/subscribe`).
- **#19 Migration from existing Claude Code memory.** One-shot script that reads `~/.claude/projects/<project>/memory/*.md` and seeds them as rules into a chosen namespace (default `personal`). Idempotent; safe to re-run.

### 6.2 Existing issues to amend

- **#5 Memory domain service.** Scope clarification: this issue covers episodic memory only (Qdrant points). Rules are issue #17. Add `memory.update_metadata` to the tool set. Add `kind` discriminator field to payload reserved for future use but locked to `"episodic"` in v1.
- **#6 MCP tool surface.** Replace verb_noun tool names with `<noun>.<verb>` (`memory.store` etc.). Note that rules are exposed as Resources (#18), not Tools, with a compatibility shim (`rules.list`, `rules.read`).

### 6.3 Code impact (scaffold)

- `src/tools.ts` — rename four tools; add `memory.update_metadata`; add `rules.upsert`, `rules.delete`, `rules.list`, `rules.read`. Wire `agent_id` from the auth layer (ADR-0004) instead of the current hardcoded empty string.
- `src/types.ts` — `MemoryRecord` gains `kind: "episodic"` (locked) and `last_retrieved_at`, `reinforcement_count` reserved for ADR-0006.
- `src/qdrant.ts` — payload index for `namespace` (already in scaffold). No schema change for this ADR.
- `src/rules/` (new) — filesystem layer for the rule store.
- `src/resources/` (new) — MCP Resources handler.

### 6.4 What we are explicitly NOT shipping in v1 (revisited in later ADRs)

- Rule version history beyond filesystem + git on the data volume. A revision history table is out of scope.
- Rule import/export in non-markdown formats. Markdown is the only on-disk shape.
- Server-side filtering of rules by `applies_to` (see Q4).
- Cross-namespace rule references (a rule in `team-alpha` referencing one in `personal`). Each namespace owns its rule set.

---

## 7. Changelog

| Date | Change | By |
|------|--------|----|
| 2026-05-27 | Initial draft after Codex second-opinion review (rules → Resources, not Tools) | Claude (architect) + Codex review |
