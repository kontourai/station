/** @vitest-environment jsdom */
import type { StationProfileStore } from '@kontourai/station-contracts';
import type { NativeRelayLinkDelivery } from '@kontourai/station-contracts/native-relay-link';
import { emptyStationProfileStore } from '@kontourai/station-contracts/station-profile';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { StrictMode, useEffect } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NativeRelayGrantMetadata } from '../nativeRelayGrantAdapter';
import { NativeStationProfileStorage } from '../stationProfileStorage';
import { TauriNativePlatformAdapter } from '../tauri';

const host = vi.hoisted(() => ({
  invoke: vi.fn(),
  platform: {
    isTauri: true,
    target: 'ios' as const,
    isDevBuild: false,
    channel: 'nightly' as 'nightly' | 'dev',
  },
  handlers: new Set<(event: { payload: unknown }) => void>(),
  launch: null as NativeRelayLinkDelivery | null,
  store: null as StationProfileStore | null,
  repository: null as NativeStationProfileStorage | null,
  events: [] as string[],
  active: 'station-profile:existing',
  account: 'opaque-account-session',
  retired: vi.fn(),
}));
const callbacks = new Map<number, (event: { payload: unknown }) => void>();
let callbackId = 0;
vi.mock('../../PlatformProfileContext', () => ({
  usePlatformProfile: () => host.platform,
  nativeProfileRepository: () => {
    if (!host.repository) throw new Error('Repository missing');
    return host.repository;
  },
}));
vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-connect')>()),
  useConnections: () => ({
    connections: [],
    captureCredentialEvidence: () => null,
    isCredentialEvidenceCurrent: () => false,
  }),
}));
vi.mock(
  '@kontourai/station-connect/connection-trust',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@kontourai/station-connect/connection-trust')
    >()),
    openDeviceConnectionTrustStore: async () => ({
      read: async () => null,
      close: () => {},
    }),
  }),
);

import { RelayRouteProfiles } from '../../../views/connections-hub/RelayRouteProfiles';
import { NativeRelayLinkIntake } from '../NativeRelayLinkIntake';

const route = {
  applicationOrigin: 'https://station.example.test',
  brokerOrigin: 'https://broker.example.test',
  stationId: '11111111-1111-4111-8111-111111111111',
  enrollmentId: '22222222-2222-4222-8222-222222222222',
};
const intent: Extract<NativeRelayLinkDelivery, { kind: 'route-intent' }> = {
  kind: 'route-intent',
  pendingId: '33333333-3333-4333-8333-333333333333',
  route,
};
function ProtectedRoot() {
  useEffect(
    () => () => {
      host.retired();
      host.account = '';
    },
    [],
  );
  return <div>Existing protected workspace</div>;
}
async function emit(delivery: NativeRelayLinkDelivery) {
  await act(async () => {
    for (const handler of host.handlers) handler({ payload: delivery });
  });
}
beforeEach(async () => {
  callbacks.clear();
  Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
    configurable: true,
    value: { unregisterListener: () => {} },
  });
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {
      transformCallback: (handler: (event: { payload: unknown }) => void) => {
        callbacks.set(++callbackId, handler);
        return callbackId;
      },
      invoke: host.invoke,
      unregisterCallback: (id: number) => callbacks.delete(id),
    },
  });
  host.platform.isDevBuild = false;
  host.platform.channel = 'nightly';
  host.handlers.clear();
  host.events = [];
  host.launch = null;
  host.store = emptyStationProfileStore();
  host.store.revision = 1;
  host.active = 'station-profile:existing';
  host.account = 'opaque-account-session';
  host.retired.mockClear();
  host.invoke.mockReset();
  host.invoke.mockImplementation(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === 'plugin:event|listen') {
        host.events.push('listen');
        const callback = callbacks.get(Number(args?.handler));
        if (!callback) throw new Error('Missing native callback');
        host.handlers.add(callback);
        return args?.handler;
      }
      if (command === 'plugin:event|unlisten') {
        const callback = callbacks.get(Number(args?.eventId));
        if (callback) host.handlers.delete(callback);
        return;
      }
      if (command === 'station_native_relay_link_take') {
        host.events.push('take');
        return host.launch;
      }
      if (command === 'station_native_relay_link_cancel') return;
      if (command === 'station_profile_store_read')
        return JSON.stringify(host.store);
      if (command === 'station_profile_store_write') {
        if (args?.expectedRevision !== host.store?.revision)
          throw new Error('revision conflict');
        host.store = JSON.parse(String(args?.contents));
        return;
      }
      if (command === 'station_native_relay_key_approval_status')
        return {
          profileName: args?.profileName,
          brokerOrigin: route.brokerOrigin,
          stationId: route.stationId,
          enrollmentId: route.enrollmentId,
          generation: null,
          keyId: null,
          status: 'untrusted',
          trustRevision: 0,
        };
      if (command === 'station_native_relay_key_approval_pending') return null;
      throw new Error('Unexpected host operation');
    },
  );
  host.repository = new NativeStationProfileStorage();
  await host.repository.hydrate();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it('drains cold delivery after listening, and only explicit Save persists public intent through the real profile repository', async () => {
  host.launch = intent;
  render(
    <NativeRelayLinkIntake>
      <ProtectedRoot />
    </NativeRelayLinkIntake>,
  );
  await screen.findByRole('dialog', { name: /Connect to /u });
  expect(host.events).toEqual(['listen', 'take']);
  expect(screen.queryByText('Existing protected workspace')).toBeNull();
  expect(host.store?.profiles).toHaveLength(0);
  expect(
    host.invoke.mock.calls.some(([command]) =>
      String(command).includes('relay_link_begin'),
    ),
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Save this Station' }));
  expect(
    (
      (await screen.findByLabelText(
        /Station application address/u,
      )) as HTMLInputElement
    ).value,
  ).toBe(route.applicationOrigin);
  fireEvent.change(screen.getByLabelText(/Name/), {
    target: { value: 'Shared Station' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save Station' }));
  await waitFor(() => expect(host.store?.profiles).toHaveLength(1));
  expect(host.store?.profiles[0]).toMatchObject({
    name: 'Shared Station',
    endpoint: route.applicationOrigin,
    configurationState: 'unconfigured',
    relayRoute: {
      brokerOrigin: route.brokerOrigin,
      stationId: route.stationId,
      enrollmentId: route.enrollmentId,
    },
  });
  expect(host.store?.profiles[0].credentialRef).toBeUndefined();
  expect(host.active).toBe('station-profile:existing');
  expect(
    host.invoke.mock.calls.some(([command]) =>
      String(command).includes('authorize_active'),
    ),
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await screen.findByText('Existing protected workspace');
  expect(host.invoke.mock.calls).toContainEqual([
    'station_native_relay_link_cancel',
    { pendingId: intent.pendingId },
    undefined,
  ]);
});
it('warm open and cancel keep the protected owner, selected Station and opaque account session alive', async () => {
  const mounted = render(
    <NativeRelayLinkIntake>
      <ProtectedRoot />
    </NativeRelayLinkIntake>,
  );
  await screen.findByText('Existing protected workspace');
  await emit(intent);
  await screen.findByRole('dialog', { name: /Connect to /u });
  expect(
    screen.getByText('Existing protected workspace').closest('[inert]'),
  ).not.toBeNull();
  expect(host.retired).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(host.active).toBe('station-profile:existing');
  expect(host.account).toBe('opaque-account-session');
  expect(host.retired).not.toHaveBeenCalled();
  mounted.unmount();
  expect(host.retired).toHaveBeenCalledOnce();
});
it('StrictMode recovery and duplicate warm notifications show one review without repeating host actions', async () => {
  host.launch = intent;
  const mounted = render(
    <StrictMode>
      <NativeRelayLinkIntake>
        <ProtectedRoot />
      </NativeRelayLinkIntake>
    </StrictMode>,
  );
  await waitFor(() => {
    expect(
      host.events,
      JSON.stringify(host.invoke.mock.calls.map(([command]) => command)),
    ).toContain('take');
  });
  await screen.findByRole('dialog', { name: /Connect to /u });
  await emit(intent);
  expect(screen.getAllByRole('dialog', { name: /Connect to /u })).toHaveLength(
    1,
  );
  expect(
    host.invoke.mock.calls.filter(
      ([command]) => command === 'station_native_relay_link_cancel',
    ),
  ).toHaveLength(0);
  mounted.unmount();
  await waitFor(() =>
    expect(
      host.invoke.mock.calls.filter(
        ([command]) => command === 'station_native_relay_link_cancel',
      ),
    ).toHaveLength(1),
  );
  await waitFor(() => expect(host.handlers.size).toBe(0));
});
it('a newer warm event wins over a late cold drain reply, and old notifications cannot replace the current review', async () => {
  let resolveLaunch!: (value: NativeRelayLinkDelivery) => void;
  const ordinaryInvoke = host.invoke.getMockImplementation();
  host.invoke.mockImplementation(async (command, args) => {
    if (command !== 'station_native_relay_link_take')
      return ordinaryInvoke?.(command, args);
    return new Promise<NativeRelayLinkDelivery>((resolve) => {
      resolveLaunch = resolve;
    });
  });
  render(
    <NativeRelayLinkIntake>
      <ProtectedRoot />
    </NativeRelayLinkIntake>,
  );
  await waitFor(() => expect(resolveLaunch).toBeDefined());
  const newer: NativeRelayLinkDelivery = {
    ...intent,
    pendingId: '44444444-4444-4444-8444-444444444444',
    route: { ...route, applicationOrigin: 'https://new.example.test' },
  };
  await emit(newer);
  await screen.findByText('https://new.example.test');
  await act(async () => resolveLaunch(intent));
  expect(screen.queryByText(route.applicationOrigin)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await screen.findByText('Existing protected workspace');
  await emit(newer);
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('rejects unexpected secret-bearing IPC fields without saving, discovery or reflected payload', async () => {
  render(
    <NativeRelayLinkIntake>
      <ProtectedRoot />
    </NativeRelayLinkIntake>,
  );
  await screen.findByText('Existing protected workspace');
  await act(async () => {
    for (const handler of host.handlers)
      handler({
        payload: { ...intent, invitationSecret: 'native-secret-canary' },
      });
  });
  await screen.findByText('Station could not verify native link metadata.');
  expect(document.body.textContent).not.toContain('native-secret-canary');
  expect(host.store?.profiles).toHaveLength(0);
  expect(
    host.invoke.mock.calls.some(
      ([command]) => command === 'station_native_relay_link_begin',
    ),
  ).toBe(false);
});
async function configureBoundFlow(initiallyConfirmed = false) {
  await host.repository?.saveRelayRouteProfile({
    name: 'Shared Station',
    endpoint: route.applicationOrigin,
    relayRoute: {
      brokerOrigin: route.brokerOrigin,
      stationId: route.stationId,
      enrollmentId: route.enrollmentId,
    },
  });
  const profile = host.store?.profiles[0];
  if (!profile?.clientInstanceId)
    throw new Error('Saved profile installation missing');
  const keyId = 'K'.repeat(43),
    code = 'ABCDABCDABCDABCD';
  const surface = {
    kind: 'station-native' as const,
    appIdentifier: 'io.kontourai.station.nightly',
    channel: 'nightly' as const,
    clientInstanceId: profile.clientInstanceId,
    keyThumbprint: 'T'.repeat(43),
  };
  const bound: Extract<NativeRelayLinkDelivery, { kind: 'bound-invitation' }> =
    {
      kind: 'bound-invitation',
      pendingId: intent.pendingId,
      route,
      invitation: {
        invitationId: 'abcdefghijklmnopqrstuv',
        expiresAt: Date.now() + 240_000,
        routingGeneration: 1,
        stationSigningKeyId: keyId,
        stationSigningGeneration: 1,
        surface,
      },
    };
  let approved = initiallyConfirmed,
    pending: unknown = null;
  let storedGrant: NativeRelayGrantMetadata | null = null;
  const ordinaryInvoke = host.invoke.getMockImplementation();
  host.invoke.mockImplementation(async (command, args) => {
    if (command === 'station_native_relay_key_approval_prepare')
      return {
        profileName: profile.name,
        ...route,
        ...surface,
        publicKey: { kty: 'EC', crv: 'P-256', x: 'AQ', y: 'Ag' },
      };
    if (command === 'station_native_relay_link_begin') {
      pending = {
        pendingId: '66666666-6666-4666-8666-666666666666',
        profileName: profile.name,
        brokerOrigin: route.brokerOrigin,
        stationId: route.stationId,
        enrollmentId: route.enrollmentId,
        generation: 1,
        keyId,
        confirmationCode: code,
        expiresAt: Date.now() + 60_000,
        trustRevision: 0,
        status: 'pending',
      };
      return pending;
    }
    if (command === 'station_native_relay_key_approval_pending') return pending;
    if (command === 'station_native_relay_key_approval_approve') {
      if (args?.fullKeyId !== keyId || args?.confirmationCode !== code)
        throw new Error('comparison mismatch');
      approved = true;
      pending = null;
    }
    if (
      command === 'station_native_relay_key_approval_status' ||
      command === 'station_native_relay_key_approval_approve'
    )
      return {
        profileName: profile.name,
        brokerOrigin: route.brokerOrigin,
        stationId: route.stationId,
        enrollmentId: route.enrollmentId,
        status: approved ? 'approved' : 'untrusted',
        generation: approved ? 1 : null,
        keyId: approved ? keyId : null,
        trustRevision: approved ? 1 : 0,
      };
    if (command === 'station_native_relay_grant_status')
      return {
        profileName: profile.name,
        profileRevision: host.store?.revision,
        stationId: route.stationId,
        enrollmentId: route.enrollmentId,
        grants: storedGrant ? [{ metadata: storedGrant, expired: false }] : [],
        cleanups: [],
      };
    if (command === 'station_native_relay_link_redeem') {
      if (!approved) throw new Error('trust missing');
      storedGrant = {
        route: {
          brokerOrigin: route.brokerOrigin,
          stationId: route.stationId,
          enrollmentId: route.enrollmentId,
          routingGeneration: 1,
          grantId: 'abcdefghijklmnopqrstuv',
        },
        stationSigningKeyId: keyId,
        stationSigningGeneration: 1,
        expiresAt: Date.now() + 3600000,
      };
      return { status: 'redeemed', grant: storedGrant };
    }
    if (command === 'station_native_enrollment_resume')
      return { version: 'station.native-relay-enrollment/v1', attempts: [] };
    return ordinaryInvoke?.(command, args);
  });
  host.launch = bound;
  return { bound, profile, keyId, code };
}
it('a bound delivery keeps invitation secret in host custody and requires independent key comparison before explicit opaque redemption', async () => {
  const { bound, profile, keyId, code } = await configureBoundFlow();
  render(
    <NativeRelayLinkIntake>
      <ProtectedRoot />
    </NativeRelayLinkIntake>,
  );
  await screen.findByRole('button', {
    name: 'Share setup info',
  });
  expect(
    host.invoke.mock.calls.some(
      ([command]) => command === 'station_native_relay_link_begin',
    ),
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Share setup info' }));
  const discover = await screen.findByRole('button', {
    name: 'Check this Station',
  });
  expect(screen.queryByLabelText('One-time Station invitation')).toBeNull();
  fireEvent.click(discover);
  const approve = await screen.findByRole('button', {
    name: 'Confirm Station',
  });
  expect((approve as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Owner’s code'), {
    target: { value: code },
  });
  fireEvent.change(screen.getByLabelText('Owner’s key ID'), {
    target: { value: 'J'.repeat(43) },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  expect((approve as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Owner’s key ID'), {
    target: { value: keyId },
  });
  expect((approve as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(approve);
  await screen.findByText('Station confirmed. Device access comes next.');
  expect(
    host.invoke.mock.calls.some(
      ([command]) => command === 'station_native_relay_link_redeem',
    ),
  ).toBe(false);
  fireEvent.click(
    screen.getByRole('button', { name: 'Continue to device approval' }),
  );
  await screen.findByText(
    'Connection invitation accepted. The Station owner still needs to approve this device.',
  );
  const begin = host.invoke.mock.calls.find(
    ([command]) => command === 'station_native_relay_link_begin',
  );
  const redeem = host.invoke.mock.calls.find(
    ([command]) => command === 'station_native_relay_link_redeem',
  );
  expect(begin?.[1]).toEqual({
    pendingId: bound.pendingId,
    profileName: profile.name,
    expectedUpdatedAt: profile.updatedAt,
  });
  expect(redeem?.[1]).toEqual({
    pendingId: bound.pendingId,
    profileName: profile.name,
    expectedUpdatedAt: profile.updatedAt,
    expectedProfileRevision: host.store?.revision,
  });
  expect(JSON.stringify(host.invoke.mock.calls)).not.toContain(
    'invitationSecret',
  );
  expect(host.active).toBe('station-profile:existing');
  expect(host.store?.profiles[0].credentialRef).toBeUndefined();
});

it.each([8, 9])(
  'reviews saved generation %i before G9 redemption so a retry cannot compound grants',
  async (savedGeneration) => {
    const { profile, keyId, bound } = await configureBoundFlow(true);
    host.launch = {
      ...bound,
      invitation: { ...bound.invitation, routingGeneration: 9 },
    };
    const oldGrant: NativeRelayGrantMetadata = {
      route: {
        brokerOrigin: route.brokerOrigin,
        stationId: route.stationId,
        enrollmentId: route.enrollmentId,
        routingGeneration: savedGeneration,
        grantId: 'abcdefghijklmnopqrstuv',
      },
      stationSigningKeyId: keyId,
      stationSigningGeneration: 1,
      expiresAt: Date.now() + 60_000,
    };
    const newGrant: NativeRelayGrantMetadata = {
      ...oldGrant,
      route: {
        ...oldGrant.route,
        routingGeneration: 9,
        grantId: 'zyxwvutsrqponmlkjihgfe',
      },
    };
    let grants = [{ metadata: oldGrant, expired: false }];
    const state = () => ({
      profileName: profile.name,
      profileRevision: host.store?.revision,
      stationId: route.stationId,
      enrollmentId: route.enrollmentId,
      grants,
      cleanups: [],
    });
    const ordinaryInvoke = host.invoke.getMockImplementation();
    host.invoke.mockImplementation(async (command, args) => {
      if (command === 'station_native_relay_grant_status') return state();
      if (command === 'station_native_relay_link_recovery_preview')
        return { state: state(), outcomes: [] };
      if (command === 'station_native_relay_link_recovery_reset') {
        grants = [];
        return { state: state(), outcomes: [] };
      }
      if (command === 'station_native_relay_link_redeem') {
        grants = [...grants, { metadata: newGrant, expired: false }];
        return { status: 'redeemed', grant: newGrant };
      }
      return ordinaryInvoke?.(command, args);
    });
    render(
      <NativeRelayLinkIntake>
        <ProtectedRoot />
      </NativeRelayLinkIntake>,
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Continue to device approval',
      }),
    );
    await screen.findByText(/A connection is already saved on this device/);
    expect(
      host.invoke.mock.calls.some(
        ([command]) => command === 'station_native_relay_link_redeem',
      ),
    ).toBe(false);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Review saved connections' }),
    );
    await screen.findByText('Remove saved connections?');
    expect(screen.getByText('Saved connections: 1.')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Continue to device approval' }),
    ).toHaveProperty('disabled', true);
    expect(
      host.invoke.mock.calls.some(
        ([command]) =>
          command === 'station_native_relay_link_redeem' ||
          command === 'station_native_relay_link_recovery_reset',
      ),
    ).toBe(false);
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove saved connections' }),
    );
    await screen.findByText(/Saved connections removed/);
    expect(screen.queryByText(/An earlier connection is saved/)).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue to device approval' }),
    );
    await screen.findByRole('button', { name: 'Request device access' });
    const reset = host.invoke.mock.calls.find(
      ([command]) => command === 'station_native_relay_link_recovery_reset',
    );
    const redeem = host.invoke.mock.calls.filter(
      ([command]) => command === 'station_native_relay_link_redeem',
    );
    expect(reset?.[1]).toEqual({
      pendingId: bound.pendingId,
      profileName: profile.name,
      expectedProfileRevision: host.store?.revision,
      expectedUpdatedAt: profile.updatedAt,
    });
    expect(redeem).toHaveLength(1);
    expect(redeem[0][1]).toEqual(reset?.[1]);
    expect(host.account).toBe('opaque-account-session');
    expect(host.active).toBe('station-profile:existing');
    expect(host.store?.profiles[0].credentialRef).toBeUndefined();
  },
);

it.each(['confirmed', 'lost-reply', 'late-reply'] as const)(
  'warm invitation %s refreshes the mounted Your Stations owner after Station confirmation and grant settlement',
  async (outcome) => {
    const { bound, code, keyId } = await configureBoundFlow();
    host.launch = null;
    const original = host.invoke.getMockImplementation();
    let releaseReply: (() => void) | undefined;
    if (outcome !== 'confirmed') {
      host.invoke.mockImplementation(async (command, args) => {
        const result = await original?.(command, args);
        if (command === 'station_native_relay_link_redeem') {
          if (outcome === 'lost-reply')
            throw new Error('private-native-transport-error');
          await new Promise<void>((resolve) => {
            releaseReply = resolve;
          });
        }
        return result;
      });
    }
    const mainClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Infinity,
          refetchOnWindowFocus: false,
        },
      },
    });
    render(
      <NativeRelayLinkIntake>
        <QueryClientProvider client={mainClient}>
          <ProtectedRoot />
          <RelayRouteProfiles />
        </QueryClientProvider>
      </NativeRelayLinkIntake>,
    );
    await screen.findByText('Station needs confirmation');
    expect(screen.queryByText('Connection invitation needed.')).toBeNull();
    const originalHeading = screen.getByRole('heading', {
      name: 'Your Stations',
    });
    await emit(bound);
    const modal = within(await screen.findByRole('dialog'));
    fireEvent.click(
      await modal.findByRole('button', { name: 'Share setup info' }),
    );
    fireEvent.click(
      await modal.findByRole('button', { name: 'Check this Station' }),
    );
    await modal.findByRole('button', { name: 'Confirm Station' });
    fireEvent.change(modal.getByLabelText('Owner’s code'), {
      target: { value: code },
    });
    fireEvent.change(modal.getByLabelText('Owner’s key ID'), {
      target: { value: keyId },
    });
    fireEvent.click(modal.getByRole('checkbox'));
    fireEvent.click(modal.getByRole('button', { name: 'Confirm Station' }));
    await screen.findByText('Station confirmed. Device access comes next.');
    fireEvent.click(
      modal.getByRole('button', { name: 'Continue to device approval' }),
    );
    if (outcome === 'late-reply') {
      await waitFor(() => expect(releaseReply).toBeTypeOf('function'));
      fireEvent.click(modal.getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await act(async () => releaseReply?.());
    } else {
      await modal.findByText(
        outcome === 'confirmed'
          ? 'Connection invitation accepted. The Station owner still needs to approve this device.'
          : 'The connection wasn’t confirmed. Close this screen and check the Station’s status before using another invitation.',
      );
      fireEvent.click(modal.getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
    await screen.findByText(/Invitation saved on this device/);
    expect(screen.queryByText('Station needs confirmation')).toBeNull();
    expect(screen.queryByText('Connection invitation needed.')).toBeNull();
    expect(screen.getByText('Station confirmed')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Your Stations' })).toBe(
      originalHeading,
    );
    expect(host.retired).not.toHaveBeenCalled();
    expect(host.account).toBe('opaque-account-session');
    expect(document.body.textContent).not.toContain(
      'private-native-transport-error',
    );
  },
);

it.each(['observed', 'pending', 'changed', 'unsafe-preview'] as const)(
  'explicit connection reset uses validated management metadata and preserves refusal for %s',
  async (outcome) => {
    const { profile, keyId, bound } = await configureBoundFlow(true);
    host.launch = {
      ...bound,
      invitation: { ...bound.invitation, routingGeneration: 3 },
    };
    const trap = 'https://secret.invalid/?password=SECRET-JWS-SDP';
    const grantRoute = {
      brokerOrigin: route.brokerOrigin,
      stationId: route.stationId,
      enrollmentId: route.enrollmentId,
      routingGeneration: 1,
      grantId: 'abcdefghijklmnopqrstuv',
    };
    const metadata = {
      route: grantRoute,
      stationSigningKeyId: keyId,
      stationSigningGeneration: 1,
      expiresAt: Date.now() + 60_000,
    };
    const state = {
      profileName: profile.name,
      profileRevision: host.store?.revision,
      stationId: route.stationId,
      enrollmentId: route.enrollmentId,
      grants: [
        { metadata, expired: false },
        {
          metadata: {
            ...metadata,
            route: {
              ...grantRoute,
              routingGeneration: 2,
              grantId: 'zyxwvutsrqponmlkjihgfe',
            },
          },
          expired: true,
        },
      ],
      cleanups: [],
    };
    const ordinaryInvoke = host.invoke.getMockImplementation();
    host.invoke.mockImplementation(async (command, args) => {
      if (command === 'station_native_relay_grant_status') return state;
      if (command === 'station_native_relay_link_recovery_preview')
        return {
          state,
          outcomes: [],
          ...(outcome === 'unsafe-preview' ? { credential: trap } : {}),
        };
      if (command === 'station_native_relay_link_recovery_reset') {
        const pending = outcome === 'pending';
        return {
          state: {
            ...state,
            grants: [],
            cleanups: pending
              ? [
                  {
                    cleanupId: '55555555-5555-4555-8555-555555555555',
                    route: grantRoute,
                    stagedAt: Date.now(),
                    recordPresent: true,
                    brokerRetired: false,
                    localCleanupRequired: true,
                    localCleanupComplete: false,
                  },
                ]
              : [],
          },
          outcomes: [
            {
              route: grantRoute,
              remoteBasis: pending
                ? null
                : {
                    kind: 'superseded-generation-observed',
                    observation: {
                      version:
                        'station-broker-native-superseded-scope-observed/v1',
                      requestNonce: 'A'.repeat(43),
                      scope: {
                        stationId: route.stationId,
                        enrollmentId: route.enrollmentId,
                        routingGeneration: 1,
                      },
                      disposition: 'superseded-generation-not-admitted',
                      leaseRevision: 3,
                    },
                  },
              localCleanupComplete: !pending,
              failure: pending ? 'brokerRejected' : null,
            },
          ],
        };
      }
      return ordinaryInvoke?.(command, args);
    });
    render(
      <NativeRelayLinkIntake>
        <ProtectedRoot />
      </NativeRelayLinkIntake>,
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Continue to device approval',
      }),
    );
    await screen.findByText('Connection error: grant-status-ambiguous');
    fireEvent.click(
      screen.getByRole('button', { name: 'Review saved connections' }),
    );
    if (outcome === 'unsafe-preview') {
      await screen.findByText(
        /Station couldn’t confirm that saved connections were removed/,
      );
    } else {
      await screen.findByText('Remove saved connections?');
      expect(screen.getByText(/Saved connections: 2\./)).toBeTruthy();
      expect(
        screen.getByText(/your Station confirmation or shared Project access/),
      ).toBeTruthy();
      const technicalDetails = screen.getByText('Technical details')
        .parentElement as HTMLDetailsElement;
      expect(technicalDetails.open).toBe(false);
      expect(
        host.invoke.mock.calls.some(
          ([command]) => command === 'station_native_relay_link_recovery_reset',
        ),
      ).toBe(false);
      if (outcome === 'changed' && host.store) host.store.revision++;
      fireEvent.click(
        screen.getByRole('button', { name: 'Remove saved connections' }),
      );
      await screen.findByText(
        outcome === 'changed'
          ? /Station couldn’t confirm that saved connections were removed/
          : outcome === 'pending'
            ? /Some saved connections could not be removed yet/
            : /Saved connections removed/,
      );
    }
    const resets = host.invoke.mock.calls.filter(
      ([command]) => command === 'station_native_relay_link_recovery_reset',
    );
    expect(resets).toHaveLength(
      outcome === 'observed' || outcome === 'pending' ? 1 : 0,
    );
    if (resets.length)
      expect(resets[0][1]).toEqual({
        pendingId: bound.pendingId,
        profileName: profile.name,
        expectedProfileRevision: state.profileRevision,
        expectedUpdatedAt: profile.updatedAt,
      });
    if (outcome === 'pending') {
      const continuation = screen.getByRole('button', {
        name: 'Continue to device approval',
      });
      expect(continuation).toHaveProperty('disabled', true);
      fireEvent.click(continuation);
    }
    expect(document.body.textContent).not.toContain(trap);
    expect(
      host.invoke.mock.calls.some(
        ([command]) =>
          command === 'station_native_relay_link_redeem' ||
          command === 'station_native_enrollment_resume' ||
          command === 'station_native_enrollment_begin_prepare' ||
          command === 'station_native_relay_key_approval_approve',
      ),
    ).toBe(false);
    expect(host.account).toBe('opaque-account-session');
  },
);

it.each([
  'ambiguous',
  'shape',
  'profile',
  'route',
  'metadata',
  'cleanup',
  'unknown',
] as const)(
  'link review classifies status %s through the real adapter without redemption or raw leakage',
  async (code) => {
    const { profile, keyId } = await configureBoundFlow(true);
    const trap = 'https://secret.invalid/?password=SECRET-JWS-SDP';
    const ordinaryInvoke = host.invoke.getMockImplementation();
    const metadata = {
      route: {
        brokerOrigin: route.brokerOrigin,
        stationId: route.stationId,
        enrollmentId: route.enrollmentId,
        routingGeneration: 1,
        grantId: 'abcdefghijklmnopqrstuv',
      },
      stationSigningKeyId: keyId,
      stationSigningGeneration: 1,
      expiresAt: Date.now() + 60_000,
    };
    host.invoke.mockImplementation(async (command, args) => {
      if (command !== 'station_native_relay_grant_status')
        return ordinaryInvoke?.(command, args);
      if (code === 'unknown') throw new Error(trap);
      const status = {
        profileName: profile.name,
        profileRevision: host.store?.revision,
        stationId: route.stationId,
        enrollmentId: route.enrollmentId,
        grants: [] as unknown[],
        cleanups: [] as unknown[],
      };
      if (code === 'ambiguous')
        status.grants = [
          { metadata, expired: false },
          {
            metadata: {
              ...metadata,
              route: {
                ...metadata.route,
                routingGeneration: 2,
                grantId: 'zyxwvutsrqponmlkjihgfe',
              },
            },
            expired: true,
          },
        ];
      if (code === 'shape') return { ...status, credential: trap };
      if (code === 'profile') status.profileName = trap;
      if (code === 'route') status.stationId = trap;
      if (code === 'metadata')
        status.grants = [
          { metadata: { ...metadata, credential: trap }, expired: false },
        ];
      if (code === 'cleanup') status.cleanups = [{ credential: trap }];
      return status;
    });
    render(
      <NativeRelayLinkIntake>
        <ProtectedRoot />
      </NativeRelayLinkIntake>,
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Continue to device approval',
      }),
    );
    await screen.findByText(`Connection error: grant-status-${code}`);
    if (code === 'ambiguous')
      expect(
        screen.getByText(
          /More than one connection is saved on this device. Review and remove them/,
        ),
      ).toBeTruthy();
    expect(screen.getByText('Connection step: grant-status')).toBeTruthy();
    expect(document.body.textContent).not.toContain(trap);
    expect(screen.queryByText(/Connection invitation accepted/)).toBeNull();
    expect(
      host.invoke.mock.calls.some(
        ([command]) =>
          command === 'station_native_relay_link_redeem' ||
          command === 'station_native_enrollment_resume' ||
          command === 'station_native_enrollment_begin_prepare',
      ),
    ).toBe(false);
  },
);

it.each([
  [
    'station-owned',
    'station_native_pairing_link_take',
    'station://pairing-deep-link',
  ],
  ['plugin', 'plugin:deep-link|get_current', 'deep-link://new-url'],
])(
  'the actual default pairing bridge selects %s delivery and listens before cold drain',
  async (mode, take, event) => {
    const ordinaryInvoke = host.invoke.getMockImplementation();
    host.invoke.mockImplementation(async (command, args) => {
      if (command === 'station_native_link_delivery_mode') return mode;
      if (command === take) return ['station-nightly://pair?code=first'];
      return ordinaryInvoke?.(command, args);
    });
    const received = vi.fn();
    const subscription =
      new TauriNativePlatformAdapter().subscribeToPairingDeepLinks(received);
    await waitFor(() =>
      expect(received).toHaveBeenCalledWith({
        url: 'station-nightly://pair?code=first',
      }),
    );
    const calls = host.invoke.mock.calls;
    const listenIndex = calls.findIndex(
      ([command, args]) =>
        command === 'plugin:event|listen' && args?.event === event,
    );
    const takeIndex = calls.findIndex(([command]) => command === take);
    expect(listenIndex).toBeGreaterThanOrEqual(0);
    expect(takeIndex).toBeGreaterThan(listenIndex);
    await act(async () => {
      for (const handler of host.handlers)
        handler({ payload: ['station-nightly://pair?code=second'] });
    });
    expect(received).toHaveBeenLastCalledWith({
      url: 'station-nightly://pair?code=second',
    });
    subscription.dispose();
    await waitFor(() => expect(host.handlers.size).toBe(0));
  },
);

it('a real unmount during launch drain cancels the late opaque handle instead of leaving host custody alive', async () => {
  let resolveLaunch!: (value: NativeRelayLinkDelivery) => void;
  const ordinaryInvoke = host.invoke.getMockImplementation();
  host.invoke.mockImplementation(async (command, args) => {
    if (command === 'station_native_relay_link_take')
      return new Promise<NativeRelayLinkDelivery>((resolve) => {
        resolveLaunch = resolve;
      });
    return ordinaryInvoke?.(command, args);
  });
  const mounted = render(
    <NativeRelayLinkIntake>
      <ProtectedRoot />
    </NativeRelayLinkIntake>,
  );
  await waitFor(() => expect(resolveLaunch).toBeDefined());
  mounted.unmount();
  await act(async () => resolveLaunch(intent));
  await waitFor(() =>
    expect(host.invoke.mock.calls).toContainEqual([
      'station_native_relay_link_cancel',
      { pendingId: intent.pendingId },
      undefined,
    ]),
  );
  await waitFor(() => expect(host.handlers.size).toBe(0));
});
it.each([
  ['nightly', false, 'http://127.0.0.1:4455', false],
  ['dev', false, 'http://127.0.0.1:4455', false],
  ['dev', true, 'http://127.0.0.1:4455', true],
  ['dev', true, 'http://[::1]:4455', true],
  ['dev', true, 'http://localhost:4455', false],
  ['dev', true, 'http://192.0.2.1:4455', false],
] as const)(
  'validates delivered origins against installed %s/debug%s policy: %s',
  async (channel, isDevBuild, applicationOrigin, accepted) => {
    host.platform.channel = channel;
    host.platform.isDevBuild = isDevBuild;
    host.launch = { ...intent, route: { ...route, applicationOrigin } };
    render(
      <NativeRelayLinkIntake>
        <ProtectedRoot />
      </NativeRelayLinkIntake>,
    );
    if (accepted) {
      await screen.findByText(applicationOrigin);
      expect(
        screen.getByRole('button', { name: 'Save this Station' }),
      ).toBeDefined();
    } else {
      await screen.findByText('Station could not verify native link metadata.');
      expect(
        screen.queryByRole('button', { name: 'Save this Station' }),
      ).toBeNull();
    }
    expect(host.store?.profiles).toHaveLength(0);
  },
);
it.each([30 * 24 * 60 * 60_000, Number.MAX_SAFE_INTEGER])(
  'does not cancel a long-lived invitation early when its expiry exceeds the browser timer range: %s',
  async (lifetime) => {
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ['Date', 'setTimeout', 'clearTimeout'],
    });
    const { bound } = await configureBoundFlow(true);
    host.launch = {
      ...bound,
      invitation: {
        ...bound.invitation,
        expiresAt:
          lifetime === Number.MAX_SAFE_INTEGER
            ? lifetime
            : Date.now() + lifetime,
      },
    };
    render(
      <NativeRelayLinkIntake>
        <ProtectedRoot />
      </NativeRelayLinkIntake>,
    );
    await screen.findByRole('button', { name: 'Continue to device approval' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(
      screen.getByRole('button', { name: 'Continue to device approval' }),
    ).toBeDefined();
    expect(
      host.invoke.mock.calls.some(
        ([command]) => command === 'station_native_relay_link_cancel',
      ),
    ).toBe(false);
  },
);
it('bound invitation expiry cancels its opaque host handle and replaces all actionable review controls', async () => {
  host.launch = {
    kind: 'bound-invitation',
    pendingId: intent.pendingId,
    route,
    invitation: {
      invitationId: 'abcdefghijklmnopqrstuv',
      expiresAt: Date.now() + 50,
      routingGeneration: 1,
      stationSigningKeyId: 'K'.repeat(43),
      stationSigningGeneration: 1,
      surface: {
        kind: 'station-native',
        appIdentifier: 'io.kontourai.station.nightly',
        channel: 'nightly',
        clientInstanceId: '55555555-5555-4555-8555-555555555555',
        keyThumbprint: 'T'.repeat(43),
      },
    },
  };
  render(
    <NativeRelayLinkIntake>
      <ProtectedRoot />
    </NativeRelayLinkIntake>,
  );
  await screen.findByText(
    'This Station invitation has expired. Ask the operator for a new link.',
  );
  expect(host.invoke.mock.calls).toContainEqual([
    'station_native_relay_link_cancel',
    { pendingId: intent.pendingId },
    undefined,
  ]);
  expect(
    screen.queryByRole('button', { name: 'Continue to device approval' }),
  ).toBeNull();
  expect(
    host.invoke.mock.calls.some(
      ([command]) =>
        command === 'station_native_relay_link_begin' ||
        command === 'station_native_relay_link_redeem',
    ),
  ).toBe(false);
});

it('keeps resumed Device setup alive after the already-redeemed invitation deadline', async () => {
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ['Date', 'setTimeout', 'clearTimeout'],
  });
  const { bound, keyId, code } = await configureBoundFlow();
  const ordinaryInvoke = host.invoke.getMockImplementation();
  const enrollmentHandle = 'E'.repeat(43);
  host.invoke.mockImplementation(async (command, args) => {
    if (command === 'station_native_enrollment_resume')
      return {
        version: 'station.native-relay-enrollment/v1',
        attempts: [
          {
            enrollmentHandle,
            phase: 'staged',
            profileRevision: host.store?.revision,
            expiresAt: Date.now() + 600000,
            registrationAvailable: false,
            candidate: null,
            transition: null,
          },
        ],
      };
    if (command === 'station_native_enrollment_abort') return;
    return ordinaryInvoke?.(command, args);
  });
  render(
    <NativeRelayLinkIntake>
      <ProtectedRoot />
    </NativeRelayLinkIntake>,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Share setup info' }),
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Check this Station' }),
  );
  fireEvent.change(await screen.findByLabelText('Owner’s code'), {
    target: { value: code },
  });
  fireEvent.change(screen.getByLabelText('Owner’s key ID'), {
    target: { value: keyId },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm Station' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Continue to device approval' }),
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Resume saved setup 1' }),
  );
  await screen.findByRole('button', { name: 'Finish device setup' });
  expect(
    host.invoke.mock.calls.some(
      ([command]) => command === 'station_native_enrollment_abort',
    ),
  ).toBe(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(
      bound.invitation.expiresAt - Date.now() + 1,
    );
  });
  expect(
    screen.getByRole('button', { name: 'Finish device setup' }),
  ).toBeDefined();
  expect(
    screen.queryByText(
      'This Station invitation has expired. Ask the operator for a new link.',
    ),
  ).toBeNull();
  expect(
    host.invoke.mock.calls.some(
      ([command]) => command === 'station_native_enrollment_abort',
    ),
  ).toBe(false);
});

it('public setup for a confirmed Station only prepares and copies public device metadata', async () => {
  await configureBoundFlow(true);
  host.launch = intent;
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  render(
    <NativeRelayLinkIntake>
      <ProtectedRoot />
    </NativeRelayLinkIntake>,
  );
  const prepare = await screen.findByRole('button', {
    name: 'Share setup info',
  });
  expect(
    screen.queryByRole('heading', { name: 'Confirm this Station' }),
  ).toBeNull();
  expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1);
  expect(
    screen.getByText('Confirmation details').closest('details')?.open,
  ).toBe(false);

  expect(
    host.invoke.mock.calls.some(
      ([command]) =>
        command === 'station_native_relay_link_begin' ||
        command === 'station_native_relay_link_redeem' ||
        command === 'station_native_relay_key_approval_approve',
    ),
  ).toBe(false);
  fireEvent.click(prepare);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Copy setup info' }),
  );
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  const copied = JSON.parse(String(writeText.mock.calls[0]?.[0]));
  expect(copied).toMatchObject({
    profileName: 'Shared Station',
    appIdentifier: 'io.kontourai.station.nightly',
    channel: 'nightly',
    publicKey: { kty: 'EC', crv: 'P-256' },
  });
  expect(copied).not.toHaveProperty('invitationSecret');
  expect(
    host.invoke.mock.calls.some(
      ([command]) =>
        command === 'station_native_relay_link_begin' ||
        command === 'station_native_relay_link_redeem' ||
        command === 'station_native_relay_key_approval_approve' ||
        command === 'station_native_relay_key_approval_revoke' ||
        command === 'station_profile_authorize_active',
    ),
  ).toBe(false);
  expect(host.store?.profiles[0].configurationState).toBe('unconfigured');
  expect(host.active).toBe('station-profile:existing');
  expect(screen.getByText('Setup info').closest('details')?.open).toBe(false);
});

it('a late redemption for the replaced handle cannot stop the newer invitation timer', async () => {
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ['Date', 'setTimeout', 'clearTimeout'],
  });
  const { bound, keyId } = await configureBoundFlow(true);
  let reply!: (value: unknown) => void;
  const ordinaryInvoke = host.invoke.getMockImplementation();
  host.invoke.mockImplementation(async (command, args) => {
    if (command === 'station_native_relay_link_redeem')
      return new Promise((resolve) => {
        reply = resolve;
      });
    return ordinaryInvoke?.(command, args);
  });
  render(
    <NativeRelayLinkIntake>
      <ProtectedRoot />
    </NativeRelayLinkIntake>,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Continue to device approval' }),
  );
  await waitFor(() => expect(reply).toBeDefined());
  const newer = {
    ...bound,
    pendingId: '77777777-7777-4777-8777-777777777777',
    invitation: { ...bound.invitation, expiresAt: Date.now() + 1000 },
  };
  await act(async () => {
    for (const handler of host.handlers) handler({ payload: newer });
    reply({
      status: 'redeemed',
      grant: {
        route: {
          brokerOrigin: route.brokerOrigin,
          stationId: route.stationId,
          enrollmentId: route.enrollmentId,
          routingGeneration: 1,
          grantId: 'abcdefghijklmnopqrstuv',
        },
        stationSigningKeyId: keyId,
        stationSigningGeneration: 1,
        expiresAt: Date.now() + 3600000,
      },
    });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1001);
  });
  await screen.findByRole('heading', { name: 'Couldn’t open this invitation' });
  expect(
    screen.queryByRole('heading', { name: 'Approve this device' }),
  ).toBeNull();
  expect(host.invoke.mock.calls).toContainEqual([
    'station_native_relay_link_cancel',
    { pendingId: newer.pendingId },
    undefined,
  ]);
});

it.each([false, true])(
  'link review discloses only a validated routing refusal and never advances Device setup (extra fields: %s)',
  async (extraFields) => {
    await configureBoundFlow(true);
    const trap = 'https://secret.invalid/?password=SECRET-JWS-SDP';
    const ordinaryInvoke = host.invoke.getMockImplementation();
    host.invoke.mockImplementation(async (command, args) => {
      if (command === 'station_native_relay_link_redeem')
        return {
          status: 'failed',
          failure: {
            primary: 'brokerRejected',
            cleanup: 'notAttempted',
            recovery: null,
            ...(extraFields ? { rawMessage: trap } : {}),
          },
        };
      return ordinaryInvoke?.(command, args);
    });
    render(
      <NativeRelayLinkIntake>
        <ProtectedRoot />
      </NativeRelayLinkIntake>,
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Continue to device approval',
      }),
    );
    await screen.findByText(/The connection wasn’t confirmed/);
    if (extraFields)
      expect(screen.queryByText('Routing failure: brokerRejected')).toBeNull();
    else
      expect(screen.getByText('Routing failure: brokerRejected')).toBeTruthy();
    expect(document.body.textContent).not.toContain(trap);
    expect(screen.queryByText(/Connection invitation accepted/)).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Request device access' }),
    ).toBeNull();
    expect(
      host.invoke.mock.calls.filter(
        ([command]) => command === 'station_native_relay_link_redeem',
      ),
    ).toHaveLength(1);
    expect(
      host.invoke.mock.calls.some(
        ([command]) =>
          command === 'station_native_enrollment_resume' ||
          command === 'station_native_enrollment_begin_prepare',
      ),
    ).toBe(false);
  },
);

it.each([
  { step: 'grant-status', fixed: false },
  { step: 'host-redemption', fixed: false },
  { step: 'grant-status', fixed: true },
])(
  'link review reports only the fixed $step step for a host rejection (fixed: $fixed)',
  async ({ step, fixed }) => {
    await configureBoundFlow(true);
    const trap = 'https://secret.invalid/?password=SECRET-JWS-SDP';
    const ordinaryInvoke = host.invoke.getMockImplementation();
    host.invoke.mockImplementation(async (command, args) => {
      if (
        command ===
        (step === 'grant-status'
          ? 'station_native_relay_grant_status'
          : 'station_native_relay_link_redeem')
      )
        throw fixed
          ? 'Station could not read native relay grant status.'
          : new Error(trap);
      return ordinaryInvoke?.(command, args);
    });
    render(
      <NativeRelayLinkIntake>
        <ProtectedRoot />
      </NativeRelayLinkIntake>,
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Continue to device approval',
      }),
    );
    await screen.findByText(/The connection wasn’t confirmed/);
    expect(screen.getByText(`Connection step: ${step}`)).toBeTruthy();
    if (fixed)
      expect(
        screen.getByText('Connection error: grant-status-unavailable'),
      ).toBeTruthy();
    expect(document.body.textContent).not.toContain(trap);
    expect(screen.queryByText(/Connection invitation accepted/)).toBeNull();
    expect(
      host.invoke.mock.calls.some(
        ([command]) =>
          command === 'station_native_enrollment_resume' ||
          command === 'station_native_enrollment_begin_prepare',
      ),
    ).toBe(false);
    expect(
      host.invoke.mock.calls.filter(
        ([command]) => command === 'station_native_relay_link_redeem',
      ),
    ).toHaveLength(step === 'grant-status' ? 0 : 1);
  },
);
