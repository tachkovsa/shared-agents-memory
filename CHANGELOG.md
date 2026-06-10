# Changelog

All notable changes are documented here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/). Releases are cut from
semantic-version git tags (`vX.Y.Z`); pushing a tag builds the versioned image
and a GitHub Release via `.github/workflows/release.yml`.

## [Unreleased]

### Added

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
