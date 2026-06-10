import { startAdminServer } from './admin/server.js';
import {
  deriveBootstrapPaths,
  loadOrInitPepper,
  PatStore,
  PEPPER_ENV_VAR,
  runBootstrapIfNeeded,
} from './auth/index.js';
import { loadConfig } from './config.js';
import { EmbeddingClient } from './embeddings.js';
import { MemoryService } from './memory/service.js';
import { promEmbeddingMetrics } from './metrics/embeddings.js';
import { createQdrantClient } from './qdrant.js';
import { runHttpTransport } from './transport/http.js';
import { runStdioTransport } from './transport/stdio.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const paths = deriveBootstrapPaths(config.storage.dataDir);
  const pepper = await loadOrInitPepper({
    pepperFilePath: paths.pepperFilePath,
    envValue: process.env[PEPPER_ENV_VAR],
  });
  const patStore = await PatStore.open({
    storePath: paths.patsJsonlPath,
    pepper,
  });
  const bootstrap = await runBootstrapIfNeeded({
    dataDir: config.storage.dataDir,
    patStore,
    paths,
  });

  if (config.transport === 'stdio' && bootstrap.bootstrapped) {
    process.stderr.write(
      '\nBootstrap complete. Set LOCAL_STDIO_AGENT_PAT to the token above and restart.\n',
    );
  }

  const qdrant = createQdrantClient(config);
  const embeddings = new EmbeddingClient(config, { metrics: promEmbeddingMetrics });

  // Admin console — additive and opt-in (ADR-0008 §3.2). Off unless ADMIN_ENABLED=true,
  // so the default MCP container behaves exactly as before. Separate listener; the
  // MCP transport below is untouched.
  if (process.env['ADMIN_ENABLED'] === 'true') {
    // A read/delete MemoryService for the console memory browser (no embedding on
    // these paths). Shares the engine's Qdrant client.
    const adminMemory = new MemoryService({
      qdrant,
      embeddings,
      collection: config.qdrant.collectionName,
    });
    const admin = await startAdminServer({
      dataDir: config.storage.dataDir,
      bindHost: process.env['ADMIN_BIND_HOST'] ?? '127.0.0.1',
      bindPort: Number(process.env['ADMIN_BIND_PORT'] ?? '8081'),
      cookieSecure: process.env['ADMIN_COOKIE_SECURE'] !== 'false',
      trustProxy: process.env['ADMIN_TRUST_PROXY'] === 'true',
      // Share the engine's PatStore instance so operator-minted PATs and
      // agent-side lookups stay consistent in-process.
      patStore,
      memoryService: adminMemory,
    });
    process.stderr.write(`[admin] console listening on ${admin.url}\n`);
  }

  if (config.transport === 'http') {
    await runHttpTransport({ config, patStore, pepper, qdrant, embeddings });
  } else {
    await runStdioTransport({ config, patStore, pepper, qdrant, embeddings });
  }
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
