# Runtime — local dev and single-node deployment

Two deployment shapes:

- **Local dev** — Qdrant in Docker, MCP server outside Docker via `npm run dev` (stdio).
- **Single-node shared** — Qdrant + MCP both in Docker, behind a TLS reverse proxy on the host (HTTP).

The HTTP transport lands with [issue #22](https://github.com/tachkovsa/shared-agents-memory/issues/22) per [ADR-0003](adr/0003-transport-stdio-and-http.md). Until then the `mcp` compose service is parked behind a profile and the only working flow is local dev.

## Prerequisites

- Docker 24+ with Compose v2 (`docker compose`, not `docker-compose`).
- Node 20+ (only needed for the local-dev flow).
- An OpenRouter API key.

## Local dev

```bash
cp .env.example .env
# set OPENROUTER_API_KEY in .env

docker compose up -d qdrant       # Qdrant on 127.0.0.1:6333 (REST) and :6334 (gRPC)
docker compose ps                 # qdrant should report `(healthy)`
npm install
npm run dev                       # MCP server in stdio mode on this terminal
```

To wipe state and start fresh:

```bash
docker compose down -v            # ⚠️  drops the qdrant_storage and qdrant_snapshots volumes
```

## Single-node shared (HTTP, post-#22)

Once HTTP transport ships, the production layout is:

```
internet ──HTTPS:443──► nginx/Caddy ──http://127.0.0.1:8080──► mcp container
                                                                  │
                                                       qdrant docker network
                                                                  ▼
                                                          qdrant container
                                                       (no host port published)
```

1. Provision the host: install Docker + a TLS-terminating reverse proxy (nginx or Caddy).
2. Copy `.env.example` to `.env`. Set `OPENROUTER_API_KEY`, `QDRANT_API_KEY` (recommended), `HTTP_PUBLIC_ORIGIN=https://memory.example.com`.
3. Create a production override (`docker-compose.prod.yml`) that:
   - Removes the `qdrant.ports` publishing so Qdrant is only reachable from the docker network.
   - Pins `data/` to a backup-friendly host path (e.g. `/var/lib/shared-agents-memory/data`).
4. `docker compose --profile http -f docker-compose.yml -f docker-compose.prod.yml up -d`
5. Point the reverse proxy at `127.0.0.1:8080`.

See [ADR-0003 §3.4](adr/0003-transport-stdio-and-http.md) for the rationale on bindings, origins, and session limits.

## Ports, volumes, env vars

### Ports

| Container | Port | Host bind | Notes |
|---|---|---|---|
| `qdrant` | 6333 | `127.0.0.1:6333` | REST API. Drop the host publishing in production. |
| `qdrant` | 6334 | `127.0.0.1:6334` | gRPC. Drop the host publishing in production. |
| `mcp` | 8080 | `127.0.0.1:8080` | HTTP MCP endpoint (post-#22). Reverse proxy connects here. |

### Volumes

| Name | Mounted in container | Purpose |
|---|---|---|
| `qdrant_storage` (named) | `qdrant:/qdrant/storage` | Vector points + payload indexes. Survives `docker compose down`; dropped only by `down -v`. |
| `qdrant_snapshots` (named) | `qdrant:/qdrant/snapshots` | Targets for [issue #10](https://github.com/tachkovsa/shared-agents-memory/issues/10) backup runbook. |
| `./data` (bind-mount) | `mcp:/app/data` | Per-namespace rules, members, quotas, audit log (ADR-0002 §3.6) + PAT store + pepper (ADR-0004 §3). |

### Environment variables (see `.env.example`)

| Var | Required | Default | Notes |
|---|---|---|---|
| `OPENROUTER_API_KEY` | ✅ | — | Used by the embedding client. |
| `OPENROUTER_BASE_URL` | | `https://openrouter.ai/api/v1` | Override for integration tests. |
| `OPENROUTER_MODEL` | | `qwen/qwen3-embedding-8b` | Vector dim locked at 4096 (ADR-0005). |
| `QDRANT_URL` | | `http://localhost:6333` | Use `http://qdrant:6333` inside compose. |
| `QDRANT_API_KEY` | | unset | MCP-side client key. Pair with `QDRANT__SERVICE__API_KEY` to enable auth. |
| `QDRANT__SERVICE__API_KEY` | | unset | Qdrant-server side key. Must match `QDRANT_API_KEY`. **Never set to empty string** — Qdrant treats that as "auth on with empty key" and returns 401 on every request. |
| `QDRANT_COLLECTION` | | `agent_memories` | |
| `MCP_SERVER_PORT` | | `3000` | Scaffold-era knob; will be superseded by HTTP transport env. |

Future HTTP-mode vars (`TRANSPORT`, `HTTP_BIND_HOST`, `HTTP_BIND_PORT`, `HTTP_PUBLIC_ORIGIN`, etc.) are listed in ADR-0003 §3.5 and will land here when issue #22 is merged.

## Security notes

- **Never publish Qdrant to a public interface.** The default compose binds 6333/6334 to loopback only; production should remove host publishing entirely (Qdrant talks to MCP only over the docker network).
- **Set `QDRANT_API_KEY` in any shared deployment.** Even though Qdrant is internal-only behind nginx, an api key is a cheap second layer.
- **No real credentials in this repo.** `.env` is gitignored; `data/` is gitignored. `.env.example` and the compose files never carry secrets.
- **Health probes don't depend on `QDRANT_API_KEY`** — the qdrant healthcheck is a TCP probe so it works whether or not the api key is set.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `qdrant` stays `unhealthy` | First-time image pull or slow disk | Wait up to ~30 s; check `docker compose logs qdrant`. |
| `mcp` exits immediately | Tried to start `--profile http` before issue #22 ships | Don't run the `http` profile yet; use `npm run dev` instead. |
| `npm run dev` cannot reach Qdrant | `QDRANT_URL` points at `http://qdrant:6333` | Outside compose, use `http://localhost:6333`. |
| `EMBEDDING dimension mismatch` at boot | `OPENROUTER_MODEL` was changed to a non-4096-dim model | Drop the qdrant collection (`down -v`) or restore the 4096-dim model. |
