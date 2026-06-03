# shared-agents-memory

MCP service that gives multiple AI agents (Claude Code, Codex CLI, Cursor, …) a **shared knowledge store** — both deterministic rules (always-load, like "never push to main") and episodic memories (semantic search via embeddings, like "Anna prefers cold brew").

Two transports: **stdio** for local dev (single-agent subprocess), **streamable HTTP** for production (multi-agent, Bearer-auth). Backed by Qdrant for vectors and the local filesystem for rules.

---

## Architecture at a glance

```
┌────────────────┐   Bearer PAT     ┌─────────────────────┐
│  agent client  │ ───────────────► │   shared-agents-    │ ─► Qdrant (vectors,
│  (Claude Code, │  POST /mcp       │   memory MCP        │    episodic memory)
│   Cursor, …)   │  GET  /mcp (SSE) │                     │
└────────────────┘                  │   /healthz /metrics │ ─► data/ (rules,
                                    └─────────────────────┘    PATs, audit)
```

- **Namespaces** are the tenancy boundary (ADR-0002). Bootstrap creates `personal`; you can add more (`work`, `team-foo`, …).
- **PATs** (`sam_pat_*`) are per-agent credentials, scoped to specific namespaces + specific operations (ADR-0004).
- **Tools** follow `noun_verb` naming: `memory_store`, `pat_create`, `namespace_add_member`, `rules_upsert`, etc. (underscore separator — OpenAI/Codex function-tool names disallow dots; ADR-0001 §3.4).

For the why behind each choice see [`docs/adr/`](docs/adr/).

---

## Quick start — connect an MCP client

### Endpoint shape

| Mode | URL |
|---|---|
| Pre-domain bring-up | `http://<vds-host>:8080/mcp` — loopback-only on the host; reach via SSH tunnel or from-server `curl` |
| Production (DNS + certbot) | `https://<your-domain>/mcp` |

The operator keeps the actual host out of the repo. For the running deployment, see your internal infra docs / password manager.

### 1. Get a PAT for your agent

If you're the operator and just bootstrapped: the **bootstrap PAT** was printed once at first server start. That's your **admin** token — keep it in a password manager. It's `service:admin` scope and should NOT be wired into a daily-driver agent.

Mint a separate PAT for each agent — see [Managing access (PATs)](#managing-access-pats) below.

### 2. Wire the PAT into your client

The MCP protocol is the same across clients; only the config file differs.

**Claude Code** (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "shared-memory": {
      "url": "https://memory.example.com/mcp",
      "headers": {
        "Authorization": "Bearer sam_pat_XXXXXXXXXXXXXXXXXXXXXXXXXXX"
      }
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "shared-memory": {
      "url": "https://memory.example.com/mcp",
      "headers": {
        "Authorization": "Bearer sam_pat_XXXXXXXXXXXXXXXXXXXXXXXXXXX"
      }
    }
  }
}
```

**Codex CLI** — set in the config file your CLI uses; the protocol is identical.

For local-dev (stdio mode), set `LOCAL_STDIO_AGENT_PAT=sam_pat_…` and run `npm run dev`. See [`docs/runtime.md`](docs/runtime.md).

### 3. Verify

Once the client is wired, ask the agent to list available tools — you should see ~19 of them, grouped `memory_*`, `pat_*`, `namespace_*`, `rules_*`. From there you can ask the agent to `memory_store`, `memory_search`, etc.

---

## Managing access (PATs)

A PAT is a Bearer credential with a fixed scope set and a fixed list of namespaces. Format: `sam_pat_<27 base32 chars>`. PATs are file-backed (`data/_auth/pats.jsonl`), hashed with a per-server pepper (ADR-0004 §3.2).

### Bootstrap PAT (one-time)

On a fresh install, the server prints the bootstrap PAT to stderr exactly once:

```
docker logs sam-mcp 2>&1 | grep -A2 "BOOTSTRAP TOKEN"
```

It has `service:admin` scope and access to the `personal` namespace. **Save it to a password manager** — it's not retrievable later. After saving, delete the disk mirror:

```bash
ssh root@<vds> 'rm -f /var/lib/shared-agents-memory/data/_auth/.bootstrap_token'
```

### Available scopes (ADR-0004 §3.4)

| Scope | What it lets the PAT do |
|---|---|
| `memory:read` | `memory_search`, `memory_get` |
| `memory:write` | `memory_store`, `memory_update_metadata` |
| `memory:delete` | `memory_delete` |
| `rules:read` | `rules_list`, `rules_read`, read `mem://<ns>/rules/*` resources |
| `rules:write` | `rules_upsert`, `rules_delete` |
| `namespace:admin` | manage members + quota + retention of namespaces you own |
| `service:admin` | manage PATs + namespaces globally; the "root" scope |

### Create a PAT for a new agent

Ask an admin-scoped agent (or your own MCP client with the bootstrap/admin PAT) to call:

```jsonc
// tools/call → pat_create
{
  "display_name": "claude-code-laptop",
  "agent_identity": "agent_claude_code_laptop",
  "allowed_namespaces": ["personal"],
  "scopes": ["memory:read", "memory:write", "memory:delete", "rules:read"],
  "expires_at": null   // or ISO-8601 to auto-expire
}
```

The response includes the **plaintext secret** — that's the only time it's shown. Hand it to the agent's config, then revoke if exposed.

**Common preset for a personal-use coding agent:**

```jsonc
{
  "display_name": "<agent>-<host>",
  "agent_identity": "agent_<agent>_<host>",
  "allowed_namespaces": ["personal"],
  "scopes": ["memory:read","memory:write","memory:delete","rules:read","rules:write"]
}
```

`namespace:admin` and `service:admin` should be reserved for one or two "ops" PATs that you don't wire into daily clients.

### List PATs

```jsonc
// tools/call → pat_list (no arguments)
```

Returns metadata only (id, display_name, scopes, allowed_namespaces, created_at, last_used_at, is_revoked) — never the secrets themselves. Use this to audit "what's currently valid?".

### Rotate a PAT (issue new secret, invalidate old)

```jsonc
// tools/call → pat_rotate
{ "pat_id": "<id-from-pat_list>" }
```

Response includes a new plaintext secret. Old one stops working immediately. Use when a PAT is suspected leaked.

### Revoke a PAT

```jsonc
// tools/call → pat_revoke
{ "pat_id": "<id>", "reason": "agent decommissioned" }
```

Revocation cascades: the PAT's membership in any namespace's `_members.json` is also pruned (no orphan ACLs left behind).

---

## Managing namespaces

A namespace is the **tenancy boundary**. Memories, rules, and audit logs live under `data/namespaces/<id>/`. Cross-namespace access is denied by default (ADR-0002 §3.3).

### Bootstrap namespace

`personal` is created automatically on first boot. Owner = the bootstrap PAT's identity.

### Create a new namespace

```jsonc
// tools/call → namespace_create
{
  "id": "work",                // kebab-case, 3-40 chars
  "display_name": "Work",
  "retention_policy": "keep-forever",   // or "decay" — see ADR-0006
  "quota": {                            // optional; defaults documented in ADR-0002 §3.4
    "daily_writes": 1000,
    "daily_embedding_tokens": 500000
  }
}
```

Requires `service:admin`. The caller is added as the namespace's first member with full scopes.

### Add a member (give another agent access to a namespace)

```jsonc
// tools/call → namespace_add_member
{
  "namespace_id": "work",
  "agent_identity": "agent_claude_code_laptop",
  "scopes": ["memory:read","memory:write","rules:read"]
}
```

Requires `namespace:admin` on the target namespace (or `service:admin`).

### List namespaces

```jsonc
// tools/call → namespace_list   // returns namespaces YOU are a member of
```

For `service:admin` PATs, returns all namespaces.

### Update a namespace

```jsonc
// tools/call → namespace_update
{
  "namespace_id": "work",
  "display_name": "Work projects",
  "retention_policy": "decay",
  "quota": { "daily_writes": 5000 }
}
```

### Remove a member

```jsonc
// tools/call → namespace_remove_member
{ "namespace_id": "work", "agent_identity": "agent_old_agent" }
```

### Delete a namespace

```jsonc
// tools/call → namespace_delete
{ "namespace_id": "work", "confirmation": "DELETE work" }
```

Soft-delete — the directory is moved to `data/_deleted/<id>-<ts>/` so an operator can restore manually. Hard-cleanup is an ops concern (see backup runbook).

---

## Using memory (episodic store)

Episodic memories live in Qdrant, embedded via OpenRouter (ADR-0005 — `qwen/qwen3-embedding-8b`, 4096-dim, Cosine). Each memory has: content, optional summary, tags, source, agent identity, timestamps, namespace.

### Store

```jsonc
// tools/call → memory_store
{
  "namespace": "personal",
  "content": "Anna prefers cold brew, sweet, with oat milk. Mentioned 2026-03-04.",
  "summary": "Anna's coffee preference",
  "tags": ["people:anna", "preference:coffee"],
  "source": "slack:#general:msg-12345",
  "id": null   // omit for auto-UUID, supply for idempotent upsert
}
```

Response: `{"id":"<uuid>","created_at":"…"}`. Content is embedded once and stored.

### Search (semantic)

```jsonc
// tools/call → memory_search
{
  "namespace": "personal",
  "query": "what does Anna drink?",
  "limit": 10,
  "tags": ["people:anna"]    // optional AND-filter
}
```

Returns ranked results with `score` (cosine similarity), the full memory record, and timestamps. Search is **scoped to one namespace per call**.

### Get / update / delete

```jsonc
// tools/call → memory_get
{ "namespace": "personal", "id": "<uuid>" }
```

```jsonc
// tools/call → memory_update_metadata
// Updates tags/summary/source/metadata without re-embedding the content.
{ "namespace": "personal", "id": "<uuid>", "tags": ["new","tags"] }
```

```jsonc
// tools/call → memory_delete
{ "namespace": "personal", "id": "<uuid>" }
```

Cross-namespace `get`/`update`/`delete` return `not_found` (never leak existence — ADR-0002 §3.3).

---

## Using rules (deterministic, always-load)

Rules are markdown files with frontmatter — small, deterministic guidance the agent reads on every turn (e.g. "never push to main without confirmation"). Stored on disk at `data/namespaces/<ns>/rules/`; surfaced as MCP **Resources** at `mem://<ns>/rules/<id>` AND as shim tools for clients with weaker Resource UX.

### Write a rule

```jsonc
// tools/call → rules_upsert
{
  "namespace": "personal",
  "id": "no-force-push",            // kebab-case, becomes filename + URI
  "title": "Don't force-push shared branches",
  "body": "Force-pushing main or shared feature branches rewrites history for everyone. Always confirm with the team first.",
  "tags": ["git","safety"],
  "severity": "hard"                 // "hard" | "soft" | "info"
}
```

### Read / list / delete

```jsonc
// tools/call → rules_read   { "namespace": "personal", "id": "no-force-push" }
// tools/call → rules_list   { "namespace": "personal" }   // or omit namespace for all readable
// tools/call → rules_delete { "namespace": "personal", "id": "no-force-push" }
```

MCP-aware clients also see rules as Resources (`resources/list`, `resources/read`) — no explicit tool call needed; the client pulls them in automatically every turn.

---

## Operations

| Concern | Where |
|---|---|
| Health check | `GET /healthz` → `{"status":"ok","qdrant":"ok","embeddings":"ok"}` (no auth) |
| Prometheus metrics | `GET /metrics` (no auth; **bind to loopback only, block at proxy**) |
| Backup + restore | [`docs/ops/qdrant-backup.md`](docs/ops/qdrant-backup.md) |
| VDS deploy | [`docs/ops/vds-deploy.md`](docs/ops/vds-deploy.md) |
| CI / CD | `.github/workflows/{ci,deploy}.yml` |
| Local development | [`docs/runtime.md`](docs/runtime.md) |

### Common operator commands (on the server)

```bash
# Service state
docker ps --filter name=sam-

# Logs
docker logs sam-mcp --tail=100
docker logs sam-qdrant --tail=100

# Restart just the MCP server (e.g. after .env change)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d mcp

# Pull a specific image tag and roll
gh workflow run deploy.yml --field image_tag=<git-sha>

# Dry-run deploy (prints commands, executes nothing)
gh workflow run deploy.yml --field image_tag=latest --field dry_run=true
```

---

## Architecture decisions

All locked in [`docs/adr/`](docs/adr/) — change protocol is "supersede by new ADR".

| ADR | Locks |
|---|---|
| [0001](docs/adr/0001-hybrid-memory-architecture.md) | Two memory classes (rules + episodic); `noun_verb` tool naming |
| [0002](docs/adr/0002-namespace-tenancy-model.md) | Namespaces as tenancy boundary; cross-namespace deny-by-default |
| [0003](docs/adr/0003-transport-stdio-and-http.md) | stdio (dev) + streamable HTTP (prod); Origin header validation |
| [0004](docs/adr/0004-auth-pat-v1.md) | PAT v1 (OAuth/DCR deferred); HMAC+pepper storage |
| [0005](docs/adr/0005-embeddings-strategy.md) | OpenRouter `qwen3-embedding-8b`; retry + circuit breaker |
| [0006](docs/adr/0006-memory-lifecycle.md) | Dedup, reinforcement, decay, supersession, staleness (lifecycle in flight) |

---

## For contributors

```bash
git clone https://github.com/tachkovsa/shared-agents-memory.git
cd shared-agents-memory
cp .env.example .env             # fill in EMBEDDINGS_API_KEY (OpenAI-compatible provider)
npm install
docker compose up -d qdrant      # Qdrant on 127.0.0.1:6333
npm run dev                      # stdio MCP server on this terminal
```

CI (`npm run ci`) runs typecheck + lint + tests. Tests use mocked Qdrant + OpenRouter, no live services required.

See [`docs/runtime.md`](docs/runtime.md) for the long form.

---

## License

MIT — see [`LICENSE`](LICENSE).
