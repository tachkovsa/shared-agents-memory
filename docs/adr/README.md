# Architecture Decision Records — shared-agents-memory

This directory holds the architectural decisions for the shared agent memory MCP service.

## What is an ADR

An Architecture Decision Record (ADR) captures a single significant architectural decision: the context, the choice made, the alternatives considered and rejected, and the consequences. ADRs are append-only — when a decision changes, a NEW ADR supersedes the old one (the old one stays for history with `Status: Superseded by ADR-NNNN`).

## ADR index

| # | Title | Status |
|---|-------|--------|
| [0001](0001-hybrid-memory-architecture.md) | Hybrid memory architecture: file rules + vector episodic | Accepted |
| [0002](0002-namespace-tenancy-model.md) | Namespace as tenancy boundary | Accepted |
| [0003](0003-transport-stdio-and-http.md) | Transport: stdio for local, streamable HTTP for shared | Accepted |
| [0004](0004-auth-pat-v1.md) | Auth: PAT in v1, OAuth/DCR deferred | Accepted |
| [0005](0005-embeddings-strategy.md) | Embeddings: OpenRouter primary, no local fallback in v1 | Accepted |
| [0006](0006-memory-lifecycle.md) | Memory lifecycle: dedup, reinforcement, per-namespace decay | Accepted |

## Status values

- **Proposed** — written, not yet accepted; open for discussion.
- **Accepted** — owner signed off; implementation can start.
- **Implemented** — code has shipped and matches the ADR. (Optional intermediate state.)
- **Superseded by ADR-NNNN** — a later ADR replaces this decision; keep for history.
- **Rejected** — decided against; keep for history of "why we did not do X".

## When to write an ADR

Before implementing any change that:
- Adds or removes a top-level component (new transport, new external dependency, new storage layer).
- Changes a public protocol or data shape (MCP tool surface, vector dimension, payload schema).
- Changes the trust boundary (auth model, scope set, multi-tenancy contract).
- Locks in an operational invariant (deployment topology, backup contract, rate-limit policy).

If the change is "implement what an existing ADR already decided" — no new ADR; just point to the ADR in the PR description.

## ADR template

See [`_template.md`](_template.md) (created with ADR-0001).

## Conventions

- Filename: `NNNN-kebab-case-title.md`, where NNNN is the next free number padded to 4 digits.
- Numbering is global and monotonic; do not skip numbers, do not reuse numbers.
- Status, Date, Authors at the top.
- Section §1 Context, §2 Constraints, §3 Decisions, §4 Alternatives considered, §5 Open questions / owner sign-off, §6 Consequences.
- Keep ADRs tight — 200–500 lines is the target. If an ADR grows past 600 lines, split it.
