import { describe, expect, it, vi } from 'vitest';
import {
  GigaChatAuth,
  GigaChatAuthError,
  StaticBearerAuth,
} from './embeddings-auth.js';
import type { FetchImpl } from './embeddings.js';

function oauthResponse(token: string): Response {
  return new Response(JSON.stringify({ access_token: token, expires_at: 0 }), {
    status: 200,
  });
}

describe('StaticBearerAuth', () => {
  it('returns a static Bearer header', async () => {
    const auth = new StaticBearerAuth('sk-secret');
    await expect(auth.authHeaders()).resolves.toEqual({
      Authorization: 'Bearer sk-secret',
    });
  });
});

describe('GigaChatAuth', () => {
  it('exchanges the Basic key for a Bearer token and posts to the OAuth endpoint', async () => {
    const fetch = vi.fn<FetchImpl>().mockResolvedValue(oauthResponse('tok-1'));
    const auth = new GigaChatAuth({ apiKey: 'base64key', fetchImpl: fetch });

    const headers = await auth.authHeaders();

    expect(headers).toEqual({ Authorization: 'Bearer tok-1' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://ngw.devices.sberbank.ru:9443/api/v2/oauth');
    const h = init.headers as Record<string, string>;
    expect(h['Authorization']).toBe('Basic base64key');
    expect(h['RqUID']).toBeTruthy();
    expect(init.body).toBe('scope=GIGACHAT_API_PERS');
  });

  it('honours a custom scope', async () => {
    const fetch = vi.fn<FetchImpl>().mockResolvedValue(oauthResponse('tok'));
    const auth = new GigaChatAuth({ apiKey: 'k', scope: 'GIGACHAT_API_CORP', fetchImpl: fetch });
    await auth.authHeaders();
    expect(fetch.mock.calls[0][1].body).toBe('scope=GIGACHAT_API_CORP');
  });

  it('caches the token across calls until it nears expiry', async () => {
    const fetch = vi.fn<FetchImpl>().mockResolvedValue(oauthResponse('tok-cached'));
    let clock = 1_000;
    const auth = new GigaChatAuth({ apiKey: 'k', fetchImpl: fetch, now: () => clock });

    await auth.authHeaders();
    clock += 10 * 60 * 1000; // +10 min, still inside the 25-min TTL
    const second = await auth.authHeaders();

    expect(second).toEqual({ Authorization: 'Bearer tok-cached' });
    expect(fetch).toHaveBeenCalledTimes(1); // served from cache
  });

  it('refreshes the token once the TTL elapses', async () => {
    const fetch = vi
      .fn<FetchImpl>()
      .mockResolvedValueOnce(oauthResponse('tok-old'))
      .mockResolvedValueOnce(oauthResponse('tok-new'));
    let clock = 0;
    const auth = new GigaChatAuth({ apiKey: 'k', fetchImpl: fetch, now: () => clock });

    const first = await auth.authHeaders();
    clock += 26 * 60 * 1000; // past the 25-min TTL
    const second = await auth.authHeaders();

    expect(first).toEqual({ Authorization: 'Bearer tok-old' });
    expect(second).toEqual({ Authorization: 'Bearer tok-new' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('throws GigaChatAuthError without leaking the response body on a non-2xx', async () => {
    const fetch = vi
      .fn<FetchImpl>()
      .mockResolvedValue(new Response('Basic c2VjcmV0 rejected', { status: 401 }));
    const auth = new GigaChatAuth({ apiKey: 'k', fetchImpl: fetch });

    const err = await auth.authHeaders().catch((e) => e);
    expect(err).toBeInstanceOf(GigaChatAuthError);
    expect((err as GigaChatAuthError).status).toBe(401);
    expect((err as Error).message).not.toContain('c2VjcmV0');
  });

  it('throws when the OAuth response omits access_token', async () => {
    const fetch = vi
      .fn<FetchImpl>()
      .mockResolvedValue(new Response(JSON.stringify({ foo: 'bar' }), { status: 200 }));
    const auth = new GigaChatAuth({ apiKey: 'k', fetchImpl: fetch });
    await expect(auth.authHeaders()).rejects.toBeInstanceOf(GigaChatAuthError);
  });
});
