/** @vitest-environment jsdom */
import type { StationProfileStore } from '@kontourai/station-contracts';
import type { NativeRelayLinkDelivery } from '@kontourai/station-contracts/native-relay-link';
import { emptyStationProfileStore } from '@kontourai/station-contracts/station-profile';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { StrictMode, useEffect } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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

import { NativeRelayLinkIntake } from '../NativeRelayLinkIntake';

const route = {
  applicationOrigin: 'https://station.example.test',
  brokerOrigin: 'https://broker.example.test',
  stationId: '11111111-1111-4111-8111-111111111111',
  enrollmentId: '22222222-2222-4222-8222-222222222222',
};
const intent: NativeRelayLinkDelivery = {
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
afterEach(() => cleanup());
it('drains cold delivery after listening, and only explicit Save persists public intent through the real profile repository', async () => {
  host.launch = intent;
  render(
    <NativeRelayLinkIntake>
      <ProtectedRoot />
    </NativeRelayLinkIntake>,
  );
  await screen.findByRole('dialog', { name: 'Review Station link' });
  expect(host.events).toEqual(['listen', 'take']);
  expect(screen.queryByText('Existing protected workspace')).toBeNull();
  expect(host.store?.profiles).toHaveLength(0);
  expect(
    host.invoke.mock.calls.some(([command]) =>
      String(command).includes('relay_link_begin'),
    ),
  ).toBe(false);
  fireEvent.click(
    screen.getByRole('button', { name: 'Review and save route' }),
  );
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
  fireEvent.click(screen.getByRole('button', { name: 'Save route' }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Close link review' }));
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
  await screen.findByRole('dialog', { name: 'Review Station link' });
  expect(
    screen.getByText('Existing protected workspace').closest('[inert]'),
  ).not.toBeNull();
  expect(host.retired).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close link review' }));
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
  await screen.findByRole('dialog', { name: 'Review Station link' });
  await emit(intent);
  expect(
    screen.getAllByRole('dialog', { name: 'Review Station link' }),
  ).toHaveLength(1);
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
  fireEvent.click(screen.getByRole('button', { name: 'Close link review' }));
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
it('a bound delivery keeps invitation secret in host custody and requires independent key comparison before explicit opaque redemption', async () => {
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
  let approved = false,
    pending: unknown = null;
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
        grants: [],
        cleanups: [],
      };
    if (command === 'station_native_relay_link_redeem') {
      if (!approved) throw new Error('trust missing');
      return {
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
      };
    }
    if (command === 'station_native_enrollment_resume')
      return { version: 'station.native-relay-enrollment/v1', attempts: [] };
    return ordinaryInvoke?.(command, args);
  });
  host.launch = bound;
  render(
    <NativeRelayLinkIntake>
      <ProtectedRoot />
    </NativeRelayLinkIntake>,
  );
  await screen.findByRole('button', {
    name: 'Prepare native Station identity',
  });
  expect(
    host.invoke.mock.calls.some(
      ([command]) => command === 'station_native_relay_link_begin',
    ),
  ).toBe(false);
  fireEvent.click(
    screen.getByRole('button', { name: 'Prepare native Station identity' }),
  );
  const discover = await screen.findByRole('button', {
    name: 'Discover Station key',
  });
  expect(screen.queryByLabelText('One-time Station invitation')).toBeNull();
  fireEvent.click(discover);
  const approve = await screen.findByRole('button', {
    name: 'Approve Station key',
  });
  expect((approve as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Operator comparison code'), {
    target: { value: code },
  });
  fireEvent.change(screen.getByLabelText('Full key ID confirmed by operator'), {
    target: { value: 'J'.repeat(43) },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  expect((approve as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Full key ID confirmed by operator'), {
    target: { value: keyId },
  });
  expect((approve as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(approve);
  await screen.findByText('Station signing key approved on this device.');
  expect(
    host.invoke.mock.calls.some(
      ([command]) => command === 'station_native_relay_link_redeem',
    ),
  ).toBe(false);
  fireEvent.click(
    screen.getByRole('button', { name: 'Redeem linked routing invitation' }),
  );
  await screen.findByText(
    'Routing grant confirmed. Device approval and account access remain separate.',
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
        screen.getByRole('button', { name: 'Review and save route' }),
      ).toBeDefined();
    } else {
      await screen.findByText('Station could not verify native link metadata.');
      expect(
        screen.queryByRole('button', { name: 'Review and save route' }),
      ).toBeNull();
    }
    expect(host.store?.profiles).toHaveLength(0);
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
    screen.queryByRole('button', { name: 'Redeem linked routing invitation' }),
  ).toBeNull();
  expect(
    host.invoke.mock.calls.some(
      ([command]) =>
        command === 'station_native_relay_link_begin' ||
        command === 'station_native_relay_link_redeem',
    ),
  ).toBe(false);
});
