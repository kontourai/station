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
  browserRelayAccountScopeKey,
  getBrowserRelayAccountScope,
} from '../browserRelayAccountScope';
import {
  adoptBrowserRelayCookies,
  type BrowserRelayAuthorityStorage,
  createBrowserRelayApplicationCredential,
  hydrateBrowserRelayApplicationAuthorityScope,
  installBrowserRelayApplicationAuthority,
  publishBrowserRelayApplicationAuthority,
  removeBrowserRelayApplicationAuthority,
  removeProvisionalBrowserRelayApplicationAuthority,
  stageBrowserRelayApplicationAuthority,
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

async function thumbprintFor(jwk: {
  kty: string;
  crv: string;
  x: string;
  y: string;
}) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }),
    ),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

class MemoryStorage implements BrowserRelayAuthorityStorage {
  values = new Map<string, unknown>();
  beforeRead?: (key: string) => Promise<void>;
  failRead?: (key: string) => Error | undefined;
  beforeCompare?: (key: string, expected: unknown) => Promise<void>;
  afterCompare?: (key: string, next: unknown) => Promise<void>;
  afterActivate?: () => Promise<void>;
  refuseAbortedWrites = false;
  async read(id: string, signal?: AbortSignal) {
    await this.beforeRead?.(id);
    if (signal?.aborted) throw signal.reason;
    const error = this.failRead?.(id);
    if (error) throw error;
    return this.values.get(id) ?? null;
  }
  async compareAndSwap(
    id: string,
    expected: any,
    next: any,
    signal?: AbortSignal,
    commitGuard?: () => boolean,
  ) {
    await this.beforeCompare?.(id, expected);
    if (signal?.aborted && this.refuseAbortedWrites) throw signal.reason;
    const current = this.values.get(id) ?? null;
    if (!sameStoredIdentity(current, expected)) return false;
    if (commitGuard && !commitGuard()) return false;
    this.values.set(id, next);
    await this.afterCompare?.(id, next);
    return true;
  }
  async activateStaged(input: any) {
    const active = this.values.get(input.activeKey) ?? null;
    const staged = this.values.get(input.stageKey) ?? null;
    if (
      !sameStoredIdentity(active, input.expectedActive) ||
      !sameStoredIdentity(staged, input.expectedStage)
    )
      return false;
    this.values.set(input.activeKey, input.activating);
    this.values.set(input.stageKey, input.stageTombstone);
    await this.afterActivate?.();
    return true;
  }
}

function sameStoredIdentity(value: unknown, expected: any) {
  if (value === null) return expected === null;
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, any>;
  const current =
    record.status === 'staged'
      ? { authorityInstanceId: record.stageId, scopeVersion: 0 }
      : {
          authorityInstanceId: record.authorityInstanceId,
          scopeVersion: record.scopeVersion,
        };
  return Boolean(
    expected &&
      current.authorityInstanceId === expected.authorityInstanceId &&
      current.scopeVersion === expected.scopeVersion,
  );
}

const stageId = 'S'.repeat(43);

async function installApprovedDevice(
  input: Parameters<typeof stageBrowserRelayApplicationAuthority>[0],
  storage: MemoryStorage,
  receiptId = input.stageId,
  isRouteCurrent: () => boolean = () => true,
) {
  await stageBrowserRelayApplicationAuthority(input, storage);
  await publishBrowserRelayApplicationAuthority(
    {
      connectionId: input.connectionId,
      applicationOrigin: input.applicationOrigin,
      route: input.route,
      stageId: receiptId,
      activationReceipt: {
        version: 'station.relay-enrollment/v1',
        state: 'active',
        enrollmentId: receiptId,
        deviceId: input.continuation.deviceId,
        receiptDigest: 'R'.repeat(43),
        receiptExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      isRouteCurrent,
      ...(input.signal ? { signal: input.signal } : {}),
    },
    storage,
  );
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
    await installApprovedDevice(
      {
        stageId,
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
    await installApprovedDevice(
      {
        stageId,
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

  it('keeps a staged enrollment inert after reload and removes only its exact stage', async () => {
    const connectionId = 'staged-only-connection';
    const transport = publish(connectionId);
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
    const keyThumbprint = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const stagedInput = {
      stageId,
      connectionId,
      applicationOrigin,
      route,
      bearer: { kind: 'device' as const, credential: 'D'.repeat(43) },
      key,
      continuation: { ...continuation, keyThumbprint },
    };
    await stageBrowserRelayApplicationAuthority(stagedInput, storage);
    await hydrateBrowserRelayApplicationAuthorityScope(
      { connectionId, applicationOrigin, route },
      storage,
    );
    const scopeKey = browserRelayAccountScopeKey({
      connectionId,
      applicationOrigin,
      route,
      clientOrigin: window.location.origin,
    });
    expect(getBrowserRelayAccountScope(scopeKey)?.authorityKey).toBeNull();
    expect(storage.values.has(storageKey(connectionId))).toBe(false);
    await expect(
      createBrowserRelayApplicationCredential({
        connectionId,
        applicationOrigin,
        route,
        transport,
        routeIsCurrent: () => true,
        storage,
      }),
    ).rejects.toThrow('unavailable or stale');
    await removeProvisionalBrowserRelayApplicationAuthority(
      { stageId, connectionId, applicationOrigin, route },
      storage,
    );
    expect(
      [...storage.values.values()].every(
        (record) =>
          !record ||
          typeof record !== 'object' ||
          (record as Record<string, unknown>).status !== 'staged',
      ),
    ).toBe(true);
  });

  it('keeps account scope pending during delayed hydration and fails closed on invalid or unreadable records', async () => {
    const connectionId = 'hydration-read-fences-scope';
    publish(connectionId);
    const storage = new MemoryStorage();
    const input = {
      stageId: 'd'.repeat(43),
      connectionId,
      applicationOrigin,
      route,
      bearer: { kind: 'device' as const, credential: 'e'.repeat(43) },
      key,
      continuation: {
        ...continuation,
        authorityKey: 'hydrated-account',
        credential: 'f'.repeat(43),
        keyThumbprint: await thumbprintFor(publicKey),
      },
    };
    await installApprovedDevice(input, storage);
    const scopeKey = browserRelayAccountScopeKey({
      connectionId,
      applicationOrigin,
      route,
      clientOrigin: window.location.origin,
    });
    let releaseRead!: () => void;
    let signalRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      signalRead = resolve;
    });
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    storage.beforeRead = async (target) => {
      if (target !== storageKey(connectionId)) return;
      storage.beforeRead = undefined;
      signalRead();
      await readGate;
    };
    const hydration = hydrateBrowserRelayApplicationAuthorityScope(
      { connectionId, applicationOrigin, route },
      storage,
    );
    await readStarted;
    expect(getBrowserRelayAccountScope(scopeKey)?.state).toBe('pending');
    expect(getBrowserRelayAccountScope(scopeKey)?.authorityKey).toBeNull();
    releaseRead();
    expect((await hydration)?.authorityKey).toBe('hydrated-account');

    const stored = storage.values.get(storageKey(connectionId)) as {
      continuation: ApplicationSessionContinuation;
    };
    stored.continuation.expiresAt = new Date(Date.now() - 1).toISOString();
    await hydrateBrowserRelayApplicationAuthorityScope(
      { connectionId, applicationOrigin, route },
      storage,
    );
    expect(getBrowserRelayAccountScope(scopeKey)?.authorityKey).toBeNull();
    expect(getBrowserRelayAccountScope(scopeKey)?.state).toBe('ready');

    stored.continuation.expiresAt = new Date(Date.now() + 60_000).toISOString();
    storage.failRead = (target) =>
      target === storageKey(connectionId)
        ? new Error('hydration read unavailable')
        : undefined;
    await expect(
      hydrateBrowserRelayApplicationAuthorityScope(
        { connectionId, applicationOrigin, route },
        storage,
      ),
    ).resolves.toMatchObject({ state: 'ready', authorityKey: null });
  });

  it('replaces only an expired inert stage on a safe retry with the same stage ID', async () => {
    const connectionId = 'expired-stage-retry';
    publish(connectionId);
    const storage = new MemoryStorage();
    const input = {
      stageId: 'Z'.repeat(43),
      connectionId,
      applicationOrigin,
      route,
      bearer: { kind: 'device' as const, credential: 'a'.repeat(43) },
      key,
      continuation: {
        ...continuation,
        authorityKey: 'retry-account',
        credential: 'b'.repeat(43),
        keyThumbprint: await thumbprintFor(publicKey),
      },
    };
    await stageBrowserRelayApplicationAuthority(input, storage);
    const stageKey = `${storageKey(connectionId)}::stage:${input.stageId}`;
    const old = storage.values.get(stageKey) as Record<string, unknown>;
    storage.values.set(stageKey, {
      ...old,
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    await stageBrowserRelayApplicationAuthority(input, storage);
    const retried = storage.values.get(stageKey) as Record<string, unknown>;
    expect(Date.parse(retried.expiresAt as string)).toBeGreaterThan(Date.now());
    expect(storage.values.has(storageKey(connectionId))).toBe(false);
  });

  it('retires the old account scope and ignores its late account and Device 401s after A to B on one route', async () => {
    const connectionId = 'same-route-account-switch';
    const transport = publish(connectionId);
    const storage = new MemoryStorage();
    const keyThumbprint = await thumbprintFor(publicKey);
    const inputA = {
      stageId: 'A'.repeat(43),
      connectionId,
      applicationOrigin,
      route,
      bearer: { kind: 'device' as const, credential: 'D'.repeat(43) },
      key,
      continuation: {
        ...continuation,
        authorityKey: 'account-A',
        credential: 'A'.repeat(43),
        keyThumbprint,
      },
    };
    await installApprovedDevice(inputA, storage);
    const scopeKey = browserRelayAccountScopeKey({
      connectionId,
      applicationOrigin,
      route,
      clientOrigin: window.location.origin,
    });
    const accountAScope = getBrowserRelayAccountScope(scopeKey);
    const credentialA = await createBrowserRelayApplicationCredential({
      connectionId,
      applicationOrigin,
      route,
      transport,
      routeIsCurrent: () => true,
      storage,
    });
    const inputB = {
      ...inputA,
      stageId: 'B'.repeat(43),
      bearer: { kind: 'device' as const, credential: 'E'.repeat(43) },
      continuation: {
        ...inputA.continuation,
        authorityKey: 'account-B',
        credential: 'B'.repeat(43),
        principal: {
          kind: 'human' as const,
          id: 'human:local:person-b',
          display: 'Person B',
        },
      },
    };
    await installApprovedDevice(inputB, storage);
    const accountBScope = getBrowserRelayAccountScope(scopeKey);
    expect(accountAScope?.authorityKey).toBe('account-A');
    expect(accountBScope?.authorityKey).toBe('account-B');
    expect(accountBScope?.scopeKey).not.toBe(accountAScope?.scopeKey);
    expect(credentialA.transportBindingIsCurrent?.()).toBe(false);

    await credentialA.onAccountUnauthorized?.();
    await credentialA.onUnauthorized?.();
    const current = storage.values.get(storageKey(connectionId)) as {
      authorityInstanceId: string;
      bearer: { credential: string };
      continuation: { authorityKey: string };
    };
    expect(current.authorityInstanceId).toBe(inputB.stageId);
    expect(current.bearer.credential).toBe(inputB.bearer.credential);
    expect(current.continuation.authorityKey).toBe('account-B');
  });

  it('uses IDB CAS when an account 401 races with a replacement install', async () => {
    const connectionId = 'cas-account-replacement';
    const transport = publish(connectionId);
    const storage = new MemoryStorage();
    const keyThumbprint = await thumbprintFor(publicKey);
    const inputA = {
      stageId: 'C'.repeat(43),
      connectionId,
      applicationOrigin,
      route,
      bearer: { kind: 'device' as const, credential: 'F'.repeat(43) },
      key,
      continuation: {
        ...continuation,
        authorityKey: 'cas-A',
        credential: 'G'.repeat(43),
        keyThumbprint,
      },
    };
    await installApprovedDevice(inputA, storage);
    const credentialA = await createBrowserRelayApplicationCredential({
      connectionId,
      applicationOrigin,
      route,
      transport,
      routeIsCurrent: () => true,
      storage,
    });
    const inputB = {
      ...inputA,
      stageId: 'H'.repeat(43),
      bearer: { kind: 'device' as const, credential: 'I'.repeat(43) },
      continuation: {
        ...inputA.continuation,
        authorityKey: 'cas-B',
        credential: 'J'.repeat(43),
      },
    };
    let replaced = false;
    storage.beforeCompare = async (target, expected) => {
      const expectedRecord = expected as {
        authorityInstanceId?: string;
      } | null;
      if (
        replaced ||
        target !== storageKey(connectionId) ||
        expectedRecord?.authorityInstanceId !== inputA.stageId
      )
        return;
      replaced = true;
      storage.beforeCompare = undefined;
      await installApprovedDevice(inputB, storage);
    };
    await credentialA.onAccountUnauthorized?.();
    const current = storage.values.get(storageKey(connectionId)) as {
      authorityInstanceId: string;
      continuation: { authorityKey: string };
    };
    expect(replaced).toBe(true);
    expect(current.authorityInstanceId).toBe(inputB.stageId);
    expect(current.continuation.authorityKey).toBe('cas-B');
  });

  it('keeps request and query authority aligned after a failed removal transition', async () => {
    const connectionId = 'failed-removal-transition';
    const transport = publish(connectionId);
    const storage = new MemoryStorage();
    const keyThumbprint = await thumbprintFor(publicKey);
    await installApprovedDevice(
      {
        stageId: 'T'.repeat(43),
        connectionId,
        applicationOrigin,
        route,
        bearer: { kind: 'device', credential: 'D'.repeat(43) },
        key,
        continuation: { ...continuation, keyThumbprint },
      },
      storage,
    );
    const routeScopeKey = browserRelayAccountScopeKey({
      connectionId,
      applicationOrigin,
      route,
      clientOrigin: window.location.origin,
    });
    const before = getBrowserRelayAccountScope(routeScopeKey);
    storage.compareAndSwap = async () => false;
    await removeBrowserRelayApplicationAuthority(
      { connectionId, applicationOrigin, route },
      storage,
    );
    const after = getBrowserRelayAccountScope(routeScopeKey);
    expect(after?.state).toBe('ready');
    expect(after?.authorityKey).toBe(continuation.authorityKey);
    expect(after?.scopeKey).not.toBe(before?.scopeKey);

    const credential = await createBrowserRelayApplicationCredential({
      connectionId,
      applicationOrigin,
      route,
      transport,
      routeIsCurrent: () => true,
      storage,
    });
    expect(credential.requestAuthority?.authorityKey).toBe(after?.scopeKey);
    expect(credential.transportBindingIsCurrent?.()).toBe(true);
  });

  it('rolls back activation if the selected route retires during the storage transaction', async () => {
    const connectionId = 'activation-retirement';
    const transport = publish(connectionId);
    const storage = new MemoryStorage();
    let routeCurrent = true;
    storage.afterActivate = async () => {
      expect(
        (storage.values.get(storageKey(connectionId)) as { status: string })
          .status,
      ).toBe('activating');
      await expect(
        createBrowserRelayApplicationCredential({
          connectionId,
          applicationOrigin,
          route,
          transport,
          routeIsCurrent: () => true,
          storage,
        }),
      ).rejects.toThrow('unavailable or stale');
      routeCurrent = false;
    };
    const input = {
      stageId: 'K'.repeat(43),
      connectionId,
      applicationOrigin,
      route,
      bearer: { kind: 'device' as const, credential: 'L'.repeat(43) },
      key,
      continuation: {
        ...continuation,
        authorityKey: 'retire-account',
        credential: 'M'.repeat(43),
        keyThumbprint: await thumbprintFor(publicKey),
      },
    };
    await expect(
      installApprovedDevice(input, storage, input.stageId, () => routeCurrent),
    ).rejects.toThrow('route changed before activation could be published');
    const current = storage.values.get(storageKey(connectionId)) as
      | { status: string; authorityInstanceId?: string }
      | undefined;
    expect(current?.status).toBe('empty');
    expect(current?.authorityInstanceId).not.toBe(input.stageId);
  });

  it('does not publish active authority when the route retires while the final CAS waits', async () => {
    const connectionId = 'activation-route-retires-in-cas';
    publish(connectionId);
    const storage = new MemoryStorage();
    const controller = new AbortController();
    const input = {
      stageId: 'g'.repeat(43),
      connectionId,
      applicationOrigin,
      route,
      bearer: { kind: 'device' as const, credential: 'h'.repeat(43) },
      key,
      continuation: {
        ...continuation,
        authorityKey: 'route-retires-in-cas',
        credential: 'i'.repeat(43),
        keyThumbprint: await thumbprintFor(publicKey),
      },
    };
    await stageBrowserRelayApplicationAuthority(input, storage);
    let routeCurrent = true;
    let activePublications = 0;
    storage.afterCompare = async (target, next) => {
      if (
        target === storageKey(connectionId) &&
        (next as { status?: string }).status === 'active'
      )
        activePublications += 1;
    };
    storage.beforeCompare = async (target) => {
      if (
        target === storageKey(connectionId) &&
        (storage.values.get(target) as { status?: string })?.status ===
          'activating'
      ) {
        storage.beforeCompare = undefined;
        routeCurrent = false;
      }
    };
    await expect(
      publishBrowserRelayApplicationAuthority(
        {
          connectionId,
          applicationOrigin,
          route,
          stageId: input.stageId,
          activationReceipt: {
            version: 'station.relay-enrollment/v1',
            state: 'active',
            enrollmentId: input.stageId,
            deviceId: input.continuation.deviceId,
            receiptDigest: 'R'.repeat(43),
            receiptExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          isRouteCurrent: () => routeCurrent,
          signal: controller.signal,
        },
        storage,
      ),
    ).rejects.toThrow('before activation could be published');
    expect(controller.signal.aborted).toBe(false);
    expect(routeCurrent).toBe(false);
    expect(activePublications).toBe(0);
    expect(
      (storage.values.get(storageKey(connectionId)) as { status?: string })
        ?.status,
    ).toBe('empty');
  });

  it('conditionally rolls back cookie alias installation when the route retires during commit', async () => {
    const connectionId = 'alias-install-retirement';
    publish(connectionId);
    const storage = new MemoryStorage();
    const keyThumbprint = await thumbprintFor(publicKey);
    let retired = false;
    storage.beforeCompare = async (target) => {
      if (retired || target !== storageKey(connectionId)) return;
      retired = true;
      retireBrowserRelayRoute(connectionId, 1);
    };
    await expect(
      installBrowserRelayApplicationAuthority(
        {
          connectionId,
          applicationOrigin,
          route,
          bearer: { kind: 'alias', credential: 'Q'.repeat(43) },
          key,
          continuation: { ...continuation, keyThumbprint },
        },
        storage,
      ),
    ).rejects.toThrow('route changed while cookie authority was committing');
    const current = storage.values.get(storageKey(connectionId)) as
      | { status: string; bearer?: unknown }
      | undefined;
    expect(retired).toBe(true);
    expect(current?.status).toBe('empty');
    expect(current?.bearer).toBeUndefined();
  });

  it('rolls back cookie alias installation when the post-commit read fails', async () => {
    const connectionId = 'alias-install-read-failure';
    publish(connectionId);
    const storage = new MemoryStorage();
    const keyThumbprint = await thumbprintFor(publicKey);
    storage.afterCompare = async (target, next) => {
      if (
        target === storageKey(connectionId) &&
        (next as { status?: string }).status === 'active'
      ) {
        storage.afterCompare = undefined;
        storage.failRead = (readKey) =>
          readKey === storageKey(connectionId)
            ? new Error('post-commit read unavailable')
            : undefined;
      }
    };
    await expect(
      installBrowserRelayApplicationAuthority(
        {
          connectionId,
          applicationOrigin,
          route,
          bearer: { kind: 'alias', credential: 'Q'.repeat(43) },
          key,
          continuation: { ...continuation, keyThumbprint },
        },
        storage,
      ),
    ).rejects.toThrow('post-commit read unavailable');
    const current = storage.values.get(storageKey(connectionId)) as
      | { status: string; bearer?: unknown }
      | undefined;
    expect(current?.status).toBe('empty');
    expect(current?.bearer).toBeUndefined();
    const scopeKey = browserRelayAccountScopeKey({
      connectionId,
      applicationOrigin,
      route,
      clientOrigin: window.location.origin,
    });
    expect(getBrowserRelayAccountScope(scopeKey)?.authorityKey).toBeNull();
  });

  it('preserves a device-only grant if cookie alias replacement fails after account 401', async () => {
    const connectionId = 'alias-failure-retains-device-only';
    const transport = publish(connectionId);
    const storage = new MemoryStorage();
    const deviceBearer = 'J'.repeat(43);
    const keyThumbprint = await thumbprintFor(publicKey);
    await installApprovedDevice(
      {
        stageId: 'k'.repeat(43),
        connectionId,
        applicationOrigin,
        route,
        bearer: { kind: 'device', credential: deviceBearer },
        key,
        continuation: { ...continuation, keyThumbprint },
      },
      storage,
    );
    const credential = await createBrowserRelayApplicationCredential({
      connectionId,
      applicationOrigin,
      route,
      transport,
      routeIsCurrent: () => true,
      storage,
    });
    await credential.onAccountUnauthorized?.();
    const deviceOnly = storage.values.get(storageKey(connectionId)) as {
      status: string;
      bearer: { credential: string };
    };
    expect(deviceOnly.status).toBe('device-only');
    expect(deviceOnly.bearer.credential).toBe(deviceBearer);

    storage.afterCompare = async (target, next) => {
      if (
        target === storageKey(connectionId) &&
        (next as { status?: string }).status === 'active'
      ) {
        storage.afterCompare = undefined;
        storage.failRead = (readKey) =>
          readKey === storageKey(connectionId)
            ? new Error('replacement read unavailable')
            : undefined;
      }
    };
    await expect(
      installBrowserRelayApplicationAuthority(
        {
          connectionId,
          applicationOrigin,
          route,
          bearer: { kind: 'alias', credential: 'L'.repeat(43) },
          key,
          continuation: {
            ...continuation,
            authorityKey: 'replacement-account',
            credential: 'M'.repeat(43),
            keyThumbprint,
          },
        },
        storage,
      ),
    ).rejects.toThrow('replacement read unavailable');
    const retained = storage.values.get(storageKey(connectionId)) as {
      status: string;
      bearer: { credential: string };
      continuation?: unknown;
    };
    expect(retained.status).toBe('device-only');
    expect(retained.bearer.credential).toBe(deviceBearer);
    expect(retained.continuation).toBeUndefined();
  });

  it('aborts a pending activation and rolls back a transaction that completed during cancellation', async () => {
    const connectionId = 'activation-abort';
    publish(connectionId);
    const storage = new MemoryStorage();
    const controller = new AbortController();
    storage.afterActivate = async () => {
      controller.abort(new Error('ceremony deadline elapsed'));
    };
    const input = {
      stageId: 'N'.repeat(43),
      connectionId,
      applicationOrigin,
      route,
      bearer: { kind: 'device' as const, credential: 'O'.repeat(43) },
      key,
      continuation: {
        ...continuation,
        authorityKey: 'aborted-account',
        credential: 'P'.repeat(43),
        keyThumbprint: await thumbprintFor(publicKey),
      },
      signal: controller.signal,
    };
    await expect(installApprovedDevice(input, storage)).rejects.toThrow(
      'ceremony deadline elapsed',
    );
    const current = storage.values.get(storageKey(connectionId)) as
      | { status: string; authorityInstanceId?: string }
      | undefined;
    expect(current?.status).toBe('empty');
    expect(current?.authorityInstanceId).not.toBe(input.stageId);
  });

  it('aborts at the final activation transaction boundary without publishing authority', async () => {
    const connectionId = 'activation-final-cas-abort';
    publish(connectionId);
    const storage = new MemoryStorage();
    const controller = new AbortController();
    storage.refuseAbortedWrites = true;
    const input = {
      stageId: 'a'.repeat(43),
      connectionId,
      applicationOrigin,
      route,
      bearer: { kind: 'device' as const, credential: 'b'.repeat(43) },
      key,
      continuation: {
        ...continuation,
        authorityKey: 'final-cas-aborted',
        credential: 'c'.repeat(43),
        keyThumbprint: await thumbprintFor(publicKey),
      },
      signal: controller.signal,
    };
    await stageBrowserRelayApplicationAuthority(input, storage);
    storage.beforeCompare = async (target) => {
      if (
        target === storageKey(connectionId) &&
        (storage.values.get(target) as { status?: string })?.status ===
          'activating'
      ) {
        storage.beforeCompare = undefined;
        controller.abort(new Error('cancelled at activation publication'));
      }
    };
    await expect(
      publishBrowserRelayApplicationAuthority(
        {
          connectionId,
          applicationOrigin,
          route,
          stageId: input.stageId,
          activationReceipt: {
            version: 'station.relay-enrollment/v1',
            state: 'active',
            enrollmentId: input.stageId,
            deviceId: input.continuation.deviceId,
            receiptDigest: 'R'.repeat(43),
            receiptExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          isRouteCurrent: () => true,
          signal: controller.signal,
        },
        storage,
      ),
    ).rejects.toThrow('cancelled at activation publication');
    expect(
      (storage.values.get(storageKey(connectionId)) as { status?: string })
        ?.status,
    ).toBe('empty');
  });

  it('removes a staged record if its ceremony signal aborts as the write settles', async () => {
    const connectionId = 'stage-abort';
    publish(connectionId);
    const storage = new MemoryStorage();
    const controller = new AbortController();
    const input = {
      stageId: 'U'.repeat(43),
      connectionId,
      applicationOrigin,
      route,
      bearer: { kind: 'device' as const, credential: 'V'.repeat(43) },
      key,
      continuation: {
        ...continuation,
        authorityKey: 'aborted-stage',
        credential: 'W'.repeat(43),
        keyThumbprint: await thumbprintFor(publicKey),
      },
      signal: controller.signal,
    };
    storage.beforeCompare = async (target) => {
      if (target.includes('::stage:')) {
        storage.beforeCompare = undefined;
        controller.abort(new Error('stage ceremony cancelled'));
      }
    };
    await expect(
      stageBrowserRelayApplicationAuthority(input, storage),
    ).rejects.toThrow('stage ceremony cancelled');
    const stageRow = storage.values.get(
      `${storageKey(connectionId)}::stage:${input.stageId}`,
    ) as Record<string, unknown> | undefined;
    expect(stageRow?.status).toBe('empty');
    expect(storage.values.has(storageKey(connectionId))).toBe(false);
  });

  it('removes the exact provisional grant even after publication promoted it active', async () => {
    const connectionId = 'provisional-published-cleanup';
    publish(connectionId);
    const storage = new MemoryStorage();
    const input = {
      stageId: 'X'.repeat(43),
      connectionId,
      applicationOrigin,
      route,
      bearer: { kind: 'device' as const, credential: 'Y'.repeat(43) },
      key,
      continuation: {
        ...continuation,
        authorityKey: 'provisional-account',
        credential: 'Z'.repeat(43),
        keyThumbprint: await thumbprintFor(publicKey),
      },
    };
    await installApprovedDevice(input, storage);
    expect(
      (storage.values.get(storageKey(connectionId)) as Record<string, unknown>)
        .status,
    ).toBe('active');
    await removeProvisionalBrowserRelayApplicationAuthority(
      { stageId: input.stageId, connectionId, applicationOrigin, route },
      storage,
    );
    expect(
      (storage.values.get(storageKey(connectionId)) as Record<string, unknown>)
        .status,
    ).toBe('empty');
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
    await installApprovedDevice(
      {
        stageId,
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
    expect(retained.status).toBe('device-only');
    expect(retained.continuation).toBeUndefined();
    expect(credential.transportBindingIsCurrent?.()).toBe(false);
    await removeBrowserRelayApplicationAuthority(
      { connectionId: 'connection-1', applicationOrigin, route },
      storage,
    );
    const removed = storage.values.get(storageKey()) as Record<string, unknown>;
    expect(removed.status).toBe('empty');
    expect(removed.bearer).toBeUndefined();
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
