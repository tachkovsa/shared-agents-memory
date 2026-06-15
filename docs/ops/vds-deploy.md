# VDS deploy runbook — shared-agents-memory

**Scope:** end-to-end guide for deploying `shared-agents-memory` to a fresh Ubuntu 22.04+ VDS.  
**Topology (ADR-0003 §3.4):**

```
internet --(TLS :443)--> nginx/Caddy --(loopback :8080)--> mcp container --(docker net :6333)--> Qdrant
```

---

## Prerequisites

- **Ubuntu 22.04 LTS** or newer (root or sudo access).
- A DNS **A record** pointing your chosen subdomain (e.g. `memory.example.com`) to the server's public IP. The record must resolve before you run certbot.
- **Port 80 and 443** reachable from the internet (for TLS certificate issuance and HTTPS traffic).
- **Port 22** reachable for SSH administration.
- A GitHub Personal Access Token (classic) with `read:packages` scope if you pull images from GHCR directly (the CD pipeline uses `GITHUB_TOKEN`; operators pulling manually need their own PAT).

---

## 1. Run the bootstrap script

Clone the repo (or copy `deploy/setup-ubuntu.sh`) to the server, then run it as root.

```bash
sudo bash deploy/setup-ubuntu.sh --proxy=nginx   # nginx (default)
# or:
sudo bash deploy/setup-ubuntu.sh --proxy=caddy   # Caddy (handles TLS automatically)
```

The script is idempotent — safe to re-run. It will:

- Install Docker Engine and the Compose plugin from Docker's official apt repo.
- Create the `sam` service user.
- Create `/var/lib/shared-agents-memory/{data,qdrant/storage,qdrant/snapshots}` with `sam:sam` ownership.
- Install nginx or Caddy.
- Configure UFW (deny all incoming; allow SSH/HTTP/HTTPS). UFW is not enabled automatically — the script asks for confirmation.
- Drop a placeholder env file at `/etc/shared-agents-memory/.env`.

Pass `--yes` to skip interactive confirmations (suitable for automated provisioning).

---

## 2. Obtain a TLS certificate

### nginx + certbot

```bash
# Install certbot if not already present:
apt-get install -y certbot python3-certbot-nginx

# Obtain and install the certificate (replaces ssl_certificate paths in nginx.conf):
certbot --nginx -d memory.example.com
```

certbot configures auto-renewal via a systemd timer or cron job. Verify:

```bash
certbot renew --dry-run
```

### Caddy (automatic)

Caddy handles TLS automatically via Let's Encrypt ACME. No manual certbot step is required. Ensure ports 80 and 443 are open before starting Caddy.

---

## 3. Configure the reverse proxy

Copy the reference configuration from the repo and edit your domain.

### nginx

```bash
cp deploy/nginx.conf /etc/nginx/sites-available/shared-agents-memory

# Replace the placeholder domain in all three locations:
sed -i 's/memory\.example\.com/your.actual.domain/g' \
    /etc/nginx/sites-available/shared-agents-memory

ln -s /etc/nginx/sites-available/shared-agents-memory \
      /etc/nginx/sites-enabled/shared-agents-memory

nginx -t && systemctl reload nginx
```

### Caddy

```bash
cp deploy/Caddyfile /etc/caddy/Caddyfile

# Replace the placeholder domain:
sed -i 's/memory\.example\.com/your.actual.domain/g' /etc/caddy/Caddyfile

caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
```

Both configurations:

- Redirect HTTP (port 80) → HTTPS (port 443).
- Proxy `/mcp` to `127.0.0.1:8080` with SSE-friendly settings (`proxy_buffering off` / `flush_interval -1`).
- Expose `/healthz` publicly (for uptime monitors).
- Block `/metrics` externally (return 404). Access metrics from the server loopback — see [§8 Operations](#8-operations).
- Add HSTS, X-Content-Type-Options, Referrer-Policy, and Permissions-Policy headers.

---

## 4. Fill in the environment file

```bash
# Open with your preferred editor:
nano /etc/shared-agents-memory/.env
```

Set all **required** values:

| Variable | Description |
|---|---|
| `EMBEDDINGS_API_KEY` | Embeddings provider API key (OpenAI-compatible endpoint — OpenRouter / OpenAI / vLLM / Ollama / etc.; ADR-0005). **Managed by CD pipeline**: set the GH repo secret `EMBEDDINGS_API_KEY`; the deploy workflow syncs it into this file on every dispatch. You can also fill it manually for an initial bring-up. |
| `EMBEDDINGS_BASE_URL` (optional) | Default `https://openrouter.ai/api/v1`. Override to point at a different provider — must speak OpenAI-compatible `/embeddings`. |
| `EMBEDDINGS_MODEL` (optional) | Default `qwen/qwen3-embedding-8b`. Must be a 4096-dim model. |
| `HTTP_PUBLIC_ORIGIN` | Your public HTTPS origin, e.g. `https://memory.example.com`. Must match the domain in your proxy config. Used for Origin header validation (ADR-0003 §3.3). |
| `SAM_PAT_PEPPER` | A 32-byte (64 hex char) random secret. Generate once: `openssl rand -hex 32`. **Never change after the first PAT is issued** — changing it invalidates all existing PATs. Back this up via a secrets manager, not alongside `data/`. |

Optional variables are documented in the env file itself. See also:

- `QDRANT_API_KEY` + `QDRANT__SERVICE__API_KEY` — enable Qdrant auth (recommended for multi-user deployments).
- `IMAGE_TAG` — pin a specific image tag (see [§7 Rollback](#7-rollback)).

The file is owned `root:sam` with mode `0640` — the `sam` user (which runs Docker) can read it.

---

## 5. Clone the repo and start the stack

```bash
# Clone into /opt/shared-agents-memory (where the CD pipeline expects it):
cd /opt
git clone https://github.com/tachkovsa/shared-agents-memory.git shared-agents-memory
cd shared-agents-memory

# Pull the latest images:
set -a && source /etc/shared-agents-memory/.env && set +a
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull

# Start (Qdrant first via depends_on, then mcp):
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Verify both containers are healthy:
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
```

Expected output: both `sam-qdrant` and `sam-mcp` show `healthy`.

---

## 6. First boot — read the bootstrap PAT

On first boot, `src/auth/bootstrap.ts` checks whether any PAT exists in `data/namespaces/personal/_auth/pats.jsonl`. If none exists, it creates a **bootstrap PAT** and writes it to **stderr**.

Read it immediately:

```bash
docker logs sam-mcp 2>&1 | grep -iE 'bootstrap|PAT|hcm_pat'
```

You will see a line similar to:

```
[bootstrap] First boot — bootstrap PAT created for namespace 'personal':
[bootstrap]   hcm_pat_<token>
[bootstrap] Store this securely. It will not be shown again.
```

**Store this PAT in your password manager immediately.** It is shown only once. If you miss it, delete `data/namespaces/personal/_auth/pats.jsonl` and restart the container — the server will generate a new bootstrap PAT (all previous PATs for that namespace are invalidated).

---

## 7. Rollback

To roll back to a previous image:

```bash
# On the server:
cd /opt/shared-agents-memory

# Set IMAGE_TAG to the previous git SHA (visible in GHCR or GitHub Actions run history):
export IMAGE_TAG=abc1234   # replace with the previous commit SHA

set -a && source /etc/shared-agents-memory/.env && set +a

docker compose -f docker-compose.yml -f docker-compose.prod.yml pull mcp
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d mcp
```

Alternatively, set `IMAGE_TAG=abc1234` in `/etc/shared-agents-memory/.env` and re-source it before running Compose. The CD pipeline's `image_tag` workflow input does the same thing via GitHub Actions.

The `data/` volume is preserved across image changes — no data is lost on rollback.

---

## 8. Operations

### Restart the stack

```bash
cd /opt/shared-agents-memory
set -a && source /etc/shared-agents-memory/.env && set +a
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart
```

### Update to a new image

The CD pipeline handles this automatically when you trigger the `deploy` workflow. For manual updates:

```bash
cd /opt/shared-agents-memory
git pull                   # pull the latest docker-compose files
set -a && source /etc/shared-agents-memory/.env && set +a
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull mcp
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d mcp
docker image prune -f      # reclaim disk space from old image layers
```

### View logs

```bash
# MCP server logs:
docker logs sam-mcp --follow --tail=100

# Qdrant logs:
docker logs sam-qdrant --follow --tail=100

# nginx access log:
tail -f /var/log/nginx/shared-agents-memory.access.log
```

### View Prometheus metrics

`/metrics` is blocked at the proxy layer. Access it directly from the server loopback:

```bash
curl -s http://127.0.0.1:8080/metrics
```

To scrape metrics from a remote Prometheus instance, expose them over an authenticated endpoint or use a Prometheus push gateway — do NOT open `/metrics` to the internet.

### Health check

```bash
# From loopback (always works):
curl -s http://127.0.0.1:8080/healthz

# From the internet (via proxy):
curl -s https://memory.example.com/healthz
```

Both should return `{"status":"ok"}`.

### Inspect data volumes

```bash
# MCP data (rules, namespace config, PAT store, audit logs):
ls /var/lib/shared-agents-memory/data/

# Qdrant storage:
ls /var/lib/shared-agents-memory/qdrant/storage/
```

---

## 9. Backups

See [qdrant-backup.md](qdrant-backup.md) for the full backup and restore runbook.

Quick summary:

- Back up **Qdrant** via the snapshot API (`curl -X POST http://localhost:6333/collections/agent_memories/snapshots`).
- Back up **`data/`** via a compressed tarball, **excluding** `data/_auth/.pepper`.
- Store backups off-host, encrypted.
- Back up `SAM_PAT_PEPPER` separately via a secrets manager.

---

## 10. GitHub Actions CD pipeline

The `deploy.yml` workflow automates image builds and deployments.

### Workflow overview

**Job `build-image`** — runs on every push to `main`:

- Builds the Docker image and pushes to GHCR as both `:<commit-sha>` and `:latest`.
- Uses Docker Buildx with layer caching.

**Job `deploy`** — runs only on manual `workflow_dispatch`:

- Inputs: `image_tag` (default `latest`), `dry_run` (default `false`).
- SSHs into the VDS, pulls the new image, and restarts the `mcp` container.
- Waits up to 60 seconds for `/healthz` to return 200.

### Required GitHub secrets

| Secret | Value |
|---|---|
| `VDS_HOST` | Public IP or hostname of the VDS. |
| `VDS_USER` | SSH user (e.g. `sam` or `ubuntu`). |
| `VDS_SSH_KEY` | Private SSH key (the full PEM content, including `-----BEGIN...-----`). |
| `EMBEDDINGS_API_KEY` | Embeddings provider API key (OpenAI-compatible). Synced into `/etc/shared-agents-memory/.env` on every deploy so the container survives reboots. Rotating it is `gh secret set EMBEDDINGS_API_KEY` + a deploy dispatch. |

Set them with:

```bash
gh secret set VDS_HOST           --body "your.vds.ip.or.hostname"
gh secret set VDS_USER           --body "sam"
gh secret set VDS_SSH_KEY        < ~/.ssh/your_deploy_key
gh secret set EMBEDDINGS_API_KEY --body "sk-or-v1-..."   # OpenRouter, OpenAI, etc.
```

### Adding the deploy key to the server

```bash
# Generate a dedicated deploy key (do NOT reuse your personal key):
ssh-keygen -t ed25519 -C "sam-deploy@github-actions" -f ~/.ssh/sam_deploy_key -N ""

# Copy the public key to the server:
ssh-copy-id -i ~/.ssh/sam_deploy_key.pub sam@your.vds.ip

# Add the private key as the VDS_SSH_KEY secret:
gh secret set VDS_SSH_KEY < ~/.ssh/sam_deploy_key
```

### Triggering a deploy

```bash
# Deploy latest image:
gh workflow run deploy.yml

# Deploy a specific image tag:
gh workflow run deploy.yml --field image_tag=abc1234

# Dry run (prints commands without executing):
gh workflow run deploy.yml --field dry_run=true
```

---

## 11. Self-hosted embeddings (bge-m3 via TEI) — ADR-0010

The default cloud profile embeds via OpenRouter (qwen3, 4096-dim). The
**self-host profile** runs a local [text-embeddings-inference](https://github.com/huggingface/text-embeddings-inference)
(TEI) sidecar serving `BAAI/bge-m3` (1024-dim) — no external embedding
dependency, data stays on the box. It is an opt-in compose overlay.

### Bring-up

```bash
# 1. Create the model-cache dir (first boot downloads bge-m3, ~2GB):
install -d -o sam -g sam /var/lib/shared-agents-memory/tei

# 2. Set the self-host embeddings profile in /etc/shared-agents-memory/.env
#    (so CD restarts of mcp keep the right provider — see note below):
#      EMBEDDINGS_API_KEY=local
#      EMBEDDINGS_BASE_URL=http://embedder/v1
#      EMBEDDINGS_MODEL=bge-m3
#      EMBEDDINGS_DIMENSION=1024

# 3. Start the stack WITH the embedder overlay (all three files):
cd /opt/shared-agents-memory
set -a && source /etc/shared-agents-memory/.env && set +a
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  -f docker-compose.embedder.yml up -d

# 4. Wait for the model to load, then verify the OpenAI-compatible route:
docker exec sam-mcp node -e "fetch('http://embedder/v1/embeddings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'bge-m3',input:'ping'})}).then(r=>r.json()).then(d=>console.log('dim=',d.data[0].embedding.length)).catch(e=>console.log('ERR',e.message))"
# Expect: dim= 1024
```

> **CD note:** the `deploy.yml` pipeline restarts only the `mcp` container using
> `docker-compose.yml` + `docker-compose.prod.yml` (it does not know about the
> embedder overlay). That is fine — the embeddings provider is read from
> `/etc/shared-agents-memory/.env` (step 2), which the base compose passes
> through, and the `embedder` container keeps running (`restart: always`)
> independently. Always set the embeddings env in `.env`, not only in the
> overlay, on a self-host box.

### Migrating data from a cloud (4096-dim) box

Vectors are model-specific and cannot be copied across dimensions/models. To
move memories from an OpenRouter/qwen3 box onto a bge-m3 box, **re-embed from the
original text**:

```bash
# On the new box, restore the old Qdrant snapshot into a SEPARATE collection
# (see qdrant-backup.md), e.g. `agent_memories_src`. Then:
cd /opt/shared-agents-memory
set -a && source /etc/shared-agents-memory/.env && set +a

# Dry-run first (embeds, reports counts, writes nothing):
npx tsx scripts/reembed-collection.ts \
  --source-collection agent_memories_src --dry-run --verbose

# Real run (creates agent_memories at 1024-dim if absent, re-embeds, upserts):
npx tsx scripts/reembed-collection.ts \
  --source-collection agent_memories_src --verbose

# Verify, then drop the temp source collection.
```

The filesystem `data/` tree (namespaces, rules, members, quotas, PAT store,
`_auth/.pepper`, audit) is provider-independent — copy it with `rsync` as-is.
Keep `SAM_PAT_PEPPER` identical to the source box so existing PATs stay valid.

## Related documents

- [ADR-0003 §3.4](../adr/0003-transport-stdio-and-http.md) — deployment topology and transport decisions
- [ADR-0004](../adr/0004-auth-pat-v1.md) — PAT lifecycle, pepper, bootstrap flow
- [qdrant-backup.md](qdrant-backup.md) — backup and restore runbook
