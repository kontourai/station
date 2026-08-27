import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authenticatedFetch,
  getJson,
  setClientCredentialResolver,
} from '../client/http.js';
import { setClientOriginResolver } from '../client-origin.js';

afterEach(() => {
  setClientOriginResolver(undefined);
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

describe('SDK client origin transport', () => {
  it('adds one reported-origin header through both central request paths', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    setClientOriginResolver(() => ({
      version: 1,
      surface: 'desktop',
      build: '1.2.3+abc',
    }));
    setClientCredentialResolver(() => ({ origin: 'http://station.test' }));

    await getJson('http://station.test/api/tasks');
    await authenticatedFetch('http://station.test/api/tasks', {
      method: 'POST',
    });

    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).get(
        'x-station-client-origin',
      ),
    ).toBe('1;desktop;1.2.3+abc');
    expect(
      new Headers(fetch.mock.calls[1]?.[1]?.headers).get(
        'x-station-client-origin',
      ),
    ).toBe('1;desktop;1.2.3+abc');
  });

  it('never sends reported origin cross-origin or on an omitted-auth request', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    setClientOriginResolver(() => ({
      version: 1,
      surface: 'web',
      build: '1.0.0',
    }));
    setClientCredentialResolver(() => ({ origin: 'http://station.test' }));
    await getJson('http://elsewhere.test/api/tasks');
    await getJson('http://station.test/api/tasks', { authentication: 'omit' });
    for (const call of fetch.mock.calls) {
      expect(
        new Headers(call[1]?.headers).get('x-station-client-origin'),
      ).toBeNull();
    }
  });
});
