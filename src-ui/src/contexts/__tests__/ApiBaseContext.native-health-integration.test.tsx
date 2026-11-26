/**
 * #3906: the native boot path is deliberately covered as one composition.
 *
 * The individual storage, SDK, and coordinator contracts have smaller unit
 * suites. This proves the real path a mobile build takes: a hydrated
 * host-owned profile supplies the connection, the public compatibility
 * handshake leads to an authenticated identity probe, and only that current
 * native response may retire a stale native failure. The bridge and transport
 * are the two process/host boundaries; no bearer exists in this renderer test.
 */
// @vitest-environment jsdom

import {
  type ConnectionStatusResult,
  ConnectionStore,
  RejectingCredentialStorage,
  useConnectionStatus,
  useConnections,
} from '@kontourai/station-connect';
import type { StationProfileStore } from '@kontourai/station-contracts';
import {
  STATION_ENVELOPE_HEADER,
  STATION_ENVELOPE_HEADER_VALUE,
} from '@kontourai/station-contracts/http';
import {
  authenticatedFetch,
  setClientCredentialResolver,
} from '@kontourai/station-sdk';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkServerHealth,
  probeServerConnection,
} from '../../lib/serverHealth';
import { NativeStationProfileStorage } from '../../platform/native/stationProfileStorage';

const nativeTransport = vi.hoisted(() => vi.fn<typeof fetch>());
const native = vi.hoisted(() => ({
  repository: null as NativeStationProfileStorage | null,
  store: null as ConnectionStore | null,
  epoch: 0,
}));

vi.mock('@kontourai/station-connect', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/station-connect')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    ConnectionsProvider: (
      props: ComponentProps<typeof actual.ConnectionsProvider>,
    ) => {
      if (!native.store)
        throw new Error('native connection store is not ready');
      return createElement(actual.ConnectionsProvider, {
        ...props,
        store: native.store,
      });
    },
  };
});

vi.mock('../../platform/PlatformProfileContext', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    nativeProfileRepository: () => {
      if (!native.repository) throw new Error('native fixture is not ready');
      return native.repository;
    },
    useNativeProfileSelection: () => async () => {},
    useNativeProfileStoreEpoch: () =>
      useSyncExternalStore(
        (listener) =>
          native.repository!.subscribeRelayRouteProfiles(() => {
            native.epoch += 1;
            listener();
          }),
        () => native.epoch,
      ),
    usePlatformProfile: () => ({
      isTauri: true,
      target: 'android',
      isMobile: true,
      isDesktop: false,
      supervisesBundledServer: false,
      isDevBuild: false,
      channel: 'nightly',
    }),
  };
});

vi.mock('../../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => null,
}));

vi.mock('../../platform/native/authenticatedTransport', () => ({
  nativeAuthenticatedTransport: nativeTransport,
}));

import { ApiBaseProvider } from '../ApiBaseContext';

const PROFILE_STORE: StationProfileStore = {
  schemaVersion: 1,
  revision: 0,
  defaultProfile: 'nightly-owner',
  projectProfiles: {},
  profiles: [
    {
      schemaVersion: 1,
      name: 'nightly-owner',
      endpoint: 'https://station.example.test:8444',
      credentialRef: { kind: 'station-bearer', id: 'host-owned-ref' },
      environmentId: 'environment-1',
      setupSource: 'paired',
      configurationState: 'configured',
      createdAt: 1,
      updatedAt: 2,
    },
    {
      schemaVersion: 1,
      name: 'another-station',
      endpoint: 'https://another.example.test:8444',
      credentialRef: { kind: 'station-bearer', id: 'other-host-ref' },
      environmentId: 'environment-2',
      setupSource: 'paired',
      configurationState: 'configured',
      createdAt: 1,
      updatedAt: 2,
    },
  ],
};

const stationIdentityHeaders = {
  'Content-Type': 'application/json',
  [STATION_ENVELOPE_HEADER]: STATION_ENVELOPE_HEADER_VALUE,
};

const HANDSHAKE = {
  schemaVersion: 1,
  environmentId: 'environment-1',
  authentication: { scheme: 'bearer', protocolVersion: 1 },
  transports: { http: 1, sse: 1, websocket: 1 },
  compatibility: {
    serverVersion: '0.4.1',
    protocolVersion: 1,
    minClientProtocol: 1,
  },
};

let connections: ReturnType<typeof useConnections> | undefined;
let health: ConnectionStatusResult | undefined;
let bindingId = '11111111-1111-4111-8111-111111111111';
let profileStore: StationProfileStore;
let authorizedOrigins: string[];
let routeRefreshError: Error | undefined;

function NativeHealthProbe() {
  connections = useConnections();
  health = useConnectionStatus({
    checkHealth: checkServerHealth,
    probeEndpoint: probeServerConnection,
    pollInterval: 60_000,
  });
  return null;
}

function currentConnection() {
  const connection = connections?.activeConnection;
  if (!connection) throw new Error('expected a hydrated active Station');
  return connection;
}

function markCurrentFailure() {
  const connection = currentConnection();
  connections?.recordEndpointFailure(connection.id, 'unreachable');
  const evidence = connections?.captureCredentialEvidence();
  connections?.markCredentialRequired(
    connection.id,
    undefined,
    evidence?.generation,
  );
}

describe('ApiBaseContext native health integration', () => {
  beforeEach(async () => {
    bindingId = '11111111-1111-4111-8111-111111111111';
    native.epoch = 0;
    authorizedOrigins = [];
    routeRefreshError = undefined;
    profileStore = structuredClone(PROFILE_STORE);
    native.repository = new NativeStationProfileStorage({
      async invoke<T>(
        command: string,
        args?: Record<string, unknown>,
      ): Promise<T> {
        if (command === 'station_profile_store_read')
          return structuredClone(profileStore) as T;
        if (command === 'station_profile_authorize_active') {
          return {
            bindingId,
            exactOrigin: profileStore.profiles.find(
              (profile) => profile.name === args?.profileName,
            )?.endpoint,
          } as T;
        }
        if (command === 'station_profile_refresh_routes') {
          expect(args).toEqual({ bindingId });
          if (routeRefreshError) throw routeRefreshError;
          return {
            bindingId,
            exactOrigin: profileStore.profiles[0].endpoint,
            authorizedOrigins,
            expiresAtMs: Date.now() + 600_000,
          } as T;
        }
        throw new Error(`unexpected native command: ${command}`);
      },
    });
    await native.repository.hydrate();
    await native.repository.authorizeDefaultProfile();
    native.store = new ConnectionStore({
      storage: native.repository,
      credentialStorage: new RejectingCredentialStorage(),
      locks: null,
    });
    nativeTransport.mockReset();
    nativeTransport.mockImplementation(async () =>
      Response.json({ bootId: 'boot-1' }, { headers: stationIdentityHeaders }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (!url.includes('/.well-known/station/v1')) {
          throw new Error(`unexpected renderer fetch: ${url}`);
        }
        expect(new Headers(init?.headers).has('Authorization')).toBe(false);
        return Response.json(HANDSHAKE);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    connections = undefined;
    health = undefined;
    native.repository = null;
    native.store = null;
    setClientCredentialResolver(undefined);
    vi.unstubAllGlobals();
  });

  it('restores the selected saved profile and recovers health only from a current authenticated identity response', async () => {
    render(
      <ApiBaseProvider>
        <NativeHealthProbe />
      </ApiBaseProvider>,
    );

    await waitFor(() =>
      expect(health).toMatchObject({ status: 'connected', reason: null }),
    );
    expect(connections?.connections).toHaveLength(2);
    expect(currentConnection()).toMatchObject({
      id: 'station-profile:nightly-owner',
      hostOwnedCredential: true,
      credentialState: 'saved',
    });
    // A different saved endpoint stays distinct and the saved default owns
    // selection without a build-supplied connection.
    expect(connections?.connections.map((connection) => connection.id)).toEqual(
      ['station-profile:nightly-owner', 'station-profile:another-station'],
    );
    // A credential reference is metadata; no bearer is projected into renderer
    // storage (and the native transport receives no Authorization header below).
    expect(JSON.stringify(connections?.connections)).not.toContain('Bearer ');

    await act(async () => {
      markCurrentFailure();
    });
    expect(currentConnection()).toMatchObject({
      credentialState: 'required',
      lastError: { reason: 'unreachable' },
    });
    // Let the provider publish the current failure before issuing the next
    // request: the SDK resolver is installed from that live provider snapshot.
    await waitFor(() =>
      expect(connections?.activeConnection?.credentialState).toBe('required'),
    );

    // Retry through the real coordinator: public compatibility handshake then
    // SDK-authenticated identity. Removing ApiBaseContext's onAuthenticated
    // wiring makes this recovery remain required.
    await act(async () => {
      health?.recheck();
    });
    await waitFor(() =>
      expect(currentConnection().credentialState).toBe('saved'),
    );
    expect(currentConnection().lastError).toBeUndefined();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([url]) =>
          String(url).includes('/.well-known/station/v1'),
        ),
    ).toBe(true);
    const identityCall = nativeTransport.mock.calls.find(([url]) =>
      String(url).includes('/api/system/identity'),
    );
    expect(identityCall).toBeDefined();
    // station#2327: the probe's identity read reaches the native transport
    // through the real SDK and ApiBaseContext wrappers still flagged for the
    // broker's reserved liveness slot.
    expect(
      (identityCall?.[1] as { livenessProbe?: boolean } | undefined)
        ?.livenessProbe,
    ).toBe(true);
    expect(
      new Headers(nativeTransport.mock.calls.at(-1)?.[1]?.headers).has(
        'Authorization',
      ),
    ).toBe(false);

    // A public success says nothing about a credential. Keep the protected
    // identity response pending; the failure must persist until that actual
    // authenticated response settles successfully.
    await act(async () => markCurrentFailure());
    let releaseDeferredIdentity: ((response: Response) => void) | undefined;
    nativeTransport.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releaseDeferredIdentity = resolve;
        }),
    );
    await act(async () => health?.recheck());
    await waitFor(() => expect(releaseDeferredIdentity).toBeDefined());
    expect(currentConnection().credentialState).toBe('required');
    expect(currentConnection().lastError?.reason).toBe('unreachable');
    await act(async () =>
      releaseDeferredIdentity?.(
        Response.json(
          { bootId: 'boot-2' },
          { headers: stationIdentityHeaders },
        ),
      ),
    );
    await waitFor(() =>
      expect(currentConnection().credentialState).toBe('saved'),
    );

    // An accepted identity response that began before a newer failure is stale
    // evidence. The real SDK callback carries the request-time generation and
    // the real store refuses to let it clear the later failure.
    let releaseStaleIdentity: ((response: Response) => void) | undefined;
    nativeTransport.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releaseStaleIdentity = resolve;
        }),
    );
    const staleRequest = authenticatedFetch(
      'https://station.example.test:8444/api/system/identity',
    );
    await waitFor(() => expect(releaseStaleIdentity).toBeDefined());
    await act(async () => markCurrentFailure());
    await act(async () => {
      releaseStaleIdentity?.(
        Response.json(
          { bootId: 'old-boot' },
          { headers: stationIdentityHeaders },
        ),
      );
      await staleRequest.catch(() => undefined);
    });
    expect(currentConnection().credentialState).toBe('required');
    expect(currentConnection().lastError?.reason).toBe('unreachable');

    // Changing only the host-issued binding retires the old response. Hold the
    // connection and generation fixed; this is authority, not a credential.
    let releaseOldBinding: ((response: Response) => void) | undefined;
    nativeTransport.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releaseOldBinding = resolve;
        }),
    );
    const oldBindingRequest = authenticatedFetch(
      'https://station.example.test:8444/api/system/identity',
    );
    await waitFor(() => expect(releaseOldBinding).toBeDefined());
    bindingId = '22222222-2222-4222-8222-222222222222';
    await native.repository?.authorizeActiveConnection(currentConnection().id);
    await act(async () => {
      releaseOldBinding?.(
        Response.json(
          { bootId: 'old-binding-boot' },
          { headers: stationIdentityHeaders },
        ),
      );
      await expect(oldBindingRequest).rejects.toMatchObject({
        name: 'StationRequestAuthorityError',
      });
    });
    expect(currentConnection()).toMatchObject({
      credentialState: 'required',
      lastError: { reason: 'unreachable' },
    });
  });

  it('selects host-authorized HTTPS through health and the SDK while retaining local HTTP recovery', async () => {
    const anchor = 'http://127.0.0.1:3774';
    const alternate = 'https://kontour.example.test';
    profileStore.profiles[0].endpoint = anchor;
    profileStore.revision += 1;
    await native.repository!.refresh();
    await native.repository!.authorizeDefaultProfile();
    render(
      <ApiBaseProvider>
        <NativeHealthProbe />
      </ApiBaseProvider>,
    );
    await waitFor(() => expect(health?.status).toBe('connected'));
    expect(currentConnection().url).toBe(anchor);
    authorizedOrigins = [alternate];
    await act(async () =>
      native.repository!.refreshNativeRoutes(currentConnection().id),
    );
    await waitFor(() => expect(currentConnection().url).toBe(alternate));
    const candidateIdentity = nativeTransport.mock.calls.find(
      ([url]) => String(url) === `${alternate}/api/system/identity`,
    );
    expect(candidateIdentity).toBeDefined();
    expect(candidateIdentity?.[1]).toMatchObject({
      expectedBindingId: bindingId,
      livenessProbe: true,
      authorityGuard: expect.any(Function),
    });
    await authenticatedFetch(`${alternate}/api/system/status`);
    expect(nativeTransport.mock.calls.at(-1)?.[0]).toBe(
      `${alternate}/api/system/status`,
    );
    expect(
      new Headers(nativeTransport.mock.calls.at(-1)?.[1]?.headers).has(
        'Authorization',
      ),
    ).toBe(false);
    expect(profileStore.profiles[0].endpoint).toBe(anchor);
    expect(
      currentConnection().endpoints.map((endpoint) => endpoint.url),
    ).toContain(anchor);

    const unknown = 'https://not-approved.example.test';
    const publicAttempts = vi.mocked(fetch).mock.calls.length;
    const privateAttempts = nativeTransport.mock.calls.length;
    expect(
      await probeServerConnection(
        unknown,
        undefined,
        'environment-1',
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: false });
    expect(vi.mocked(fetch).mock.calls).toHaveLength(publicAttempts);
    expect(nativeTransport.mock.calls).toHaveLength(privateAttempts);

    nativeTransport.mockImplementation(async (input) => {
      if (new URL(String(input)).origin === alternate)
        throw new Error('offline');
      return Response.json(
        { bootId: 'local-recovery' },
        { headers: stationIdentityHeaders },
      );
    });
    await act(async () => health?.recheck());
    await waitFor(() => expect(currentConnection().url).toBe(anchor));
    expect(health?.status).toBe('connected');
    expect(profileStore.profiles[0].endpoint).toBe(anchor);
  });

  it('withdraws HTTPS receipts immediately after host refresh fails and recovers canonical health', async () => {
    render(
      <ApiBaseProvider>
        <NativeHealthProbe />
      </ApiBaseProvider>,
    );
    await waitFor(() => expect(health?.status).toBe('connected'));
    const anchor = currentConnection().url;
    const connectionId = currentConnection().id;
    const alternate = 'https://kontour.example.test';
    authorizedOrigins = [alternate];
    await act(async () => native.repository!.refreshNativeRoutes(connectionId));
    await waitFor(() => expect(currentConnection().url).toBe(alternate));
    routeRefreshError = new Error('anchor proof unavailable');
    await act(async () => {
      await expect(
        native.repository!.refreshNativeRoutes(connectionId),
      ).rejects.toThrow('anchor proof unavailable');
      expect(
        native.repository!.captureNativeRequestBinding(connectionId, alternate),
      ).toBeNull();
      expect(
        native.repository!.captureNativeRequestBinding(connectionId, anchor),
      ).not.toBeNull();
    });
    await waitFor(() => expect(currentConnection().url).toBe(anchor));
    expect(
      currentConnection().endpoints.map((endpoint) => endpoint.url),
    ).toEqual([anchor]);
    await act(async () => health?.recheck());
    await waitFor(() => expect(health?.status).toBe('connected'));
    const privateAttempts = nativeTransport.mock.calls.length;
    expect(
      await probeServerConnection(
        alternate,
        undefined,
        'environment-1',
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: false });
    expect(nativeTransport.mock.calls).toHaveLength(privateAttempts);
  });

  it('does not send a native credential to an admitted route reporting another Station identity', async () => {
    render(
      <ApiBaseProvider>
        <NativeHealthProbe />
      </ApiBaseProvider>,
    );
    await waitFor(() => expect(health?.status).toBe('connected'));
    const anchor = currentConnection().url;
    const alternate = 'https://kontour.example.test';
    vi.mocked(fetch).mockImplementation(async (input) =>
      Response.json({
        ...HANDSHAKE,
        environmentId:
          new URL(String(input)).origin === alternate
            ? 'foreign-station'
            : HANDSHAKE.environmentId,
      }),
    );
    authorizedOrigins = [alternate];
    await act(async () =>
      native.repository!.refreshNativeRoutes(currentConnection().id),
    );
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([url]) => String(url).startsWith(alternate)),
      ).toBe(true),
    );
    await waitFor(() => expect(health?.checking).toBe(false));
    expect(currentConnection().url).toBe(anchor);
    expect(
      nativeTransport.mock.calls.some(([url]) =>
        String(url).startsWith(alternate),
      ),
    ).toBe(false);
  });

  it('ignores an alternate health body after its host binding is retired', async () => {
    render(
      <ApiBaseProvider>
        <NativeHealthProbe />
      </ApiBaseProvider>,
    );
    await waitFor(() => expect(health?.status).toBe('connected'));
    const anchor = currentConnection().url;
    const alternate = 'https://kontour.example.test';
    let releaseBody: (() => void) | undefined;
    nativeTransport.mockImplementation(async (input) => {
      if (new URL(String(input)).origin !== alternate)
        return Response.json(
          { bootId: 'canonical' },
          { headers: stationIdentityHeaders },
        );
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            releaseBody = () => {
              controller.enqueue(
                new TextEncoder().encode('{"bootId":"retired-alternate"}'),
              );
              controller.close();
            };
          },
        }),
        { headers: stationIdentityHeaders },
      );
    });
    authorizedOrigins = [alternate];
    await act(async () =>
      native.repository!.refreshNativeRoutes(currentConnection().id),
    );
    await waitFor(() => expect(releaseBody).toBeDefined());
    await native.repository!.authorizeDefaultProfile();
    await act(async () => releaseBody?.());
    await waitFor(() => expect(health?.checking).toBe(false));
    expect(currentConnection().url).toBe(anchor);
    expect(currentConnection().lastBootId).not.toBe('retired-alternate');
  });

  it('does not let a retired native binding body reach canonical health success', async () => {
    render(
      <ApiBaseProvider>
        <NativeHealthProbe />
      </ApiBaseProvider>,
    );
    await waitFor(() => expect(health?.status).toBe('connected'));

    let releaseBody: (() => void) | undefined;
    let nativeAttempts = 0;
    nativeTransport.mockImplementation(async () => {
      nativeAttempts += 1;
      if (nativeAttempts > 1) return new Promise<Response>(() => {});
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          releaseBody = () => {
            controller.enqueue(
              new TextEncoder().encode('{"bootId":"retired-body-boot"}'),
            );
            controller.close();
          };
        },
      });
      return new Response(body, {
        headers: stationIdentityHeaders,
      });
    });

    await act(async () => health?.recheck());
    await waitFor(() => expect(releaseBody).toBeDefined());
    // No connection or credential-generation mutation follows the request;
    // only the host-owned binding is retired before the body reader settles.
    bindingId = '33333333-3333-4333-8333-333333333333';
    await native.repository?.authorizeActiveConnection(currentConnection().id);
    await act(async () => releaseBody?.());

    await waitFor(() => expect(health?.status).toBe('error'));
    // Header acceptance was current and may legitimately retain the saved
    // credential; the stale BODY must not create coordinator success.
    expect(currentConnection().credentialState).toBe('saved');
    expect(JSON.stringify(currentConnection())).not.toContain(
      'retired-body-boot',
    );
    expect(nativeAttempts).toBeGreaterThanOrEqual(1);
  });
});
