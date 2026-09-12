import { createServer } from 'node:http';
import type { APIRequestContext } from '@playwright/test';
import { request as playwrightRequest } from '@playwright/test';
import { describe, expect, test, vi } from 'vitest';
import {
  authenticatedE2EFetch,
  createAuthenticatedE2ERequest,
} from '../../tests/helpers/authenticated-request';

const OPERATOR_CREDENTIAL = 'a'.repeat(43);
const env = {
  PW_BASE_URL: 'http://localhost:5274',
  PW_API_BASE_URL: 'http://localhost:3242',
  STATION_E2E_HOST_CREDENTIAL: OPERATOR_CREDENTIAL,
};

describe('authenticated E2E request fixture', () => {
  test('uses fresh sockets for fixture writes and does not retry an ambiguous reset', async () => {
    const sockets = new Set();
    let writes = 0;
    const server = createServer((req, res) => {
      sockets.add(req.socket);
      writes += 1;
      if (req.url === '/reset') req.socket.destroy();
      else res.end('ok');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing test listener');
    const url = `http://127.0.0.1:${address.port}`;
    const context = await playwrightRequest.newContext();
    try {
      const client = createAuthenticatedE2ERequest(context, {
        ...env,
        PW_API_BASE_URL: url,
      });
      expect((await client.post(`${url}/first`)).ok()).toBe(true);
      expect((await client.post(`${url}/second`)).ok()).toBe(true);
      expect(sockets.size).toBe(2);
      await expect(client.post(`${url}/reset`)).rejects.toThrow(
        /ECONNRESET|socket hang up/,
      );
      expect(writes).toBe(3);
    } finally {
      await context.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  test('adds the operator bearer only to an explicitly authenticated call', async () => {
    const get = vi.fn().mockResolvedValue({ ok: () => true });
    const authenticated = createAuthenticatedE2ERequest(
      { get } as unknown as APIRequestContext,
      env,
    );

    await authenticated.get('http://localhost:3242/api/system/status', {
      headers: { Accept: 'application/json' },
    });

    expect(get).toHaveBeenCalledWith(
      'http://localhost:3242/api/system/status',
      {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
          connection: 'close',
        },
      },
    );
  });

  test('refuses to send the bearer to a cross-origin target', () => {
    const get = vi.fn();
    const authenticated = createAuthenticatedE2ERequest(
      { get } as unknown as APIRequestContext,
      env,
    );

    expect(() => authenticated.get('https://example.test/protected')).toThrow(
      'refused unowned origin https://example.test',
    );
    expect(get).not.toHaveBeenCalled();
  });

  test('does not impose a hop-by-hop close header on UI-proxied calls', async () => {
    const post = vi.fn().mockResolvedValue({ ok: () => true });
    const client = createAuthenticatedE2ERequest(
      { post } as unknown as APIRequestContext,
      env,
    );
    await client.post('/api/connections', { data: { name: 'fixture' } });
    expect(post.mock.calls[0]?.[1].headers).not.toHaveProperty('connection');
    expect(post.mock.calls[0]?.[1].headers.authorization).toBe(
      `Bearer ${OPERATOR_CREDENTIAL}`,
    );
  });

  test('fails closed without the runner credential', () => {
    expect(() =>
      createAuthenticatedE2ERequest({} as APIRequestContext, {
        PW_BASE_URL: env.PW_BASE_URL,
        PW_API_BASE_URL: env.PW_API_BASE_URL,
      }),
    ).toThrow('operator credential is missing or malformed');
  });

  test('authenticates runner-owned Node fetches without exposing the bearer cross-origin', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await authenticatedE2EFetch(
        'http://localhost:3242/api/plugins/install',
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        env,
      );
      const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(new Headers(init.headers).get('content-type')).toBe(
        'application/json',
      );
      expect(new Headers(init.headers).get('authorization')).toBe(
        `Bearer ${OPERATOR_CREDENTIAL}`,
      );
      expect(() =>
        authenticatedE2EFetch('https://example.test/protected', {}, env),
      ).toThrow('refused unowned origin https://example.test');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
