import {
  deriveBootstrapPaths,
  loadOrInitPepper,
  PatStore,
  PEPPER_ENV_VAR,
  runBootstrapIfNeeded,
} from './auth/index.js';
import { loadConfig } from './config.js';
import { EmbeddingClient } from './embeddings.js';
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
