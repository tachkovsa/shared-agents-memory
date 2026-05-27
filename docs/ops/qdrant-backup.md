# Qdrant + filesystem backup and restore runbook

**Scope:** production backups for `shared-agents-memory`.  
**What is backed up:** Qdrant `agent_memories` collection (episodic memories) **and** the `data/` filesystem tree (rules, namespace config, member lists, quota state, PAT store, audit logs, soft-deleted namespaces).  
**What is NOT backed up:** `data/_auth/.pepper` — see [§8](#8-what-is-not-backed-up-and-why).

---

## Concepts

Two independent stores hold the complete system state:

| Store | Contains | Backup method |
|---|---|---|
| Qdrant `agent_memories` | All episodic memories for every namespace | Qdrant snapshot API |
| `data/` filesystem | Rules, namespace JSON, members, quotas, PATs, audit logs, soft-deleted namespaces | Compressed tarball |

A complete backup is **one snapshot file + one tarball with the same timestamp**. They must be taken close together and stored as a pair.

Docker Compose resource names (from `docker-compose.yml`):

| Resource | Name |
|---|---|
| Qdrant container | `sam-qdrant` |
| Qdrant REST port | `127.0.0.1:6333` |
| Qdrant storage volume | `qdrant_storage` |
| Qdrant snapshots volume | `qdrant_snapshots` |

---

## 1. Backup procedure (production)

Both artifacts use the same `TIMESTAMP` so the pair stays identifiable.

```bash
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR=/var/backups/shared-agents-memory   # adjust to your layout
mkdir -p "$BACKUP_DIR"
```

### A. Qdrant snapshot

Trigger the snapshot:

```bash
curl -s -X POST http://localhost:6333/collections/agent_memories/snapshots \
  | tee /tmp/snapshot-response.json
```

The response body is:

```json
{ "result": { "name": "agent_memories-<qdrant-timestamp>.snapshot", ... }, "status": "ok" }
```

Extract the snapshot name and copy it out of the Docker volume:

```bash
SNAP_NAME=$(jq -r '.result.name' /tmp/snapshot-response.json)

# The qdrant_snapshots volume is mounted at /qdrant/snapshots inside the container.
docker cp sam-qdrant:/qdrant/snapshots/"$SNAP_NAME" \
  "$BACKUP_DIR/qdrant-${TIMESTAMP}.snapshot"
```

> **Note:** If `QDRANT__SERVICE__API_KEY` is set, add `-H "api-key: $QDRANT_API_KEY"` to every `curl` call.

### B. Filesystem tarball

```bash
tar --exclude='data/_auth/.pepper' \
    -czf "$BACKUP_DIR/data-${TIMESTAMP}.tar.gz" \
    data/
```

`data/_deleted/` is included by default so soft-deleted namespaces remain recoverable. `.pepper` is explicitly excluded — see [ADR-0004 §3.2](../adr/0004-auth-pat-v1.md).

### C. Checksums

```bash
sha256sum "$BACKUP_DIR/qdrant-${TIMESTAMP}.snapshot" \
          "$BACKUP_DIR/data-${TIMESTAMP}.tar.gz" \
  > "$BACKUP_DIR/SHA256SUMS-${TIMESTAMP}.txt"

echo "Checksums written:"
cat "$BACKUP_DIR/SHA256SUMS-${TIMESTAMP}.txt"
```

Store the `.txt` file alongside the two artifacts. Verify at any time with:

```bash
sha256sum -c "$BACKUP_DIR/SHA256SUMS-${TIMESTAMP}.txt"
```

### D. Off-host transfer

Ship all three files to your off-host storage before considering the backup complete. See [§6](#6-retention-policy) for encryption options and [§7](#7-cron-snippet) for an example cron/systemd setup.

---

## 2. Restore procedure (clean server)

Assumptions: a fresh host with Docker Compose available, `data/` does not yet exist or is empty. Run each step in order.

### Step 1 — Restore `.pepper` from the env-var mirror

The pepper is the **only defence against stolen-volume replay** ([ADR-0004 §3.2](../adr/0004-auth-pat-v1.md)). It lives in two places: `data/_auth/.pepper` (the file) and `SAM_PAT_PEPPER` (the env var). They must match. On a clean restore the file is missing, so restore it first:

```bash
mkdir -p data/_auth
# Option A — paste the value from the env mirror:
printf '%s' "$SAM_PAT_PEPPER" > data/_auth/.pepper
chmod 0600 data/_auth/.pepper

# Option B — re-run bootstrap with SAM_PAT_PEPPER set.
# The server will write the file from the env var at startup.
```

If the pepper value is lost, all existing PATs are effectively invalidated (their stored hashes cannot be verified). Revoke and re-issue all PATs after recovery.

### Step 2 — Verify backup integrity

```bash
sha256sum -c SHA256SUMS-${TIMESTAMP}.txt
```

Both lines must print `OK`. Do not proceed with a corrupt artifact.

### Step 3 — Extract the filesystem tarball

```bash
tar -xzf data-${TIMESTAMP}.tar.gz
# This unpacks into ./data/ relative to the current directory.
# Verify the pepper file was NOT included (it should not be):
test ! -f data/_auth/.pepper && echo "pepper absent from tarball — good" \
  || echo "WARNING: pepper present in tarball"
```

The pepper you restored in Step 1 must survive this extraction. If your extraction target is different from `./`, adjust accordingly.

### Step 4 — Start Qdrant empty

```bash
docker compose up -d qdrant
# Wait for healthy:
docker inspect sam-qdrant --format '{{.State.Health.Status}}'
```

At this point Qdrant has no collection yet.

### Step 5 — Upload the Qdrant snapshot

```bash
curl -X PUT http://localhost:6333/collections/agent_memories/snapshots/upload \
  --form snapshot=@qdrant-${TIMESTAMP}.snapshot
```

Qdrant will recreate the collection with the original vector config and all points. Wait for a `200 OK` response before proceeding.

Check the collection is healthy:

```bash
curl -s http://localhost:6333/collections/agent_memories \
  | jq '.result.status'
# Expect: "green"
```

### Step 6 — Start the MCP server

```bash
# stdio mode (default local dev):
npm run dev

# HTTP mode (Docker Compose, requires ADR-0003 transport):
docker compose --profile http up -d mcp
```

### Step 7 — Smoke test

Run these checks immediately after startup:

```bash
# 1. List all namespaces (MCP tool call — adjust transport as needed):
#    Expected: returns at least the "personal" namespace.
npx @modelcontextprotocol/inspector \
  --transport stdio \
  --command "npm run dev" \
  -- tools/call namespace.list '{}'

# 2. Search a known memory (use a phrase you expect to match):
npx @modelcontextprotocol/inspector \
  --transport stdio \
  --command "npm run dev" \
  -- tools/call memory.search '{"namespace":"personal","query":"<known query phrase>","limit":1}'

# 3. Read a known rule via Resources:
npx @modelcontextprotocol/inspector \
  --transport stdio \
  --command "npm run dev" \
  -- resources/read '{"uri":"mem://personal/rules/INDEX.md"}'
```

All three should return non-error results. If `namespace.list` returns 0 namespaces, the tarball was not extracted correctly. If `memory.search` returns 0 results for a known phrase, the Qdrant snapshot did not load.

---

## 3. Disaster recovery — Qdrant volume lost, filesystem intact

**What is recoverable:** all rules, namespace config (`_namespace.json`, `_members.json`, `_quota.json`), PAT store (`pats.jsonl`), auth audit log (`_auth/audit.jsonl`), per-namespace audit logs, and soft-deleted namespaces (`_deleted/`).

**What is gone:** all episodic memories stored in Qdrant. This is permanent if there is no Qdrant snapshot backup.

**Recovery steps:**

1. Confirm `data/` is intact: `ls data/namespaces/` should list your namespaces.
2. Start Qdrant fresh — it will create an empty volume.
3. The collection `agent_memories` does not exist yet. The MCP server's startup collection-init (issue #3 scaffold) will recreate it empty.
4. Start the MCP server. Rules and namespace configuration are served from the filesystem immediately. Episodic memories are empty.
5. Inform users that memories are gone. Agents can re-populate via `memory.store` as they work.

**Blast radius summary:**

| Data | Status |
|---|---|
| Rules | Fully recovered |
| Namespace config, memberships, quotas | Fully recovered |
| PAT store (auth credentials) | Fully recovered |
| Audit logs | Fully recovered |
| Soft-deleted namespaces | Fully recovered |
| Episodic memories | **Lost permanently** |

---

## 4. Disaster recovery — filesystem lost, Qdrant intact

**What is recoverable:** all episodic memories stored in Qdrant.

**What is gone:** rules, namespace config, PAT store, audit logs.

**Detection:** on startup the server checks for `data/namespaces/<id>/_namespace.json` before serving requests. If a Qdrant collection exists but the namespace JSON files are absent, Qdrant holds memories that cannot be authorised. These are **orphaned memories** — points whose `namespace` payload references a namespace that no longer exists in the filesystem.

**Option A — restore from the most recent filesystem backup (preferred):**

Follow [§2](#2-restore-procedure-clean-server) Steps 1–3 and 6–7. Because Qdrant is intact, skip Steps 4–5. All memories will again be authorised immediately after the namespace files are restored.

**Option B — cold-start (filesystem backup unavailable):**

1. Recreate namespaces manually using `namespace.create` (requires a new bootstrap PAT — see [ADR-0004 §3.4](../adr/0004-auth-pat-v1.md) bootstrap flow).
2. Recreate namespace members with `namespace.add_member`.
3. Qdrant points already contain the correct `namespace` payload field, so memory searches will return results once the namespace exists again.
4. Accept that:
   - Rules are gone (re-create them via `rules.upsert`).
   - PAT audit history is gone.
   - Quota state resets to zero (safe — the service re-accumulates usage going forward).

> **Note on orphaned memories:** If a namespace name cannot be restored exactly (the same kebab-case `id`), Qdrant points for that namespace are permanently orphaned. They are not deleted but cannot be queried through the auth layer. A future cleanup script can filter by `namespace` payload and delete them. Do not attempt manual point deletion in production without a tested script.

---

## 5. Backup integrity check

Verify a backup before relying on it. Run these checks on a separate machine or non-production environment — never on the production Qdrant instance.

### Checksum verification

```bash
sha256sum -c SHA256SUMS-${TIMESTAMP}.txt
# Both lines must print OK.
```

### Filesystem tarball: structural check

```bash
TMPDIR=$(mktemp -d)
tar -xzf data-${TIMESTAMP}.tar.gz -C "$TMPDIR"

# Count namespaces:
echo "Namespaces found:"
ls "$TMPDIR/data/namespaces/"

# Validate JSON files parse:
find "$TMPDIR/data/namespaces" \
     "$TMPDIR/data/_auth" \
  -name '*.json' \
  | while read f; do
      python3 -c "import json,sys; json.load(open('$f'))" \
        && echo "OK  $f" \
        || echo "FAIL $f"
    done

# Confirm pepper is absent:
test ! -f "$TMPDIR/data/_auth/.pepper" \
  && echo "pepper correctly absent" \
  || echo "WARNING: pepper present — remove from backup"

rm -rf "$TMPDIR"
```

Expected: all JSON files parse without error; namespace count matches production; pepper is absent.

### End-to-end test: restore to a shadow environment

1. Start a second Qdrant on a non-production port:

```bash
docker run -d --name sam-qdrant-verify \
  -p 127.0.0.1:6335:6333 \
  -v qdrant_verify_storage:/qdrant/storage \
  qdrant/qdrant:v1.18.1
```

2. Upload the snapshot:

```bash
curl -X PUT http://localhost:6335/collections/agent_memories/snapshots/upload \
  --form snapshot=@qdrant-${TIMESTAMP}.snapshot
```

3. Extract the filesystem tarball into a separate data directory:

```bash
mkdir /tmp/sam-verify && tar -xzf data-${TIMESTAMP}.tar.gz -C /tmp/sam-verify
```

4. Start a temporary MCP server pointed at the shadow environment:

```bash
DATA_DIR=/tmp/sam-verify/data \
QDRANT_URL=http://localhost:6335 \
  npm run dev
```

5. Run the smoke tests from [§2 Step 7](#step-7--smoke-test).

6. Tear down:

```bash
docker stop sam-qdrant-verify && docker rm sam-qdrant-verify
docker volume rm qdrant_verify_storage
rm -rf /tmp/sam-verify
```

A successful end-to-end test confirms the backup is complete and restorable.

---

## 6. Retention policy

Recommended schedule (operator decision — the service does not enforce this):

| Cadence | Retain |
|---|---|
| Daily | 7 days |
| Weekly | 4 weeks |
| Monthly | 6 months |

Prune old backups after each successful daily run.

### Encryption options (choose one per your infrastructure)

**S3-compatible object storage with server-side encryption:**

```bash
aws s3 cp "$BACKUP_DIR/qdrant-${TIMESTAMP}.snapshot" \
  s3://your-bucket/sam-backups/ --sse aws:kms
aws s3 cp "$BACKUP_DIR/data-${TIMESTAMP}.tar.gz" \
  s3://your-bucket/sam-backups/ --sse aws:kms
aws s3 cp "$BACKUP_DIR/SHA256SUMS-${TIMESTAMP}.txt" \
  s3://your-bucket/sam-backups/ --sse aws:kms
```

**age (client-side encryption before upload):**

```bash
age -r "$(cat ~/.config/age/recipient.pub)" \
  -o "$BACKUP_DIR/qdrant-${TIMESTAMP}.snapshot.age" \
  "$BACKUP_DIR/qdrant-${TIMESTAMP}.snapshot"
```

**restic (deduplicated, encrypted, supports S3/SFTP/local):**

```bash
restic -r s3:s3.amazonaws.com/your-bucket/sam-backups backup \
  "$BACKUP_DIR/qdrant-${TIMESTAMP}.snapshot" \
  "$BACKUP_DIR/data-${TIMESTAMP}.tar.gz"
```

**borg (deduplicated, encrypted, local or SSH remote):**

```bash
borg create --compression lzma \
  /mnt/backup-volume::sam-${TIMESTAMP} \
  "$BACKUP_DIR/qdrant-${TIMESTAMP}.snapshot" \
  "$BACKUP_DIR/data-${TIMESTAMP}.tar.gz"
```

Pick whichever fits your existing infrastructure. The non-negotiable requirements are: encrypted at rest, stored off the production host.

---

## 7. Cron snippet

The script below performs the full backup (Qdrant snapshot + filesystem tarball + checksums + off-host transfer). Wire in your preferred off-host method where indicated.

```bash
#!/usr/bin/env bash
# shared-agents-memory backup
# Place this at /usr/local/bin/sam-backup.sh (chmod 0700, owned by root or the deploy user)

set -euo pipefail

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR=/var/backups/shared-agents-memory
DATA_DIR=${DATA_DIR:-/opt/shared-agents-memory/data}
CONTAINER=sam-qdrant
COLLECTION=agent_memories
QDRANT_URL=http://localhost:6333
RETAIN_DAYS=7

mkdir -p "$BACKUP_DIR"

# 1. Qdrant snapshot
SNAP_RESPONSE=$(curl -sf -X POST "${QDRANT_URL}/collections/${COLLECTION}/snapshots")
SNAP_NAME=$(echo "$SNAP_RESPONSE" | jq -r '.result.name')
docker cp "${CONTAINER}:/qdrant/snapshots/${SNAP_NAME}" \
  "${BACKUP_DIR}/qdrant-${TIMESTAMP}.snapshot"

# 2. Filesystem tarball (exclude .pepper per ADR-0004 §3.2)
tar --exclude="${DATA_DIR}/_auth/.pepper" \
    -czf "${BACKUP_DIR}/data-${TIMESTAMP}.tar.gz" \
    "$DATA_DIR"

# 3. Checksums
sha256sum "${BACKUP_DIR}/qdrant-${TIMESTAMP}.snapshot" \
          "${BACKUP_DIR}/data-${TIMESTAMP}.tar.gz" \
  > "${BACKUP_DIR}/SHA256SUMS-${TIMESTAMP}.txt"

# 4. Ship off-host — replace this block with your preferred method
# (see §6 for age / restic / borg / S3 examples)
# aws s3 sync "$BACKUP_DIR/" s3://your-bucket/sam-backups/ --sse aws:kms

# 5. Prune backups older than RETAIN_DAYS days
find "$BACKUP_DIR" \
  \( -name 'qdrant-*.snapshot' -o -name 'data-*.tar.gz' -o -name 'SHA256SUMS-*.txt' \) \
  -mtime "+${RETAIN_DAYS}" -delete

echo "Backup complete: qdrant-${TIMESTAMP}.snapshot + data-${TIMESTAMP}.tar.gz"
```

### Schedule with `/etc/cron.d/`

```cron
# /etc/cron.d/sam-backup
# Run at 02:00 UTC daily
0 2 * * * root /usr/local/bin/sam-backup.sh >> /var/log/sam-backup.log 2>&1
```

### Schedule with a systemd timer

`/etc/systemd/system/sam-backup.service`:

```ini
[Unit]
Description=shared-agents-memory backup
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/sam-backup.sh
StandardOutput=journal
StandardError=journal
```

`/etc/systemd/system/sam-backup.timer`:

```ini
[Unit]
Description=Run sam-backup daily at 02:00 UTC

[Timer]
OnCalendar=*-*-* 02:00:00 UTC
AccuracySec=1min
Persistent=true

[Install]
WantedBy=timers.target
```

Enable:

```bash
systemctl daemon-reload
systemctl enable --now sam-backup.timer
# Check next trigger:
systemctl list-timers sam-backup.timer
```

---

## 8. What is NOT backed up (and why)

| Item | Why excluded |
|---|---|
| `data/_auth/.pepper` | **ADR-0004 §3.2** — the pepper is the defence against stolen-volume replay. Backing it up alongside `pats.jsonl` would defeat the protection: an attacker who obtains both files could verify and replay any token. The pepper lives in the `SAM_PAT_PEPPER` environment variable on the host; back it up through your secrets management tool (Vault, SSM Parameter Store, an encrypted password manager), NOT in the data backup. |
| `node_modules/`, `dist/`, build output | Recreatable from `npm install` + `npm run build`. Including them wastes storage and masks real changes. |
| `.env`, environment files | Operator manages secrets separately. `.env` typically contains `QDRANT_API_KEY`, `OPENROUTER_API_KEY`, and `SAM_PAT_PEPPER`. Back these up through a secrets manager, not a filesystem tarball. |

---

## Related documents

- [ADR-0001 §3.5](../adr/0001-hybrid-memory-architecture.md) — filesystem layout for rules
- [ADR-0002 §3.4–3.6](../adr/0002-namespace-tenancy-model.md) — namespace directory layout, quota state
- [ADR-0004 §3.2](../adr/0004-auth-pat-v1.md) — pepper rationale (stolen-volume replay defence)
- [docs/runtime.md](../runtime.md) — production deployment layout (TLS, bind addresses)
