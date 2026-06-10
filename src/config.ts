import 'dotenv/config';

export type TransportMode = 'stdio' | 'http';

/** Qdrant vector quantization config (ADR-0010 §3.4). */
export interface QdrantQuantizationConfig {
  /** `int8` scalar quantization, or `none` to disable. */
  mode: 'int8' | 'none';
  /** Re-rank quantized candidates against on-disk originals. */
  rescore: boolean;
  /** Fetch this multiple of `limit` candidates before rescoring. */
  oversampling: number;
}

export interface HttpTransportConfig {
  bindHost: string;
  bindPort: number;
  publicOrigin: string;
  sessionIdleMs: number;
  maxSessions: number;
  maxInflightPerSession: number;
  keepaliveSec: number;
}

export interface Config {
  transport: TransportMode;
  http: HttpTransportConfig;
  /**
   * Embeddings provider configuration. Targets the OpenAI-compatible
   * `/embeddings` endpoint — works with OpenRouter, OpenAI proper, vLLM,
   * Together, Anyscale, Ollama (OpenAI-compat mode), llama.cpp server, etc.
   * Default base URL + model stay OpenRouter+qwen3 (ADR-0005); override via
   * the `EMBEDDINGS_*` env vars.
   */
  embeddings: {
    apiKey: string;
    baseUrl: string;
    model: string;
    embeddingDimension: number;
  };
  qdrant: {
    url: string;
    apiKey?: string;
    collectionName: string;
    /** Vector quantization for RAM economy (ADR-0010 §3.4). */
    quantization: QdrantQuantizationConfig;
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

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function parseIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = parseInt(raw, 10);
  return isNaN(n) ? defaultValue : n;
}

function parseFloatEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

export function loadConfig(): Config {
  const transport = (process.env['TRANSPORT'] ?? 'stdio') as TransportMode;
  if (transport !== 'stdio' && transport !== 'http') {
    throw new Error(`TRANSPORT must be "stdio" or "http", got: ${transport}`);
  }

  const bindHost = process.env['HTTP_BIND_HOST'] ?? '127.0.0.1';
  const publicOrigin = process.env['HTTP_PUBLIC_ORIGIN'] ?? '';

  // Fail fast when TRANSPORT=http and HTTP_PUBLIC_ORIGIN is not set.
  if (transport === 'http' && !publicOrigin) {
    throw new Error(
      'HTTP_PUBLIC_ORIGIN is required when TRANSPORT=http. ' +
        'Set it to the public-facing origin, e.g. https://memory.example.com',
    );
  }

  // Warn at startup when binding to 0.0.0.0 without an explicit origin.
  if (bindHost === '0.0.0.0' && !publicOrigin) {
    process.stderr.write(
      'WARNING: HTTP_BIND_HOST=0.0.0.0 without HTTP_PUBLIC_ORIGIN. ' +
        'The MCP server is exposed on all interfaces with no Origin check. ' +
        'Set HTTP_PUBLIC_ORIGIN intentionally or bind to 127.0.0.1 instead.\n',
    );
  }

  const sessionIdleMin = clampInt(
    parseIntEnv('MCP_HTTP_SESSION_IDLE_MIN', 15),
    5,
    60,
  );
  const keepaliveSec = clampInt(
    parseIntEnv('MCP_HTTP_KEEPALIVE_SEC', 30),
    5,
    300,
  );

  return {
    transport,
    http: {
      bindHost,
      bindPort: parseIntEnv('HTTP_BIND_PORT', 8080),
      publicOrigin,
      sessionIdleMs: sessionIdleMin * 60_000,
      maxSessions: clampInt(
        parseIntEnv('MCP_HTTP_MAX_SESSIONS', 64),
        1,
        10_000,
      ),
      maxInflightPerSession: clampInt(
        parseIntEnv('MCP_HTTP_MAX_INFLIGHT_PER_SESSION', 8),
        1,
        1_000,
      ),
      keepaliveSec,
    },
    embeddings: {
      apiKey: requireEnv('EMBEDDINGS_API_KEY'),
      baseUrl:
        process.env['EMBEDDINGS_BASE_URL'] ??
        'https://openrouter.ai/api/v1',
      model: process.env['EMBEDDINGS_MODEL'] ?? 'qwen/qwen3-embedding-8b',
      // ADR-0010 §3.3: provider-driven, configurable. Default 1024 (bge-m3,
      // self-host profile). Cloud qwen3 deployments set EMBEDDINGS_DIMENSION=4096.
      embeddingDimension: clampInt(parseIntEnv('EMBEDDINGS_DIMENSION', 1024), 1, 65_536),
    },
    qdrant: {
      url: process.env['QDRANT_URL'] ?? 'http://localhost:6333',
      apiKey: process.env['QDRANT_API_KEY'] || undefined,
      collectionName:
        process.env['QDRANT_COLLECTION'] ?? 'agent_memories',
      quantization: {
        mode: process.env['QDRANT_QUANTIZATION'] === 'none' ? 'none' : 'int8',
        rescore: process.env['QDRANT_RESCORE'] !== 'false',
        oversampling: parseFloatEnv('QDRANT_OVERSAMPLING', 2.0),
      },
    },
    server: {
      port: Number(process.env['MCP_SERVER_PORT'] ?? '3000'),
    },
    storage: {
      dataDir: process.env['DATA_DIR'] ?? './data',
    },
  };
}
