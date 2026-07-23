import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { QdrantClient } from '@qdrant/js-client-rest';
import type { PatStore } from '../auth/pat-store.js';
import type { MemoryService } from '../memory/service.js';
import { createAdminApp } from './api/app.js';
import { Argon2idPasswordHasher } from './auth/password.js';
import { SessionService } from './auth/session-service.js';
import { FileSetupTokenStore, setupTokenPath } from './auth/setup-token.js';
import { openDb } from './stores/db.js';
import { SqliteOperatorStore } from './stores/operator-store.js';
import { SqliteSessionStore } from './stores/session-store.js';

export interface AdminServerOptions {
  dataDir: string;
  bindHost?: string;
  bindPort?: number;
  cookieSecure?: boolean;
  trustProxy?: boolean;
  /** Override the built-SPA directory; defaults to dist/admin-public next to this file. */
  staticDir?: string;
  /** Shared PatStore (opened with the server pepper) — enables PAT management routes. */
  patStore?: PatStore;
  /** MemoryService over the engine's Qdrant — enables the memory browser routes. */
  memoryService?: MemoryService;
  /** Engine Qdrant client — enables the verifiable operator hard-delete route (needs `collection`). */
  qdrant?: QdrantClient;
  /** Qdrant collection the memories live in — required alongside `qdrant` for hard-delete. */
  collection?: string;
  /** Enables the observability summary route (health + counts + metrics). */
  observability?: {
    qdrant: QdrantClient;
    collection: string;
    version: string;
    getBreakerState?: () => string;
  };
}

export interface AdminServer {
  url: string;
  close(): Promise<void>;
}

/**
 * Start the admin console as its own Fastify listener (ADR-0008 §3.2). Additive
 * and opt-in — wired in `src/index.ts` only when ADMIN_ENABLED=true, so the MCP
 * container's default behaviour is unchanged.
 */
export async function startAdminServer(opts: AdminServerOptions): Promise<AdminServer> {
  const db = openDb(join(opts.dataDir, 'admin.sqlite'));
  const operators = new SqliteOperatorStore(db);
  const sessions = new SessionService({
    operators,
    sessions: new SqliteSessionStore(db),
    hasher: new Argon2idPasswordHasher(),
  });

  const setupTokens = new FileSetupTokenStore(setupTokenPath(opts.dataDir));
  const app = await createAdminApp({
    sessions,
    operators,
    cookieSecure: opts.cookieSecure ?? true,
    trustProxy: opts.trustProxy ?? false,
    staticDir: resolveStaticDir(opts.staticDir),
    setupTokens,
    dataDir: opts.dataDir,
    patStore: opts.patStore,
    memoryService: opts.memoryService,
    qdrant: opts.qdrant,
    collection: opts.collection,
    observability: opts.observability,
  });
  app.addHook('onClose', () => {
    db.close();
  });

  const host = opts.bindHost ?? '127.0.0.1';
  const port = opts.bindPort ?? 8081;
  const url = await app.listen({ host, port });

  if (await sessions.needsSetup()) {
    const token = await setupTokens.ensureToken();
    printSetupBanner(url, opts.dataDir, token);
  }

  return {
    url,
    async close() {
      await app.close();
    },
  };
}

function printSetupBanner(url: string, dataDir: string, token: string | null): void {
  const tokenPath = setupTokenPath(dataDir);
  if (token) {
    process.stderr.write(
      '\n===============================================================\n' +
        'ADMIN SETUP TOKEN — needed to create the first operator\n\n' +
        `    ${token}\n\n` +
        `Also written to: ${tokenPath} (mode 0600).\n` +
        `Create the first operator at ${url}, then this token is consumed.\n` +
        '===============================================================\n\n',
    );
  } else {
    process.stderr.write(
      `[admin] awaiting first-operator setup at ${url} — token in ${tokenPath}\n`,
    );
  }
}

function resolveStaticDir(explicit?: string): string | undefined {
  // This file is dist/admin/server.js at runtime; the built SPA is dist/admin-public.
  const candidate = explicit ?? join(import.meta.dirname, '..', 'admin-public');
  return existsSync(join(candidate, 'index.html')) ? candidate : undefined;
}
