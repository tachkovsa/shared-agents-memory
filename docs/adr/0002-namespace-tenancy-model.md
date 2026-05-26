# ADR-0002: Namespace as tenancy boundary

**Status:** Proposed
**Date:** 2026-05-27
**Authors:** Claude (architect pass, opus tier), Codex review pass
**Related issues:** #5 (amend), #7 (amend)
**Depends on:** ADR-0001 (memory architecture sets the surfaces this ADR scopes)

---

## 1. Context

The 13 founding issues mention `namespace` as a payload field (issue #3 indexes it; issue #5 makes it a tool argument; issue #7 says "namespace permissions"). But nothing names namespace as the tenancy boundary, defines the cross-namespace policy, or commits to a quota model. Without that, "namespace" silently degrades to "a tag that anyone can supply."

The service is built to serve:

- **Personal memory** — the owner's own knowledge across all their projects. One namespace, one user.
- **Per-project shared memory** — knowledge for one repo (e.g. `hcm.guru`) shared across the owner's agents (Claude Code, Codex CLI, Cursor).
- **Team memory (future)** — knowledge for a team of humans + agents on a project; each human has multiple agent identities; the team has one namespace.

These have different membership shapes but the same isolation requirement: a write in namespace A is not readable from namespace B unless an explicit allowlist says otherwise. This is the same RLS pattern as the HCM.guru codebase ([`docs/auth.md` § Tenant Isolation](../../../../docs/auth.md)) — a tenancy boundary enforced at the data layer, not "everyone can see everything and we hope clients filter".

### 1.1 Why call it namespace, not tenant

"Tenant" implies a billing/organisation construct. "Namespace" is the technical isolation primitive — it could be a person, a project, or a team. One owner can have many namespaces. A team is one namespace shared by many agents. The vocabulary fits the personal-→-team trajectory.

### 1.2 What changes if we get this wrong

If namespace is just an unauthenticated tag, three things break:

1. **Cross-namespace leaks.** A misbehaving or compromised agent search call with `namespace: "team-alpha"` returns rows it shouldn't see.
2. **Quota gaming.** A free-tier namespace bursts on embeddings cost; the bill lands on the owner.
3. **Onboarding teams later becomes a rewrite.** "Adding multi-tenancy" mid-flight is far harder than designing it in from day one. ([HCM.guru learned this pattern across ADR-0153 zero-global-tables; we are not repeating it.](../../../../docs/adr/0153-zero-global-tables-full-tenant-isolation.md))

---

## 2. Constraints already locked (do not re-litigate)

1. **Qdrant is the only vector store.** Per-namespace **separate collections** are NOT used — see §4.2. One collection, namespace-filtered points.
2. **Filesystem rules** (ADR-0001) live under `data/namespaces/<namespace>/rules/`. The directory boundary is the rule-store boundary; OS permissions are NOT load-bearing, the service layer is.
3. **Auth is per-token, tokens are issued per agent identity** (ADR-0004). A namespace is accessed by agents, not by tokens directly.
4. **No anonymous reads.** Every request resolves a `(agentId, namespaceId, scope[])` triple at boundary. Anonymous = HTTP 401.

---

## 3. Decisions

### 3.1 Namespace shape

```ts
interface Namespace {
  id: string;                    // kebab-case, immutable, unique, e.g. "personal", "team-alpha", "hcm-guru"
  display_name: string;          // human-readable, "Personal", "Team Alpha"
  owner_agent_id: string;        // the agent identity that owns admin rights (typically the human's primary agent token)
  visibility: "private";         // v1: only "private" (default-deny cross-namespace). Reserved for "shared-readonly" later.
  retention_policy: RetentionPolicy;  // ADR-0006 — keep-forever | decay-90d | decay-180d | decay-365d
  quota: NamespaceQuota;         // see §3.4
  created_at: ISODateTime;
  updated_at: ISODateTime;
}
```

Stored as a single file `data/namespaces/<id>/_namespace.json` at the root of the namespace directory. Hand-edits are tolerated but discouraged — `namespace.create`/`namespace.update` admin tools maintain the canonical write path.

Namespace IDs are immutable. Rename = create-new + migrate + delete-old. Reason: every Qdrant point, audit row, and PAT scope grant references the namespace ID; renaming would cascade across thousands of records. Display name is the rename-safe handle.

### 3.2 Agent ↔ namespace membership

A separate mapping: `data/namespaces/<id>/_members.json` per namespace:

```ts
interface NamespaceMember {
  agent_id: string;              // PAT-issued agent identity from ADR-0004
  scopes: AgentScope[];          // subset of the namespace's full scope set
  added_by: string;              // agent_id of the admin who added them
  added_at: ISODateTime;
}
```

Scopes (ADR-0004 § 3.3 enumerates the full set):
- `memory:read` — `memory.search`, `memory.get`
- `memory:write` — `memory.store`, `memory.update_metadata`
- `memory:delete` — `memory.delete`
- `rules:read` — `resources/list`, `resources/read`, `rules.list`, `rules.read` for `mem://<ns>/rules/*`
- `rules:write` — `rules.upsert`, `rules.delete`
- `namespace:admin` — manage members, quota, retention policy, rename display_name

`namespace:admin` is a self-bootstrapping scope: the `owner_agent_id` set at namespace creation always implicitly carries it, even if `_members.json` omits the entry.

### 3.3 Authorization at the boundary

Every MCP tool call and resource read resolves through one chokepoint:

```ts
// pseudocode in src/auth/resolve-request.ts
async function resolveRequest(rawAuthHeader: string, requestedNamespace: string, requiredScope: AgentScope): Promise<RequestContext> {
  const token = parseBearer(rawAuthHeader);                              // throws MCP_AUTH_FAILED on shape mismatch
  const agent = await resolveAgentIdentityFromToken(token);              // throws MCP_AUTH_REVOKED if hash misses
  const member = await loadNamespaceMember(requestedNamespace, agent.id); // throws NAMESPACE_FORBIDDEN if absent
  if (!member.scopes.includes(requiredScope)) throw new ScopeInsufficient(requiredScope);
  return { agentId: agent.id, namespaceId: requestedNamespace, scopes: member.scopes };
}
```

Hard rules:
- The check happens BEFORE the tool handler runs.
- The tool handler receives `RequestContext` and trusts it — handlers never re-parse the Authorization header, never accept `agentId` or `namespaceId` from the input arguments.
- The current scaffold (`src/tools.ts:55`) sets `agent_id: ''` because there is no auth layer. ADR-0004 + this ADR jointly remove that hole.

### 3.4 Quotas

Per namespace, four buckets (sized for "single Ubuntu VDS, personal/small-team scale"):

```ts
interface NamespaceQuota {
  daily_embedding_tokens: number;        // OpenRouter cost cap. Default: 1_000_000 (~$5/day at qwen3-embedding-8b rates)
  daily_writes: number;                  // memory.store + rules.upsert combined. Default: 5000
  daily_searches: number;                // memory.search. Default: 20000
  max_memories: number;                  // hard cap on Qdrant points in this namespace. Default: 100_000
}
```

Tracking is in-process counters with periodic flush to `data/namespaces/<id>/_quota.json`. State survives restarts (file-backed) but not crashes mid-window — the in-flight delta is lost. Acceptable for v1: a ~30-second budget leak after a crash is not a security event.

Quota exhaustion → MCP `errors[].code = "QUOTA_EXCEEDED"` with `details: { bucket, resetsAt }`. Embedding-token exhaustion is the most likely to fire; the others are safety rails.

Admin can override per-namespace via `namespace.update_quota` tool (requires `namespace:admin` scope).

### 3.5 Cross-namespace policy

**Default DENY.** No agent can read or write across namespaces it is not a member of. There is no "platform admin" agent in v1.

**Future opt-in:** a `visibility: "shared-readonly"` namespace mode (reserved field in §3.1, NOT implemented in v1) would expose `resources/list` and `memory.search` to any authenticated agent, while writes remain restricted to members. This is the path for "publish a knowledge base namespace for everyone to consult" — out of scope for v1 to keep the auth surface tight.

**Admin operations** (backup, audit) run as a separate process with direct filesystem and Qdrant access, NOT as an MCP client. The MCP API itself has no cross-namespace primitives.

### 3.6 Storage layout (cross-reference)

```
data/
  namespaces/
    personal/
      _namespace.json                # this ADR §3.1
      _members.json                  # this ADR §3.2
      _quota.json                    # this ADR §3.4 (auto-maintained)
      rules/                         # ADR-0001
        INDEX.md
        ...
      audit/                         # ADR-0004 § audit log (out of scope here)
    team-alpha/
      ...
  qdrant/                            # shared Qdrant storage
    ...
```

The Qdrant collection is shared across namespaces; the `namespace` payload field (already indexed in scaffold `src/qdrant.ts:60`) is the filter. Every read query MUST include a `namespace` filter; the boundary check above ensures agents can only filter for namespaces they're a member of.

### 3.7 Bootstrap: the `personal` namespace

On first boot, the service initialises a single namespace `personal` with:
- `owner_agent_id` set to a bootstrap PAT printed to the operator's console (one-shot, replace-after-first-login per ADR-0004 onboarding flow)
- Default quotas (§3.4)
- `retention_policy: keep-forever` (ADR-0006)
- Empty `rules/` directory + a minimal `INDEX.md`

This avoids the chicken-and-egg of "you need a namespace to log in, you need to log in to create a namespace."

---

## 4. Alternatives considered

### 4.1 Namespace as untrusted tag (status quo of issue #5)

**What.** The caller supplies `namespace` as a tool argument; the server filters by it but does no membership check.
**Why tempting.** Simplest possible model; defers tenancy to "later".
**Why rejected.** §1.2 — three failure modes (leak, quota, future rewrite). The scaffold already has this gap (`agent_id: ''` in `src/tools.ts:55`); v1 closes it.

### 4.2 One Qdrant collection per namespace

**What.** Create a new Qdrant collection on namespace creation (`agent_memories__personal`, `agent_memories__team_alpha`).
**Why tempting.** Physical isolation. Easier per-namespace backup. Quota per collection is trivial.
**Why rejected.**
- Qdrant collections have a fixed vector config; cross-collection search is not supported in a single query. Per-collection limits us to one-namespace queries — which is fine for v1 (cross-namespace search is DENY anyway) but locks out future `visibility: "shared-readonly"` federation.
- Collection creation is a slow operation (~seconds); admin-side namespace provisioning takes a noticeable hit.
- Backups can target a namespace via Qdrant's filter-based snapshots; physical separation is not required.
- Per-namespace payload index = `(namespace_keyword_index) → small filter` is fast enough at our scale (tens of namespaces × tens of thousands of points). We are not optimising for million-tenant scale.

Codex's review explicitly flagged "Qdrant collections have fixed vector config and mixed dimensions in one collection are a footgun" — that's a separate concern (dimensions, ADR-0005), not a reason to fan out by namespace.

### 4.3 Membership in Postgres (sidecar DB) rather than JSON files

**What.** Add a Postgres container; store `_members.json` / `_quota.json` rows there.
**Why tempting.** Real ACID semantics, easier concurrent updates, joins.
**Why rejected for v1.** Adds a database dependency, a migration story, and an operator burden, for a workload that fits in <1 MB JSON files at the personal/small-team scale. Revisit when the namespace count crosses ~50 or membership churn becomes a real workflow. (HCM.guru runs Postgres because it's a SaaS; this is a memory MCP service for a few agents.)

### 4.4 Cross-namespace federation in v1

**What.** Allow an admin to grant read-only access to namespace B for a member of namespace A.
**Why tempting.** Real teams have overlapping knowledge ("team-alpha can see team-platform's rules").
**Why rejected for v1.** Federation rules multiply the auth surface and audit complexity. Default DENY is correct for MVP; federation is ADR-?-future once the v1 patterns settle.

---

## 5. Open questions / owner sign-off

| # | Question | Author recommendation |
|---|----------|----------------------|
| Q1 | Should `daily_embedding_tokens` default be per-namespace or per-owner (one human with three namespaces still hits a single cap)? | Per-namespace in v1. Per-owner aggregation is a richer concept (requires owner identity beyond namespace) — defer. If the owner wants a global cap, they tighten per-namespace quotas. |
| Q2 | Hardcoded defaults (§3.4) or admin-tunable via env? | Both: env overrides defaults at boot (`DEFAULT_NS_DAILY_EMBEDDING_TOKENS=…`); per-namespace overrides via `namespace.update_quota`. Common pattern in the HCM.guru codebase. |
| Q3 | When a member's `agent_id` is deleted (ADR-0004 PAT revocation), do we auto-remove their `_members.json` entries across all namespaces? | Yes — orphaned membership entries are pruned on the next admin tool call. A passive prune (cron) is also acceptable; pick whichever is cheaper to implement. |
| Q4 | Audit retention — how long do we keep `data/namespaces/<id>/audit/*.jsonl`? | 365 days for `audit/*` lines; configurable per namespace. Audit is append-only (no rotation deletes within the window); after 365 days, rotate out via the backup runbook (issue #10). |

---

## 6. Consequences

### 6.1 New issues to file

- **#17 Namespace lifecycle tools.** `namespace.create`, `namespace.list` (only namespaces the caller is a member of), `namespace.update` (display_name, quota, retention), `namespace.add_member`, `namespace.remove_member`, `namespace.delete` (with confirmation envelope).
- **#18 Bootstrap flow.** On first boot, create `personal` namespace + emit one-shot bootstrap PAT to operator console.

### 6.2 Existing issues to amend

- **#5 Memory domain service.** Add namespace boundary as the FIRST validation step in every domain operation. Tool handlers receive `RequestContext` (§3.3), never raw input. Add quota debit step in the embedding/write path.
- **#7 Agent auth/authz.** Scope the auth ADR's authorization layer to "resolve token → resolve namespace membership → resolve scope," matching §3.3 here. Reference ADR-0004 (not just this ADR) for the token half.
- **#9 Observability.** Add per-namespace metrics: `mem_quota_used_total{namespace, bucket}`, `mem_quota_rejections_total{namespace, bucket}`, `mem_memory_count{namespace}`.

### 6.3 Code impact

- `src/auth/` (new) — `resolveRequest`, namespace + member loader, scope checker.
- `src/tools.ts` — wire every tool through `RequestContext`. Remove the empty `agent_id: ''` placeholder.
- `src/namespaces/` (new) — namespace + member + quota CRUD on the filesystem.
- `src/qdrant.ts` — `search_memory` filter must REJECT a query that doesn't pass `namespace` (currently allows it). `delete_memory` must verify the point's payload `namespace` equals the request's namespace before deletion.

### 6.4 What we are explicitly NOT shipping in v1

- Cross-namespace federation (§3.5 reserved field).
- Per-owner quota aggregation across namespaces (Q1).
- A web admin UI for namespace management. MCP tools are the only management surface in v1.
- Per-namespace Qdrant collections (§4.2).

---

## 7. Changelog

| Date | Change | By |
|------|--------|----|
| 2026-05-27 | Initial draft | Claude (architect) |
