// @vitest-environment jsdom

import {
  authenticatedFetch,
  setClientCredentialResolver,
} from '@kontourai/station-sdk';
import { render, waitFor } from '@testing-library/react';
import { type ReactNode, useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeTransport = vi.hoisted(() => vi.fn<typeof fetch>());
const nativeBinding = vi.hoisted(() => ({
  current: {
    bindingId: '11111111-1111-4111-8111-111111111111',
    exactOrigin: 'https://station.example.test',
  } as { bindingId: string; exactOrigin: string } | null,
}));

vi.mock('@kontourai/station-connect', () => ({
  requestAuthorityScopeFromCredentialEvidence: (
    evidence: {
      connectionId: string;
      activationEpoch: string;
      authorityGeneration: number;
      credentialState: string;
      origin: string;
    },
    options?: { authorityQualifier?: string },
  ) => ({
    apiBase: evidence.origin,
    authorityKey: JSON.stringify([
      evidence.connectionId,
      evidence.activationEpoch,
      evidence.authorityGeneration,
      evidence.credentialState,
      ...(options?.authorityQualifier ? [options.authorityQualifier] : []),
    ]),
  }),
  ConnectionsProvider: ({ children }: { children: ReactNode }) => children,
  DEFAULT_CONNECTION_CREDENTIAL_KEY: 'station-connection-credential',
  defaultCredentialStorage: { remove: vi.fn() },
  RejectingCredentialStorage: class {},
  setNativePairingExchangeTransport: vi.fn(),
  useConnections: () => ({
    apiBase: 'https://station.example.test',
    activeConnection: {
      id: 'station-profile:station',
      lastError: undefined,
    },
    credentialProvider: { getCredential: () => undefined },
    markCredentialRequired: vi.fn(),
    // Every accepted authenticated response now reports back so stale
    // credential evidence can be retired; the store decides whether there IS
    // anything stale, from the connection and credential generation captured
    // when the request STARTED. This fixture's connection has nothing stale,
    // but both calls still happen, so the fixture has to provide them.
    captureCredentialEvidence: () => ({
      connectionId: 'station-profile:station',
      activationEpoch: 'runtime:1',
      generation: 0,
      authorityGeneration: 0,
      credentialState: 'device-session',
      origin: 'https://station.example.test',
    }),
    isCredentialEvidenceCurrent: () => true,
    recordAuthenticatedSuccess: vi.fn(),
    // #3602: the SSE wake watches the connection's credential-authority
    // generation rather than the credential VALUE (a browser device session
    // has none, before or after pairing).
    credentialAuthorityGeneration: () => 0,
  }),
}));

vi.mock('../../platform/PlatformProfileContext', () => ({
  useNativeProfileStoreEpoch: () => 0,
  useNativeProfileSelection: () => async () => {},
  usePlatformProfile: () => ({
    isTauri: true,
    target: 'android',
    isMobile: true,
    isDesktop: false,
    supervisesBundledServer: false,
    isDevBuild: true,
  }),
  nativeProfileRepository: () => ({
    get: () => null,
    set: () => {},
    remove: () => {},
    commitVerifiedPairing: async () => 'station-profile:station',
    makeDefault: async () => {},
    authorizeActiveConnection: async () => true,
    captureNativeRequestBinding: () => nativeBinding.current,
  }),
}));

vi.mock('../../platform/native/authenticatedTransport', () => ({
  nativeAuthenticatedTransport: nativeTransport,
}));

import { getJson } from '../../../../packages/sdk/src/client/http';
import { ApiBaseProvider } from '../ApiBaseContext';

let firstHealthRequest: Promise<Response> | undefined;
let firstScopedHealthRequest: Promise<Response> | undefined;

function InitialHealthProbe() {
  useLayoutEffect(() => {
    firstHealthRequest = authenticatedFetch(
      'https://station.example.test/api/system/identity',
    );
  }, []);
  return null;
}

function ScopedInitialHealthProbe() {
  useLayoutEffect(() => {
    firstScopedHealthRequest = getJson(
      'https://station.example.test/api/system/identity',
      {
        requestScope: {
          apiBase: 'https://station.example.test',
          authorityKey: JSON.stringify([
            'station-profile:station',
            'runtime:1',
            0,
            'device-session',
            '11111111-1111-4111-8111-111111111111',
          ]),
        },
      },
    );
    // The assertion awaits this same promise below; attach a rejection handler
    // now because layout effects run before the test can observe it.
    void firstScopedHealthRequest.catch(() => undefined);
  }, []);
  return null;
}

describe('ApiBaseContext native transport installation order', () => {
  beforeEach(() => {
    firstHealthRequest = undefined;
    firstScopedHealthRequest = undefined;
    nativeBinding.current = {
      bindingId: '11111111-1111-4111-8111-111111111111',
      exactOrigin: 'https://station.example.test',
    };
    setClientCredentialResolver(undefined);
    nativeTransport.mockReset();
    nativeTransport.mockResolvedValue(new Response('{}', { status: 200 }));
  });

  afterEach(() => {
    setClientCredentialResolver(undefined);
    vi.unstubAllGlobals();
  });

  it('installs the native authenticated transport before a child layout-effect health probe', async () => {
    const rawFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', rawFetch);

    render(
      <ApiBaseProvider>
        <InitialHealthProbe />
      </ApiBaseProvider>,
    );

    await waitFor(() => expect(firstHealthRequest).toBeDefined());
    await expect(firstHealthRequest).resolves.toMatchObject({ status: 200 });
    expect(nativeTransport).toHaveBeenCalledOnce();
    const ordinaryInit = nativeTransport.mock.calls[0]?.[1] as
      | { expectedBindingId?: string }
      | undefined;
    expect(ordinaryInit).toMatchObject({
      expectedBindingId: '11111111-1111-4111-8111-111111111111',
      authorityGuard: expect.any(Function),
    });
    expect(rawFetch).not.toHaveBeenCalled();
  });

  it('fails a scoped native request closed when its exact authorized receipt is absent', async () => {
    nativeBinding.current = null;
    render(
      <ApiBaseProvider>
        <ScopedInitialHealthProbe />
      </ApiBaseProvider>,
    );
    await waitFor(() => expect(firstScopedHealthRequest).toBeDefined());
    await expect(firstScopedHealthRequest).rejects.toMatchObject({
      name: 'StationRequestAuthorityError',
    });
    expect(nativeTransport).not.toHaveBeenCalled();
  });

  it('passes the captured guard and opaque receipt through the lazy native transport', async () => {
    render(
      <ApiBaseProvider>
        <ScopedInitialHealthProbe />
      </ApiBaseProvider>,
    );
    await waitFor(() => expect(firstScopedHealthRequest).toBeDefined());
    await expect(firstScopedHealthRequest).resolves.toMatchObject({
      status: 200,
    });
    const init = nativeTransport.mock.calls[0]?.[1] as RequestInit & {
      authorityGuard?: () => void;
      expectedBindingId?: string;
    };
    expect(init.authorityGuard).toEqual(expect.any(Function));
    expect(init.expectedBindingId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('does not dispatch an old queued scope after the same profile receives a fresh native receipt', async () => {
    nativeBinding.current = {
      bindingId: '22222222-2222-4222-8222-222222222222',
      exactOrigin: 'https://station.example.test',
    };
    render(
      <ApiBaseProvider>
        <ScopedInitialHealthProbe />
      </ApiBaseProvider>,
    );
    await waitFor(() => expect(firstScopedHealthRequest).toBeDefined());
    await expect(firstScopedHealthRequest).rejects.toMatchObject({
      name: 'StationRequestAuthorityError',
    });
    expect(nativeTransport).not.toHaveBeenCalled();
  });
});
