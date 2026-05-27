/**
 * stdio transport wiring (Mode A — local dev / single-user).
 *
 * ADR-0003 §3.2: The MCP server binary spawns as a child process of one agent
 * client. Credentials are resolved once at startup from LOCAL_STDIO_AGENT_PAT.
 * No HTTP server is started; stdout is reserved for the MCP protocol.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createId } from '@paralleldrive/cuid2';
import type { QdrantClient } from '@qdrant/js-client-rest';
import {
  AuthAuditWriter,
  AuthError,
  PatStore,
  auditPathForDataDir,
  registerPatTools,
  resolvePat,
  resolveSampleRate,
} from '../auth/index.js';
import type { Config } from '../config.js';
import { EmbeddingClient } from '../embeddings.js';
import { MemoryService, registerMemoryTools } from '../memory/index.js';
import { makeOrphanPruneCallback, registerNamespaceTools } from '../namespaces/tools.js';
import { initCollection } from '../qdrant.js';
import { registerRuleTools } from '../rules/index.js';

const STDIO_PAT_ENV_VAR = 'LOCAL_STDIO_AGENT_PAT';

export interface StdioDeps {
  config: Config;
  patStore: PatStore;
  pepper: Buffer;
  qdrant: QdrantClient;
  embeddings: EmbeddingClient;
}

export async function runStdioTransport(deps: StdioDeps): Promise<void> {
  const { config, patStore, pepper, qdrant, embeddings } = deps;

  const sessionSecret = process.env[STDIO_PAT_ENV_VAR];
  if (!sessionSecret) {
    process.stderr.write(
      `\n${STDIO_PAT_ENV_VAR} is not set. The server cannot accept tool calls ` +
        `without an agent identity bound at startup. Set ${STDIO_PAT_ENV_VAR} to a ` +
        `valid sam_pat_* token and restart.\n`,
    );
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

  await initCollection(qdrant, config.qdrant.collectionName);

  const server = new McpServer({
    name: 'shared-agents-memory',
    version: '0.1.0',
  });

  const memoryService = new MemoryService({
    qdrant,
    embeddings,
    collection: config.qdrant.collectionName,
  });

  registerMemoryTools(server, {
    service: memoryService,
    sessionPat,
    auditor,
    dataDir: config.storage.dataDir,
  });

  const sessionId = createId();

  registerPatTools(server, {
    patStore,
    sessionPat,
    auditor,
    sessionId,
    pepper,
    onPatRevoked: makeOrphanPruneCallback(patStore, config.storage.dataDir, auditor),
  });

  registerNamespaceTools(server, {
    patStore,
    sessionPat,
    auditor,
    sessionId,
    pepper,
    dataDir: config.storage.dataDir,
  });

  registerRuleTools(server, {
    sessionPat,
    auditor,
    dataDir: config.storage.dataDir,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
