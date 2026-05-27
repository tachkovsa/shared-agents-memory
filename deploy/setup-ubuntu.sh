#!/usr/bin/env bash
# setup-ubuntu.sh — one-shot idempotent bootstrap for shared-agents-memory on Ubuntu 22.04+
#
# Usage:
#   sudo ./setup-ubuntu.sh [--proxy=nginx|caddy] [--yes]
#
# Options:
#   --proxy=nginx   Install and configure nginx (default).
#   --proxy=caddy   Install and configure Caddy instead.
#   --yes           Skip interactive confirmation before irreversible actions
#                   (UFW enable, overwriting existing config files).
#                   Safe to use in CI/automation.
#
# What this script does:
#   1. Installs Docker Engine + Compose plugin (official Docker apt repo).
#   2. Creates the `sam` service user (no login shell).
#   3. Creates /var/lib/shared-agents-memory/{data,qdrant/storage,qdrant/snapshots}
#      with sam:sam ownership.
#   4. Installs nginx or Caddy depending on --proxy.
#   5. Configures UFW (deny all in, allow SSH/HTTP/HTTPS).
#   6. Drops a placeholder /etc/shared-agents-memory/.env for operator to fill.
#   7. Prints next-step instructions.
#
# This script is idempotent: safe to run multiple times on the same host.
# It will not overwrite existing config files unless --yes is passed.

set -euo pipefail

# --------------------------------------------------------------------------- helpers
log()  { printf '\e[1;32m[setup]\e[0m %s\n' "$*"; }
warn() { printf '\e[1;33m[setup]\e[0m %s\n' "$*"; }
die()  { printf '\e[1;31m[setup]\e[0m ERROR: %s\n' "$*" >&2; exit 1; }

confirm() {
    # Usage: confirm "message"
    # Returns 0 if --yes was passed or the user confirms.
    local msg="$1"
    if [[ "${OPT_YES}" == "true" ]]; then
        return 0
    fi
    printf '\e[1;33m[confirm]\e[0m %s [y/N] ' "$msg"
    read -r ans
    [[ "$ans" =~ ^[Yy]$ ]]
}

require_root() {
    if [[ "$EUID" -ne 0 ]]; then
        die "This script must be run as root (or via sudo)."
    fi
}

# --------------------------------------------------------------------------- argument parsing
OPT_PROXY="nginx"
OPT_YES="false"

for arg in "$@"; do
    case "$arg" in
        --proxy=nginx)  OPT_PROXY="nginx" ;;
        --proxy=caddy)  OPT_PROXY="caddy" ;;
        --yes)          OPT_YES="true"    ;;
        --help|-h)
            grep '^#' "$0" | grep -v '^#!/' | sed 's/^# \?//'
            exit 0
            ;;
        *) die "Unknown argument: $arg. Run with --help for usage." ;;
    esac
done

require_root

log "Starting shared-agents-memory bootstrap (proxy=${OPT_PROXY}, yes=${OPT_YES})"

# --------------------------------------------------------------------------- 1. Docker Engine
log "Step 1: Install Docker Engine + Compose plugin"

if command -v docker &>/dev/null; then
    log "  Docker already installed: $(docker --version)"
else
    log "  Adding Docker's official apt repository..."

    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg lsb-release

    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg

    echo \
        "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu \
$(lsb_release -cs) stable" \
        > /etc/apt/sources.list.d/docker.list

    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

    systemctl enable --now docker
    log "  Docker installed: $(docker --version)"
fi

# Verify Compose plugin is available.
if ! docker compose version &>/dev/null; then
    die "Docker Compose plugin not found after installation. Check apt output above."
fi
log "  Compose plugin: $(docker compose version)"

# --------------------------------------------------------------------------- 2. Service user
log "Step 2: Create 'sam' service user"

if id sam &>/dev/null; then
    log "  User 'sam' already exists."
else
    useradd --system --no-create-home --shell /usr/sbin/nologin sam
    log "  User 'sam' created."
fi

# Add sam to the docker group so it can run docker commands.
if id -nG sam | grep -qw docker; then
    log "  User 'sam' already in docker group."
else
    usermod -aG docker sam
    log "  User 'sam' added to docker group."
fi

# --------------------------------------------------------------------------- 3. Data directories
log "Step 3: Create /var/lib/shared-agents-memory directory tree"

for dir in \
    /var/lib/shared-agents-memory/data \
    /var/lib/shared-agents-memory/qdrant/storage \
    /var/lib/shared-agents-memory/qdrant/snapshots; do

    if [[ -d "$dir" ]]; then
        log "  Already exists: $dir"
    else
        mkdir -p "$dir"
        log "  Created: $dir"
    fi
    chown -R sam:sam /var/lib/shared-agents-memory
done

# --------------------------------------------------------------------------- 4. Reverse proxy
log "Step 4: Install reverse proxy (${OPT_PROXY})"

case "$OPT_PROXY" in
    nginx)
        if command -v nginx &>/dev/null; then
            log "  nginx already installed: $(nginx -v 2>&1)"
        else
            apt-get install -y -qq nginx
            systemctl enable nginx
            log "  nginx installed."
        fi
        ;;
    caddy)
        if command -v caddy &>/dev/null; then
            log "  Caddy already installed: $(caddy version)"
        else
            apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
            curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
                | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
            curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
                | tee /etc/apt/sources.list.d/caddy-stable.list
            apt-get update -qq
            apt-get install -y -qq caddy
            systemctl enable caddy
            log "  Caddy installed: $(caddy version)"
        fi
        ;;
esac

# --------------------------------------------------------------------------- 5. UFW
log "Step 5: Configure UFW firewall"

if ! command -v ufw &>/dev/null; then
    apt-get install -y -qq ufw
fi

# Apply rules idempotently — ufw is tolerant of duplicate rule adds.
log "  Setting default policies (deny incoming, allow outgoing)..."
ufw --force default deny incoming  >/dev/null
ufw --force default allow outgoing >/dev/null

log "  Allowing SSH (22)..."
ufw allow 22/tcp >/dev/null

log "  Allowing HTTP (80)..."
ufw allow 80/tcp >/dev/null

log "  Allowing HTTPS (443)..."
ufw allow 443/tcp >/dev/null

# UFW enable is irreversible if SSH is misconfigured; require confirmation.
UFW_STATUS=$(ufw status | head -1)
if [[ "$UFW_STATUS" == "Status: active" ]]; then
    log "  UFW already active."
else
    warn "  UFW is not active yet."
    if confirm "Enable UFW now? (ensure SSH on port 22 is working before proceeding)"; then
        ufw --force enable
        log "  UFW enabled."
    else
        warn "  UFW not enabled. Run 'ufw enable' manually when ready."
    fi
fi

# --------------------------------------------------------------------------- 6. Environment file
log "Step 6: Drop placeholder /etc/shared-agents-memory/.env"

mkdir -p /etc/shared-agents-memory
chmod 0750 /etc/shared-agents-memory

ENV_FILE="/etc/shared-agents-memory/.env"

if [[ -f "$ENV_FILE" ]] && ! confirm "  $ENV_FILE already exists — overwrite?"; then
    log "  Skipping .env creation (file exists, operator chose not to overwrite)."
else
    cat > "$ENV_FILE" <<'ENVEOF'
# /etc/shared-agents-memory/.env
# Operator: fill in all REQUIRED values before starting the stack.
# Source this file before running docker compose:
#   set -a && source /etc/shared-agents-memory/.env && set +a

# ------------------------------------------------------------------ REQUIRED
# Your OpenRouter API key (https://openrouter.ai/keys).
OPENROUTER_API_KEY=

# The public HTTPS origin of your deployment — MUST match the domain in your
# nginx/Caddy config. Used for Origin header validation (ADR-0003 §3.3).
# Example: https://memory.example.com
HTTP_PUBLIC_ORIGIN=

# A 32-byte (64 hex char) random secret. Generated once; never change after
# first PAT is issued (changing it invalidates all existing PATs).
# Generate with:  openssl rand -hex 32
SAM_PAT_PEPPER=

# ------------------------------------------------------------------ OPTIONAL
# Qdrant API key. If set, also set QDRANT__SERVICE__API_KEY to the same value.
# Leave empty to disable Qdrant auth (acceptable on an internal-network-only deployment).
# QDRANT_API_KEY=
# QDRANT__SERVICE__API_KEY=

# Image tag to deploy (set by CD pipeline; override for manual rollback).
# IMAGE_TAG=latest

# Host path for the mcp data volume (default: /var/lib/shared-agents-memory/data).
# SAM_DATA_DIR=/var/lib/shared-agents-memory/data

# OpenRouter model override (default: qwen/qwen3-embedding-8b).
# OPENROUTER_MODEL=qwen/qwen3-embedding-8b

# Qdrant collection name override (default: agent_memories).
# QDRANT_COLLECTION=agent_memories
ENVEOF

    chown root:sam "$ENV_FILE"
    chmod 0640 "$ENV_FILE"
    log "  Created $ENV_FILE"
fi

# --------------------------------------------------------------------------- 7. App directory
log "Step 7: Prepare /opt/shared-agents-memory"

if [[ -d /opt/shared-agents-memory ]]; then
    log "  /opt/shared-agents-memory already exists."
else
    mkdir -p /opt/shared-agents-memory
    chown sam:sam /opt/shared-agents-memory
    log "  Created /opt/shared-agents-memory"
fi

# --------------------------------------------------------------------------- done
cat <<'EOF'

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 shared-agents-memory bootstrap complete — next steps
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. FILL IN /etc/shared-agents-memory/.env
   Open the file and set ALL required values:
     - OPENROUTER_API_KEY
     - HTTP_PUBLIC_ORIGIN  (e.g. https://memory.example.com)
     - SAM_PAT_PEPPER      (generate: openssl rand -hex 32)

2. POINT DNS
   Create an A record for your domain pointing to this server's IP.

3. OBTAIN A TLS CERTIFICATE (nginx)
     certbot --nginx -d memory.example.com
   Or if using Caddy, it handles this automatically.

4. CONFIGURE THE REVERSE PROXY
   Copy the reference config from your repo:

   nginx:  cp deploy/nginx.conf /etc/nginx/sites-available/shared-agents-memory
           # Edit the file and replace memory.example.com with your domain.
           ln -s /etc/nginx/sites-available/shared-agents-memory \
                   /etc/nginx/sites-enabled/shared-agents-memory
           nginx -t && systemctl reload nginx

   Caddy:  cp deploy/Caddyfile /etc/caddy/Caddyfile
           # Edit the file and replace memory.example.com with your domain.
           caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy

5. CLONE THE REPO AND START THE STACK
     cd /opt/shared-agents-memory
     git clone https://github.com/tachkovsa/shared-agents-memory.git .
     set -a && source /etc/shared-agents-memory/.env && set +a
     docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
     docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

6. READ THE BOOTSTRAP PAT
   On first boot the server writes a bootstrap PAT to stderr.
   View it with:
     docker logs sam-mcp 2>&1 | grep -i 'bootstrap\|pat'
   Store this PAT securely — it is shown only once.

7. VERIFY HEALTH
     curl -s http://127.0.0.1:8080/healthz     # should return {"status":"ok"}
     curl -s http://127.0.0.1:8080/metrics     # Prometheus metrics (loopback only)

8. METRICS
   /metrics is blocked at the proxy layer. Access it from the server:
     curl http://127.0.0.1:8080/metrics

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 See docs/ops/vds-deploy.md for the full operator runbook.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF
