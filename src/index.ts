import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  deriveBootstrapPaths,
  loadOrInitPepper,
  PatStore,
  PEPPER_ENV_VAR,
  runBootstrapIfNeeded,
} from './auth/index.js';
import { loadConfig } from './config.js';
import { EmbeddingClient } from './embeddings.js';
import { createQdrantClient, initCollection } from './qdrant.js';
import { registerTools } from './tools.js';

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
  await runBootstrapIfNeeded({
    dataDir: config.storage.dataDir,
    patStore,
    paths,
  });

  const qdrant = createQdrantClient(config);
  await initCollection(qdrant, config.qdrant.collectionName);

  const embeddings = new EmbeddingClient(config);

  const server = new McpServer({
    name: 'shared-agents-memory',
    version: '0.1.0',
  });

  registerTools(server, { qdrant, embeddings, config });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
