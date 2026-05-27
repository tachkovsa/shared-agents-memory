import 'dotenv/config';

export interface Config {
  openRouter: {
    apiKey: string;
    baseUrl: string;
    model: string;
    embeddingDimension: number;
  };
  qdrant: {
    url: string;
    apiKey?: string;
    collectionName: string;
  };
  server: {
    port: number;
  };
  storage: {
    dataDir: string;
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    openRouter: {
      apiKey: requireEnv('OPENROUTER_API_KEY'),
      baseUrl:
        process.env['OPENROUTER_BASE_URL'] ??
        'https://openrouter.ai/api/v1',
      model: process.env['OPENROUTER_MODEL'] ?? 'qwen/qwen3-embedding-8b',
      embeddingDimension: 4096,
    },
    qdrant: {
      url: process.env['QDRANT_URL'] ?? 'http://localhost:6333',
      apiKey: process.env['QDRANT_API_KEY'] || undefined,
      collectionName:
        process.env['QDRANT_COLLECTION'] ?? 'agent_memories',
    },
    server: {
      port: Number(process.env['MCP_SERVER_PORT'] ?? '3000'),
    },
    storage: {
      dataDir: process.env['DATA_DIR'] ?? './data',
    },
  };
}
