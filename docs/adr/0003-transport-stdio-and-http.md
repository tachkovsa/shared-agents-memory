# ADR-0003: Transport — stdio for local dev, streamable HTTP for shared

**Status:** Proposed
**Date:** 2026-05-27
**Authors:** Claude (architect pass), Codex review pass (this ADR is a Codex catch — scaffold is stdio, but auth is HTTP)
**Related issues:** #2 (amend), #6 (amend), #8 (amend)
**Depends on:** ADR-0002 (defines what "shared" means — multi-namespace, authenticated)
**Spec reference:** Model Context Protocol revision **2025-06-18** §3.2 Transports — `stdio`, `Streamable HTTP`.

---

## 1. Context

The scaffold (`src/index.ts:23`) uses `StdioServerTransport`. This was the right starting point — the simplest possible MCP transport, no HTTP server, no auth, runs in `stdin/stdout`. It works for "I am hacking on this locally with one agent."

It does NOT work for the project's stated goal: a service multiple agents connect to over a network, with per-request authentication. stdio is fundamentally a single-client subprocess transport — the agent client launches the server as a child process, talks over its stdin/stdout, and the credential model is "you have permission to fork this process, therefore you have access."

The 13 founding issues mix the two transports implicitly:
- Issue #2 (Docker Compose) implies a long-running server.
- Issue #6 (MCP tool surface) says "Choose MVP transport and document support for local `stdio` versus deployed Streamable HTTP."
- Issue #7 (Auth) specifies "bearer-token authentication for HTTP MCP transport" with "environment-based credential loading for local stdio mode if stdio is supported."
- Issue #8 (Ubuntu VDS) requires "TLS reverse proxy" — only meaningful for HTTP.

Codex's review caught this gap explicitly: *"bearer auth and WWW-Authenticate metadata are HTTP concerns, so ADRs must say when remote MCP transport arrives and how stdio is secured."* This ADR resolves it.

### 1.1 What MCP says

MCP 2025-06-18 §3.2 sanctions two transports:

- **`stdio`** — server runs as a child process of the client. Transport is line-delimited JSON-RPC over stdin/stdout. No transport-level authentication; trust is "I forked you."
- **`Streamable HTTP`** — server is an HTTP endpoint. Single endpoint accepts JSON-RPC over POST; server may upgrade the response to `text/event-stream` for server-initiated events. Session correlation via `Mcp-Session-Id` header. **This is the transport for remote / multi-client deployments.** Authorization layered on top per MCP §6.

A third option, plain **SSE** (server-sent events) at the protocol layer, was **deprecated** in MCP revision 2025-03-26 §6 and superseded by Streamable HTTP in 2025-06-18. New servers do not implement plain SSE. **WebSockets are not sanctioned.**

### 1.2 Why this is worth an ADR and not just a code change

Choosing stdio vs HTTP is not a wire-format choice — it cascades into:

- Authentication model (env var vs Bearer; ADR-0004).
- Deployment topology (subprocess per client vs central server; issue #8).
- Concurrency model (one client per stdio process vs many sessions on one HTTP server).
- Security boundary (process trust vs token trust + TLS).
- Operational tooling (each client launches its own MCP server vs one shared MCP server is operated).

Picking one without thinking through the cascade leads to "we have a server but it's stdio, so we also need a sidecar HTTP-to-stdio bridge" — the worst of both worlds.

---

## 2. Constraints already locked (do not re-litigate)

1. **Single Ubuntu VDS deployment** (issue #8). The shared MCP server is one process, behind a TLS reverse proxy.
2. **Authenticated multi-agent** (ADR-0002). Multiple agent identities connect concurrently; each is authorized at the request boundary.
3. **MCP protocol revision 2025-06-18.** We do not implement legacy SSE; we do not invent transports.
4. **No CORS for the MCP endpoint.** Browser-resident MCP clients are out of scope (security cost > use case in v1).

---

## 3. Decisions

### 3.1 Two transports, two deployment modes, one server codebase

**Mode A — Local stdio (development + single-user, single-host scenarios).**

- The MCP server binary spawns as a child process of one agent client.
- Transport: `StdioServerTransport` (scaffold default).
- Credentials: a single env var `LOCAL_STDIO_AGENT_PAT` resolves the calling client to a single agent identity. The agent identity must already exist in `data/namespaces/<ns>/_members.json` (ADR-0002).
- No HTTP server is started.
- Use cases:
  - Developing rules and episodic memories on your own laptop without setting up a remote server.
  - Running shared-agents-memory inside an agent runner that prefers subprocess MCP (some shells).
  - Smoke-testing the protocol surface during development.

**Mode B — Shared streamable HTTP (production + multi-agent + remote).**

- The MCP server runs as a long-lived process (`docker compose up`) behind nginx/Caddy with TLS termination (issue #8).
- Transport: `StreamableHttpServerTransport` at `POST /mcp` for client requests; `GET /mcp` opens the server-side event stream for asynchronous deliveries.
- Credentials: Bearer PAT in the `Authorization` header on every request (ADR-0004).
- Use cases: every connection from a remote agent — Claude Code on a laptop, Codex CLI on a CI runner, a team member's Cursor instance.

**One codebase.** `src/index.ts` reads `TRANSPORT=stdio|http` (default `stdio` for backward compat with the scaffold) and wires the matching transport. The tool/resource registration is identical across both. The auth resolver (ADR-0004) is the only branching point: stdio resolves once at startup; HTTP resolves per request.

### 3.2 stdio mode rules

- **Single agent identity per process.** The env var binds the entire process to one agent. A stdio server cannot serve multiple identities; if you want that, use HTTP.
- **No CORS, no Origin check, no rate-limit middleware.** stdio is intra-process; the parent is the boundary.
- **Namespace authorization still applies.** Even though only one agent is connected, the agent's `_members.json` membership still gates which namespaces are reachable. stdio mode does NOT bypass ADR-0002.
- **No persistent session row.** Session is the lifetime of the process.
- **Diagnostics.** stdio mode logs structured JSON to **stderr** (stdout is reserved for the MCP protocol). The scaffold currently logs to `console.error` already — keep.

### 3.3 HTTP mode rules

- **Bind to `127.0.0.1`, not `0.0.0.0`.** The TLS reverse proxy (nginx/Caddy) connects over loopback; the MCP server itself never speaks to the internet directly. Closes the "MCP server accidentally exposed on a public port" failure mode.
- **`Origin` header validation.** Per MCP 2025-06-18 §3.2 Streamable HTTP transport security notes, requests with an `Origin` header that does not match the deployed origin are rejected. Cheap defence against DNS rebinding for any future loopback clients.
- **No CORS preflight.** Same-origin only. Browser MCP clients out of scope (§2).
- **Session correlation.** Server issues `Mcp-Session-Id` at MCP `initialize`. Subsequent requests carry it. Session expires after **15 minutes idle** (env-tunable `MCP_HTTP_SESSION_IDLE_MIN`, default 15, min 5, max 60); a stale session returns `MCP_SESSION_EXPIRED` and forces re-handshake.
- **Connection limits.** v1 accepts at most **64 concurrent sessions** and **8 concurrent in-flight tool calls per session**. Beyond either: HTTP 429 with `Retry-After`. Tuned for single Ubuntu VDS at small-team scale.
- **Audit on every request boundary.** Tool calls, resource reads, and auth failures all emit audit lines per ADR-0004 § audit.
- **Idle SSE behaviour.** The `GET /mcp` server-event stream sends a `:ping` keepalive comment every 30 s to defeat proxy idle timeouts. No correctness contract depends on its arrival order.

### 3.4 Deployment shapes (cross-reference issue #8)

**stdio + Docker Compose (NOT recommended for production):** The scaffold's `docker compose up` runs the server with `TRANSPORT=stdio`, which means Docker can't forward MCP traffic to it — there's no port. This combination only makes sense as "I want Qdrant in Docker but the MCP server outside Docker." Document but do not bless.

**HTTP + Docker Compose (production path):**

```
                 +--------------------+
   internet -->  | nginx (TLS, :443)  |
                 +---------+----------+
                           | http :8080 (loopback)
                           v
                 +--------------------+
                 | shared-agents-     |
                 | memory             |  -- mounts data/, embeddings/cache
                 |   TRANSPORT=http   |
                 +---------+----------+
                           | http :6333 (docker network)
                           v
                 +--------------------+
                 |       Qdrant       |  -- mounts qdrant/storage
                 +--------------------+
```

- nginx (or Caddy) terminates TLS, forwards loopback to `:8080`.
- The MCP server container exposes only port 8080 on the loopback network.
- Qdrant binds to the Docker internal network only — never to a host port.
- Volumes are bind-mounts under `/var/lib/shared-agents-memory/` on the host for easy backup (issue #10).

### 3.5 Configuration

```
# Mode A — stdio (default, scaffold-compatible)
TRANSPORT=stdio
LOCAL_STDIO_AGENT_PAT=hcm_pat_...   # the single PAT this stdio process binds to (ADR-0004)

# Mode B — HTTP
TRANSPORT=http
HTTP_BIND_HOST=127.0.0.1            # default; set to 0.0.0.0 only if you know what you're doing
HTTP_BIND_PORT=8080                 # default
HTTP_PUBLIC_ORIGIN=https://memory.example.com   # required when TRANSPORT=http; used for Origin check
MCP_HTTP_SESSION_IDLE_MIN=15        # default 15, min 5, max 60
MCP_HTTP_MAX_SESSIONS=64            # default 64
MCP_HTTP_MAX_INFLIGHT_PER_SESSION=8 # default 8
```

`HTTP_BIND_HOST=0.0.0.0` without a reverse proxy is flagged in startup logs with a `WARNING: binding to 0.0.0.0 without HTTP_PUBLIC_ORIGIN matches it intentionally?`. The service does not refuse to start — but it makes noise. (Codex review: "fail loud, not silent.")

### 3.6 Spec version negotiation

At MCP `initialize`, the client proposes a `protocolVersion`. v1 supports **exactly `"2025-06-18"`**. If the client proposes an older revision (`"2025-03-26"`), the server responds with `"2025-06-18"` per the MCP negotiation rule. Clients unable to speak that revision fail handshake — that is the correct behaviour.

The HCM.guru ADR-0162 § 3.10.4 set this precedent verbatim; we adopt it.

---

## 4. Alternatives considered

### 4.1 stdio-only for v1

**What.** Defer HTTP entirely. Every agent runs the server as a subprocess locally.
**Why tempting.** Simplest auth model (env var). No TLS / nginx / reverse proxy. Matches the scaffold.
**Why rejected.** Defeats the project premise. "Shared agent memory" means agents on different machines connect to the same store. stdio cannot do that — every stdio server is a fresh, isolated subprocess with its own filesystem view and Qdrant connection. Two laptops cannot share state via stdio.

A degraded version of this — "stdio per laptop, but all of them point at the same Qdrant" — recovers the shared store, but each laptop ends up running its own MCP service, doing its own auth, with no central audit. That is not the design.

### 4.2 HTTP-only for v1, drop stdio from the scaffold

**What.** Rip out `StdioServerTransport`; require Docker even for development.
**Why tempting.** One transport, one auth model, one set of integration tests.
**Why rejected.** stdio is genuinely useful for development and for agent shells that prefer subprocess MCP (some integrations of Claude Desktop, some Cursor workflows). Keeping it as Mode A costs ~50 LOC; ripping it out costs developer-onboarding friction.

### 4.3 Plain SSE as the HTTP transport

**What.** Use the older MCP SSE transport instead of Streamable HTTP.
**Why tempting.** Some older clients only speak SSE.
**Why rejected.** Plain SSE was deprecated in MCP 2025-03-26 § 6 and superseded in 2025-06-18. We ship to the current spec; older clients lag.

### 4.4 WebSockets

**What.** Use WebSockets for bidirectional MCP.
**Why tempting.** Cleaner abstraction than POST + SSE.
**Why rejected.** Not a sanctioned MCP transport. We speak the spec.

### 4.5 Long-poll fallback for clients with broken SSE

**What.** If a client cannot keep an SSE connection open (corporate proxies), fall back to long-polling.
**Why tempting.** Maximises client compatibility.
**Why rejected.** Adds a second async delivery path with its own bug surface. The MCP spec already requires clients to handle both Streamable HTTP and the lack-of-streaming case (the server may simply reply with a complete JSON-RPC body and never upgrade to SSE). Clients behind hostile proxies degrade to "no asynchronous notifications this session" — acceptable.

---

## 5. Open questions / owner sign-off

| # | Question | Author recommendation |
|---|----------|----------------------|
| Q1 | `MCP_HTTP_MAX_SESSIONS=64` default — is this enough for the personal-→-small-team trajectory, or should it be 128? | 64. Each session is cheap; concurrent humans + agents at the personal-and-friends scale will not exceed this. Bump in v1.1 once we have telemetry. |
| Q2 | When `TRANSPORT=stdio`, do we still write audit log lines to disk (`data/namespaces/<ns>/audit/*.jsonl`), or only structured stderr? | Both. stdio mode is a real production-shaped invocation when used inside agent shells; losing audit lines because "it's local" violates the auditability invariant. |
| Q3 | Should the keepalive `:ping` interval (§3.3) be env-tunable? | No — hardcode 30 s. Tunable knobs without a use case become operational footguns. |
| Q4 | Do we support running the server with `TRANSPORT=http` outside Docker (bare-metal `node dist/index.js` behind nginx)? | Yes — Docker is the recommended path (issue #8), but the binary itself has no Docker dependency. Document both. |

---

## 6. Consequences

### 6.1 New issues to file

- **#22 Streamable HTTP transport wiring.** Replace/augment `StdioServerTransport` in `src/index.ts` with a transport selector based on `TRANSPORT`. Implement the HTTP server (Node's built-in `http.createServer` or a thin Express wrapper — caller's choice).
- **#23 Origin + binding validation.** Implement the `Origin` check, the loopback-bind default, and the "binding to 0.0.0.0 without explicit consent" startup warning.

### 6.2 Existing issues to amend

- **#2 Docker Compose runtime.** Specify that the MCP service container runs with `TRANSPORT=http`. Add nginx/Caddy sidecar to the production override (or document the user's choice). Document Qdrant binding to internal network only.
- **#6 MCP tool surface.** This ADR resolves the deferred decision "Choose MVP transport and document support for local `stdio` versus deployed Streamable HTTP" — both transports, gated by `TRANSPORT` env. Cross-link this ADR.
- **#7 Agent auth/authz.** The PAT-in-env (stdio) vs PAT-in-Authorization (HTTP) split is decided here; ADR-0004 implements both.
- **#8 Ubuntu VDS deploy with TLS.** Specify nginx/Caddy on host; MCP server on loopback; Qdrant on docker network. The runbook ships `nginx.conf` / `Caddyfile` snippets.
- **#9 Observability.** Add transport-level metrics: `mem_http_sessions_active` gauge, `mem_http_requests_total{outcome}` counter, `mem_http_session_duration_seconds` histogram, `mem_stdio_messages_total{direction}` counter.

### 6.3 Code impact (scaffold)

- `src/index.ts` — split into transport selector. Move stdio wiring into `src/transport/stdio.ts`; add `src/transport/http.ts`.
- `src/transport/http.ts` (new) — HTTP server, session table, `Mcp-Session-Id` header handling, `Origin` validation, keepalive ping.
- `src/auth/` (new in ADR-0002) — gains a stdio mode (resolve at boot from env) and an HTTP mode (resolve per request from `Authorization`).
- `package.json` — `@modelcontextprotocol/sdk` ships both `StdioServerTransport` and `StreamableHTTPServerTransport`; no new dependency.

### 6.4 What we are explicitly NOT shipping in v1

- WebSockets, plain SSE, long-poll fallback (§4.3, §4.4, §4.5).
- CORS support for browser clients.
- Multi-tenant per-host (one HTTP server serving multiple `HTTP_PUBLIC_ORIGIN` values via Host header).
- Load-balanced multi-instance deployment (sticky-session routing).

---

## 7. Changelog

| Date | Change | By |
|------|--------|----|
| 2026-05-27 | Initial draft — created in response to Codex review (scaffold ships stdio but auth/Bearer is HTTP) | Claude (architect) + Codex review |
