/** @vitest-environment jsdom */

import type { SavedConnection } from '@kontourai/station-connect';
import type { ApplicationSessionContinuation } from '@kontourai/station-contracts/application-session';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  proof: vi.fn(async () => ({
    Origin: window.location.origin,
    'X-Station-Account-Continuation': 'continuation-header',
    'X-Station-Account-Proof': 'fresh-proof',
  })),
  cookieAdopt: vi.fn(),
}));

vi.mock(
  '@kontourai/station-sdk/application-session',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-sdk/application-session')
      >();
    return {
      ...actual,
      ApplicationSessionClient: class {
        headers = mocks.proof;
        adoptCookies = mocks.cookieAdopt;
      },
    };
  },
);

import { createRelayEnrollmentKey } from '@kontourai/station-sdk/relay-enrollment';
import {
  adoptBrowserRelayCookies,
  type BrowserRelayAuthorityStorage,
  createBrowserRelayApplicationCredential,
  installBrowserRelayApplicationAuthority,
  removeBrowserRelayApplicationAuthority,
} from '../browserRelayApplicationAuthority';
import {
  publishBrowserRelayBinding,
  retireBrowserRelayRoute,
} from '../browserRelayRouteBinding';

const stationId = '11111111-1111-4111-8111-111111111111';
const route: NonNullable<SavedConnection['brokerRoute']> = {
  brokerOrigin: 'https://broker.example.test',
  scope: {
    stationId,
    enrollmentId: '22222222-2222-4222-8222-222222222222',
    routingGeneration: 3,
    browserOrigin: window.location.origin,
  },
};
const applicationOrigin = 'https://station.example.test';
const continuation: ApplicationSessionContinuation = {
  version: 'station.application-session/v1',
  credential: 'A'.repeat(43),
  authorityKey: 'account-session-1',
  stationId,
  deviceId: 'device-1',
  principal: { kind: 'human', id: 'human:local:person-1', display: 'Person' },
  requestOrigin: applicationOrigin,
  clientOrigin: window.location.origin,
  keyThumbprint: 'thumbprint',
  nonce: 'N'.repeat(43),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};
const privateKey = {
  extractable: false,
  algorithm: { name: 'ECDSA', namedCurve: 'P-256' },
  usages: ['sign'],
} as unknown as CryptoKey;
const publicKey = {
  kty: 'EC',
  crv: 'P-256',
  x: 'X'.repeat(43),
  y: 'Y'.repeat(43),
} as const;
const key = { privateKey, publicKey, sign: async () => new Uint8Array(64) };

class MemoryStorage implements BrowserRelayAuthorityStorage {
  values = new Map<string, unknown>();
  async read(id: string) {
    return this.values.get(id) ?? null;
  }
  async write(id: string, record: unknown) {
    this.values.set(id, record);
  }
  async remove(id: string) {
    this.values.delete(id);
  }
}

function storageKey(connectionId = 'connection-1') {
  return JSON.stringify([
    connectionId,
    applicationOrigin,
    route.brokerOrigin,
    route.scope.stationId,
    route.scope.enrollmentId,
    route.scope.routingGeneration,
    route.scope.browserOrigin,
    window.location.origin,
  ]);
}

function publish(connectionId = 'connection-1') {
  const transport = vi.fn(
    async (_request: RequestInfo | URL, init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          authorization: new Headers(init?.headers).get('Authorization'),
        }),
      );
    },
  );
  publishBrowserRelayBinding({
    connectionId,
    selectionEpoch: 1,
    route,
    applicationOrigin,
    transport,
    isCurrent: () => true,
    close: vi.fn(),
  });
  return transport;
}

describe('browser relay application authority', () => {
  afterEach(() => {
    retireBrowserRelayRoute();
    mocks.proof.mockClear();
    mocks.cookieAdopt.mockReset();
  });

  it('stores a route-bound Device credential and adds a fresh SDK proof inside the encrypted transport', async () => {
    const transport = publish();
    const storage = new MemoryStorage();
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        JSON.stringify({
          crv: publicKey.crv,
          kty: publicKey.kty,
          x: publicKey.x,
          y: publicKey.y,
        }),
      ),
    );
    const thumbprint = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const authority = { ...continuation, keyThumbprint: thumbprint };
    await installBrowserRelayApplicationAuthority(
      {
        connectionId: 'connection-1',
        applicationOrigin,
        route,
        bearer: { kind: 'device', credential: 'D'.repeat(43) },
        key,
        continuation: authority,
      },
      storage,
    );
    const credential = await createBrowserRelayApplicationCredential({
      connectionId: 'connection-1',
      applicationOrigin,
      route,
      transport,
      routeIsCurrent: () => true,
      storage,
    });
    expect(credential.credential).toBe('D'.repeat(43));
    await credential.transport?.('https://station.example.test/api/projects', {
      method: 'GET',
    });
    expect(mocks.proof).toHaveBeenCalledWith(authority, {
      method: 'GET',
      url: 'https://station.example.test/api/projects',
    });
    const headers = new Headers(transport.mock.calls[0]?.[1]?.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${'D'.repeat(43)}`);
    expect(headers.get('X-Station-Account-Continuation')).toBe(
      'continuation-header',
    );
    expect(headers.get('X-Station-Account-Proof')).toBe('fresh-proof');
  });

  it('installs the exact nonextractable key created for relay enrollment without replacing it', async () => {
    publish();
    const storage = new MemoryStorage();
    const enrollmentKey = await createRelayEnrollmentKey();
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        JSON.stringify({
          crv: enrollmentKey.publicKey.crv,
          kty: enrollmentKey.publicKey.kty,
          x: enrollmentKey.publicKey.x,
          y: enrollmentKey.publicKey.y,
        }),
      ),
    );
    const keyThumbprint = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    await installBrowserRelayApplicationAuthority(
      {
        connectionId: 'connection-1',
        applicationOrigin,
        route,
        bearer: { kind: 'device', credential: 'D'.repeat(43) },
        key: enrollmentKey,
        continuation: { ...continuation, keyThumbprint },
      },
      storage,
    );
    const saved = storage.values.get(storageKey()) as {
      key: { privateKey: CryptoKey; publicKey: typeof enrollmentKey.publicKey };
    };
    expect(saved.key.privateKey).toBe(enrollmentKey.privateKey);
    expect(saved.key.publicKey).toEqual(enrollmentKey.publicKey);
  });

  it('refuses absent, expired, or retired route authority rather than using direct HTTP', async () => {
    const storage = new MemoryStorage();
    const transport = publish();
    await expect(
      createBrowserRelayApplicationCredential({
        connectionId: 'connection-1',
        applicationOrigin,
        route,
        transport,
        routeIsCurrent: () => true,
        storage,
      }),
    ).rejects.toThrow('unavailable or stale');
    expect(transport).not.toHaveBeenCalled();
    retireBrowserRelayRoute('connection-1', 1);
    await expect(
      createBrowserRelayApplicationCredential({
        connectionId: 'connection-1',
        applicationOrigin,
        route,
        transport,
        routeIsCurrent: () => false,
        storage,
      }),
    ).rejects.toThrow('stale');
  });

  it('invalidates an in-flight credential after explicit local revocation', async () => {
    publish();
    const storage = new MemoryStorage();
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        JSON.stringify({
          crv: publicKey.crv,
          kty: publicKey.kty,
          x: publicKey.x,
          y: publicKey.y,
        }),
      ),
    );
    const thumbprint = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    await installBrowserRelayApplicationAuthority(
      {
        connectionId: 'connection-1',
        applicationOrigin,
        route,
        bearer: { kind: 'alias', credential: 'A'.repeat(43) },
        key,
        continuation: { ...continuation, keyThumbprint: thumbprint },
      },
      storage,
    );
    const credential = await createBrowserRelayApplicationCredential({
      connectionId: 'connection-1',
      applicationOrigin,
      route,
      transport: vi.fn(async () => new Response('{}')),
      routeIsCurrent: () => true,
      storage,
    });
    expect(credential.transportBindingIsCurrent?.()).toBe(true);
    await removeBrowserRelayApplicationAuthority(
      { connectionId: 'connection-1', applicationOrigin, route },
      storage,
    );
    expect(credential.transportBindingIsCurrent?.()).toBe(false);
  });

  it('clears only browser application authority after an account 401 callback', async () => {
    publish();
    const storage = new MemoryStorage();
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        JSON.stringify({
          crv: publicKey.crv,
          kty: publicKey.kty,
          x: publicKey.x,
          y: publicKey.y,
        }),
      ),
    );
    const thumbprint = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    await installBrowserRelayApplicationAuthority(
      {
        connectionId: 'connection-1',
        applicationOrigin,
        route,
        bearer: { kind: 'device', credential: 'D'.repeat(43) },
        key,
        continuation: { ...continuation, keyThumbprint: thumbprint },
      },
      storage,
    );
    const credential = await createBrowserRelayApplicationCredential({
      connectionId: 'connection-1',
      applicationOrigin,
      route,
      transport: vi.fn(async () => new Response('{}')),
      routeIsCurrent: () => true,
      storage,
    });
    await credential.onAccountUnauthorized?.();
    const retained = storage.values.get(storageKey()) as Record<
      string,
      unknown
    >;
    expect(retained.bearer).toEqual({
      kind: 'device',
      credential: 'D'.repeat(43),
    });
    expect(retained.continuation).toBeUndefined();
    expect(credential.transportBindingIsCurrent?.()).toBe(false);
  });

  it('does not attempt relay cookie adoption from a cross-origin browser', async () => {
    await expect(
      adoptBrowserRelayCookies({
        connectionId: 'connection-1',
        applicationOrigin,
        route,
        storage: new MemoryStorage(),
      }),
    ).rejects.toThrow('browser to be on the Station HTTPS origin');
    expect(mocks.cookieAdopt).not.toHaveBeenCalled();
  });
});
