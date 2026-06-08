# ADR-0008: Admin console transport + stack (BFF, SPA, persistence)

**Status:** Accepted
**Date:** 2026-06-08 (signed off 2026-06-08)
**Authors:** Claude (architect pass), Codex + Kimi stack-review pass (Context7-checked: Fastify v5 ESM, shadcn/Tailwind v4, TanStack Query v5, Vite)
**Related issues:** #54 (epic), #62 (BFF scaffold), #63 (UI shell), #57 (this ADR)
**Depends on:** ADR-0003 (transports), ADR-0007 (human auth), ADR-0009 (open-core boundary)

---

## 1. Context

The engine speaks MCP (JSON-RPC) to agents over a hand-rolled `node:http` server (ADR-0003), which is tested (272 tests) and works. The admin console is a **browser** client — JSON-RPC is the wrong surface for it. We need: an HTTP/REST API for the UI, operator-session handling (ADR-0007), static SPA serving, and a clean seam for the future SaaS layer (ADR-0009). This ADR picks the framework, the persistence, the build/serve model, and the project layout.

Two AI advisors were consulted on the stack (Codex, Kimi); they agreed on everything except the framework (Kimi → Hono for edge-portability; Codex → Fastify for plugin maturity). The owner resolved it (§5.1).

## 2. Constraints already locked (do not re-litigate)

1. The existing MCP `node:http` transport (ADR-0003) is **not refactored** — it stays a separate, tested listener. The admin server is additive.
2. Engine domain logic (memory/namespaces/rules/PAT) is reused, not reimplemented — routes call the same services the MCP tools call.
3. ESM + TypeScript, Node ≥ 20. Single-container, low-ops self-host.
4. No `org_id`; OSS is an implicit single workspace (ADR-0009 §3.2).
5. Frontend is React + shadcn/ui + Tailwind v4 + Phosphor (owner-fixed).

## 3. Decisions

### 3.1 Backend framework — Fastify v5

The admin API is a **Fastify v5** app (native ESM; `type: module` already set). Official plugins cover our exact needs: `@fastify/cookie` (sessions, ADR-0007), `@fastify/static` (serve the built SPA), `@fastify/rate-limit` (#59 abuse protection). Routes stay **thin**: validate input (zod) → call a domain service → serialize. No business logic in handlers.

### 3.2 Process & routing model — separate listener, proxy unifies paths

The admin Fastify app and the MCP `node:http` server run as **two listeners in one process / one container**, on two ports (e.g. MCP `:8080`, admin `:8081`). The reverse proxy (nginx/Caddy, already in `deploy/`) routes `/mcp` → MCP and `/`, `/api/admin` → admin. Rationale: keeps the tested MCP path untouched (no god-server cramming both surfaces through one dispatcher), gives ops independent bind/expose control (e.g. admin on a VPN interface), and is a smaller, reversible change. A single front dispatcher was considered and rejected (§4).

### 3.3 Shared domain services

Engine logic that both MCP tools and admin routes need is consumed through framework-neutral services (the existing `src/{memory,namespaces,rules,auth}` modules; extracted further only where an MCP tool currently inlines logic). Admin routes import these directly. This is the reuse boundary that prevents divergence between "what an agent can do" and "what the console shows".

### 3.4 Persistence — SQLite for operator concerns only

Operator accounts, sessions, and TOTP secrets live in **SQLite (`better-sqlite3`)** in `DATA_DIR` (ADR-0007 §3.1–3.2). Engine file-stores (PATs `pats.jsonl`, namespaces, rules, audit JSONL) are **unchanged** — SQLite is "just another file" in the data volume, used only where ACID + indexing genuinely help (login attempts, session revocation). Access goes through **repository interfaces** (ADR-0009 §3.3); the SaaS layer swaps the SQLite impl for Postgres without touching routes.

### 3.5 Frontend stack

React 19 + **Vite** + Tailwind v4 (`@tailwindcss/vite`) + **shadcn/ui** + **@phosphor-icons/react** + **TanStack Query v5** (all server state: CRUD invalidation, audit pagination, search results, metrics polling) + **React Router v7** + **React Hook Form** + zod. No Redux/Zustand — component state + URL search params carry filters/selection. Validation schemas live in `src/admin/shared` and are imported by **both** the SPA and the Fastify routes (single source of truth).

### 3.6 Build & serve

The SPA (`src/admin/web`) builds with Vite to `dist/admin-public`; Fastify serves it via `@fastify/static` with SPA fallback. Dev: `vite` dev server with a proxy to the Fastify API (hot reload). Prod: one Node process serves API + static assets. New scripts: `build:web` (vite build), `dev:web` (vite), and `build` becomes `tsc && vite build`. The Dockerfile builder stage runs both.

### 3.7 Project layout

```
src/
  admin/
    api/        # Fastify app + thin routes (auth, pats, namespaces, rules, memory, audit, metrics)
    auth/       # operator auth: password (argon2id), TOTP, session service, auth-provider iface
    stores/     # SQLite connection + OperatorStore/SessionStore behind repository ifaces
    web/        # Vite + React SPA (shadcn, Phosphor, TanStack Query)
    shared/     # zod schemas + types shared between api and web
  memory/ namespaces/ rules/ auth/ ...   # existing engine — reused, not moved
```

## 4. Alternatives considered

- **Hono (Kimi's pick).** Lighter, ESM-native, edge-portable. Rejected as default: our near-term needs (sessions, rate-limit, static, CSRF) map to mature *official* Fastify plugins, whereas Hono assembles them from smaller parts; the edge-portability win is speculative for a SaaS control-plane that will be server-side (Postgres + payment SDKs) anyway. **Revisit trigger:** if the SaaS layer commits to an edge runtime, the thin routes port to Hono with low cost.
- **Fastify as the single shell for MCP too.** Rejected: refactors the working, tested `node:http` transport onto Fastify for no functional gain — pure risk against ADR-0003.
- **Single front dispatcher on one port.** Rejected (for now): adds a hand-rolled router in front of two stacks; the reverse proxy already does this better. Cheap to add later if a one-port deploy is wanted.
- **NestJS.** Too much structure for a small admin; against the file-shaped, low-dep ethos.
- **Stay file-based for operators.** Rejected — password/session/TOTP want ACID and indexed lookups; awkward and race-prone in JSONL.
- **libsql/Turso or Postgres in OSS.** Premature; Postgres is the SaaS impl behind the repository interface.

## 5. Open questions / owner sign-off

| # | Question | Author recommendation |
|---|----------|----------------------|
| Q1 | Framework: Fastify or Hono? | Fastify. |
| Q2 | Two listeners + reverse-proxy routing (§3.2), or one port via a front dispatcher? | Two listeners + proxy — least risk to the MCP path, most ops flexibility. |
| Q3 | SPA served by Fastify (`@fastify/static`) vs shipped as separate static behind the proxy? | Fastify-served — one artifact, one container, simplest self-host. |
| Q4 | `build` runs `tsc && vite build` (§3.6) — acceptable to couple server + web builds? | Yes; keep `build:server`/`build:web` split available for CI granularity. |

### 5.1 Owner sign-off (2026-06-08)

| # | Decision | Notes |
|---|----------|-------|
| Q1 | **Fastify** | Owner: "Fastify на слуху, стоит брать именно его." Hono documented as the runner-up with a revisit trigger (§4). |
| Q2 | **Two listeners + reverse-proxy** | Owner picked the more future-proof option: admin (control plane) stays separable from MCP (data plane) — can later split into its own process/service or bind to a private interface, without touching the tested MCP path. An optional single-port mode may be added later for proxy-less self-hosts. |
| Q3 | SPA served by Fastify (`@fastify/static`) | Author recommendation accepted as default. |
| Q4 | `build` = `tsc && vite build`, with `build:server`/`build:web` split | Author recommendation accepted as default. |

## 6. Consequences

- New deps: `fastify`, `@fastify/cookie`, `@fastify/static`, `@fastify/rate-limit`, `better-sqlite3`; dev: `vite`, `@vitejs/plugin-react`, `react`, `react-dom`, `@tanstack/react-query`, `react-router`, `react-hook-form`, `tailwindcss`, `@tailwindcss/vite`, `@phosphor-icons/react`, shadcn deps (`class-variance-authority`, `clsx`, `tailwind-merge`). (Operator-auth deps in ADR-0007 §6.)
- **#62** scaffolds the Fastify app + layout; **#63** the UI shell + login.
- `package.json` scripts + `Dockerfile` builder stage updated (§3.6).
- `deploy/` proxy configs gain an admin upstream + `/api/admin` route.
- NOT shipping: a one-port dispatcher (Q2), SSR (SPA only), any non-React UI.

## 7. Changelog

| Date | Change | By |
|------|--------|----|
| 2026-06-08 | Initial draft — Fastify + SQLite + Vite SPA, separate-listener model, layout. Owner signed off Q1 (Fastify). | Claude + Codex/Kimi review |
