# ADR-0004: Auth — PAT in v1, OAuth/DCR deferred

**Status:** Accepted
**Date:** 2026-05-27 (signed off 2026-05-27)
**Authors:** Claude (architect pass), Codex review pass (split out OAuth/DCR per "overkill for v1 with 3-5 known agents")
**Related issues:** #7 (replaces scope), and new issues in §6
**Depends on:** ADR-0002 (namespace tenancy), ADR-0003 (transport)
**Spec reference:** MCP revision **2025-06-18** § 6 Authorization; RFC 6750 (Bearer); RFC 8259 (JWT — referenced but not adopted in v1)

---

## 1. Context

The v1 user base is a single human (you) operating 3-5 agent identities (Claude Code, Codex CLI, Cursor) on 1-3 machines. The 13 founding issues describe an auth model in issue #7 that mixes:
- PAT-style bearer tokens for the HTTP path.
- OAuth 2.1 dynamic client registration (DCR, RFC 7591) for first-class agent shells.
- Environment-variable credentials for stdio.

Doing all three in v1 is a misallocation: DCR is the path for "Claude Desktop on a stranger's laptop auto-enrolls"; we don't have those strangers yet. The HCM.guru ADR-0162 ships PAT in Wave 3b-α and DCR in Wave 3b-β — two phases — exactly because the surface area is different.

Codex's review put it bluntly: *"DCR is overkill for v1 with 3-5 known agents. ADR-0005 should be split: v1 PAT scopes now, OAuth/DCR as separate later phase."* This ADR adopts that split.

### 1.1 Threat model for v1

The service runs on a single Ubuntu VDS. The threats we are defending against in v1:

1. **PAT theft.** A token leaks (committed to git, exfiltrated from a laptop). Attacker uses it to read/write namespace data.
2. **Replay across namespaces.** A token issued for namespace A is used against namespace B.
3. **Replay after revocation.** The owner revokes a token; an attacker continues to use the cached secret.
4. **Server compromise.** The server itself is breached; attacker exfiltrates the PAT store and reuses tokens elsewhere (e.g., against a future SaaS variant of this service).
5. **Quota abuse.** A compromised or careless agent burns the OpenRouter budget.
6. **Audit gap.** An admin cannot tell which token did what.

Defences in this ADR:

| Threat | Defence |
|---|---|
| 1 — PAT theft | Token shown once at mint; immediate revocation; scopes scoped to the minimum needed; namespace-scoped at mint |
| 2 — Cross-namespace replay | Token carries `allowed_namespaces[]` at mint; namespace check at boundary (ADR-0002 §3.3) |
| 3 — Replay after revoke | `is_revoked` flag checked on every request; cache TTL ≤ 60 s |
| 4 — Server compromise | Hashes stored with HMAC + per-server pepper; pepper lives in env, not in the data volume (so a stolen volume is not directly replayable elsewhere) |
| 5 — Quota abuse | Per-namespace quotas (ADR-0002 §3.4) |
| 6 — Audit gap | Every request emits an audit line tagged with the resolved `agent_id` |

What this ADR explicitly does NOT defend against in v1: a sophisticated attacker who controls the VDS and the env pepper simultaneously, social-engineering of the owner, supply-chain attacks on `@modelcontextprotocol/sdk` or `@qdrant/js-client-rest`. Those are out of scope for an MVP shared-memory service.

---

## 2. Constraints already locked (do not re-litigate)

1. **No anonymous access.** Every request resolves to an agent identity. (ADR-0002 §1.)
2. **Two transports** — stdio (local) and streamable HTTP (shared). (ADR-0003.)
3. **Per-namespace authorization** is layered on top of authentication. (ADR-0002 §3.3.)
4. **No SaaS multi-organisation contract** in v1. There is no concept of "owner of the service" beyond the operator who installed it.

---

## 3. Decisions

### 3.1 PAT shape

```ts
interface AgentPat {
  id: string;                        // cuid, public, used in audit and in revoke calls
  display_name: string;              // human-readable, e.g. "Claude Code on laptop", "Codex CLI in CI"
  token_prefix: string;              // first 12 chars of the secret, stored in plaintext for log correlation and lookup
  token_hash: string;                // HMAC-SHA-256(secret, server_pepper). NOT bare SHA-256 — see §3.2.
  agent_identity: string;            // cuid, the stable identifier this token resolves to (one agent_identity may have many tokens — rotation)
  allowed_namespaces: string[];      // hard scope at mint; cannot be widened
  scopes: AgentScope[];              // ADR-0002 §3.2 — memory:read | memory:write | …
  created_at: ISODateTime;
  created_by: string;                // agent_identity that minted this token (self-mint for first token, then admin-mint)
  expires_at: ISODateTime | null;    // null = no expiry; recommend 365d for human-managed tokens, 90d for CI
  last_used_at: ISODateTime | null;  // updated by the auth resolver; eventually-consistent (batched flush)
  is_revoked: boolean;
  revoked_at: ISODateTime | null;
  revoked_reason: string | null;
}
```

The secret presented over the wire has the shape `sam_pat_<27-char-base32>` (3-char prefix + 27 chars Crockford base32, ~135 bits of entropy). The `sam_` namespacing prefix lets gitleaks/secret-scanning tools recognise it.

Storage: `data/_auth/pats.jsonl` — append-only JSONL, one record per token. Updates (revoke, `last_used_at` flush) are written as a new line with the same `id` and a `_supersedes` field; readers fold the latest record per `id`. Compaction is a manual operator-side step (issue: future ops runbook).

Why JSONL not Postgres: same reasoning as ADR-0002 §4.3 — file-shaped at this scale; revisit when token count crosses ~1000 or when audit-write rate forces a real DB.

### 3.2 Token hashing — HMAC + per-server pepper, not bare SHA-256

The naive design is `token_hash = SHA-256(secret)`. Codex flagged this in review: *"PAT hashes should be HMAC/peppered or token-prefix indexed, not bare SHA-256 as the whole story."* Right call.

**Why bare SHA-256 is insufficient.** The space of `sam_pat_*` tokens is large enough that brute-force is impractical. But an attacker who exfiltrates `pats.jsonl` from one server can:
- Confirm whether a known-shape token they hold matches any row (offline check, no rate-limit).
- If the service is ever cloned onto another machine using the same data volume, the same hashes are valid — there is no per-server binding.

**Decision:** `token_hash = HMAC-SHA-256(key = server_pepper, message = secret)`. The pepper is a 32-byte random value, generated at first boot and stored in `data/_auth/.pepper` (mode 0600) AND mirrored into the `SERVER_PEPPER` env var on the host (operator runbook). Both copies are checked at startup; mismatch → fail-loud, refuse to start. (Reason for the duplication: a stolen data volume without the env-var copy is harder to reuse; a corrupt env without the file copy is recoverable.)

Pepper rotation is a heavy operation (re-hash every PAT, revoke nothing) — out of scope for v1. Pepper compromise = revoke all PATs and reissue.

**Token lookup at request time:**

1. Parse `Bearer sam_pat_<secret>` from `Authorization`.
2. Extract `token_prefix = secret[0..12]`.
3. Scan `pats.jsonl` for rows where `token_prefix` matches (indexed in memory at boot; this scan is O(1) on the index lookup).
4. For each candidate, compute `HMAC-SHA-256(pepper, secret)` and compare against the stored `token_hash` in constant time.
5. On match: check `is_revoked`, `expires_at`, return the `agent_identity`.

The `token_prefix` is the lookup key. It's deterministic (same secret → same prefix) but reveals only 12 chars of base32 (~60 bits) — not enough to brute-force the remaining 75 bits.

**Cache.** Resolved PATs cache in memory for 60 s (`(token_hash) → AgentPat`). Revocation immediately invalidates the cache entry by id; a stale cache hit window of ≤60 s on revoked tokens is the worst case.

### 3.3 Scope set (cross-reference ADR-0002 §3.2)

| Scope | Allows |
|---|---|
| `memory:read` | `memory.search`, `memory.get` |
| `memory:write` | `memory.store`, `memory.update_metadata` |
| `memory:delete` | `memory.delete` |
| `rules:read` | `resources/list`, `resources/read`, `rules.list`, `rules.read` for `mem://<ns>/rules/*` |
| `rules:write` | `rules.upsert`, `rules.delete` |
| `namespace:admin` | `namespace.*` tools for namespaces the agent is in (rename, quota, member management) |
| `service:admin` | Server-wide admin — `namespace.create`, `namespace.delete`, `pat.list`, `pat.revoke` for any agent's tokens |

`service:admin` is bootstrap-only in v1. The first PAT minted at first boot (ADR-0002 §3.7) carries `service:admin` + every other scope. Subsequent admin tokens are minted via `pat.create_admin` (an admin-tool requiring `service:admin`).

`allowed_namespaces` is enforced **independently** of `scopes`: a token with `memory:read` and `allowed_namespaces: ["personal"]` cannot read `team-alpha` even if a member entry exists. The scope is the verb; the namespace allowlist is the object set.

### 3.4 Bootstrap flow

On first boot (when `data/_auth/pats.jsonl` does not exist):

1. Generate a `service:admin` PAT.
2. Write it to `pats.jsonl` (hashed).
3. Print the plaintext token ONCE to stderr with a clearly-marked banner:
   ```
   ===============================================================
   FIRST-BOOT BOOTSTRAP TOKEN — SAVE THIS, IT WILL NOT BE SHOWN AGAIN

       sam_pat_<27 chars>

   Also written to: data/_auth/.bootstrap_token (mode 0600).
   DELETE THAT FILE AS SOON AS YOU HAVE COPIED THE TOKEN.
   The server will refuse to print it on later boots.
   ===============================================================
   ```
4. **Also** write the plaintext token to `data/_auth/.bootstrap_token` (mode 0600, owner-only readable). Belt-and-suspenders fallback for operators who missed the stderr banner — see §5.1 Q1 sign-off override.
5. Write a marker file `data/_auth/.bootstrap_done` to suppress the banner AND to refuse to regenerate the bootstrap token on later boots.

The owner saves this token, configures their first agent client with it, then immediately:
- Deletes `data/_auth/.bootstrap_token` (the file in step 4).
- Mints scoped-down PATs for each agent identity via `pat.create`.
- Revokes the bootstrap token (`pat.revoke`) so even a leaked copy from step 4 is useless.

**Operator runbook MUST flag the lingering bootstrap-token file as a hygiene risk on every subsequent boot** if `data/_auth/.bootstrap_token` still exists when `.bootstrap_done` is set. Stderr warning per boot: `WARNING: data/_auth/.bootstrap_token still exists; delete it after copying the secret.`

### 3.5 PAT lifecycle tools (admin-only)

- `pat.create({ display_name, agent_identity, allowed_namespaces[], scopes[], expires_in_days })` — mints a new PAT, returns the plaintext **once**.
- `pat.list({ agent_identity? })` — lists PATs (without secrets) the caller has visibility into. Non-admin: only own PATs. Admin: all PATs.
- `pat.revoke({ pat_id, reason })` — marks revoked, takes effect ≤ 60s due to cache TTL.
- `pat.rotate({ pat_id })` — convenience: mint new PAT with the same scopes + revoke the old one in one call.

All four are exposed as MCP tools. `pat.create` and `pat.rotate` enforce the consequences-first envelope (similar to HCM.guru ADR-0162 §3.8.1, simplified):

1. First call → returns `{ pending: { confirmation_token, summary, will_create: { scopes, allowed_namespaces, expires_at } } }`. No write.
2. Second call with `confirmation_token` → performs the mint and returns the secret.

This forces the agent client to surface the consequences to the human before the token exists. Confirmation token is HMAC-bound to `(session_id, tool_id, input_hash, expires_at_60s)` and single-use.

### 3.6 stdio mode auth

When `TRANSPORT=stdio` (ADR-0003 § 3.2), the resolver runs ONCE at boot:

1. Read `LOCAL_STDIO_AGENT_PAT` from env.
2. Resolve the PAT through the same hashing path as HTTP.
3. Bind the entire process to the resolved `agent_identity` + `allowed_namespaces[]` + `scopes[]`.
4. Every subsequent JSON-RPC request inherits this binding. The request handlers see the same `RequestContext` shape as HTTP, just resolved at boot instead of per-request.

`Authorization` headers in stdio mode are ignored (there are none — stdio has no headers). A future stdio mode that supports a credential message could revisit; out of scope.

### 3.7 HTTP mode auth

Per request:

1. Extract `Authorization: Bearer sam_pat_...` from the HTTP request.
2. If missing or malformed → respond at HTTP layer with `401 Unauthorized` and `WWW-Authenticate: Bearer realm="shared-agents-memory"`. Per MCP §6, auth failure is HTTP layer, not JSON-RPC `errors[]`.
3. Resolve via §3.2 (hash + lookup + revocation + expiry check).
4. Per-tool-call: namespace check + scope check via ADR-0002 §3.3.

On success, the session row (ADR-0003 §3.3) is annotated with the resolved `agent_identity` and `allowed_namespaces` — subsequent requests on the same `Mcp-Session-Id` reuse the cached resolution without re-hashing, refreshed every 60 s.

### 3.8 Audit (cross-reference ADR-0002 §6, ADR-0006)

Every auth boundary outcome emits an append-only line to `data/_auth/audit.jsonl`:

| `event` | When | `details` |
|---|---|---|
| `pat.minted` | `pat.create` succeeds | `{ pat_id, agent_identity, allowed_namespaces, scopes, expires_at, by }` |
| `pat.revoked` | `pat.revoke` succeeds | `{ pat_id, reason, by }` |
| `auth.success` | Per request boundary | `{ agent_identity, namespace, scope, tool_or_resource }` (sampled at 10% to control volume; per-tenant override) |
| `auth.failure` | Per request boundary | `{ reason: "missing" \| "malformed" \| "unknown" \| "revoked" \| "expired" \| "scope_insufficient" \| "namespace_forbidden", token_prefix?, remote_addr? }` (every line, never sampled) |
| `auth.rate_limited` | HTTP-layer rate limit fires | `{ remote_addr, retry_after }` |

`auth.jsonl` is global (not per-namespace) because tokens span namespaces. Retention: 365 days, then operator rotates per the backup runbook (issue #10).

### 3.9 What we are NOT doing in v1 (deferred ADRs)

- **OAuth 2.1 + dynamic client registration.** First-class agent shells (Claude Desktop, Cursor) auto-enrolling without a manual PAT mint is a useful capability — but at v1 scale (3-5 known agents, all yours) it adds significant surface (`/.well-known/oauth-authorization-server`, `/authorize`, `/token`, `/register` endpoints, PKCE flow, refresh-token rotation, JWT signing key management, consent screen UI) for zero current users. Deferred to a future ADR once the v1 PAT model has been in production for >1 month and there's a real use case (e.g., bringing 5+ team members onboard, each on multiple machines).
- **JWT-style stateless tokens.** A future iteration could replace PAT lookup with JWT verification (no DB hit per request). Considered but rejected for v1: stateless tokens defer revocation (need a denylist anyway) and add key-rotation operational burden, all to save a 1-ms hash lookup that's not the bottleneck.
- **mTLS / client certificates.** Sophisticated but irrelevant to the v1 client population.
- **WebAuthn / passkey-based admin bootstrap.** A future "no env var" bootstrap UX. v1 uses the first-boot banner (§3.4).
- **External IdP federation** (Google, GitHub OAuth as the user identity). Future SaaS variant; not v1.

---

## 4. Alternatives considered

### 4.1 Single shared secret in env (no per-agent identity)

**What.** `MCP_API_KEY=...`; every request presents it; no `agent_identity` distinction.
**Why tempting.** Trivial.
**Why rejected.** Loses the audit identity (who did what), the per-agent scoping, and the rotation story. A single secret in env is also a single point of leak.

### 4.2 OAuth 2.1 + DCR from day one

**What.** Implement what HCM.guru ADR-0162 ships in Wave 3b-β.
**Why tempting.** Future-proof; matches the "best practice" answer.
**Why rejected.** §1 — surface vs. users mismatch. Defer to a real use case.

### 4.3 JWT (stateless, signed by server private key)

**What.** Tokens are JWTs; verification is a signature check, no DB hit.
**Why tempting.** Stateless, fast, no per-request file I/O.
**Why rejected.** Revocation requires a denylist anyway (because stateless tokens cannot be invalidated). At our scale the PAT lookup is a single hashmap probe — there is no performance problem to solve. JWTs are the right answer at high request rates with horizontal scale, neither of which applies in v1.

### 4.4 mTLS

**What.** Each agent has a client cert; mutual TLS at nginx.
**Why tempting.** No bearer tokens to leak.
**Why rejected.** Cert provisioning is a worse operator story than PAT minting for a 3-5-agent deployment. Future option for high-trust enterprise variants.

### 4.5 Bare SHA-256 hash of PAT (no pepper)

**What.** `token_hash = SHA-256(secret)`. No pepper.
**Why tempting.** Even simpler than HMAC + pepper.
**Why rejected.** Codex flag (§1, §3.2). Pepper costs almost nothing (10 LOC, one env var, one boot check) and meaningfully raises the bar for a stolen-volume attack.

---

## 5. Open questions / owner sign-off

| # | Question | Author recommendation |
|---|----------|----------------------|
| Q1 | Bootstrap token: print once to stderr (§3.4) — or write to a marker file the operator reads once? | Stderr. A file-based bootstrap secret tends to linger; the operator MUST act on a stderr banner. (Operator runbook explains how.) |
| Q2 | Should `expires_at` be required at PAT mint, or optional (default null = no expiry)? | Optional with a recommended default of 365 days. Hard requirement creates rotation toil at v1 scale; sensible default nudges good hygiene. |
| Q3 | Should we ship `pat.rotate` (§3.5) in v1, or defer until the first manual rotation pain happens? | Ship in v1. It's ~30 LOC over `pat.create + pat.revoke` and the convenience is real. |
| Q4 | `auth.success` audit sampling rate — 10% (§3.8) or full? | 10% in v1, env-tunable. Full sampling at 64 sessions × 60 req/min/session = 3840 lines/min — that's noise. `auth.failure` is full-rate because rare and important. |
| Q5 | Where do we draw the line between `namespace:admin` (manage one namespace) and `service:admin` (server-wide)? Is `namespace.create` `namespace:admin` or `service:admin`? | `service:admin` for `namespace.create` and `namespace.delete`; `namespace:admin` for everything inside an existing namespace. Creating namespaces is a server-shape change; deleting is destructive cross-cutting. |

### 5.1 Owner sign-off (2026-05-27)

| # | Decision | Notes |
|---|----------|-------|
| Q1 | **Bootstrap token: stderr banner + one-shot marker file** (extends recommendation of stderr-only) | Owner override: belt-and-suspenders. Token is printed to stderr AND written to `data/_auth/.bootstrap_token` (mode 0600). Operator must delete the file after copying. Subsequent boots emit a hygiene warning if the file still exists. §3.4 updated to reflect the dual-output flow and the runbook requirement. |
| Q2 | `expires_at` optional with default 365 days at mint | Per author recommendation. |
| Q3 | `pat.rotate` shipped in v1 | Per author recommendation. |
| Q4 | `auth.success` audit sampling 10%, env-tunable | Per author recommendation. `auth.failure` stays full-rate. Env knob: `AUDIT_SUCCESS_SAMPLE_RATE` (default 0.1, range 0.0–1.0). |
| Q5 | `service:admin` for `namespace.create` / `namespace.delete`; `namespace:admin` for in-namespace operations | Per author recommendation. |

### 6.1 New issues to file

- **#24 PAT minting + storage layer.** `data/_auth/pats.jsonl`, append-only writer, in-memory index, HMAC+pepper hashing, pepper file + env sync at boot.
- **#25 PAT lifecycle MCP tools.** `pat.create`, `pat.list`, `pat.revoke`, `pat.rotate` with the confirmation-token ceremony.
- **#21 Bootstrap flow.** First-boot banner, `.bootstrap_done` marker, refusal to print on subsequent boots. (Same issue as ADR-0002 namespace bootstrap — consolidated.)

### 6.2 Existing issues to amend

- **#7 Agent auth/authz.** Replace OAuth/DCR mentions with "PAT in v1; OAuth/DCR is a deferred ADR." Cross-link this ADR. Scope is now: PAT minting + lookup + revocation + scopes + namespace allowlist + bootstrap banner.
- **#9 Observability.** Add: `mem_pat_lookups_total{outcome}` counter, `mem_pat_active_count` gauge, `mem_auth_failures_total{reason}` counter.

### 6.3 Code impact (scaffold)

- `src/auth/pat-store.ts` (new) — JSONL writer, in-memory index, HMAC+pepper hash.
- `src/auth/resolve-request.ts` (new, also referenced from ADR-0002) — boundary resolver for HTTP requests.
- `src/auth/bootstrap.ts` (new) — first-boot banner + marker file.
- `src/auth/pepper.ts` (new) — load `.pepper` file + env var, cross-check at boot.
- `src/tools.ts` — add `pat.*` tool registrations. Replace the empty `agent_id: ''` (`src/tools.ts:55`) with the resolved agent identity from `RequestContext`.
- `.env.example` — add `SERVER_PEPPER=` (commented "auto-generated on first boot, mirror from data/_auth/.pepper") and `LOCAL_STDIO_AGENT_PAT=` (only for `TRANSPORT=stdio`).
- `.gitignore` — explicitly ignore `data/_auth/.pepper`, `data/_auth/pats.jsonl`, `data/_auth/.bootstrap_token`, `data/_auth/.bootstrap_done`.

### 6.4 Future ADRs unlocked by this one

- **ADR-?-future — OAuth 2.1 + DCR.** Ports HCM.guru ADR-0162 §3.2.2; reuses the PAT path for headless/CI agents, layers OAuth for first-class shells.
- **ADR-?-future — Pepper rotation.** Online rotation procedure: dual-pepper window, batched re-hash, cutover.

---

## 7. Changelog

| Date | Change | By |
|------|--------|----|
| 2026-05-27 | Initial draft after Codex split feedback (PAT v1, DCR deferred; HMAC+pepper not bare SHA-256) | Claude (architect) + Codex review |
| 2026-05-27 | Owner sign-off on all 5 §5 questions (Q1 extends recommendation: bootstrap token written to both stderr AND a one-shot file); §3.4 and §6.3 updated; status Proposed → Accepted | tachkovsa |
