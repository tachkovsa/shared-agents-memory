# syntax=docker/dockerfile:1.7
# Multi-stage build for the shared-agents-memory MCP server (+ optional admin console).
#
# The runtime image serves the HTTP transport (ADR-0003 §3.4) and, when
# ADMIN_ENABLED=true, the admin console (ADR-0008) on a separate port.
# stdio mode is supported for local dev outside Docker (`npm run dev`).
#
# Base image is Debian slim (glibc), not Alpine (musl): the admin console pulls
# native modules (better-sqlite3, @node-rs/argon2) whose prebuilt binaries
# target glibc. glibc avoids a source compile in the builder.

ARG NODE_VERSION=20-bookworm-slim

# ---------- builder ----------
FROM node:${NODE_VERSION} AS builder

WORKDIR /app

# Toolchain for native modules. @node-rs/argon2 ships prebuilt binaries, but
# better-sqlite3 compiles from source when no prebuilt matches the build arch
# (e.g. linux/arm64). These live in the builder only — the runtime stays slim
# and receives the already-compiled .node files via the node_modules copy.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# rollup and @tailwindcss/oxide pull platform-specific native binaries via
# optionalDependencies. A macOS-generated lockfile pins the darwin variants and
# npm won't backfill the linux ones (npm/cli#4828), so `npm ci` / `npm install`
# leave rollup's native binding missing in the container. Dropping the lockfile
# forces a clean platform-correct resolution — works in local Docker (arm64) and
# GHA (x64) alike. package.json ranges still bound the versions.
RUN rm -f package-lock.json && npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

# Build the server (tsc -> dist) and the admin SPA (vite -> dist/admin-public).
RUN npm run build && npm run build:web

# Drop dev dependencies in-place so they can be copied wholesale to runtime.
RUN npm prune --omit=dev

# ---------- runtime ----------
FROM node:${NODE_VERSION} AS runtime

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# Run as the unprivileged `node` user shipped with the base image (uid/gid 1000).
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# Extra CA certs (e.g. the Минцифры root for GigaChat). The dir ships tracked
# with just a README; if an operator drops a PEM in before building, it bundles
# into the image. Activate it with NODE_EXTRA_CA_CERTS (see certs/README.md).
COPY --chown=node:node certs ./certs

USER node

CMD ["node", "dist/index.js"]
