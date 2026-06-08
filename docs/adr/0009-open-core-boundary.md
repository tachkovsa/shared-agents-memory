# ADR-0009: Open-core boundary — OSS engine + admin, private SaaS control-plane

**Status:** Proposed
**Date:** 2026-06-08
**Authors:** Claude (architect pass), Codex + Kimi stack-review pass
**Related issues:** #54 (epic), #58, #59, #61
**Depends on:** ADR-0002 (namespace tenancy), ADR-0004 (PAT auth)

---

## 1. Context

SAM is moving from an internal tool to an **open-core** product: a fully usable open-source self-hostable engine, monetised by a **SaaS control-plane kept in a separate private repository**. We need a single authoritative statement of what lives where, so contributors (human and agent) never add commercial logic to the public repo, and so the OSS data model doesn't grow a tenancy concept the SaaS layer should own.

This ADR is the boundary. ADR-0007 (human auth) and ADR-0008 (admin transport) build on it.

## 2. Constraints already locked (do not re-litigate)

1. Engine surface (memory/rules/namespaces/PAT, transports, Qdrant, embeddings, observability) is OSS and shipped (ADR-0001..0006).
2. **OSS exposes users + namespaces + PAT only — no organization/account concept.** Orgs are the SaaS differentiator (owner decision, 2026-06-08).
3. Billing target is CIS first; only a provider seam + stub ships in OSS (#61). No payment code in the public repo.
4. Self-host must remain fully functional with zero SaaS components present.

## 3. Decisions

### 3.1 The boundary

| Layer | Repo | Notes |
|---|---|---|
| MCP engine: memory/rules/namespaces/PAT, transports, Qdrant, embeddings, lifecycle, observability | **OSS (this repo)** | shipped |
| Web admin console + admin API (BFF) | **OSS** | ADR-0008 |
| Human (operator) authentication — login/session/RBAC | **OSS** | ADR-0007 |
| Per-tenant quota **enforcement** + abuse protection | **OSS** | #59; the seam plans plug into |
| `org`/`account` tenancy above namespaces | **private SaaS** | not modelled in OSS |
| Billing, self-serve signup, provisioning, plan→quota enforcement, BYO-key tiers | **private SaaS** | OSS ships only the provider interface + stub (#61) |
| Privacy/GDPR export+delete ops at SaaS scale | **private SaaS** | OSS keeps per-namespace delete only |

### 3.2 OSS = implicit single workspace

The OSS build behaves as a single tenant the operator owns. There is **no `org_id` / `account_id` field** anywhere in OSS code or storage. Namespaces remain the only tenancy axis (ADR-0002). The SaaS layer introduces `org` *above* namespaces in its own repo and maps requests to a namespace set before they reach engine code — the engine never learns about orgs.

### 3.3 The three seams

The SaaS layer plugs in through three interfaces defined in OSS, each with an OSS default implementation:

1. **Repository interfaces** — operator/session/quota persistence (ADR-0007, ADR-0008). OSS impl = SQLite (`better-sqlite3`); SaaS impl = Postgres. Engine file-stores (PATs/namespaces/rules/audit) stay as-is.
2. **Auth-provider interface** — resolves an authenticated principal. OSS impl = local password+TOTP operator (ADR-0007); SaaS impl = org-scoped identity / SSO.
3. **Billing-provider interface** — entitlement/quota lookup (#61). OSS impl = no-op stub (everything unlimited). SaaS impl = CIS provider, private.

Routes and services depend on the interface, never the concrete impl. This is what keeps the public repo free of commercial logic while letting SaaS reuse the engine unchanged.

### 3.4 Licensing

Engine stays permissive (**MIT**, unchanged). The SaaS control-plane is closed by being a **separate private repo**, not by a restrictive license. We do NOT adopt BSL/SSPL in v1 — premature; revisit only if a larger player clones the hosted offering.

## 4. Alternatives considered

- **Monorepo with a private `saas/` directory.** Rejected: licensing ambiguity and leak risk on a public repo; CI/secret handling gets fragile. Clean repo split is simpler.
- **Source-available license (BSL/SSPL) for the whole thing.** Rejected: harms adoption/contributions for a moat we don't need yet.
- **Everything OSS, including billing.** Rejected: no commercial moat; also drags payment/PII code into a public repo.
- **Model orgs in OSS, hide them in the UI.** Rejected: dead tenancy concept in engine storage is exactly the coupling we want to avoid; the SaaS layer owns orgs entirely.

## 5. Open questions / owner sign-off

| # | Question | Author recommendation |
|---|----------|----------------------|
| Q1 | Keep engine license MIT, or move to Apache-2.0 (adds an explicit patent grant) before going public? | MIT — lowest friction, already in place; Apache-2.0 is a marginal gain not worth the relicensing pass now. |
| Q2 | Do the three seam interfaces (§3.3) ship now, or only when the SaaS repo starts consuming them? | Ship the interface + OSS default for repositories and billing now (#61); ship the auth-provider interface as part of ADR-0007. Cheap, and it keeps the boundary honest from day one. |
| Q3 | Should `data/` SQLite for operators/sessions live in the same volume as engine file-stores, or a separate path? | Same `DATA_DIR` — one backup target, one volume; matches the single-container story. |

## 6. Consequences

- **#58** is this ADR; close it on sign-off.
- **#61** billing-provider interface + stub follows §3.3.
- **#59** quota enforcement reads entitlements through the billing-provider interface.
- README gains an "open-core boundary" note (#55) so contributors know what belongs in the private repo.
- Explicitly NOT shipping: any `org_id`, any payment integration, any SSO — all SaaS-repo concerns.

## 7. Changelog

| Date | Change | By |
|------|--------|----|
| 2026-06-08 | Initial draft — open-core boundary, three seams, MIT kept, no org in OSS | Claude + Codex/Kimi review |
