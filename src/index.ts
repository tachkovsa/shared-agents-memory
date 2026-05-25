import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createQdrantClient, initCollection } from './qdrant.js';
import { EmbeddingClient } from './embeddings.js';
import { registerTools } from './tools.js';

async function main(): Promise<void> {
  const config = loadConfig();

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
