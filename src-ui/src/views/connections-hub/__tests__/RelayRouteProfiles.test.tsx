/** @vitest-environment jsdom */

import { defaultStorage } from '@kontourai/station-connect';
import type { NativeVerifiedPeerSignaling } from '@kontourai/station-connect/native-application';
import type { NativeEnrollmentOpenedPeer } from '@kontourai/station-connect/native-enrollment';
import {
  emptyStationProfileStore,
  type StationProfileStore,
} from '@kontourai/station-contracts';
import type { ApprovedStationConnectionTrust } from '@kontourai/station-contracts/connection-proof';
import {
  NATIVE_RELAY_ENROLLMENT_ACTIVATE_PATH,
  NATIVE_RELAY_ENROLLMENT_BEGIN_PATH,
  NATIVE_RELAY_ENROLLMENT_FINALIZE_PATH,
  NATIVE_RELAY_ENROLLMENT_LOGIN_PATH,
  NATIVE_RELAY_ENROLLMENT_REGISTER_PATH,
  NATIVE_RELAY_ENROLLMENT_STATUS_PATH,
  NATIVE_RELAY_ENROLLMENT_VERSION,
} from '@kontourai/station-contracts/native-relay-enrollment';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { NativeStationProfileRepository } from '../../../platform/native/stationProfileStorage';

const mocks = vi.hoisted(() => ({
  isDesktop: true,
  profiles: [] as readonly Record<string, unknown>[],
  repository: null as NativeStationProfileRepository | null,
  listeners: new Set<() => void>(),
  remove: vi.fn(),
  save: vi.fn(),
  read: vi.fn(),
  close: vi.fn(),
  prepareKey: vi.fn(),
  beginKey: vi.fn(),
  cancelKey: vi.fn(),
  pendingKey: vi.fn(),
  approveKey: vi.fn(),
  revokeKey: vi.fn(),
  keyStatus: vi.fn(),
  grantInvoke: vi.fn(),
  enrollmentInvoke: vi.fn(),
  exchangeResponse: vi.fn(),
  openVerifiedPeer: vi.fn(),
  exchangeSignals: [] as AbortSignal[],
  finalizeResponses: [] as unknown[],
  recoveryAttempts: [] as unknown[],
  transitionCurrentFails: false,
  credentialEvidence: null as null | {
    connectionId: string;
    origin: string;
    nativeBrokerRoute: {
      routeVersion: 1;
      profileName: string;
      profileRevision: number;
      brokerOrigin: string;
      stationId: string;
      enrollmentId: string;
    };
  },
  accountSessionActive: false,
  accountLogin: vi.fn(),
  accountAcceptInvitation: vi.fn(),
  accountRetire: vi.fn(),
}));

vi.mock('@kontourai/station-connect', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/station-connect')>();
  return {
    ...actual,
    useConnections: () => ({
      captureCredentialEvidence: () => mocks.credentialEvidence,
      isCredentialEvidenceCurrent: () => true,
    }),
  };
});

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () =>
    mocks.accountSessionActive
      ? { requiresEnrolledCredential: true, isCurrent: () => true }
      : undefined,
  useNativeRelayAccountSession: () => ({
    login: mocks.accountLogin,
    acceptInvitation: mocks.accountAcceptInvitation,
    retireAccount: mocks.accountRetire,
  }),
}));

vi.mock(
  '../../../platform/native/nativeRelayGrantAdapter',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../platform/native/nativeRelayGrantAdapter')
      >();
    return {
      ...actual,
      nativeRelayGrantAdapter: actual.createNativeRelayGrantAdapter(
        mocks.grantInvoke,
      ),
    };
  },
);

vi.mock('../../../platform/native/tauriInvoke', () => ({
  invokeTauri: <T,>(command: string, args?: Record<string, unknown>) =>
    mocks.enrollmentInvoke(command, args) as Promise<T>,
}));

vi.mock(
  '@kontourai/station-connect/native-application',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-connect/native-application')
      >();
    return {
      ...actual,
      createNativeVerifiedPeerTransport: (input: {
        signaling: NativeVerifiedPeerSignaling;
        origin: string;
        trust: {
          current(): ApprovedStationConnectionTrust | null;
          recheck(
            value: ApprovedStationConnectionTrust,
            stage: 'checkpoint' | 'before-remote-description',
          ): Promise<boolean>;
        };
      }) => ({
        openVerifiedPeer: (signal: AbortSignal) =>
          mocks.openVerifiedPeer(input, signal),
      }),
    };
  },
);

vi.mock(
  '@kontourai/station-connect/native-enrollment',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-connect/native-enrollment')
      >();
    return {
      ...actual,
      createNativeEnrollmentExchange: (input: {
        signal: AbortSignal;
        open: (signal: AbortSignal) => Promise<NativeEnrollmentOpenedPeer>;
      }) => {
        mocks.exchangeSignals.push(input.signal);
        return async (
          prepare: (peerHandle: string) => Promise<{
            requestHandle: string;
            path: string;
          }>,
          accept: (
            requestHandle: string,
            response: unknown,
            status: number,
          ) => Promise<unknown>,
        ) => {
          input.signal.throwIfAborted();
          const opened = await input.open(input.signal);
          try {
            const request = await prepare(opened.peer.peerHandle);
            const response = await mocks.exchangeResponse(request);
            const result = await accept(request.requestHandle, response, 200);
            await opened.assertCurrent();
            return result;
          } finally {
            await opened.close();
          }
        };
      },
    };
  },
);

vi.mock('../../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isTauri: true, isDesktop: mocks.isDesktop }),
  nativeProfileRepository: () =>
    mocks.repository ?? {
      getRelayRouteProfiles: () => mocks.profiles,
      subscribeRelayRouteProfiles: (listener: () => void) => {
        mocks.listeners.add(listener);
        return () => mocks.listeners.delete(listener);
      },
      removeRelayRouteProfile: mocks.remove,
      saveRelayRouteProfile: mocks.save,
    },
}));

vi.mock(
  '@kontourai/station-connect/connection-trust',
  async (importOriginal) => ({
    // The real `stationRelayRouteTrustStatus` runs; only the device store is faked.
    ...(await importOriginal<
      typeof import('@kontourai/station-connect/connection-trust')
    >()),
    openDeviceConnectionTrustStore: async () => ({
      read: mocks.read,
      close: mocks.close,
    }),
  }),
);

vi.mock('../../../platform/native/relayKeyApproval', () => ({
  nativeRelayKeyApproval: {
    prepare: mocks.prepareKey,
    begin: mocks.beginKey,
    cancel: mocks.cancelKey,
    pending: mocks.pendingKey,
    approve: mocks.approveKey,
    revoke: mocks.revokeKey,
    status: mocks.keyStatus,
  },
}));

import { NativeStationProfileStorage } from '../../../platform/native/stationProfileStorage';
import { RelayRouteProfiles } from '../RelayRouteProfiles';

const stationId = '11111111-1111-4111-8111-111111111111';
const enrollmentId = '22222222-2222-4222-8222-222222222222';

function currentProfileStore(revision = 12, updatedAt = 2) {
  const store = emptyStationProfileStore();
  store.revision = revision;
  store.profiles.push({
    schemaVersion: 1,
    name: 'Home Station',
    endpoint: 'https://station.example',
    setupSource: 'manual',
    configurationState: 'unconfigured',
    createdAt: 1,
    updatedAt,
    clientInstanceId: '33333333-3333-4333-8333-333333333333',
    relayRoute: {
      brokerOrigin: 'https://broker.example',
      stationId,
      enrollmentId,
    },
  });
  return store;
}

const enrollmentHandle = 'E'.repeat(43);
const enrollmentPeerHandle = 'P'.repeat(43);
const enrollmentNonce = 'N'.repeat(43);
const enrollmentTransitionHandle = 'T'.repeat(43);
const enrollmentSurface = {
  kind: 'station-native' as const,
  appIdentifier: 'io.kontourai.station',
  channel: 'nightly' as const,
  clientInstanceId: '33333333-3333-4333-8333-333333333333',
  keyThumbprint: 'A'.repeat(43),
};
const enrollmentSigningKey = {
  kty: 'EC' as const,
  crv: 'P-256' as const,
  x: 'X'.repeat(43),
  y: 'Y'.repeat(43),
};
const enrollmentCandidate = {
  version: 'station-native-device-binding-candidate/v1',
  stationId,
  deviceId: '44444444-4444-4444-8444-444444444444',
  bindingId: '55555555-5555-4555-8555-555555555555',
  surface: enrollmentSurface,
  deviceProofJwk: {
    kty: 'EC',
    crv: 'P-256',
    x: 'X'.repeat(43),
    y: 'Y'.repeat(43),
  },
  deviceProofKeyThumbprint: 'D'.repeat(43),
};

function configureEnrollmentHost() {
  let requestCounter = 0;
  mocks.openVerifiedPeer.mockImplementation(
    async (
      input: {
        signaling: NativeVerifiedPeerSignaling;
        origin: string;
        trust: {
          current(): ApprovedStationConnectionTrust | null;
          recheck(
            value: ApprovedStationConnectionTrust,
            stage: 'checkpoint' | 'before-remote-description',
          ): Promise<boolean>;
        };
      },
      signal: AbortSignal,
    ) => {
      const peer = await input.signaling.prepare(signal);
      await input.signaling.open(peer.peerHandle, 'offer-sdp', signal);
      await input.signaling.read(peer.peerHandle, signal);
      return {
        peer,
        stationAudience: input.origin,
        channel: {
          send() {},
          close() {},
          subscribe: () => () => {},
        },
        assertCurrent: async () => {
          const current = input.trust.current();
          if (!current || !(await input.trust.recheck(current, 'checkpoint')))
            throw new Error('test_binding_stale');
        },
        close: () => input.signaling.close(peer.peerHandle),
      };
    },
  );
  mocks.enrollmentInvoke.mockImplementation(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === 'station_native_enrollment_resume')
        return {
          version: NATIVE_RELAY_ENROLLMENT_VERSION,
          attempts: mocks.recoveryAttempts,
        };
      if (command === 'station_native_relay_enrollment_binding')
        return {
          profileName: 'Home Station',
          profileRevision: 12,
          scope: { stationId, enrollmentId, routingGeneration: 4 },
          surface: enrollmentSurface,
          trustRevision: 4,
          stationId,
          enrollmentId,
          generation: 3,
          signingKey: enrollmentSigningKey,
        };
      if (command === 'station_native_relay_ice_configuration')
        return {
          version: 'station-relay-ice-configuration/v1',
          scope: { stationId, enrollmentId, routingGeneration: 4 },
          surface: enrollmentSurface,
          iceTransportPolicy: 'relay',
          issuedAt: Date.now(),
          expiresAt: Date.now() + 600_000,
          iceServers: [
            {
              urls: ['turns:relay.example:5349?transport=tcp'],
              username: 'short-lived-user',
              credential: 'short-lived-secret',
            },
          ],
        };
      if (command === 'station_native_enrollment_peer_prepare')
        return {
          version: 'station-native-enrollment-peer/v1',
          peerHandle: enrollmentPeerHandle,
          nonce: enrollmentNonce,
          connectionId: enrollmentSurface.clientInstanceId,
          expiresAt: Date.now() + 120_000,
          scope: { stationId, enrollmentId, routingGeneration: 4 },
          surface: enrollmentSurface,
          stationAudience: 'https://station.example',
          trust: {
            stationId,
            enrollmentId,
            generation: 3,
            signingKey: enrollmentSigningKey,
          },
        };
      if (command === 'station_native_enrollment_peer_open')
        return { expiresAt: Date.now() + 110_000 };
      if (command === 'station_native_enrollment_peer_read')
        return {
          version: 'station-broker-native-connection-answer/v2',
          answerSdp: 'test-answer-sdp',
          stationProof: 'test-station-proof',
          expiresAt: Date.now() + 100_000,
        };
      if (command === 'station_native_enrollment_peer_close') return undefined;
      if (command.endsWith('_prepare')) {
        const path =
          command === 'station_native_enrollment_begin_prepare'
            ? NATIVE_RELAY_ENROLLMENT_BEGIN_PATH
            : command === 'station_native_enrollment_login_prepare'
              ? args?.invitation
                ? NATIVE_RELAY_ENROLLMENT_REGISTER_PATH
                : NATIVE_RELAY_ENROLLMENT_LOGIN_PATH
              : command === 'station_native_enrollment_finalize_prepare'
                ? NATIVE_RELAY_ENROLLMENT_FINALIZE_PATH
                : command === 'station_native_enrollment_activate_prepare'
                  ? NATIVE_RELAY_ENROLLMENT_ACTIVATE_PATH
                  : command === 'station_native_enrollment_status_prepare'
                    ? NATIVE_RELAY_ENROLLMENT_STATUS_PATH
                    : null;
        if (!path) throw new Error(`Unexpected enrollment prepare ${command}`);
        return {
          version: 'station-native-enrollment-request/v1',
          requestHandle: `${String(++requestCounter).padStart(42, '0')}Q`,
          peerHandle: String(args?.peerHandle ?? enrollmentPeerHandle),
          enrollmentHandle:
            typeof args?.enrollmentHandle === 'string'
              ? args.enrollmentHandle
              : enrollmentHandle,
          method: 'POST',
          path,
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        };
      }
      if (command === 'station_native_enrollment_challenge_accept')
        return {
          version: NATIVE_RELAY_ENROLLMENT_VERSION,
          enrollmentHandle,
          candidate: enrollmentCandidate,
          registrationAvailable: true,
        };
      if (
        command === 'station_native_enrollment_pending_accept' ||
        command === 'station_native_enrollment_status_accept'
      )
        return {
          version: NATIVE_RELAY_ENROLLMENT_VERSION,
          enrollmentHandle,
          state: 'pending',
        };
      if (command === 'station_native_enrollment_delivery_accept')
        return {
          version: NATIVE_RELAY_ENROLLMENT_VERSION,
          enrollmentHandle,
          state: 'staged',
        };
      if (
        command === 'station_native_enrollment_activation_accept' ||
        command === 'station_native_enrollment_transition_current'
      ) {
        if (
          command === 'station_native_enrollment_transition_current' &&
          mocks.transitionCurrentFails
        )
          throw new Error('native_enrollment_transition_retired');
        return {
          version: NATIVE_RELAY_ENROLLMENT_VERSION,
          enrollmentHandle:
            typeof args?.enrollmentHandle === 'string'
              ? args.enrollmentHandle
              : enrollmentHandle,
          state: 'active',
          profileRevision:
            typeof args?.expectedProfileRevision === 'number'
              ? args.expectedProfileRevision
              : 13,
          transitionHandle:
            typeof args?.transitionHandle === 'string'
              ? args.transitionHandle
              : enrollmentTransitionHandle,
        };
      }
      if (command === 'station_native_enrollment_abort') return undefined;
      throw new Error(`Unexpected native enrollment command: ${command}`);
    },
  );
  mocks.exchangeResponse.mockImplementation(
    async (request: { path: string }) => {
      if (request.path === NATIVE_RELAY_ENROLLMENT_BEGIN_PATH)
        return {
          version: NATIVE_RELAY_ENROLLMENT_VERSION,
          enrollmentHandle,
          candidate: enrollmentCandidate,
          registrationAvailable: true,
        };
      if (
        request.path === NATIVE_RELAY_ENROLLMENT_LOGIN_PATH ||
        request.path === NATIVE_RELAY_ENROLLMENT_REGISTER_PATH
      )
        return { state: 'pending' };
      if (request.path === NATIVE_RELAY_ENROLLMENT_STATUS_PATH)
        return { state: 'pending' };
      if (request.path === NATIVE_RELAY_ENROLLMENT_FINALIZE_PATH)
        return mocks.finalizeResponses.shift() ?? { state: 'delivered' };
      if (request.path === NATIVE_RELAY_ENROLLMENT_ACTIVATE_PATH)
        return { state: 'active' };
      throw new Error(`Unexpected enrollment request path ${request.path}`);
    },
  );
}

function configureEnrollmentReadyRoute() {
  configureEnrollmentHost();
  const liveStore = currentProfileStore();
  const grant = {
    route: {
      brokerOrigin: 'https://broker.example',
      stationId,
      enrollmentId,
      routingGeneration: 4,
      grantId: 'abcdefghijklmnopqrstuv',
    },
    stationSigningKeyId: 'sha256:station-signing-key',
    stationSigningGeneration: 3,
    expiresAt: Date.now() + 3_600_000,
  };
  mocks.grantInvoke.mockImplementation(async (command: string) => {
    if (command === 'station_profile_store_read') return liveStore;
    if (command === 'station_native_relay_grant_status')
      return {
        profileName: 'Home Station',
        profileRevision: 12,
        stationId,
        enrollmentId,
        grants: [{ metadata: grant, expired: false }],
        cleanups: [],
      };
    throw new Error(`Unexpected native grant command: ${command}`);
  });
  mocks.keyStatus.mockResolvedValue({
    status: 'approved',
    trustRevision: 4,
    profileName: 'Home Station',
    brokerOrigin: 'https://broker.example',
    stationId,
    enrollmentId,
    generation: 3,
    keyId: 'sha256:station-signing-key',
  });
  mocks.pendingKey.mockResolvedValue(null);
  return { liveStore };
}

function renderRoutes() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const element = () => (
    <QueryClientProvider client={queryClient}>
      <RelayRouteProfiles />
    </QueryClientProvider>
  );
  const rendered = render(element());
  return {
    ...rendered,
    queryClient,
    rerenderRoutes: () => rendered.rerender(element()),
  };
}

function selectNativeRelayRoute(profileName = 'Home Station') {
  mocks.credentialEvidence = {
    connectionId: `station-profile:${profileName.toLowerCase()}`,
    origin: 'https://station.example',
    nativeBrokerRoute: {
      routeVersion: 1,
      profileName,
      profileRevision: 12,
      brokerOrigin: 'https://broker.example',
      stationId,
      enrollmentId,
    },
  };
}

describe('RelayRouteProfiles', () => {
  beforeEach(() => {
    mocks.isDesktop = true;
    mocks.repository = null;
    mocks.listeners.clear();
    mocks.remove.mockReset();
    mocks.save.mockReset();
    mocks.read.mockReset();
    mocks.close.mockReset();
    mocks.prepareKey.mockReset();
    mocks.beginKey.mockReset();
    mocks.cancelKey.mockReset();
    mocks.cancelKey.mockResolvedValue(undefined);
    mocks.pendingKey.mockReset();
    mocks.approveKey.mockReset();
    mocks.revokeKey.mockReset();
    mocks.keyStatus.mockReset();
    mocks.grantInvoke.mockReset();
    mocks.enrollmentInvoke.mockReset();
    mocks.exchangeResponse.mockReset();
    mocks.openVerifiedPeer.mockReset();
    mocks.exchangeSignals.length = 0;
    mocks.finalizeResponses.length = 0;
    mocks.recoveryAttempts.length = 0;
    mocks.transitionCurrentFails = false;
    mocks.credentialEvidence = null;
    mocks.accountSessionActive = false;
    mocks.accountLogin.mockReset();
    mocks.accountAcceptInvitation.mockReset();
    mocks.accountRetire.mockReset();
    mocks.accountLogin.mockImplementation(async () => {
      mocks.accountSessionActive = true;
      return { authorityKey: 'test-account-scope' };
    });
    mocks.accountAcceptInvitation.mockResolvedValue({
      data: { grantsDeviceAccess: false },
    });
    mocks.accountRetire.mockImplementation(() => {
      mocks.accountSessionActive = false;
    });
    mocks.keyStatus.mockResolvedValue({
      status: 'untrusted',
      trustRevision: 0,
      profileName: 'Home Station',
      brokerOrigin: 'https://broker.example',
      stationId,
      enrollmentId,
      generation: null,
      keyId: null,
    });
    mocks.pendingKey.mockResolvedValue(null);
    const profile = {
      schemaVersion: 1,
      name: 'Home Station',
      endpoint: 'https://station.example',
      setupSource: 'manual',
      configurationState: 'unconfigured',
      createdAt: 1,
      updatedAt: 2,
      relayRoute: {
        brokerOrigin: 'https://broker.example',
        stationId,
        enrollmentId,
      },
    };
    mocks.profiles = [profile];
    mocks.read.mockResolvedValue({
      schemaVersion: 1,
      revision: 1,
      status: 'approved',
      trust: {
        stationId,
        enrollmentId,
        generation: 1,
        signingKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      },
    });
    mocks.remove.mockImplementation(async () => {
      mocks.profiles = [];
      for (const listener of mocks.listeners) listener();
    });
  });

  test('lists an unconnected route, offers edit, and removes it without revoking trust', async () => {
    renderRoutes();
    expect(screen.getByText('Saved broker routes')).toBeTruthy();
    expect(screen.getByText('Not connected')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText('Station key untrusted')).toBeTruthy(),
    );
    expect(
      screen.getByRole('button', { name: 'Prepare native Station identity' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(
      screen.getByRole('heading', { name: 'Edit broker route' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove this route' }));
    expect(
      screen.getByRole('heading', { name: 'Remove broker route?' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove route' }));
    await waitFor(() =>
      expect(mocks.remove).toHaveBeenCalledWith(
        'station-profile:home station',
        2,
      ),
    );
    expect(
      screen.getByText(
        'No broker routes are saved on this device yet. Save the Station and broker details provided by the Station operator to begin setup.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Add broker route' }),
    ).toBeTruthy();
  });

  test('redeems only from the explicit mounted route action and invalidates host grant status', async () => {
    const invitation = {
      version: 'station-broker-native-route-invitation/v2',
      brokerOrigin: 'https://broker.example',
      scope: { stationId, enrollmentId, routingGeneration: 4 },
      stationSigningKeyId: 'sha256:station-signing-key',
      stationSigningGeneration: 3,
      surface: {
        kind: 'station-native',
        appIdentifier: 'io.kontourai.station',
        channel: 'nightly',
        clientInstanceId: '33333333-3333-4333-8333-333333333333',
        keyThumbprint: 'sha256:install-proof',
      },
      invitationId: 'abcdefghijklmnopqrstuv',
      invitationSecret: 'a'.repeat(43),
      expiresAt: Date.now() + 60_000,
    };
    const grant = {
      route: {
        brokerOrigin: 'https://broker.example',
        stationId,
        enrollmentId,
        routingGeneration: 4,
        grantId: 'abcdefghijklmnopqrstuv',
      },
      stationSigningKeyId: 'sha256:station-signing-key',
      stationSigningGeneration: 3,
      expiresAt: Date.now() + 3_600_000,
    };
    let redeemed = false;
    const liveProfileStore = currentProfileStore();
    mocks.grantInvoke.mockImplementation(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === 'station_profile_store_read') return liveProfileStore;
        if (command === 'station_native_relay_grant_status') {
          expect(args).toEqual({ profileName: 'Home Station' });
          return {
            profileName: 'Home Station',
            profileRevision: 12,
            stationId,
            enrollmentId,
            grants: redeemed ? [{ metadata: grant, expired: false }] : [],
            cleanups: [],
          };
        }

        if (command === 'station_native_relay_grant_redeem') {
          expect(args).toEqual({
            profileName: 'Home Station',
            expectedProfileRevision: 12,
            invitation,
          });
          redeemed = true;
          return { status: 'redeemed', grant };
        }
        throw new Error(`Unexpected native grant command: ${command}`);
      },
    );
    mocks.keyStatus.mockResolvedValue({
      status: 'approved',
      trustRevision: 4,
      profileName: 'Home Station',
      brokerOrigin: 'https://broker.example',
      stationId,
      enrollmentId,
      generation: 3,
      keyId: 'sha256:station-signing-key',
    });
    mocks.pendingKey.mockResolvedValue(null);

    const { queryClient } = renderRoutes();
    await screen.findByText(
      'A routing grant has not been saved on this device.',
    );
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(mocks.grantInvoke).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('One-time routing invitation'), {
      target: { value: JSON.stringify(invitation) },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Redeem routing grant' }),
    );

    await screen.findByText(/Routing grant active · expires/);
    expect(mocks.grantInvoke).toHaveBeenCalledWith(
      'station_native_relay_grant_redeem',
      expect.objectContaining({
        profileName: 'Home Station',
        expectedProfileRevision: 12,
        invitation,
      }),
    );
    expect(mocks.grantInvoke).toHaveBeenCalledWith(
      'station_profile_store_read',
    );
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(
      screen.getByText(
        /account access, device approval, and Project access remain separate/,
      ),
    ).toBeTruthy();
    expect(
      queryClient.getQueryData([
        'native-relay-grant',
        'home station',
        2,
        'https://broker.example',
        stationId,
        enrollmentId,
      ]),
    ).toMatchObject({ grants: [{ metadata: grant }] });
  });

  test('does not redeem from an old mounted row after the live public row is replaced', async () => {
    const invitation = {
      version: 'station-broker-native-route-invitation/v2',
      brokerOrigin: 'https://broker.example',
      scope: { stationId, enrollmentId, routingGeneration: 4 },
      stationSigningKeyId: 'sha256:station-signing-key',
      stationSigningGeneration: 3,
      surface: {
        kind: 'station-native',
        appIdentifier: 'io.kontourai.station',
        channel: 'nightly',
        clientInstanceId: '33333333-3333-4333-8333-333333333333',
        keyThumbprint: 'sha256:install-proof',
      },
      invitationId: 'abcdefghijklmnopqrstuv',
      invitationSecret: 'a'.repeat(43),
      expiresAt: Date.now() + 60_000,
    };
    const liveProfileStore = currentProfileStore(13, 3);
    mocks.grantInvoke.mockImplementation(async (command: string) => {
      if (command === 'station_profile_store_read') return liveProfileStore;
      if (command === 'station_native_relay_grant_status')
        return {
          profileName: 'Home Station',
          profileRevision: 12,
          stationId,
          enrollmentId,
          grants: [],
          cleanups: [],
        };
      throw new Error(`Unexpected native grant command: ${command}`);
    });
    mocks.keyStatus.mockResolvedValue({
      status: 'approved',
      trustRevision: 4,
      profileName: 'Home Station',
      brokerOrigin: 'https://broker.example',
      stationId,
      enrollmentId,
      generation: 3,
      keyId: 'sha256:station-signing-key',
    });

    renderRoutes();
    await screen.findByText(
      'A routing grant has not been saved on this device.',
    );
    fireEvent.change(screen.getByLabelText('One-time routing invitation'), {
      target: { value: JSON.stringify(invitation) },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Redeem routing grant' }),
    );

    await screen.findByText(
      'The saved route changed. Review it and try again.',
    );
    expect(mocks.grantInvoke).toHaveBeenCalledWith(
      'station_profile_store_read',
    );
    expect(mocks.grantInvoke).not.toHaveBeenCalledWith(
      'station_native_relay_grant_redeem',
      expect.anything(),
    );
  });

  test('runs the explicit enrollment, registration, approval, staging and activation journey', async () => {
    configureEnrollmentReadyRoute();
    mocks.finalizeResponses.push({ state: 'pending' }, { state: 'delivered' });
    const rendered = renderRoutes();

    await screen.findByRole('heading', { name: 'Device setup' });
    fireEvent.click(screen.getByRole('button', { name: 'Begin Device setup' }));
    await screen.findByRole('heading', {
      name: 'Public Device candidate for the Station operator',
    });
    expect(screen.getByText(enrollmentCandidate.deviceId)).toBeTruthy();
    expect(
      screen.getByText(enrollmentCandidate.deviceProofKeyThumbprint),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Station account username'), {
      target: { value: 'operator-account@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Station account password'), {
      target: { value: 'test-password-only' },
    });
    fireEvent.click(
      screen.getByLabelText(
        'I have an operator invitation to register a new Station account',
      ),
    );
    fireEvent.change(
      screen.getByLabelText('Operator registration invitation'),
      { target: { value: 'test-operator-invitation' } },
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Register and request Device approval',
      }),
    );

    await screen.findByRole('region', { name: 'Pending operator approval' });
    expect(
      screen.getByText(
        'Waiting for the Station operator to approve this Device.',
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Station account password')).toBeNull();
    const loginCall = mocks.enrollmentInvoke.mock.calls.find(
      ([command]) => command === 'station_native_enrollment_login_prepare',
    );
    expect(loginCall?.[1]).toMatchObject({
      credentials: {
        username: 'operator-account@example.test',
        password: 'test-password-only',
      },
      invitation: 'test-operator-invitation',
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Check operator approval' }),
    );
    await screen.findByText(
      'The Station operator has not completed approval yet.',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Check and stage Device delivery' }),
    );
    await screen.findByText(
      'Operator approval is still pending. You can check again later.',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Check and stage Device delivery' }),
    );
    await screen.findByRole('region', { name: 'Device delivery staged' });
    expect(
      mocks.enrollmentInvoke.mock.calls.some(
        ([command]) => command === 'station_native_enrollment_activate_prepare',
      ),
    ).toBe(false);

    fireEvent.click(
      screen.getByRole('button', { name: 'Activate this Device' }),
    );
    await screen.findByText(/Device configured/);
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(
      screen.getByText(/Account sign-in and Project access remain separate/),
    ).toBeTruthy();
    expect(
      mocks.enrollmentInvoke.mock.calls.some(
        ([command]) =>
          command === 'station_native_enrollment_transition_current',
      ),
    ).toBe(true);

    rendered.unmount();
    expect(
      mocks.enrollmentInvoke.mock.calls.some(
        ([command]) => command === 'station_native_enrollment_abort',
      ),
    ).toBe(false);
  });

  test('requires explicit resume selection and runs begin only for the selected saved attempt', async () => {
    configureEnrollmentReadyRoute();
    mocks.recoveryAttempts.push({
      enrollmentHandle,
      phase: 'begin-required',
      profileRevision: 12,
      expiresAt: Date.now() + 60_000,
      registrationAvailable: false,
      candidate: null,
      transition: null,
    });
    renderRoutes();

    const resumeButton = await screen.findByRole('button', {
      name: `Resume saved setup 1`,
    });
    expect(
      screen.queryByRole('button', { name: 'Begin Device setup' }),
    ).toBeNull();
    expect(mocks.enrollmentInvoke).not.toHaveBeenCalledWith(
      'station_native_enrollment_begin_prepare',
      expect.anything(),
    );

    fireEvent.click(resumeButton);
    await screen.findByRole('heading', {
      name: 'Public Device candidate for the Station operator',
    });
    expect(mocks.enrollmentInvoke).toHaveBeenCalledWith(
      'station_native_enrollment_begin_prepare',
      expect.objectContaining({ enrollmentHandle }),
    );
    expect(
      screen.getByText(
        /does not sign in for application use or grant Project access/,
      ),
    ).toBeTruthy();
  });

  test('rechecks recovery before begin and blocks a setup that appeared meanwhile', async () => {
    configureEnrollmentReadyRoute();
    renderRoutes();
    const beginButton = await screen.findByRole('button', {
      name: 'Begin Device setup',
    });
    mocks.recoveryAttempts.push({
      enrollmentHandle,
      phase: 'candidate',
      profileRevision: 12,
      expiresAt: Date.now() + 60_000,
      registrationAvailable: false,
      candidate: enrollmentCandidate,
      transition: null,
    });

    fireEvent.click(beginButton);
    await screen.findByRole('button', {
      name: 'Resume Device 44444444-4444-4444-8444-444444444444',
    });
    expect(mocks.enrollmentInvoke).not.toHaveBeenCalledWith(
      'station_native_enrollment_begin_prepare',
      expect.anything(),
    );
  });

  test('shows configured only after selected active attempt passes host currentness', async () => {
    configureEnrollmentReadyRoute();
    mocks.recoveryAttempts.push({
      enrollmentHandle,
      phase: 'active',
      profileRevision: 12,
      expiresAt: Date.now() + 60_000,
      registrationAvailable: false,
      candidate: null,
      transition: {
        version: NATIVE_RELAY_ENROLLMENT_VERSION,
        enrollmentHandle,
        state: 'active',
        profileRevision: 12,
        transitionHandle: enrollmentTransitionHandle,
      },
    });
    renderRoutes();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Resume saved setup 1' }),
    );
    await screen.findByText(/Device configured/);
    expect(mocks.enrollmentInvoke).toHaveBeenCalledWith(
      'station_native_enrollment_transition_current',
      {
        enrollmentHandle,
        transitionHandle: enrollmentTransitionHandle,
        expectedProfileRevision: 12,
      },
    );
    expect(
      screen.getByText(/Account sign-in and Project access remain separate/),
    ).toBeTruthy();
  });

  test('does not display configured when selected active attempt fails host currentness', async () => {
    configureEnrollmentReadyRoute();
    mocks.transitionCurrentFails = true;
    mocks.recoveryAttempts.push({
      enrollmentHandle,
      phase: 'active',
      profileRevision: 12,
      expiresAt: Date.now() + 60_000,
      registrationAvailable: false,
      candidate: null,
      transition: {
        version: NATIVE_RELAY_ENROLLMENT_VERSION,
        enrollmentHandle,
        state: 'active',
        profileRevision: 12,
        transitionHandle: enrollmentTransitionHandle,
      },
    });
    renderRoutes();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Resume saved setup 1' }),
    );
    await screen.findByRole('alert');
    expect(screen.queryByText('Device configured')).toBeNull();
  });

  test('resumes staged delivery without automatically activating it', async () => {
    configureEnrollmentReadyRoute();
    mocks.recoveryAttempts.push({
      enrollmentHandle,
      phase: 'staged',
      profileRevision: 12,
      expiresAt: Date.now() + 60_000,
      registrationAvailable: false,
      candidate: enrollmentCandidate,
      transition: null,
    });
    renderRoutes();

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Resume Device 44444444-4444-4444-8444-444444444444',
      }),
    );
    await screen.findByRole('button', { name: 'Activate this Device' });
    expect(mocks.enrollmentInvoke).not.toHaveBeenCalledWith(
      'station_native_enrollment_activate_prepare',
      expect.anything(),
    );
  });

  test('mounts account sign-in only on the matching selected native route and keeps credentials transient', async () => {
    configureEnrollmentReadyRoute();
    selectNativeRelayRoute();
    const { queryClient } = renderRoutes();
    await screen.findByRole('region', {
      name: 'Station account for Home Station',
    });

    fireEvent.change(screen.getByLabelText('Station account username'), {
      target: { value: 'member@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Station account password'), {
      target: { value: 'transient-password' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Sign in to this Station account' }),
    );

    await screen.findByLabelText('Account invitation token');
    expect(mocks.accountLogin).toHaveBeenCalledWith({
      username: 'member@example.test',
      password: 'transient-password',
    });
    expect(screen.queryByLabelText('Station account password')).toBeNull();
    expect(
      queryClient
        .getMutationCache()
        .getAll()
        .every((mutation) => mutation.state.variables === undefined),
    ).toBe(true);

    fireEvent.change(screen.getByLabelText('Account invitation token'), {
      target: { value: 'one-time-account-invitation' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Accept account invitation' }),
    );
    await screen.findByText(/does not confirm Project membership/);
    expect(mocks.accountAcceptInvitation).toHaveBeenCalledWith(
      'one-time-account-invitation',
    );
    expect(
      (screen.getByLabelText('Account invitation token') as HTMLInputElement)
        .value,
    ).toBe('');

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Forget account session on this device',
      }),
    );
    await screen.findByLabelText('Station account username');
    expect(mocks.accountRetire).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(/remote Station account was not signed out or revoked/),
    ).toBeTruthy();
  });

  test('clears unsent account fields when the active native route changes', async () => {
    configureEnrollmentReadyRoute();
    selectNativeRelayRoute();
    const rendered = renderRoutes();
    await screen.findByLabelText('Station account username');
    fireEvent.change(screen.getByLabelText('Station account username'), {
      target: { value: 'member@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Station account password'), {
      target: { value: 'transient-password' },
    });

    selectNativeRelayRoute('Other Station');
    await act(async () => rendered.rerenderRoutes());
    expect(
      screen.queryByRole('region', {
        name: 'Station account for Home Station',
      }),
    ).toBeNull();
    selectNativeRelayRoute();
    await act(async () => rendered.rerenderRoutes());
    await screen.findByLabelText('Station account username');
    expect(
      (screen.getByLabelText('Station account username') as HTMLInputElement)
        .value,
    ).toBe('');
    expect(
      (screen.getByLabelText('Station account password') as HTMLInputElement)
        .value,
    ).toBe('');
  });

  test('aborts the owned attempt and network signal when the user cancels', async () => {
    configureEnrollmentReadyRoute();
    renderRoutes();
    await screen.findByRole('heading', { name: 'Device setup' });
    fireEvent.click(screen.getByRole('button', { name: 'Begin Device setup' }));
    await screen.findByRole('heading', {
      name: 'Public Device candidate for the Station operator',
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel Device setup' }),
    );
    await screen.findByRole('button', { name: 'Begin Device setup' });
    expect(mocks.exchangeSignals.at(-1)?.aborted).toBe(true);
    expect(mocks.enrollmentInvoke).toHaveBeenCalledWith(
      'station_native_enrollment_abort',
      { enrollmentHandle },
    );
    expect(screen.queryByText(/Device configured/)).toBeNull();
  });

  test('disposes an unfinished enrollment on row unmount', async () => {
    configureEnrollmentReadyRoute();
    const rendered = renderRoutes();
    await screen.findByRole('heading', { name: 'Device setup' });
    fireEvent.click(screen.getByRole('button', { name: 'Begin Device setup' }));
    await screen.findByRole('heading', {
      name: 'Public Device candidate for the Station operator',
    });
    const ownedSignal = mocks.exchangeSignals.at(-1);

    rendered.unmount();

    expect(ownedSignal?.aborted).toBe(true);
    await waitFor(() =>
      expect(mocks.enrollmentInvoke).toHaveBeenCalledWith(
        'station_native_enrollment_abort',
        { enrollmentHandle },
      ),
    );
  });

  test('revalidates the captured public row epoch against live host profile storage before begin', async () => {
    const { liveStore } = configureEnrollmentReadyRoute();
    renderRoutes();
    await screen.findByRole('button', { name: 'Begin Device setup' });

    liveStore.revision = 13;
    liveStore.profiles[0].updatedAt = 3;
    fireEvent.click(screen.getByRole('button', { name: 'Begin Device setup' }));

    await screen.findByText(
      'The saved route changed. Reopen setup and try again.',
    );
    expect(mocks.grantInvoke).toHaveBeenCalledWith(
      'station_profile_store_read',
    );
    expect(mocks.enrollmentInvoke).not.toHaveBeenCalledWith(
      'station_native_enrollment_begin_prepare',
      expect.anything(),
    );
  });

  test('creates a route from the empty state and persists it through the native repository', async () => {
    window.localStorage.clear();
    const persisted = { store: emptyStationProfileStore() };
    const bridge = {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        if (command === 'station_profile_store_read')
          return structuredClone(persisted.store) as T;
        if (command === 'station_profile_store_write') {
          if (args?.expectedRevision !== persisted.store.revision)
            throw new Error('profile store revision conflict');
          persisted.store = JSON.parse(
            String(args.contents),
          ) as StationProfileStore;
          return undefined as T;
        }
        throw new Error(`Unexpected native profile command: ${command}`);
      },
    };
    const repository = new NativeStationProfileStorage(
      bridge,
      defaultStorage,
      true,
    );
    await repository.hydrate();
    mocks.repository = repository;

    renderRoutes();
    expect(
      screen.getByText(
        'No broker routes are saved on this device yet. Save the Station and broker details provided by the Station operator to begin setup.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add broker route' }));

    fireEvent.change(screen.getByLabelText(/Station application address/), {
      target: { value: 'https://station.example' },
    });
    fireEvent.change(screen.getByLabelText(/Broker address/), {
      target: { value: 'https://broker.example' },
    });
    fireEvent.change(screen.getByLabelText('Station ID'), {
      target: { value: stationId },
    });
    fireEvent.change(screen.getByLabelText('Enrollment ID'), {
      target: { value: enrollmentId },
    });
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: 'Zach Station' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save route' }));

    await screen.findByText('Zach Station');
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(repository.getRelayRouteProfiles()).toHaveLength(1);
    expect(persisted.store.profiles[0]).toMatchObject({
      name: 'Zach Station',
      endpoint: 'https://station.example',
      relayRoute: {
        brokerOrigin: 'https://broker.example',
        stationId,
        enrollmentId,
      },
    });
    expect(persisted.store.profiles[0]).not.toHaveProperty('credentialRef');

    const restoredRepository = new NativeStationProfileStorage(
      bridge,
      defaultStorage,
      true,
    );
    await restoredRepository.hydrate();
    expect(restoredRepository.getRelayRouteProfiles()).toMatchObject([
      {
        name: 'Zach Station',
        relayRoute: {
          brokerOrigin: 'https://broker.example',
          stationId,
          enrollmentId,
        },
      },
    ]);
  });

  test('explains when the saved-route limit pauses automatic renewal', () => {
    const template = mocks.profiles[0];
    mocks.profiles = Array.from({ length: 65 }, (_, index) => ({
      ...template,
      name: `Saved route ${index}`,
    }));
    renderRoutes();
    expect(screen.getByRole('alert').textContent).toMatch(
      /renewal is paused for all saved routes/i,
    );
  });

  test('does not promise automatic renewal on mobile', () => {
    mocks.isDesktop = false;
    const template = mocks.profiles[0];
    mocks.profiles = Array.from({ length: 65 }, (_, index) => ({
      ...template,
      name: `Saved route ${index}`,
    }));
    renderRoutes();
    expect(
      screen.queryByText(
        /approved routing grants renew while this desktop app/i,
      ),
    ).toBeNull();
    expect(screen.queryByText(/automatic grant renewal is paused/i)).toBeNull();
  });

  test('hides cached approved trust and disables revocation after a native status refetch fails', async () => {
    mocks.keyStatus.mockResolvedValue({
      status: 'approved',
      trustRevision: 4,
      profileName: 'Home Station',
      brokerOrigin: 'https://broker.example',
      stationId,
      enrollmentId,
      generation: 3,
      keyId: 'sha256:cached-approved-key',
    });
    mocks.pendingKey.mockResolvedValue(null);
    const { queryClient } = renderRoutes();

    await screen.findByText('Station key approved');
    expect(screen.getByText('sha256:cached-approved-key')).toBeTruthy();
    mocks.keyStatus.mockRejectedValueOnce(
      new Error('native keyring unavailable'),
    );
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: ['native-relay-key-approval', 'Home Station', 'status'],
      });
    });

    await screen.findByText('Native key trust unavailable');
    expect(screen.queryByText('sha256:cached-approved-key')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Revoke Station key trust' }),
    ).toBeNull();
  });

  test('reveals rotation setup only on request and keeps the current key trusted until a new key is approved', async () => {
    const rotatedCandidate = {
      pendingId: 'pending-rotation',
      profileName: 'Home Station',
      brokerOrigin: 'https://broker.example',
      stationId,
      enrollmentId,
      generation: 8,
      keyId: 'sha256:rotated-station-key',
      confirmationCode: 'ABCD1234EFGH5678',
      expiresAt: Date.now() + 60_000,
      trustRevision: 1,
      status: 'pending' as const,
    };
    const approvedOldKey = {
      status: 'approved',
      trustRevision: 1,
      profileName: 'Home Station',
      brokerOrigin: 'https://broker.example',
      stationId,
      enrollmentId,
      generation: 7,
      keyId: 'sha256:old-station-key',
    };
    const approvedNewKey = {
      ...approvedOldKey,
      trustRevision: 2,
      generation: 8,
      keyId: rotatedCandidate.keyId,
    };
    mocks.keyStatus.mockResolvedValue(approvedOldKey);
    mocks.pendingKey.mockResolvedValue(null);
    mocks.prepareKey.mockResolvedValue({
      profileName: 'Home Station',
      brokerOrigin: 'https://broker.example',
      stationId,
      enrollmentId,
      appIdentifier: 'io.kontourai.station',
      channel: 'stable',
      clientInstanceId: 'install-1',
      keyThumbprint: 'sha256:install-proof',
      publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    });
    mocks.beginKey.mockImplementation(async () => {
      mocks.pendingKey.mockResolvedValue(rotatedCandidate);
      return rotatedCandidate;
    });
    mocks.approveKey.mockImplementation(async () => {
      mocks.pendingKey.mockResolvedValue(null);
      mocks.keyStatus.mockResolvedValue(approvedNewKey);
      return approvedNewKey;
    });

    renderRoutes();
    await screen.findByText('Station key approved');
    expect(screen.getByText('sha256:old-station-key')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Review new Station key' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Prepare native Station identity' }),
    ).toBeNull();
    expect(screen.queryByLabelText('One-time Station invitation')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'Review new Station key' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Prepare native Station identity' }),
    );
    await screen.findByRole('region', {
      name: 'Public install proof metadata',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel key review' }));
    await screen.findByRole('button', { name: 'Review new Station key' });
    expect(
      screen.queryByRole('region', { name: 'Public install proof metadata' }),
    ).toBeNull();
    expect(screen.getByText('sha256:old-station-key')).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: 'Review new Station key' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Prepare native Station identity' }),
    );
    await screen.findByRole('region', {
      name: 'Public install proof metadata',
    });
    fireEvent.change(screen.getByLabelText('One-time Station invitation'), {
      target: {
        value: '{"version":"station-broker-native-route-invitation/v2"}',
      },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Discover Station key' }),
    );
    await screen.findByRole('region', {
      name: 'Candidate from native verification',
    });
    expect(screen.getByText('Station key approved')).toBeTruthy();
    expect(screen.getByText('sha256:old-station-key')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Operator comparison code'), {
      target: { value: 'ABCD-1234-EFGH-5678' },
    });
    fireEvent.change(
      screen.getByLabelText('Full key ID confirmed by operator'),
      {
        target: { value: rotatedCandidate.keyId },
      },
    );
    fireEvent.click(
      screen.getByLabelText(
        /I got these values from the Station operator through a separate channel/,
      ),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Approve Station key' }),
    );
    await waitFor(() =>
      expect(mocks.approveKey).toHaveBeenCalledWith({
        pendingId: rotatedCandidate.pendingId,
        confirmationCode: 'ABCD1234EFGH5678',
        fullKeyId: rotatedCandidate.keyId,
      }),
    );
    await waitFor(() =>
      expect(screen.getByText('sha256:rotated-station-key')).toBeTruthy(),
    );
    expect(
      screen.getByRole('button', { name: 'Review new Station key' }),
    ).toBeTruthy();
    expect(screen.queryByLabelText('One-time Station invitation')).toBeNull();
  });

  test('requires native surface preparation, a pasted invitation, and separately entered operator values', async () => {
    const candidate = {
      pendingId: 'pending-1',
      profileName: 'Home Station',
      brokerOrigin: 'https://broker.example',
      stationId,
      enrollmentId,
      generation: 7,
      keyId: 'sha256:full-station-key-id',
      confirmationCode: 'ABCD1234EFGH5678',
      expiresAt: Date.now() + 60_000,
      trustRevision: 0,
      status: 'pending' as const,
    };
    const invitationJson = JSON.stringify({
      version: 'station-broker-native-route-invitation/v2',
      brokerOrigin: 'https://broker.example',
      scope: { stationId, enrollmentId, routingGeneration: 7 },
      stationSigningKeyId: 'sha256:station-key',
      stationSigningGeneration: 4,
      surface: {
        kind: 'station-native',
        appIdentifier: 'io.kontourai.station',
        channel: 'stable',
        clientInstanceId: 'install-1',
        keyThumbprint: 'sha256:install-proof',
      },
      invitationId: 'invite-1',
      invitationSecret: 'one-time-invitation-secret',
      expiresAt: Date.now() + 60_000,
    });
    mocks.prepareKey.mockResolvedValue({
      profileName: 'Home Station',
      brokerOrigin: 'https://broker.example',
      stationId,
      enrollmentId,
      appIdentifier: 'io.kontourai.station',
      channel: 'stable',
      clientInstanceId: 'install-1',
      keyThumbprint: 'sha256:install-proof',
      publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    });
    mocks.beginKey.mockImplementation(
      async (_profileName: string, invitation: string) => {
        expect(invitation).toBe(invitationJson);
        mocks.pendingKey.mockResolvedValue(candidate);
        return candidate;
      },
    );
    mocks.approveKey.mockImplementation(async () => {
      mocks.pendingKey.mockResolvedValue(null);
      const status = {
        status: 'approved',
        trustRevision: 1,
        profileName: 'Home Station',
        brokerOrigin: 'https://broker.example',
        stationId,
        enrollmentId,
        generation: 7,
        keyId: candidate.keyId,
      };
      mocks.keyStatus.mockResolvedValue(status);
      return status;
    });
    mocks.revokeKey.mockImplementation(async () => {
      const status = {
        status: 'revoked',
        trustRevision: 2,
        profileName: 'Home Station',
        brokerOrigin: 'https://broker.example',
        stationId,
        enrollmentId,
        generation: 7,
        keyId: candidate.keyId,
      };
      mocks.keyStatus.mockResolvedValue(status);
      return status;
    });

    renderRoutes();
    await screen.findByText('Station key untrusted');
    fireEvent.click(
      screen.getByRole('button', { name: 'Prepare native Station identity' }),
    );
    await screen.findByText('sha256:install-proof');
    expect(screen.getByText('io.kontourai.station')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('One-time Station invitation'), {
      target: { value: invitationJson },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Discover Station key' }),
    );
    await screen.findByText('sha256:full-station-key-id');
    expect(screen.getByText('ABCD-1234-EFGH-5678')).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Approve Station key' })
        .hasAttribute('disabled'),
    ).toBe(true);

    fireEvent.change(screen.getByLabelText('Operator comparison code'), {
      target: { value: 'ABCD-1234-EFGH-567I' },
    });
    fireEvent.change(
      screen.getByLabelText('Full key ID confirmed by operator'),
      {
        target: { value: candidate.keyId },
      },
    );
    fireEvent.click(
      screen.getByLabelText(
        /I got these values from the Station operator through a separate channel/,
      ),
    );
    expect(
      screen
        .getByRole('button', { name: 'Approve Station key' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(mocks.approveKey).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Operator comparison code'), {
      target: { value: 'abcd-1234-efgh-5678' },
    });
    expect(
      screen
        .getByRole('button', { name: 'Approve Station key' })
        .hasAttribute('disabled'),
    ).toBe(false);
    fireEvent.click(
      screen.getByRole('button', { name: 'Approve Station key' }),
    );
    await waitFor(() =>
      expect(mocks.approveKey).toHaveBeenCalledWith({
        pendingId: 'pending-1',
        confirmationCode: 'ABCD1234EFGH5678',
        fullKeyId: candidate.keyId,
      }),
    );
    await screen.findByText('Station key approved');
    expect(screen.getByText(/Route remains disconnected/)).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Prepare native Station identity' }),
    ).toBeNull();
    expect(
      screen.queryByRole('region', { name: 'Public install proof metadata' }),
    ).toBeNull();
    expect(screen.queryByLabelText('One-time Station invitation')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Revoke Station key trust' }),
    ).toBeTruthy();
    fireEvent.change(
      screen.getByLabelText(
        'Type the current full key ID to confirm revocation',
      ),
      {
        target: { value: candidate.keyId },
      },
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Revoke Station key trust' }),
    );
    await waitFor(() =>
      expect(mocks.revokeKey).toHaveBeenCalledWith({
        profileName: 'Home Station',
        expectedTrustRevision: 1,
        fullKeyId: candidate.keyId,
      }),
    );
    await screen.findByText('Station key trust revoked');
    expect(
      screen.getByRole('button', { name: 'Prepare native Station identity' }),
    ).toBeTruthy();
  });
});
