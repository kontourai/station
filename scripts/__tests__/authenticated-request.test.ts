import type { APIRequestContext } from '@playwright/test';
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
