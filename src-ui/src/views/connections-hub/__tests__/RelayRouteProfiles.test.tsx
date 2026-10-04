/** @vitest-environment jsdom */

import { defaultStorage } from '@kontourai/station-connect';
import type { NativeVerifiedPeerSignaling } from '@kontourai/station-connect/native-application';
import {
  captureNativeEnrollmentFailure,
  type NativeEnrollmentOpenedPeer,
} from '@kontourai/station-connect/native-enrollment';
import { parseNativeRelayLink } from '@kontourai/station-connect/native-relay-link';
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
import type { ProjectInvitationAcceptance } from '@kontourai/station-contracts/project-membership';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
    activationEpoch: string;
    nativeBrokerRoute: {
      routeVersion: 1;
      profileName: string;
      profileRevision: number;
      brokerOrigin: string;
      stationId: string;
      enrollmentId: string;
    };
  },
  selectionEpoch: 0,
  accountSessionActive: false,
  accountLogin: vi.fn(),
  accountAcceptInvitation: vi.fn(),
  accountLogout: vi.fn(),
  accountRetire: vi.fn(),
  connections: [] as Array<Record<string, unknown>>,
  setActiveConnection: vi.fn(),
}));

vi.mock('@kontourai/station-connect', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/station-connect')>();
  return {
    ...actual,
    useConnections: () => ({
      captureCredentialEvidence: () => mocks.credentialEvidence,
      isCredentialEvidenceCurrent: () => true,
      connections: mocks.connections,
      setActiveConnection: mocks.setActiveConnection,
    }),
  };
});

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () =>
    mocks.accountSessionActive
      ? {
          apiBase: 'https://station.example',
          authorityKey: 'selected-route-account',
          requiresEnrolledCredential: true,
          isCurrent: () => true,
        }
      : undefined,
  useNativeRelayAccountSession: () => ({
    login: mocks.accountLogin,
    acceptInvitation: mocks.accountAcceptInvitation,
    logout: mocks.accountLogout,
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
  usePlatformProfile: () => ({
    isTauri: true,
    isDesktop: mocks.isDesktop,
    channel: 'nightly',
    pairingDeepLinkScheme: 'station-nightly',
  }),
  nativeProfileRepository: () =>
    mocks.repository ?? {
      refresh: async () => false,
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

function pastePlainText(target: HTMLElement, text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (kind: string) => (kind === 'text/plain' ? text : '') },
  });
  fireEvent(target, event);
}

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
          expiresAt: Date.now() + 300_000,
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

function renderRoutes(
  onInvitationAccepted?: NonNullable<
    NonNullable<
      Parameters<typeof RelayRouteProfiles>[0]
    >['onInvitationAccepted']
  >,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const element = () => (
    <QueryClientProvider client={queryClient}>
      <RelayRouteProfiles onInvitationAccepted={onInvitationAccepted} />
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
  mocks.profiles = mocks.profiles.map((profile) =>
    profile.name === profileName
      ? {
          ...profile,
          configurationState: 'configured',
          environmentId: stationId,
          clientInstanceId: '33333333-3333-4333-8333-333333333333',
          credentialRef: {
            kind: 'station-bearer',
            id: 'native-enrollment:configured-test-reference',
          },
        }
      : profile,
  );
  mocks.credentialEvidence = {
    connectionId: `station-profile:${profileName.toLowerCase()}`,
    origin: 'https://station.example',
    activationEpoch: `selection:${profileName}:${++mocks.selectionEpoch}`,
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

function openDetails(label: string) {
  const summary = screen.getByText(label);
  const details = summary.closest('details');
  if (!details?.open) fireEvent.click(summary);
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
    mocks.selectionEpoch = 0;
    mocks.accountSessionActive = false;
    mocks.accountLogin.mockReset();
    mocks.accountAcceptInvitation.mockReset();
    mocks.accountLogout.mockReset();
    mocks.accountRetire.mockReset();
    mocks.accountLogin.mockImplementation(async () => {
      mocks.accountSessionActive = true;
      return { authorityKey: 'test-account-scope' };
    });
    mocks.accountAcceptInvitation.mockResolvedValue({
      scope: {
        stationId,
        localProjectId: 'member-project-local-id',
        localProjectSlug: 'shared-project',
        portableProjectId: 'portable-project-id',
      },
      grantsDeviceAccess: false,
    });
    mocks.accountLogout.mockImplementation(async () => {
      mocks.accountSessionActive = false;
      return { revoked: true };
    });
    mocks.accountRetire.mockImplementation(() => {
      mocks.accountSessionActive = false;
    });
    mocks.connections = [];
    mocks.setActiveConnection.mockReset();
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

  test('copies an explicit public iOS setup link without issuing an invitation or granting access', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderRoutes();
    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'More actions for Home Station' }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy setup link' }));
    // iOS requires the clipboard write in the original tap activation.
    expect(writeText).toHaveBeenCalledOnce();
    const link = String(writeText.mock.calls[0]?.[0]);
    const decoded = parseNativeRelayLink(link, {
      channel: 'nightly',
      appIdentifier: 'io.kontourai.station.nightly',
    });
    expect(decoded).toEqual({
      version: 'station-native-relay-link/v1',
      kind: 'route-intent',
      applicationOrigin: mocks.profiles[0].endpoint,
      brokerOrigin: 'https://broker.example',
      stationId,
      enrollmentId,
    });
    expect(link).toMatch(/^station-relay-nightly:\/\/relay#/u);
    expect(decoded).not.toHaveProperty('invitation');
    expect(mocks.beginKey).not.toHaveBeenCalled();
    expect(mocks.approveKey).not.toHaveBeenCalled();
    expect(mocks.accountLogin).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  test('lists an unconfigured route, offers edit, and removes it without revoking trust', async () => {
    renderRoutes();
    expect(screen.getByText('Your Stations')).toBeTruthy();
    expect(screen.getByText('Setup needed')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText('Station needs confirmation')).toBeTruthy(),
    );
    expect(
      screen.getByRole('button', { name: 'Share setup info' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('dialog', { name: 'About Station confirmation' }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'About Station confirmation' }),
    );
    expect(
      within(
        screen.getByRole('dialog', { name: 'About Station confirmation' }),
      ).getByText(/Compare the code and full key ID/),
    ).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(
      screen.queryByRole('dialog', { name: 'About Station confirmation' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(
      screen.getByRole('heading', { name: 'Edit broker route' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(
      screen.getByRole('button', { name: 'More actions for Home Station' }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));
    const confirm = within(
      screen.getByRole('dialog', { name: 'Remove Home Station?' }),
    );
    fireEvent.click(confirm.getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(mocks.remove).toHaveBeenCalledWith(
        'station-profile:home station',
        2,
      ),
    );
    expect(
      screen.getByText(
        'No Stations yet. Open a setup link from the Station owner, or add one.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add a Station' })).toBeTruthy();
  });

  test('selects only a fresh configured Station through ConnectionsContext', async () => {
    const profile = mocks.profiles[0];
    mocks.profiles = [{ ...profile, configurationState: 'configured' }];
    mocks.connections = [
      {
        id: 'station-profile:home station',
        url: 'https://station.example',
        nativeBrokerRoute: {
          routeVersion: 1,
          profileName: 'Home Station',
          profileRevision: 12,
          brokerOrigin: 'https://broker.example',
          stationId,
          enrollmentId,
        },
      },
    ];
    mocks.setActiveConnection.mockImplementation(async (id: string) => {
      expect(id).toBe('station-profile:home station');
      selectNativeRelayRoute();
    });
    renderRoutes();

    expect(screen.getByText('Not in use')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use this Station' }));
    await screen.findByText('In use · sign in needed');
    expect(mocks.setActiveConnection).toHaveBeenCalledWith(
      'station-profile:home station',
    );
    expect(
      screen.getByRole('button', { name: 'Sign in to this Station account' }),
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
    await screen.findByText('Connection invitation needed.');
    expect(screen.getByText('Setup needed')).toBeTruthy();
    expect(mocks.grantInvoke).toHaveBeenCalledTimes(1);

    const routingInvitationField = screen.getByLabelText(
      'One-time routing invitation',
    ) as HTMLInputElement;
    expect(routingInvitationField.type).toBe('password');
    expect(routingInvitationField.getAttribute('autocomplete')).toBe('off');
    expect(routingInvitationField.getAttribute('autocapitalize')).toBe('none');
    expect(routingInvitationField.getAttribute('autocorrect')).toBe('off');
    expect(routingInvitationField.getAttribute('spellcheck')).toBe('false');
    const routingInvitationJson = JSON.stringify(invitation, null, 2);
    pastePlainText(routingInvitationField, routingInvitationJson);
    expect(routingInvitationField.value).toBe(
      routingInvitationJson.replace(/\r\n?|\n/gu, ''),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Redeem routing grant' }),
    );

    await screen.findByText(
      'Invitation saved on this device. This does not confirm a live connection or current Station access.',
    );
    const expiryDetails = screen
      .getByText('Expiry details')
      .closest('details') as HTMLDetailsElement;
    expect(expiryDetails.open).toBe(false);
    fireEvent.click(screen.getByText('Expiry details'));
    expect(expiryDetails.open).toBe(true);
    expect(expiryDetails.textContent).toContain(
      'This is its local expiry, not a live check of Station availability.',
    );
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
    expect(screen.getByText('Setup needed')).toBeTruthy();
    expect(screen.getByText('Station confirmed')).toBeTruthy();
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
    await screen.findByText('Connection invitation needed.');
    openDetails('Advanced: paste a connection invitation');
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
    const { liveStore } = configureEnrollmentReadyRoute();
    const repository = new NativeStationProfileStorage(
      {
        invoke: async <T,>(command: string) => {
          if (command !== 'station_profile_store_read')
            throw new Error('Unexpected profile operation');
          return structuredClone(liveStore) as T;
        },
      },
      defaultStorage,
      true,
    );
    await repository.hydrate();
    mocks.repository = repository;
    const originalHost = mocks.enrollmentInvoke.getMockImplementation()!;
    mocks.enrollmentInvoke.mockImplementation(async (command, args) => {
      const result = await originalHost(command, args);
      if (command === 'station_native_enrollment_activation_accept') {
        liveStore.revision = 13;
        Object.assign(liveStore.profiles[0]!, {
          configurationState: 'configured',
          environmentId: stationId,
          updatedAt: 3,
          credentialRef: {
            kind: 'station-bearer',
            id: 'native-enrollment:configured-test-reference',
          },
        });
      }
      return result;
    });
    mocks.finalizeResponses.push({ state: 'pending' }, { state: 'delivered' });
    const rendered = renderRoutes();

    await screen.findByRole('heading', { name: 'Approve this device' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Request device access' }),
    );
    await screen.findByText('Device request details');
    fireEvent.click(screen.getByText('Device request details'));
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
      screen.getByLabelText('Create an account with a Project invitation'),
    );
    fireEvent.change(screen.getByLabelText('Project invitation link or code'), {
      target: {
        value: `https://station.test/account/join#invitation=${'I'.repeat(43)}`,
      },
    });
    const operatorInvitationField = screen.getByLabelText(
      'Project invitation link or code',
    ) as HTMLInputElement;
    expect(operatorInvitationField.type).toBe('password');
    expect(operatorInvitationField.getAttribute('autocomplete')).toBe('off');
    expect(operatorInvitationField.getAttribute('autocapitalize')).toBe('none');
    expect(operatorInvitationField.getAttribute('autocorrect')).toBe('off');
    expect(operatorInvitationField.getAttribute('spellcheck')).toBe('false');
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Register and request Device approval',
      }),
    );

    await screen.findByRole('region', { name: 'Pending operator approval' });
    expect(
      screen.getByText('Waiting for the Station owner to approve this device.'),
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
      invitation: 'I'.repeat(43),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Check approval' }));
    await screen.findByText(
      'The Station operator has not completed approval yet.',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue after approval' }),
    );
    await screen.findByText(
      'Operator approval is still pending. You can check again later.',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue after approval' }),
    );
    await screen.findByRole('region', { name: 'Device delivery staged' });
    expect(
      mocks.enrollmentInvoke.mock.calls.some(
        ([command]) => command === 'station_native_enrollment_activate_prepare',
      ),
    ).toBe(false);

    fireEvent.click(
      screen.getByRole('button', { name: 'Finish device setup' }),
    );
    await screen.findByText('Not in use');
    expect(screen.queryByText('Setup needed')).toBeNull();
    expect(repository.getRelayRouteProfiles()[0]?.configurationState).toBe(
      'configured',
    );
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

  test('automatic saved setup check exposes the allowlisted host resume refusal without Begin or retries', async () => {
    configureEnrollmentReadyRoute();
    const original = mocks.enrollmentInvoke.getMockImplementation()!;
    mocks.enrollmentInvoke.mockImplementation(async (command, args) => {
      if (command === 'station_native_enrollment_resume')
        throw 'native_enrollment_route_refused';
      return original(command, args);
    });
    renderRoutes();
    await screen.findByText(/Saved Device setup could not be checked/);
    expect(
      screen.getByText(
        /Stage: recovery. Code: native_enrollment_route_refused/,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Request device access' }),
    ).toBeNull();
    expect(
      mocks.enrollmentInvoke.mock.calls.filter(
        ([command]) => command === 'station_native_enrollment_resume',
      ),
    ).toHaveLength(1);
    expect(
      mocks.enrollmentInvoke.mock.calls.some(
        ([command]) => command === 'station_native_enrollment_begin_prepare',
      ),
    ).toBe(false);
  });

  test('saved route refresh preserves ambiguity for actionable wizard recovery before opening a peer', async () => {
    configureEnrollmentReadyRoute();
    const original = mocks.grantInvoke.getMockImplementation()!;
    let statusReads = 0;
    mocks.grantInvoke.mockImplementation(async (command, args) => {
      const response = await original(command, args);
      if (
        command !== 'station_native_relay_grant_status' ||
        ++statusReads === 1
      )
        return response;
      const grant = response.grants[0];
      return {
        ...response,
        grants: [
          grant,
          {
            ...grant,
            metadata: {
              ...grant.metadata,
              route: {
                ...grant.metadata.route,
                routingGeneration: 5,
                grantId: 'zyxwvutsrqponmlkjihgfe',
              },
            },
          },
        ],
      };
    });
    renderRoutes();
    await screen.findByText(/Ask the Station owner for a new setup invitation/);
    expect(
      screen.getByText(
        /Stage: route-status. Code: native_enrollment_saved_connections_ambiguous/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Check after connection recovery' }),
    ).toBeTruthy();
    expect(mocks.openVerifiedPeer).not.toHaveBeenCalled();
    expect(mocks.enrollmentInvoke).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Request device access' }),
    ).toBeNull();
  });

  test('automatic recovery diagnostics cover route validation before client construction and exclude secret traps', async () => {
    configureEnrollmentReadyRoute();
    const original = mocks.grantInvoke.getMockImplementation()!;
    const trap = 'https://secret.invalid/?password=SECRET-JWS-SDP';
    mocks.grantInvoke.mockImplementation(async (command, args) => {
      if (command === 'station_profile_store_read') throw new Error(trap);
      return original(command, args);
    });
    renderRoutes();
    await screen.findByText(/Saved Device setup could not be checked/);
    expect(
      screen.getByText(/Stage: route-currentness. Code: unknown/),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain(trap);
    expect(mocks.enrollmentInvoke).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Request device access' }),
    ).toBeNull();
  });

  test('Device Begin troubleshooting excludes raw host error text and does not show a candidate', async () => {
    configureEnrollmentReadyRoute();
    const original = mocks.enrollmentInvoke.getMockImplementation()!;
    const trap = 'https://secret.invalid/?password=SECRET-JWS-SDP';
    mocks.enrollmentInvoke.mockImplementation(async (command, args) => {
      if (command === 'station_native_enrollment_begin_prepare')
        throw new Error(trap);
      return original(command, args);
    });
    renderRoutes();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Request device access' }),
    );
    await screen.findByRole('alert');
    expect(
      await screen.findByText('Device setup troubleshooting'),
    ).toBeTruthy();
    expect(
      screen.getByText(/Stage: begin-preflight. Code: unknown/),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain(trap);
    expect(screen.queryByText('Device request details')).toBeNull();
    expect(
      mocks.enrollmentInvoke.mock.calls.filter(
        ([command]) => command === 'station_native_enrollment_begin_prepare',
      ),
    ).toHaveLength(1);
  });

  test('peer-open failure gives a plain next step and keeps stage details collapsed', async () => {
    configureEnrollmentReadyRoute();
    const trap = 'transport timed out at https://secret.invalid/?token=SECRET';
    mocks.openVerifiedPeer.mockRejectedValue(
      captureNativeEnrollmentFailure(new Error(trap), 'peer-open'),
    );
    renderRoutes();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Request device access' }),
    );

    expect(
      await screen.findByText(
        'Station couldn’t confirm this device setup step. Keep this screen open and ask the Station owner what to do next.',
      ),
    ).toBeTruthy();
    const troubleshooting = screen.getByText('Device setup troubleshooting')
      .parentElement as HTMLDetailsElement;
    expect(troubleshooting.open).toBe(false);
    expect(document.body.textContent).not.toContain(trap);
    fireEvent.click(screen.getByText('Device setup troubleshooting'));
    expect(troubleshooting.textContent).toContain(
      'Stage: peer-open. Code: unknown.',
    );
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
      screen.queryByRole('button', { name: 'Request device access' }),
    ).toBeNull();
    expect(mocks.enrollmentInvoke).not.toHaveBeenCalledWith(
      'station_native_enrollment_begin_prepare',
      expect.anything(),
    );

    fireEvent.click(resumeButton);
    await screen.findByText('Device request details');
    fireEvent.click(screen.getByText('Device request details'));
    expect(mocks.enrollmentInvoke).toHaveBeenCalledWith(
      'station_native_enrollment_begin_prepare',
      expect.objectContaining({ enrollmentHandle }),
    );
    expect(
      screen.queryByText(
        /After approval, sign in again to open your shared projects/,
      ),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'About device approval' }),
    );
    expect(
      within(
        screen.getByRole('dialog', { name: 'About device approval' }),
      ).getByText(/After approval, sign in again to open your shared projects/),
    ).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
  });

  test('rechecks recovery before begin and blocks a setup that appeared meanwhile', async () => {
    configureEnrollmentReadyRoute();
    renderRoutes();
    const beginButton = await screen.findByRole('button', {
      name: 'Request device access',
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

  test('sign-in failure exposes safe step diagnostics after Begin without secret text', async () => {
    configureEnrollmentReadyRoute();
    const original = mocks.enrollmentInvoke.getMockImplementation()!;
    const trap = 'https://secret.invalid/?password=PRIVATE';
    mocks.enrollmentInvoke.mockImplementation(async (command, args) => {
      if (command === 'station_native_enrollment_login_prepare')
        throw captureNativeEnrollmentFailure(new Error(trap), 'host-prepare');
      return original(command, args);
    });
    renderRoutes();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Request device access' }),
    );
    fireEvent.change(await screen.findByLabelText('Station account username'), {
      target: { value: 'member' },
    });
    fireEvent.change(screen.getByLabelText('Station account password'), {
      target: { value: 'private-password' },
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Sign in and request Device approval',
      }),
    );
    await screen.findByRole('alert');
    expect(screen.getByText(/Stage: host-prepare. Code: unknown/)).toBeTruthy();
    expect(document.body.textContent).not.toContain(trap);
  });

  test.each(['activation-unknown', 'staged'] as const)(
    'signed terminal status after expired %s closes the request before new setup',
    async (phase) => {
      configureEnrollmentReadyRoute();
      mocks.recoveryAttempts.push({
        enrollmentHandle,
        phase,
        profileRevision: 12,
        expiresAt: Date.now() - 1,
        registrationAvailable: true,
        candidate: enrollmentCandidate,
        transition: null,
      });
      const original = mocks.enrollmentInvoke.getMockImplementation()!;
      mocks.enrollmentInvoke.mockImplementation(async (command, args) => {
        if (command === 'station_native_enrollment_status_accept') {
          mocks.recoveryAttempts.length = 0;
          return {
            version: NATIVE_RELAY_ENROLLMENT_VERSION,
            enrollmentHandle,
            state: 'expired',
          };
        }
        return original(command, args);
      });
      renderRoutes();
      fireEvent.click(
        await screen.findByRole('button', {
          name: 'Resume Device 44444444-4444-4444-8444-444444444444',
        }),
      );
      await screen.findByRole('button', { name: 'Request device access' });
      expect(
        screen.queryByRole('button', { name: 'Check Device status' }),
      ).toBeNull();
      expect(mocks.enrollmentInvoke).not.toHaveBeenCalledWith(
        'station_native_enrollment_cancel_prepare',
        expect.anything(),
      );
    },
  );

  test.each(['active', 'pending', 'invalid'] as const)(
    'reconciles expired staged delivery with %s status before cancellation',
    async (outcome) => {
      configureEnrollmentReadyRoute();
      mocks.recoveryAttempts.push({
        enrollmentHandle,
        phase: 'staged',
        profileRevision: 12,
        expiresAt: Date.now() - 1,
        registrationAvailable: false,
        candidate: enrollmentCandidate,
        transition: null,
      });
      const original = mocks.enrollmentInvoke.getMockImplementation()!;
      mocks.enrollmentInvoke.mockImplementation(async (command, args) => {
        if (command === 'station_native_enrollment_status_accept') {
          if (outcome === 'invalid')
            throw captureNativeEnrollmentFailure(
              'native_enrollment_invalid',
              'application-response',
              400,
            );
          if (outcome === 'active')
            return {
              version: NATIVE_RELAY_ENROLLMENT_VERSION,
              enrollmentHandle,
              state: 'active',
              profileRevision: 13,
              transitionHandle: enrollmentTransitionHandle,
            };
        }
        return original(command, args);
      });
      renderRoutes();
      fireEvent.click(
        await screen.findByRole('button', {
          name: 'Resume Device 44444444-4444-4444-8444-444444444444',
        }),
      );
      if (outcome === 'active') await screen.findByText(/Device configured/);
      else {
        if (outcome === 'pending')
          await screen.findByText(/Station has not confirmed activation yet/);
        else
          await screen.findByText(
            /Stage: application-response. Code: native_enrollment_invalid/,
          );
        expect(
          screen.getByRole('button', { name: 'Check Device status' }),
        ).toBeTruthy();
        expect(
          screen.queryByRole('button', { name: 'Finish device setup' }),
        ).toBeNull();
        expect(
          screen.queryByRole('button', { name: 'Cancel Device setup' }),
        ).toBeNull();
      }
      expect(
        mocks.enrollmentInvoke.mock.calls.some(
          ([command]) =>
            command === 'station_native_enrollment_activate_prepare' ||
            command === 'station_native_enrollment_cancel_prepare' ||
            command === 'station_native_enrollment_abort',
        ),
      ).toBe(false);
    },
  );

  test('checks uncertain activation after a successful server reply without retrying Finish or cancelling the Device', async () => {
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
    const original = mocks.enrollmentInvoke.getMockImplementation()!;
    let statusChecks = 0;
    mocks.enrollmentInvoke.mockImplementation(async (command, args) => {
      if (command === 'station_native_enrollment_activation_accept')
        throw captureNativeEnrollmentFailure(
          'native_enrollment_operation_refused',
          'host-accept',
          200,
        );
      if (command === 'station_native_enrollment_status_accept') {
        statusChecks++;
        if (statusChecks === 1) return original(command, args);
        return {
          version: NATIVE_RELAY_ENROLLMENT_VERSION,
          enrollmentHandle,
          state: 'active',
          profileRevision: 13,
          transitionHandle: enrollmentTransitionHandle,
        };
      }
      return original(command, args);
    });
    renderRoutes();
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Resume Device 44444444-4444-4444-8444-444444444444',
      }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Finish device setup' }),
    );
    const check = await screen.findByRole('button', {
      name: 'Check Device status',
    });
    expect(
      screen.getByText(
        /Stage: host-accept. Code: native_enrollment_operation_refused/,
      ),
    ).toBeTruthy();
    expect(screen.getByText('HTTP status: 200')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Finish device setup' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Cancel Device setup' }),
    ).toBeNull();
    fireEvent.click(check);
    await screen.findByText(/Station has not confirmed activation yet/);
    fireEvent.click(
      screen.getByRole('button', { name: 'Check Device status' }),
    );
    await screen.findByText(/Device configured/);
    expect(
      mocks.enrollmentInvoke.mock.calls.filter(
        ([command]) => command === 'station_native_enrollment_activate_prepare',
      ),
    ).toHaveLength(1);
    expect(
      mocks.enrollmentInvoke.mock.calls.some(
        ([command]) =>
          command === 'station_native_enrollment_abort' ||
          command === 'station_native_enrollment_cancel_prepare',
      ),
    ).toBe(false);
  });

  test('expired saved setup offers cleanup and never account submission', async () => {
    configureEnrollmentReadyRoute();
    mocks.recoveryAttempts.push({
      enrollmentHandle,
      phase: 'candidate',
      profileRevision: 12,
      expiresAt: Date.now() - 1,
      registrationAvailable: true,
      candidate: enrollmentCandidate,
      transition: null,
    });
    renderRoutes();
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Close expired Device 44444444-4444-4444-8444-444444444444',
      }),
    );
    await screen.findByRole('button', {
      name: 'Confirm Device setup cancellation',
    });
    expect(
      screen.queryByRole('button', {
        name: 'Sign in and request Device approval',
      }),
    ).toBeNull();
    expect(mocks.enrollmentInvoke).not.toHaveBeenCalledWith(
      'station_native_enrollment_login_prepare',
      expect.anything(),
    );
  });

  test('challenge expiry clears account fields and offers closing the expired request', async () => {
    configureEnrollmentReadyRoute();
    const original = mocks.enrollmentInvoke.getMockImplementation()!;
    let finishChallenge!: () => void;
    const challengeReady = new Promise<void>((resolve) => {
      finishChallenge = resolve;
    });
    mocks.enrollmentInvoke.mockImplementation(async (command, args) => {
      const result = await original(command, args);
      if (command === 'station_native_enrollment_challenge_accept') {
        finishChallenge();
        return { ...result, expiresAt: Date.now() + 200 };
      }
      return result;
    });
    renderRoutes();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Request device access' }),
    );
    await challengeReady;
    fireEvent.change(await screen.findByLabelText('Station account username'), {
      target: { value: 'member' },
    });
    fireEvent.change(screen.getByLabelText('Station account password'), {
      target: { value: 'private-password' },
    });
    await screen.findByRole('button', { name: 'Close expired request' });
    expect(screen.queryByLabelText('Station account password')).toBeNull();
    expect(mocks.enrollmentInvoke).not.toHaveBeenCalledWith(
      'station_native_enrollment_login_prepare',
      expect.anything(),
    );
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
    await screen.findByRole('button', { name: 'Finish device setup' });
    expect(mocks.enrollmentInvoke).not.toHaveBeenCalledWith(
      'station_native_enrollment_activate_prepare',
      expect.anything(),
    );
  });

  test('mounts account sign-in only on the matching selected native route and keeps credentials transient', async () => {
    configureEnrollmentReadyRoute();
    selectNativeRelayRoute();
    const onInvitationAccepted = vi.fn();
    const { queryClient } = renderRoutes(onInvitationAccepted);
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

    await screen.findByLabelText('Project invitation link or code');
    expect(mocks.accountLogin).toHaveBeenCalledWith({
      username: 'member@example.test',
      password: 'transient-password',
    });
    expect(screen.queryByLabelText('Station account password')).toBeNull();
    expect(
      queryClient
        .getMutationCache()
        .getAll()
        .every(
          (mutation) =>
            mutation.state.variables === undefined ||
            typeof mutation.state.variables === 'number',
        ),
    ).toBe(true);

    const accountInvitationField = screen.getByLabelText(
      'Project invitation link or code',
    ) as HTMLInputElement;
    expect(accountInvitationField.type).toBe('password');
    expect(accountInvitationField.getAttribute('autocomplete')).toBe('off');
    expect(accountInvitationField.getAttribute('autocapitalize')).toBe('none');
    expect(accountInvitationField.getAttribute('autocorrect')).toBe('off');
    expect(accountInvitationField.getAttribute('spellcheck')).toBe('false');
    fireEvent.change(accountInvitationField, {
      target: {
        value: `https://station.test/account/join#invitation=${'J'.repeat(43)}`,
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Join Project' }));
    await screen.findByText(/Access was added for Project shared-project/);
    expect(mocks.accountAcceptInvitation).toHaveBeenCalledWith('J'.repeat(43));
    expect(onInvitationAccepted).toHaveBeenCalledTimes(1);
    expect(onInvitationAccepted).toHaveBeenCalledWith(
      {
        scope: {
          stationId,
          localProjectId: 'member-project-local-id',
          localProjectSlug: 'shared-project',
          portableProjectId: 'portable-project-id',
        },
        grantsDeviceAccess: false,
      } satisfies ProjectInvitationAcceptance,
      expect.objectContaining({
        apiBase: 'https://station.example',
        authorityKey: 'selected-route-account',
      }),
    );
    expect(
      (
        screen.getByLabelText(
          'Project invitation link or code',
        ) as HTMLInputElement
      ).value,
    ).toBe('');

    fireEvent.click(
      screen.getByRole('button', {
        name: 'More account actions for Home Station',
      }),
    );
    fireEvent.click(
      screen.getByRole('menuitem', {
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

  test('ignores an older account failure after selection changes away and back', async () => {
    configureEnrollmentReadyRoute();
    selectNativeRelayRoute();
    let rejectLogin: (error: Error) => void = () => {};
    const delayedLogin = new Promise<never>((_, reject) => {
      rejectLogin = reject;
    });
    mocks.accountLogin.mockReturnValue(delayedLogin);
    const rendered = renderRoutes();
    await screen.findByLabelText('Station account username');
    fireEvent.change(screen.getByLabelText('Station account username'), {
      target: { value: 'old@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Station account password'), {
      target: { value: 'old-secret' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Sign in to this Station account' }),
    );
    await waitFor(() => expect(mocks.accountLogin).toHaveBeenCalledTimes(1));

    selectNativeRelayRoute('Other Station');
    await act(async () => rendered.rerenderRoutes());
    selectNativeRelayRoute();
    await act(async () => rendered.rerenderRoutes());
    await screen.findByLabelText('Station account username');

    await act(async () => {
      rejectLogin(new Error('old account attempt failed'));
      await delayedLogin.catch(() => undefined);
    });
    expect(
      screen.queryByText(
        'Station could not sign in this account for the selected route.',
      ),
    ).toBeNull();
  });

  test('remote sign-out requires the typed revocation receipt and remains distinct from local retirement', async () => {
    configureEnrollmentReadyRoute();
    selectNativeRelayRoute();
    mocks.accountSessionActive = true;
    renderRoutes();

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Sign out of this Station account',
      }),
    );
    await screen.findByText(
      /Station confirmed this account session was revoked/,
    );
    expect(mocks.accountLogout).toHaveBeenCalledTimes(1);
    expect(mocks.accountRetire).not.toHaveBeenCalled();
    expect(
      screen.queryByLabelText('Project invitation link or code'),
    ).toBeNull();
    expect(
      await screen.findByLabelText('Station account username'),
    ).toBeTruthy();
  });

  test('does not claim remote revocation when sign-out outcome is unknown', async () => {
    configureEnrollmentReadyRoute();
    selectNativeRelayRoute();
    mocks.accountSessionActive = true;
    mocks.accountLogout.mockImplementation(async () => {
      mocks.accountSessionActive = false;
      throw new Error('remote_revocation_unknown');
    });
    renderRoutes();

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Sign out of this Station account',
      }),
    );
    await screen.findByRole('alert');
    expect(
      screen.getByText(
        /could not confirm whether the remote account session was revoked/,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(/confirmed this account session was revoked/),
    ).toBeNull();
    expect(mocks.accountRetire).not.toHaveBeenCalled();
  });

  test('does not forward an accepted invitation after the selected route epoch changes', async () => {
    configureEnrollmentReadyRoute();
    selectNativeRelayRoute();
    mocks.accountSessionActive = true;
    const acceptedReceipt: ProjectInvitationAcceptance = {
      scope: {
        stationId,
        localProjectId: 'member-project-local-id',
        localProjectSlug: 'shared-project',
        portableProjectId: 'portable-project-id',
      },
      grantsDeviceAccess: false,
    };
    let resolveAcceptance: (receipt: ProjectInvitationAcceptance) => void =
      () => {};
    const pendingAcceptance = new Promise<ProjectInvitationAcceptance>(
      (resolve) => {
        resolveAcceptance = resolve;
      },
    );
    mocks.accountAcceptInvitation.mockReturnValue(pendingAcceptance);
    const onInvitationAccepted = vi.fn();
    const rendered = renderRoutes(onInvitationAccepted);

    fireEvent.change(
      await screen.findByLabelText('Project invitation link or code'),
      {
        target: { value: 'P'.repeat(43) },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Join Project' }));
    await waitFor(() =>
      expect(mocks.accountAcceptInvitation).toHaveBeenCalled(),
    );

    selectNativeRelayRoute('Other Station');
    await act(async () => rendered.rerenderRoutes());
    selectNativeRelayRoute();
    await act(async () => rendered.rerenderRoutes());

    await act(async () => {
      resolveAcceptance(acceptedReceipt);
      await pendingAcceptance;
    });
    expect(onInvitationAccepted).not.toHaveBeenCalled();
  });

  test('aborts the owned attempt and network signal when the user cancels', async () => {
    configureEnrollmentReadyRoute();
    renderRoutes();
    await screen.findByRole('heading', { name: 'Approve this device' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Request device access' }),
    );
    await screen.findByText('Device request details');
    fireEvent.click(screen.getByText('Device request details'));

    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel Device setup' }),
    );
    await screen.findByRole('button', { name: 'Request device access' });
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
    await screen.findByRole('heading', { name: 'Approve this device' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Request device access' }),
    );
    try {
      await screen.findByText('Device request details');
    } catch (error) {
      throw new Error(
        JSON.stringify({
          failure: 'native_begin_before_candidate',
          grantCommands: mocks.grantInvoke.mock.calls.map(
            ([command]) => command,
          ),
          enrollmentCommands: mocks.enrollmentInvoke.mock.calls.map(
            ([command]) => command,
          ),
          peerOpenCount: mocks.openVerifiedPeer.mock.calls.length,
          exchangePaths: mocks.exchangeResponse.mock.calls.map(
            ([request]) => request.path,
          ),
        }),
        { cause: error },
      );
    }
    fireEvent.click(screen.getByText('Device request details'));
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
    await screen.findByRole('button', { name: 'Request device access' });

    liveStore.revision = 13;
    liveStore.profiles[0].updatedAt = 3;
    fireEvent.click(
      screen.getByRole('button', { name: 'Request device access' }),
    );

    await screen.findByText(
      'This Station’s connection changed. Close setup and open it again.',
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
        'No Stations yet. Open a setup link from the Station owner, or add one.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add a Station' }));

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
    expect(screen.getByText('Setup needed')).toBeTruthy();
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

  test('explains foreground grant renewal and route cap on mobile', () => {
    mocks.isDesktop = false;
    const template = mocks.profiles[0];
    mocks.profiles = Array.from({ length: 65 }, (_, index) => ({
      ...template,
      name: `Saved route ${index}`,
    }));
    renderRoutes();
    fireEvent.click(
      screen.getByRole('button', { name: 'About your Stations' }),
    );
    expect(
      screen.getByText(
        /approved routing grants renew while this app is awake/i,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/automatic grant renewal is paused/i)).toBeTruthy();
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

    await screen.findByText('Station confirmed');
    expect(screen.getByText('sha256:cached-approved-key')).toBeTruthy();
    mocks.keyStatus.mockRejectedValueOnce(
      new Error('native keyring unavailable'),
    );
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: ['native-relay-key-approval', 'Home Station', 'status'],
      });
    });

    await screen.findByText('Station identity unavailable');
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
    await screen.findByText('Station confirmed');
    expect(screen.getByText('sha256:old-station-key')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Review new Station key' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Share setup info' }),
    ).toBeNull();
    expect(screen.queryByLabelText('One-time Station invitation')).toBeNull();

    openDetails('Confirmation details');
    fireEvent.click(
      screen.getByRole('button', { name: 'Review new Station key' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Share setup info' }));
    await screen.findByRole('region', {
      name: 'Public install proof metadata',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel key review' }));
    await screen.findByRole('button', { name: 'Review new Station key' });
    expect(
      screen.queryByRole('region', { name: 'Public install proof metadata' }),
    ).toBeNull();
    expect(screen.getByText('sha256:old-station-key')).toBeTruthy();

    openDetails('Confirmation details');
    fireEvent.click(
      screen.getByRole('button', { name: 'Review new Station key' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Share setup info' }));
    await screen.findByRole('region', {
      name: 'Public install proof metadata',
    });
    openDetails('Advanced: paste a setup invitation');
    fireEvent.change(screen.getByLabelText('One-time Station invitation'), {
      target: {
        value: '{"version":"station-broker-native-route-invitation/v2"}',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check this Station' }));
    await screen.findByRole('region', {
      name: 'Candidate from native verification',
    });
    expect(screen.getByText('Station confirmed')).toBeTruthy();
    expect(screen.getByText('sha256:old-station-key')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Owner’s code'), {
      target: { value: 'ABCD-1234-EFGH-5678' },
    });
    fireEvent.change(screen.getByLabelText('Owner’s key ID'), {
      target: { value: rotatedCandidate.keyId },
    });
    fireEvent.click(
      screen.getByLabelText(/I checked both values with the owner/),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Station' }));
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
    const invitationJson = JSON.stringify(
      {
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
      },
      null,
      2,
    );
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
        expect(JSON.parse(invitation)).toMatchObject({
          version: 'station-broker-native-route-invitation/v2',
          brokerOrigin: 'https://broker.example',
          scope: { stationId, enrollmentId, routingGeneration: 7 },
          invitationId: 'invite-1',
        });
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
    await screen.findByText('Station needs confirmation');
    fireEvent.click(screen.getByRole('button', { name: 'Share setup info' }));
    await screen.findByText('sha256:install-proof');
    expect(screen.getByText('io.kontourai.station')).toBeTruthy();
    const stationInvitationField = screen.getByLabelText(
      'One-time Station invitation',
    ) as HTMLInputElement;
    expect(stationInvitationField.type).toBe('password');
    expect(stationInvitationField.getAttribute('autocomplete')).toBe('off');
    expect(stationInvitationField.getAttribute('autocapitalize')).toBe('none');
    expect(stationInvitationField.getAttribute('autocorrect')).toBe('off');
    expect(stationInvitationField.getAttribute('spellcheck')).toBe('false');
    pastePlainText(stationInvitationField, invitationJson);
    fireEvent.click(screen.getByRole('button', { name: 'Check this Station' }));
    await screen.findByText('sha256:full-station-key-id');
    expect(screen.getByText('ABCD-1234-EFGH-5678')).toBeTruthy();
    const candidateRegion = screen.getByRole('region', {
      name: 'Candidate from native verification',
    });
    const routeDetails = candidateRegion.querySelector('details');
    const operatorCode = screen.getByRole('textbox', {
      name: 'Owner’s code',
    });
    const operatorKeyId = screen.getByRole('textbox', {
      name: 'Owner’s key ID',
    });
    const separateChannelAttestation = screen.getByRole('checkbox', {
      name: /I checked both values with the owner/,
    });
    const approveButton = screen.getByRole('button', {
      name: 'Confirm Station',
    });
    expect(routeDetails).not.toBeNull();
    expect(routeDetails?.open).toBe(false);
    expect(
      screen.getByText('Station needs confirmation').closest('details'),
    ).toBeNull();
    expect(
      within(candidateRegion)
        .getByText('sha256:full-station-key-id')
        .closest('details'),
    ).toBe(routeDetails);
    expect(
      within(candidateRegion)
        .getByText('ABCD-1234-EFGH-5678')
        .closest('details'),
    ).toBe(routeDetails);
    expect(
      within(candidateRegion).getByText(stationId).closest('details'),
    ).toBe(routeDetails);
    expect(approveButton.hasAttribute('disabled')).toBe(true);
    expect(
      approveButton.compareDocumentPosition(routeDetails!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    fireEvent.change(operatorCode, {
      target: { value: 'ABCD-1234-EFGH-567I' },
    });
    fireEvent.change(operatorKeyId, {
      target: { value: candidate.keyId },
    });
    fireEvent.click(separateChannelAttestation);
    expect(approveButton.hasAttribute('disabled')).toBe(true);
    expect(mocks.approveKey).not.toHaveBeenCalled();
    fireEvent.change(operatorCode, {
      target: { value: 'abcd-1234-efgh-5678' },
    });
    expect(approveButton.hasAttribute('disabled')).toBe(false);
    fireEvent.click(approveButton);
    await waitFor(() =>
      expect(mocks.approveKey).toHaveBeenCalledWith({
        pendingId: 'pending-1',
        confirmationCode: 'ABCD1234EFGH5678',
        fullKeyId: candidate.keyId,
      }),
    );
    await screen.findByText('Station confirmed');
    expect(screen.getByText('Station confirmed')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Share setup info' }),
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
    await screen.findByText('Station confirmation removed');
    expect(
      screen.getByRole('button', { name: 'Share setup info' }),
    ).toBeTruthy();
  });

  test('removes actual line breaks from pasted Station invitation JSON and keeps escaped newlines literal', async () => {
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
    renderRoutes();
    await screen.findByText('Station needs confirmation');
    fireEvent.click(screen.getByRole('button', { name: 'Share setup info' }));
    await screen.findByText('sha256:install-proof');
    const input = screen.getByLabelText(
      'One-time Station invitation',
    ) as HTMLInputElement;
    const opaque = '{\n"invitationSecret":"literal\\nsequence"\r\n}';
    pastePlainText(input, opaque);
    expect(input.value).toBe('{"invitationSecret":"literal\\nsequence"}');
  });
});
