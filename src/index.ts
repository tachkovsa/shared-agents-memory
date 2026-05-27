import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  AuthAuditWriter,
  AuthError,
  auditPathForDataDir,
  deriveBootstrapPaths,
  loadOrInitPepper,
  PatStore,
  PEPPER_ENV_VAR,
  resolvePat,
  resolveSampleRate,
  runBootstrapIfNeeded,
} from './auth/index.js';
import { loadConfig } from './config.js';
import { EmbeddingClient } from './embeddings.js';
import { createQdrantClient, initCollection } from './qdrant.js';
import { registerTools } from './tools.js';

const STDIO_PAT_ENV_VAR = 'LOCAL_STDIO_AGENT_PAT';

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

  const sessionSecret = process.env[STDIO_PAT_ENV_VAR];
  if (!sessionSecret) {
    if (bootstrap.bootstrapped) {
      process.stderr.write(
        `\n${STDIO_PAT_ENV_VAR} is not set. Copy the bootstrap token above, ` +
          `set it as ${STDIO_PAT_ENV_VAR}, and restart the server.\n`,
      );
    } else {
      process.stderr.write(
        `\n${STDIO_PAT_ENV_VAR} is not set. The server cannot accept tool calls ` +
          `without an agent identity bound at startup. Set ${STDIO_PAT_ENV_VAR} to a ` +
          `valid sam_pat_* token and restart.\n`,
      );
    }
    process.exit(1);
  }

  let sessionPat;
  try {
    sessionPat = resolvePat(patStore, sessionSecret);
  } catch (err) {
    if (err instanceof AuthError) {
      process.stderr.write(
        `\nFailed to resolve ${STDIO_PAT_ENV_VAR}: ${err.reason} — ${err.message}.\n`,
      );
      process.exit(1);
    }
    throw err;
  }

  const auditor = new AuthAuditWriter({
    path: auditPathForDataDir(config.storage.dataDir),
    successSampleRate: resolveSampleRate(process.env),
  });

  const qdrant = createQdrantClient(config);
  await initCollection(qdrant, config.qdrant.collectionName);

  const embeddings = new EmbeddingClient(config);

  const server = new McpServer({
    name: 'shared-agents-memory',
    version: '0.1.0',
  });

  registerTools(server, {
    qdrant,
    embeddings,
    config,
    sessionPat,
    auditor,
    dataDir: config.storage.dataDir,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
