# Changelog

All notable changes are documented here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/). Releases are cut from
semantic-version git tags (`vX.Y.Z`); pushing a tag builds the versioned image
and a GitHub Release via `.github/workflows/release.yml`.

## [Unreleased]

### Added

- **Single-domain deploy layout for the console** (`/console` subpath). The
  operator SPA now builds with `base=/console/` (override via `CONSOLE_BASE`) and
  the router picks up the basename from `import.meta.env.BASE_URL`, so it can be
  served alongside a marketing landing on one apex domain. New
  `deploy/nginx-artelmemory.conf`: `/` → landing (static), `/mcp`+`/healthz` →
  MCP (:8080), `/console` (prefix-stripped) + `/api/admin` → console (:8081).
  The admin listener stays root-relative; the reverse proxy strips `/console`.

## [0.3.0] — 2026-06-15

### Added

- **ArtelMemory operator console + landing page** (ADR-0008/0009). The admin
  console is now a complete operator UI (React 19 + Router + TanStack Query +
  Tailwind), rebranded to the **ArtelMemory** visual identity (technical
  identifiers — package name, `sam_*` tokens, `sam_admin_session` cookie — are
  unchanged). Screens: Overview · Namespaces (create/share/unshare) · Memory
  (semantic search, write, delete, infinite scroll) · PAT (create/reveal-once/
  revoke/rotate/delete) · Rules (read + author) · Audit · Observability ·
  Billing (demo) · Login/Setup. Plus a static marketing landing (`landing/`).

- **Admin BFF mutation endpoints** (ADR-0008). Backing the console's write
  actions: namespace create + member share/unshare, memory write + search, PAT
  rotate + delete, rule create, billing read. CSRF is enforced for all non-GET
  requests inside `requireAuth`; namespace ids are traversal-guarded. PAT
  lifecycle ops (mint/rotate/revoke/delete) are serialized on a write mutex.

- **Local embeddings deploy bundle — TEI + bge-m3** (ADR-0010 §3.4). New
  `docker-compose.embedder.yml` overlay adds a Hugging Face text-embeddings-inference
  (TEI) sidecar serving `BAAI/bge-m3` (1024-dim) over the OpenAI-compatible
  `/v1/embeddings` route on the internal docker network — self-hosted embeddings,
  no external dependency, data residency. Opt-in: apply on top of
  `docker-compose.yml` + `docker-compose.prod.yml`; the cloud (OpenRouter)
  deployment is unaffected. `.env.example` now presents two pre-matched
  model/dimension profiles (self-host bge-m3/1024, cloud qwen3/4096) to prevent
  the dimension-mismatch footgun. See `docs/ops/vds-deploy.md`.

- **Re-embed migration CLI** (`scripts/reembed-collection.ts`). Regenerates
  vectors from the original `content` text when switching embedding models (e.g.
  cloud qwen3 4096-dim → self-host bge-m3 1024-dim), where vectors cannot be
  copied directly. Scrolls a source Qdrant collection, re-embeds via the
  configured provider, and upserts each point (same id + payload, new vector)
  into the target. Idempotent; `--dry-run`, `--skip-deleted`, `--batch` flags.

- **Admin BFF read API — namespaces** (ADR-0008/0009). Operator-authenticated
  read endpoints the console will consume: `GET /api/admin/namespaces` (list) and
  `GET /api/admin/namespaces/:id` (detail + members). Behind the session +
  CSRF auth guard; an operator is an instance admin (no org scoping — that's the
  private SaaS layer). First slice of the console BFF; PAT/memory/audit views follow.

- **Configurable embedding dimension + Qdrant int8 quantization** (ADR-0010). New
  `EMBEDDINGS_DIMENSION` (default **1024**, was a hardcoded 4096) lets a deployment
  match its embedding model — the self-host CIS profile runs bge-m3 (1024-dim) over
  the existing OpenAI-compatible path. The Qdrant collection is now created with
  **int8 scalar quantization** (quantized vectors resident, originals + payload
  on disk) and searches use rescoring + oversampling — ~4× more vectors per box,
  near-lossless. Knobs: `QDRANT_QUANTIZATION` (`int8`|`none`), `QDRANT_RESCORE`,
  `QDRANT_OVERSAMPLING`. `initCollection` validates an existing collection against
  the configured dimension and fails loud on mismatch.

- **Memory lifecycle: semantic dedup on write + reinforcement counter** (ADR-0006
  §3.2–3.3, #26). `memory.store` now matches new content against the top-1 in the
  namespace and either reinforces (cosine > 0.99), merges near-duplicates
  (threshold < cosine ≤ 0.99; unions tags, appends `metadata.dedup_history`,
  capped at 5), or inserts. The response gains `outcome`
  (`inserted` | `reinforced` | `merged`) and `matched_existing_id`. A
  caller-supplied `id` bypasses dedup. `memory.get` / `memory.search` hits bump a
  best-effort `retrieval_count` + `last_retrieved_at`, batched and flushed every
  60 s. New per-namespace `dedup_threshold` (default 0.95, range [0.85, 0.99], 1.0
  disables) tunable via `namespace.update`.

## [0.2.0] — 2026-06-08

### Added

- **Operator admin console** (opt-in via `ADMIN_ENABLED`, off by default) — a web
  UI + BFF for managing the service, on a separate Fastify listener. The MCP
  transport path is unchanged.
  - Human operator auth: cookie sessions (SQLite-backed, instant revoke),
    `argon2id` passwords, optional TOTP, and a one-time **setup token** gating
    first-operator creation.
  - React + shadcn/ui + Tailwind v4 + Phosphor SPA (login / setup / shell),
    built with Vite and served by `@fastify/static`.
- ADRs 0007 (operator auth), 0008 (admin transport + stack), 0009 (open-core
  boundary) — accepted.
- `release` workflow: version-tag-driven image build + GitHub Release, with a
  guard that the tag matches `package.json`.

### Changed

- Docker base image moved to `node:20-bookworm-slim` (glibc) so the admin's
  native modules (`better-sqlite3`, `@node-rs/argon2`) install from prebuilt
  binaries.

## [0.1.0]

- Initial MCP service: hybrid memory (file rules + Qdrant episodic), namespaces,
  PAT auth, stdio + streamable HTTP transports, OpenRouter embeddings,
  observability, and the Ubuntu VDS deploy pipeline.
