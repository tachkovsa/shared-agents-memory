/**
 * Provider factory — resolves EMBEDDINGS_PROVIDER to a concrete
 * EmbeddingProvider. Kept separate from embeddings.ts so the Yandex client
 * (which imports primitives FROM embeddings.ts) can be wired in without an
 * import cycle.
 *
 *   openai   (default) — OpenAI-compatible: OpenRouter, OpenAI, vLLM, TEI, …
 *                        static Bearer key.
 *   gigachat           — OpenAI-shaped body, but a cached OAuth token (Sber).
 *   yandex             — Yandex Cloud Foundation Models (distinct protocol).
 */

import type { Config } from './config.js';
import { EmbeddingClient, type EmbeddingClientOptions, type EmbeddingProvider } from './embeddings.js';
import { GigaChatAuth } from './embeddings-auth.js';
import { YandexEmbeddingClient } from './embeddings-yandex.js';

export function createEmbeddingClient(
  config: Config,
  opts: EmbeddingClientOptions = {},
): EmbeddingProvider {
  const provider = config.embeddings.provider ?? 'openai';

  switch (provider) {
    case 'yandex':
      return new YandexEmbeddingClient(config, opts);

    case 'gigachat':
      // GigaChat's /embeddings is OpenAI-shaped ({model,input} -> {data:[{embedding}]}),
      // so the standard client works once auth is swapped for the OAuth token flow.
      return new EmbeddingClient(config, {
        ...opts,
        auth: new GigaChatAuth({
          apiKey: config.embeddings.apiKey,
          scope: config.embeddings.scope,
          // Share the caller's fetch (and thus its test double / instrumentation)
          // with the OAuth exchange so it isn't a second, unmockable transport.
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        }),
      });

    case 'openai':
      return new EmbeddingClient(config, opts);

    default: {
      // Exhaustiveness guard — a new provider added to the union without a case
      // here trips the compiler.
      const _never: never = provider;
      throw new Error(`Unknown EMBEDDINGS_PROVIDER: ${String(_never)}`);
    }
  }
}
