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

COPY package.json package-lock.json ./
RUN npm ci

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

USER node

CMD ["node", "dist/index.js"]
