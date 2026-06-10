import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createAdminApp } from './api/app.js';
import { Argon2idPasswordHasher } from './auth/password.js';
import { SessionService } from './auth/session-service.js';
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

  const app = await createAdminApp({
    sessions,
    operators,
    cookieSecure: opts.cookieSecure ?? true,
    trustProxy: opts.trustProxy ?? false,
    staticDir: resolveStaticDir(opts.staticDir),
  });
  app.addHook('onClose', () => {
    db.close();
  });

  const host = opts.bindHost ?? '127.0.0.1';
  const port = opts.bindPort ?? 8081;
  const url = await app.listen({ host, port });

  if (await sessions.needsSetup()) {
    process.stderr.write(
      `[admin] no operator yet — open the console and create the first one at ${url}\n`,
    );
  }

  return {
    url,
    async close() {
      await app.close();
    },
  };
}

function resolveStaticDir(explicit?: string): string | undefined {
  // This file is dist/admin/server.js at runtime; the built SPA is dist/admin-public.
  const candidate = explicit ?? join(import.meta.dirname, '..', 'admin-public');
  return existsSync(join(candidate, 'index.html')) ? candidate : undefined;
}
