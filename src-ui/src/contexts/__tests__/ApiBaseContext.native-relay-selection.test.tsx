/** @vitest-environment jsdom */
import type { StationProfileStore } from '@kontourai/station-contracts';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import {
  assertClientRawEgressAllowed,
  authenticatedFetch,
} from '@kontourai/station-sdk';
import {
  getProjectView,
  listProjectViews,
} from '@kontourai/station-sdk/client';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NativeAccountPublicScope } from '../../platform/native/nativeAccountSessionBridge';
import { NativeStationProfileStorage } from '../../platform/native/stationProfileStorage';

const boundary = vi.hoisted(() => ({
  repository: null as NativeStationProfileStorage | null,
  fetch: vi.fn<typeof fetch>(),
  retired: vi.fn(),
  logout: vi.fn<() => Promise<{ revoked: true }>>(),
  bindings: [] as string[],
}));
vi.mock('../../platform/PlatformProfileContext', () => ({
  nativeProfileRepository: () => boundary.repository,
  useNativeProfileSelection: () => async () => {},
  useNativeProfileStoreEpoch: () => 0,
  usePlatformProfile: () => ({
    isTauri: true,
    isMobile: true,
    isDesktop: false,
    supervisesBundledServer: false,
  }),
}));
vi.mock('../../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => null,
}));
vi.mock('../../platform/native/nativeRelayApplicationRuntime', () => ({
  createNativeRelayApplicationRuntime: async (input: {
    bindingId: string;
    origin: string;
    selectionIsCurrent(): boolean;
    signal: AbortSignal;
  }) => {
    boundary.bindings.push(input.bindingId);
    const isCurrent = () => !input.signal.aborted && input.selectionIsCurrent();
    return {
      origin: input.origin,
      authorityIdentity: input.bindingId,
      scope: {},
      surface: {},
      isCurrent,
      assertCurrent: async () => {
        if (!isCurrent()) throw new Error('retired');
      },
      fetch: boundary.fetch,
    };
  },
}));
vi.mock('../../platform/native/nativeAccountSessionBridge', () => ({
  createNativeAccountSessionBridge: async (input: {
    application: { origin: string };
    signal: AbortSignal;
  }) => {
    let current: NativeAccountPublicScope | null = null;
    let retired = false;
    const listeners = new Set<() => void>();
    return {
      current: () =>
        !input.signal.aborted &&
        current &&
        Date.parse(current.expiresAt) > Date.now()
          ? current
          : null,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async login(credentials: { username: string }) {
        if (retired || current) throw new Error('native_account_scope_retired');
        current = Object.freeze({
          instanceId: credentials.username,
          generation: 1,
          authorityKey: `account:${credentials.username}`,
          principal: humanPrincipal(
            'test',
            credentials.username,
            credentials.username,
          ),
          deviceId: '11111111-1111-4111-8111-111111111111',
          target: {
            kind: 'station-native' as const,
            stationId: '11111111-1111-4111-8111-111111111111',
            audience: input.application.origin,
            surface: {
              kind: 'station-native' as const,
              appIdentifier: 'com.kontourai.station.dev',
              channel: 'dev' as const,
              clientInstanceId: '22222222-2222-4222-8222-222222222222',
              keyThumbprint: 'x'.repeat(43),
            },
          },
          keyThumbprint: 'x'.repeat(43),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        for (const listener of listeners) listener();
        return current;
      },
      requestHeaders: async () => ({
        'X-Station-Native-Account-Continuation': 'account-receipt',
        'X-Station-Native-Account-Proof': 'host-proof',
      }),
      acceptInvitation: async () => ({ data: { accepted: true } }),
      async logout() {
        try {
          return await boundary.logout();
        } finally {
          retired = true;
          current = null;
          for (const listener of listeners) listener();
        }
      },
      retire: () => {
        retired = true;
        boundary.retired();
        current = null;
        for (const listener of listeners) listener();
      },
    };
  },
}));
vi.mock('../../platform/native/authenticatedTransport', () => ({
  nativeAuthenticatedTransport: () => {
    throw new Error('native direct HTTP fallback');
  },
}));

import {
  checkServerHealth,
  setStationHealthRouteResolver,
} from '../../lib/serverHealth';
import { nativeRelayAccountScopeKey } from '../../platform/native/nativeRelayAccountScope';
import { captureNativeRelayConnectionOwner } from '../../platform/native/nativeRelayConnectionOwnerRegistry';
import {
  ApiBaseProvider,
  useHostRequestAuthorityScope,
  useNativeRelayAccountSession,
} from '../ApiBaseContext';

const origin = 'https://native-station.example.test';
const profileStore: StationProfileStore = {
  schemaVersion: 1,
  revision: 1,
  defaultProfile: null,
  projectProfiles: {},
  profiles: [
    {
      schemaVersion: 1,
      name: 'relay',
      endpoint: origin,
      credentialRef: { kind: 'station-bearer', id: 'opaque-device-ref' },
      environmentId: '11111111-1111-4111-8111-111111111111',
      clientInstanceId: '22222222-2222-4222-8222-222222222222',
      relayRoute: {
        brokerOrigin: 'https://broker.example.test',
        stationId: '11111111-1111-4111-8111-111111111111',
        enrollmentId: '33333333-3333-4333-8333-333333333333',
      },
      setupSource: 'manual',
      configurationState: 'configured',
      createdAt: 1,
      updatedAt: 1,
    },
  ],
};
const bindingId = '44444444-4444-4444-8444-444444444444';
const ownerKey = nativeRelayAccountScopeKey({
  connectionId: 'station-profile:relay',
  origin,
  route: {
    routeVersion: 1,
    profileName: 'relay',
    profileRevision: 1,
    ...profileStore.profiles[0].relayRoute!,
  },
  bindingId,
});
beforeEach(async () => {
  boundary.fetch
    .mockReset()
    .mockImplementation(async () => Response.json({ success: true, data: [] }));
  boundary.retired.mockClear();
  boundary.logout.mockReset().mockResolvedValue({ revoked: true });
  boundary.bindings.length = 0;
  boundary.repository = new NativeStationProfileStorage({
    async invoke<T>(command: string) {
      if (command === 'station_profile_store_read')
        return structuredClone(profileStore) as T;
      if (command === 'station_profile_authorize_active')
        return { bindingId, exactOrigin: origin } as T;
      throw new Error(command);
    },
  });
  await boundary.repository.hydrate();
  await boundary.repository.authorizeActiveConnection(
    'station-profile:relay',
    true,
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('raw HTTP fallback');
    }),
  );
});
afterEach(() => {
  cleanup();
  captureNativeRelayConnectionOwner(ownerKey)?.dispose();
  setStationHealthRouteResolver();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function mounted() {
  return renderHook(
    () => ({
      scope: useHostRequestAuthorityScope(),
      account: useNativeRelayAccountSession(),
    }),
    {
      wrapper: ({ children }) => <ApiBaseProvider>{children}</ApiBaseProvider>,
    },
  );
}
it('mounts selected native SDK and health without Origin/direct fallback and partitions account changes', async () => {
  const { result } = mounted();
  expect(result.current.scope).toBeUndefined();
  await act(async () => {
    await expect(authenticatedFetch(`${origin}/api/projects`)).rejects.toThrow(
      'sign-in',
    );
  });
  expect(boundary.fetch).not.toHaveBeenCalled();
  await act(async () => {
    await result.current.account.login({
      username: 'alice',
      password: 'test-password',
    });
  });
  const alice = result.current.scope;
  expect(alice).toBeDefined();
  await listProjectViews(origin, { requestScope: alice });
  const headers = new Headers(boundary.fetch.mock.calls.at(-1)?.[1]?.headers);
  expect(headers.has('Origin')).toBe(false);
  expect(headers.has('Authorization')).toBe(false);
  expect(headers.get('X-Station-Native-Account-Proof')).toBe('host-proof');
  expect(await checkServerHealth(origin)).toBe(true);
  const healthCount = boundary.fetch.mock.calls.length;
  expect(await checkServerHealth('https://foreign.example.test')).toBe(false);
  expect(boundary.fetch).toHaveBeenCalledTimes(healthCount);
  expect(boundary.bindings).toEqual([bindingId]);
  expect(() => assertClientRawEgressAllowed(origin, 'terminal')).toThrow();
  await act(async () => {
    await result.current.account.retireAccount();
    await result.current.account.login({
      username: 'bob',
      password: 'test-password',
    });
  });
  expect(alice?.isCurrent()).toBe(false);
  expect(result.current.scope?.authorityKey).not.toBe(alice?.authorityKey);
  const count = boundary.fetch.mock.calls.length;
  await expect(
    listProjectViews(origin, { requestScope: alice }),
  ).rejects.toThrow();
  expect(boundary.fetch).toHaveBeenCalledTimes(count);
  expect(fetch).not.toHaveBeenCalled();
});
it('account 401 retires only account scope; Project 403 preserves account and Device', async () => {
  const { result } = mounted();
  await act(async () => {
    await result.current.account.login({
      username: 'alice',
      password: 'test-password',
    });
  });
  const scope = result.current.scope;
  boundary.fetch.mockImplementationOnce(async () =>
    Response.json({ error: { code: 'project_forbidden' } }, { status: 403 }),
  );
  await expect(
    getProjectView(origin, 'demo', { requestScope: scope }),
  ).rejects.toThrow();
  expect(scope?.isCurrent()).toBe(true);
  expect(boundary.retired).not.toHaveBeenCalled();
  boundary.fetch.mockImplementationOnce(async () =>
    Response.json(
      { error: { code: 'account_required' } },
      {
        status: 401,
        headers: { 'X-Station-Authentication-Failure': 'account' },
      },
    ),
  );
  await act(async () => {
    await expect(
      listProjectViews(origin, { requestScope: scope }),
    ).rejects.toThrow();
  });
  expect(result.current.scope).toBeUndefined();
  expect(scope?.isCurrent()).toBe(false);
  expect(
    boundary.repository?.captureNativeRequestBinding(
      'station-profile:relay',
      origin,
    )?.bindingId,
  ).toBe(bindingId);
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['confirmed', 'unknown'] as const)(
  'mounts remote logout and fresh reauthentication without retiring Device custody (%s)',
  async (outcome) => {
    const { result } = mounted();
    await act(async () => {
      await result.current.account.login({
        username: 'alice',
        password: 'test-password',
      });
    });
    const before = result.current.scope;
    expect(before?.isCurrent()).toBe(true);
    if (outcome === 'unknown')
      boundary.logout.mockRejectedValueOnce(
        new Error('remote outcome unknown'),
      );
    await act(async () => {
      const operation = result.current.account.logout();
      if (outcome === 'confirmed')
        await expect(operation).resolves.toEqual({ revoked: true });
      else await expect(operation).rejects.toThrow('remote outcome unknown');
    });
    expect(boundary.logout).toHaveBeenCalledTimes(1);
    expect(before?.isCurrent()).toBe(false);
    expect(result.current.scope).toBeUndefined();
    expect(
      boundary.repository?.captureNativeRequestBinding(
        'station-profile:relay',
        origin,
      )?.bindingId,
    ).toBe(bindingId);
    expect(await checkServerHealth(origin)).toBe(true);
    await act(async () => {
      await result.current.account.login({
        username: 'alice',
        password: 'test-password',
      });
    });
    expect(result.current.scope?.isCurrent()).toBe(true);
    await listProjectViews(origin, { requestScope: result.current.scope });
  },
);

it('retires an expired account owner so the same approved Device can sign in again', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const { result } = mounted();
  await act(async () => {
    await result.current.account.login({
      username: 'alice',
      password: 'test-password',
    });
  });
  const before = result.current.scope;
  expect(before?.isCurrent()).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_001);
  });
  expect(before?.isCurrent()).toBe(false);
  expect(result.current.scope).toBeUndefined();
  await act(async () => {
    await result.current.account.login({
      username: 'alice',
      password: 'test-password',
    });
  });
  expect(result.current.scope?.isCurrent()).toBe(true);
  expect(
    boundary.repository?.captureNativeRequestBinding(
      'station-profile:relay',
      origin,
    )?.bindingId,
  ).toBe(bindingId);
});
