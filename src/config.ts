import 'dotenv/config';

export type TransportMode = 'stdio' | 'http';

/** Embeddings provider selector (ADR-0005). */
export type EmbeddingsProvider = 'openai' | 'gigachat' | 'yandex';

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
    /**
     * Which provider protocol to speak. `openai` (default) covers every
     * OpenAI-compatible endpoint (OpenRouter, OpenAI, vLLM, TEI, …). `gigachat`
     * reuses the OpenAI-shaped client with a cached OAuth token. `yandex` uses
     * the Yandex Cloud Foundation Models protocol. See createEmbeddingClient.
     */
    provider?: EmbeddingsProvider;
    apiKey: string;
    baseUrl: string;
    model: string;
    embeddingDimension: number;
    /** GigaChat OAuth scope (provider=gigachat). Default GIGACHAT_API_PERS. */
    scope?: string;
    /** Yandex Cloud folder id (provider=yandex) — required to build the model URI. */
    folderId?: string;
    /** Yandex auth method (provider=yandex): `API_KEY` (default) or `IAM_TOKEN`. */
    authMethod?: string;
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

/** Default embeddings base URL per provider when EMBEDDINGS_BASE_URL is unset. */
function defaultEmbeddingsBaseUrl(provider: EmbeddingsProvider): string {
  switch (provider) {
    case 'gigachat':
      return 'https://gigachat.devices.sberbank.ru/api/v1';
    case 'yandex':
      return 'https://llm.api.cloud.yandex.net/foundationModels/v1';
    case 'openai':
    default:
      return 'https://openrouter.ai/api/v1';
  }
}

/** Default embeddings model per provider when EMBEDDINGS_MODEL is unset. */
function defaultEmbeddingsModel(provider: EmbeddingsProvider): string {
  switch (provider) {
    case 'gigachat':
      return 'Embeddings';
    case 'yandex':
      return 'text-search-doc';
    case 'openai':
    default:
      return 'qwen/qwen3-embedding-8b';
  }
}

export function loadConfig(): Config {
  const transport = (process.env['TRANSPORT'] ?? 'stdio') as TransportMode;
  if (transport !== 'stdio' && transport !== 'http') {
    throw new Error(`TRANSPORT must be "stdio" or "http", got: ${transport}`);
  }

  const embeddingsProvider = (process.env['EMBEDDINGS_PROVIDER'] ?? 'openai') as EmbeddingsProvider;
  if (!['openai', 'gigachat', 'yandex'].includes(embeddingsProvider)) {
    throw new Error(
      `EMBEDDINGS_PROVIDER must be "openai", "gigachat" or "yandex", got: ${embeddingsProvider}`,
    );
  }
  // Yandex builds an emb://<folder>/<model> URI, so the folder id is mandatory.
  if (embeddingsProvider === 'yandex' && !process.env['EMBEDDINGS_FOLDER_ID']) {
    throw new Error('EMBEDDINGS_FOLDER_ID is required when EMBEDDINGS_PROVIDER=yandex.');
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
      provider: embeddingsProvider,
      apiKey: requireEnv('EMBEDDINGS_API_KEY'),
      // Base URL / model defaults depend on the provider so a minimal
      // gigachat/yandex config (just provider + key + folder) works out of the box.
      baseUrl: process.env['EMBEDDINGS_BASE_URL'] ?? defaultEmbeddingsBaseUrl(embeddingsProvider),
      model: process.env['EMBEDDINGS_MODEL'] ?? defaultEmbeddingsModel(embeddingsProvider),
      // ADR-0010 §3.3: provider-driven, configurable. Default 1024 (bge-m3,
      // self-host profile). Cloud qwen3 = 4096; GigaChat = 1024; Yandex = 256.
      embeddingDimension: clampInt(parseIntEnv('EMBEDDINGS_DIMENSION', 1024), 1, 65_536),
      scope: process.env['EMBEDDINGS_SCOPE'] ?? 'GIGACHAT_API_PERS',
      folderId: process.env['EMBEDDINGS_FOLDER_ID'] || undefined,
      authMethod: process.env['EMBEDDINGS_AUTH_METHOD'] ?? 'API_KEY',
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
