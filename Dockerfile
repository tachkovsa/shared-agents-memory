# syntax=docker/dockerfile:1.7
# Multi-stage build for the shared-agents-memory MCP server.
#
# The runtime image is intended for the HTTP transport (ADR-0003 §3.4).
# stdio mode is supported for local dev outside Docker (`npm run dev`).
# Until issue #22 ships the HTTP transport, the docker-compose `mcp` service
# is parked behind the `http` profile and stays inactive by default.

ARG NODE_VERSION=20-alpine

# ---------- builder ----------
FROM node:${NODE_VERSION} AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

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
