# Changelog

All notable changes are documented here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/). Releases are cut from
semantic-version git tags (`vX.Y.Z`); pushing a tag builds the versioned image
and a GitHub Release via `.github/workflows/release.yml`.

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
