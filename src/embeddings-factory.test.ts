import { describe, expect, it, vi } from 'vitest';
import { createEmbeddingClient } from './embeddings-factory.js';
import type { FetchImpl } from './embeddings.js';
import type { Config, EmbeddingsProvider } from './config.js';

function makeConfig(embeddings: Partial<Config['embeddings']> & { provider?: EmbeddingsProvider }): Config {
  return {
    embeddings: {
      apiKey: 'the-key',
      baseUrl: 'https://provider.test/v1',
      model: 'model-x',
      embeddingDimension: 4,
      ...embeddings,
    },
    qdrant: { url: 'http://localhost:6333', collectionName: 'test' },
    server: { port: 3000 },
    storage: { dataDir: './data' },
  } as Config;
}

const vec4 = [0.1, 0.2, 0.3, 0.4];

function embeddingsResponse(vectors: number[][]): Response {
  return new Response(
    JSON.stringify({ data: vectors.map((embedding) => ({ embedding })), usage: { total_tokens: 1 } }),
    { status: 200 },
  );
}

function oauthResponse(token: string): Response {
  return new Response(JSON.stringify({ access_token: token }), { status: 200 });
}

describe('createEmbeddingClient', () => {
  it('openai (default): uses the static Bearer key directly', async () => {
    const fetch = vi.fn<FetchImpl>().mockResolvedValue(embeddingsResponse([vec4]));
    const client = createEmbeddingClient(makeConfig({ provider: 'openai' }), { fetchImpl: fetch });

    await client.embed('hi');

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://provider.test/v1/embeddings');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer the-key');
  });

  it('gigachat: exchanges an OAuth token then sends it as Bearer, reusing the cache', async () => {
    const fetch = vi.fn<FetchImpl>().mockImplementation((url) => {
      if (String(url).includes('/oauth')) return Promise.resolve(oauthResponse('gc-token'));
      return Promise.resolve(embeddingsResponse([vec4]));
    });
    const config = makeConfig({
      provider: 'gigachat',
      baseUrl: 'https://gigachat.devices.sberbank.ru/api/v1',
    });
    const client = createEmbeddingClient(config, { fetchImpl: fetch });

    await client.embed('one');
    await client.embed('two');

    const oauthCalls = fetch.mock.calls.filter(([u]) => String(u).includes('/oauth'));
    const embedCalls = fetch.mock.calls.filter(([u]) => String(u).endsWith('/embeddings'));
    expect(oauthCalls).toHaveLength(1); // token cached across both embeds
    expect(embedCalls).toHaveLength(2);
    expect((embedCalls[0][1].headers as Record<string, string>)['Authorization']).toBe('Bearer gc-token');
  });

  it('yandex: posts to /textEmbedding with Api-Key auth and x-folder-id', async () => {
    const fetch = vi.fn<FetchImpl>().mockResolvedValue(
      new Response(JSON.stringify({ embedding: vec4 }), { status: 200 }),
    );
    const config = makeConfig({
      provider: 'yandex',
      baseUrl: 'https://llm.api.cloud.yandex.net/foundationModels/v1',
      folderId: 'b1gxxxx',
      model: 'text-search-doc',
    });
    const client = createEmbeddingClient(config, { fetchImpl: fetch });

    const out = await client.embed('привет');

    expect(out).toEqual(vec4);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://llm.api.cloud.yandex.net/foundationModels/v1/textEmbedding');
    const h = init.headers as Record<string, string>;
    expect(h['Authorization']).toBe('Api-Key the-key');
    expect(h['x-folder-id']).toBe('b1gxxxx');
    expect(JSON.parse(init.body as string).modelUri).toBe('emb://b1gxxxx/text-search-doc');
  });

  it('yandex: throws when folderId is missing', () => {
    expect(() => createEmbeddingClient(makeConfig({ provider: 'yandex' }))).toThrow(/FOLDER_ID/);
  });
});
