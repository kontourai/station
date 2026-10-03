import {
  CLIENT_PROTOCOL_HEADER,
  STATION_COMPAT_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authenticatedFetch,
  type ClientAuthenticatedTransport,
  fetchSSE,
  getJson,
  mutateJson,
  setClientCredentialResolver,
} from '../client/http.js';

const STATION = 'https://station.example.test';

afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

function sentProtocol(call: unknown[] | undefined): string | null {
  return new Headers((call?.[1] as RequestInit | undefined)?.headers).get(
    CLIENT_PROTOCOL_HEADER,
  );
}

/** Stands in for a browser page served from `origin`. */
function servePageFrom(origin: string): void {
  vi.stubGlobal('location', { href: `${origin}/`, origin });
}

describe('SDK client protocol header (#2962)', () => {
  it('declares the protocol this build speaks on every central request path', async () => {
    // Pinned beside the constant it is derived from.
    expect(STATION_COMPAT_PROTOCOL_VERSION).toBe(1);
    const fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    setClientCredentialResolver(() => ({
      credential: 'credential',
      origin: STATION,
    }));

    await getJson(`${STATION}/api/tasks`);
    await mutateJson(`${STATION}/api/tasks`, 'POST', undefined, { a: 1 });
    await authenticatedFetch(`${STATION}/api/tasks`, { method: 'POST' });
    // No ambient credential for this origin: still a Station request.
    await authenticatedFetch('https://other.example.test/api/tasks');
    const stream = fetchSSE(`${STATION}/api/events`, {
      onMessage: () => undefined,
      reconnect: false,
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
    stream.close();

    expect(fetch.mock.calls.map((call) => sentProtocol(call))).toEqual([
      '1',
      '1',
      '1',
      '1',
      '1',
    ]);
  });

  it('is the only writer of the header', async () => {
    const fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    await getJson(`${STATION}/api/tasks`, {
      authentication: 'omit',
      headers: { 'x-station-client-protocol': '7' },
    });
    expect(sentProtocol(fetch.mock.calls[0])).toBe('1');
  });

  it('never makes a browser preflight it to another origin over plain fetch', async () => {
    servePageFrom('https://ui.example.test');
    const fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);

    await getJson(`${STATION}/api/tasks`, { authentication: 'omit' });
    await authenticatedFetch(`${STATION}/api/tasks`);
    // The page's own host is the one that served it: no preflight risk.
    await getJson('/api/tasks', { authentication: 'omit' });
    await getJson('https://ui.example.test/api/tasks', {
      authentication: 'omit',
    });

    expect(fetch.mock.calls.map((call) => sentProtocol(call))).toEqual([
      null,
      null,
      '1',
      '1',
    ]);
  });

  it('declares it through a configured transport, which no preflight governs', async () => {
    servePageFrom('tauri://localhost');
    const fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    const transport = vi.fn<ClientAuthenticatedTransport>(
      async () => new Response('{}'),
    );
    setClientCredentialResolver(() => ({ origin: STATION, transport }));

    await getJson(`${STATION}/api/tasks`);
    await mutateJson(`${STATION}/api/tasks`, 'POST');
    await authenticatedFetch(`${STATION}/api/tasks`);

    expect(fetch).not.toHaveBeenCalled();
    expect(transport.mock.calls.map((call) => sentProtocol(call))).toEqual([
      '1',
      '1',
      '1',
    ]);
  });
});
