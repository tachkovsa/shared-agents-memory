# ADR-0007: Human (operator) authentication for the admin console

**Status:** Accepted
**Date:** 2026-06-08 (signed off 2026-06-08)
**Authors:** Claude (architect pass), Codex + Kimi review pass
**Related issues:** #54 (epic), #60 (impl), #56 (this ADR)
**Depends on:** ADR-0004 (PAT auth), ADR-0009 (open-core boundary)

---

## 1. Context

Agent PATs (ADR-0004) authenticate *machines*. The web admin console (ADR-0008) is operated by a *human*, which ADR-0004 §3.9 explicitly deferred ("WebAuthn / passkey-based admin bootstrap … External IdP federation … not v1"). This ADR defines v1 human auth: how an operator logs in, how a session is held and revoked, and how an operator's actions map onto the engine's authorization model.

The threat model extends ADR-0004 §1.1 with one new asset — the **operator session cookie** — and one hard rule: **an agent PAT must never grant console login, and an operator session must never be usable as an agent credential.** The two credential systems are deliberately disjoint.

## 2. Constraints already locked (do not re-litigate)

1. Agent PATs (ADR-0004) are unchanged; they are not console credentials.
2. Single-node self-host; one operator or a small handful (ADR-0009 §3.2 — implicit single workspace, no orgs).
3. Cookie-session model, **not** JWT — revocation must be instant, mirroring PAT revocation (ADR-0004 §4.3 reasoning: stateless tokens need a denylist anyway).
4. Operator state persists in SQLite, engine file-stores stay as-is (ADR-0008 §3.4).

## 3. Decisions

### 3.1 Operator account

SQLite table `operators`:

| Column | Notes |
|---|---|
| `id` | cuid2 |
| `username` | unique, case-folded |
| `password_hash` | argon2id |
| `totp_secret` | nullable; set when the operator enrols TOTP |
| `recovery_codes` | hashed (argon2id), single-use |
| `role` | `owner` \| `viewer` (read-only) — minimal RBAC; richer roles are SaaS |
| `is_disabled` | boolean |
| `created_at`, `last_login_at` | ISO-8601 |

Password hashing: **argon2id** (via `@node-rs/argon2` — prebuilt binaries, no node-gyp). TOTP: **`otpauth`** (zero-dep), optional per operator, enforced at login when a secret is set. Recovery codes for TOTP loss.

### 3.2 Sessions — server-side, opaque cookie

SQLite table `operator_sessions`: `id` (opaque 256-bit random), `operator_id`, `created_at`, `expires_at`, `csrf_token`, `ip`, `user_agent`.

- Cookie: `HttpOnly`, `Secure`, `SameSite=Strict`, holds only the opaque `id`.
- **Revocation = `DELETE` the row** → instant, no cache window. Same mental model as `pat.revoke`.
- Sliding expiry (default 7d idle) with an absolute cap (default 30d), both env-tunable.
- Logout deletes the row; "log out everywhere" deletes all rows for an `operator_id`.

### 3.3 CSRF

Cookie auth ⇒ CSRF defence required. Double-submit: `csrf_token` stored on the session, echoed in a non-cookie response, required as an `X-CSRF-Token` header on all mutating (`POST`/`PUT`/`DELETE`) admin requests. `SameSite=Strict` is the first line; the token is defence-in-depth.

### 3.4 First-operator bootstrap

On first boot with an empty `operators` table, the server prints a **one-time setup token** to stderr (mirrors the PAT bootstrap banner, ADR-0004 §3.4) and exposes a single-use `/api/admin/setup` endpoint that accepts that token and creates the first `owner`. Token is invalidated once an operator exists. No default credentials ever.

### 3.5 Operator → engine authorization

An operator session is **not** an `agent_identity`. When the admin API (ADR-0008) calls engine services on the operator's behalf:

- In OSS (single workspace) an `owner` operator has full authority over all namespaces; a `viewer` is read-only. Authorization is checked at the admin-API boundary, then services are called directly (not via a PAT).
- Audit lines (ADR-0004 §3.8) gain `actor_type: "operator" | "agent"` and, for operators, `operator_id`. Operator actions and agent actions are distinguishable in the log.
- This binding goes through the **auth-provider interface** (ADR-0009 §3.3) so the SaaS layer can substitute org-scoped resolution without touching engine code.

## 4. Alternatives considered

- **JWT / stateless tokens.** Rejected per constraint 3 — revocation needs a denylist anyway; server-side sessions give instant revoke for free and match the PAT model.
- **Reuse PATs for human login.** Rejected — different lifecycle, different threat surface; conflating them means a leaked console cookie could drive agent tools and vice-versa.
- **OIDC / SSO (Google, GitHub) in v1.** Deferred to the SaaS layer (ADR-0009). The auth-provider interface (§3.5) leaves the seam.
- **`@fastify/secure-session` (stateless encrypted cookie).** Tempting (no session table), but loses instant server-side revocation. Rejected for the same reason as JWT; we use `@fastify/cookie` + a SQLite-backed session store instead.

## 5. Open questions / owner sign-off

| # | Question | Author recommendation |
|---|----------|----------------------|
| Q1 | Is TOTP mandatory for `owner` in v1, or opt-in? | Opt-in in v1 (single operator, self-host); strongly recommended in docs. Mandatory TOTP is a SaaS-tier policy. |
| Q2 | argon2id (`@node-rs/argon2`, native, prebuilt) vs `scrypt` from `node:crypto` (zero new dep)? | argon2id — we already ship a native dep (`better-sqlite3`), and it's the current OWASP first choice. scrypt is the fallback if prebuilt binaries ever bite a self-hoster's platform. |
| Q3 | Session lifetime defaults (7d idle / 30d absolute)? | Accept as defaults, env-tunable. |
| Q4 | First-operator bootstrap: stderr setup-token + `/setup` page (§3.4) vs env-seeded `ADMIN_*` credentials? | Setup-token + page — consistent with the PAT bootstrap pattern operators already know; avoids long-lived creds in env. |

### 5.1 Owner sign-off (2026-06-08)

| # | Decision | Notes |
|---|----------|-------|
| Q1 | **TOTP opt-in** in v1 | Per recommendation. Strongly recommended in docs; mandatory MFA is a SaaS-tier policy. |
| Q2 | **argon2id** (`@node-rs/argon2`) | Per recommendation. The scrypt impl stays behind the `PasswordHasher` interface as a zero-dependency fallback. |
| Q3 | Session lifetimes 7d idle / 30d absolute, env-tunable | Per recommendation. |
| Q4 | Setup-token + `/setup` page bootstrap | Per recommendation. |

## 6. Consequences

- New SQLite store (`operators`, `operator_sessions`) — OSS impl behind a repository interface (ADR-0009 §3.3).
- **#60** implements this ADR (operator store, session store, login/logout, TOTP, bootstrap).
- Audit schema gains `actor_type` + `operator_id`.
- `.env.example` gains session-lifetime knobs; `.gitignore` covers the SQLite file.
- New deps: `@node-rs/argon2`, `otpauth`, `@fastify/cookie`.
- NOT shipping: SSO/OIDC, mandatory MFA, password-reset-by-email (no mailer in OSS) — recovery is via recovery codes + operator-table access.

## 7. Changelog

| Date | Change | By |
|------|--------|----|
| 2026-06-08 | Initial draft — cookie sessions, argon2id, optional TOTP, setup-token bootstrap | Claude + Codex/Kimi review |
