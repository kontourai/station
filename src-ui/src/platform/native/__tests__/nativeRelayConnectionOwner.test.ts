import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type { ProjectInvitationAcceptance } from '@kontourai/station-contracts/project-membership';
import type { SelfHostedBrokerNativeClientSurfaceV2 } from '@kontourai/station-contracts/self-hosted-broker';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { NativeAccountPublicScope } from '../nativeAccountSessionBridge';
import { createNativeRelayApplicationRuntime } from '../nativeRelayApplicationRuntime';

type NativeRelayApplicationRuntimeInput = Parameters<
  typeof createNativeRelayApplicationRuntime
>[0];

const mocks = vi.hoisted(() => ({
  createApplication: vi.fn(),
  createAccount: vi.fn(),
}));

vi.mock('../nativeRelayApplicationRuntime', () => ({
  createNativeRelayApplicationRuntime: mocks.createApplication,
}));
vi.mock('../nativeAccountSessionBridge', () => ({
  createNativeAccountSessionBridge: mocks.createAccount,
}));

import {
  getNativeRelayAccountScope,
  nativeRelayAccountScopeKey,
  subscribeNativeRelayAccountScope,
} from '../nativeRelayAccountScope';
import { prepareNativeRelayConnectionOwner } from '../nativeRelayConnectionOwner';
import {
  captureNativeRelayConnectionOwner,
  retireNativeRelayConnectionOwners,
} from '../nativeRelayConnectionOwnerRegistry';

const origin = 'https://relay.example.test';
const stationId = '11111111-1111-4111-8111-111111111111';
const enrollmentId = '22222222-2222-4222-8222-222222222222';
const bindingId = '33333333-3333-4333-8333-333333333333';
const applicationSurface: SelfHostedBrokerNativeClientSurfaceV2 = {
  kind: 'station-native',
  appIdentifier: 'io.kontourai.station.test',
  channel: 'dev',
  clientInstanceId: '44444444-4444-4444-8444-444444444444',
  keyThumbprint: 'K'.repeat(43),
};

function input(profileName = 'Relay') {
  return {
    connectionId: `station-profile:${profileName}`,
    origin,
    route: {
      routeVersion: 1 as const,
      profileName,
      profileRevision: 1,
      brokerOrigin: 'https://broker.example.test',
      stationId,
      enrollmentId,
    },
    bindingId,
    selectionIsCurrent: () => true,
  };
}

function runtimeFor(
  runtimeInput: NativeRelayApplicationRuntimeInput,
): Awaited<ReturnType<typeof createNativeRelayApplicationRuntime>> {
  const isCurrent = () =>
    !runtimeInput.signal.aborted && runtimeInput.selectionIsCurrent();
  return {
    origin: runtimeInput.origin,
    scope: {
      stationId: runtimeInput.route.stationId,
      enrollmentId: runtimeInput.route.enrollmentId,
      routingGeneration: 1,
    },
    surface: applicationSurface,
    authorityIdentity: runtimeInput.bindingId,
    isCurrent,
    async assertCurrent() {
      if (!isCurrent())
        throw new Error('native_relay_application_owner_retired');
    },
    async fetch() {
      if (!isCurrent())
        throw new Error('native_relay_application_owner_retired');
      return Response.json({ data: {} });
    },
  };
}

function accountFor(
  application: Parameters<
    typeof import('../nativeAccountSessionBridge').createNativeAccountSessionBridge
  >[0]['application'],
) {
  let current: NativeAccountPublicScope | null = null;
  const listeners = new Set<() => void>();
  const account: NativeAccountPublicScope = Object.freeze({
    instanceId: 'session-instance',
    generation: 1,
    authorityKey: 'session-authority',
    principal: humanPrincipal('fixture', 'member', 'Member'),
    deviceId: '55555555-5555-4555-8555-555555555555',
    target: {
      kind: 'station-native' as const,
      stationId,
      audience: application.origin,
      surface: applicationSurface,
    },
    keyThumbprint: applicationSurface.keyThumbprint,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const accepted: ProjectInvitationAcceptance = {
    scope: {
      stationId,
      localProjectId: 'project-local',
      localProjectSlug: 'shared-project',
      portableProjectId: 'project-portable',
    },
    grantsDeviceAccess: false,
  };
  return {
    async login() {
      current = account;
      for (const listener of listeners) listener();
      return account;
    },
    current: () =>
      !application.isCurrent() ||
      !current ||
      Date.parse(current.expiresAt) <= Date.now()
        ? null
        : current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async requestHeaders() {
      return {
        'X-Station-Native-Account-Continuation': 'C'.repeat(43),
        'X-Station-Native-Account-Proof': 'proof',
      };
    },
    async acceptInvitation() {
      return accepted;
    },
    async logout() {
      return { revoked: true as const };
    },
    retire() {
      if (!current) return;
      current = null;
      for (const listener of listeners) listener();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  retireNativeRelayConnectionOwners();
  vi.mocked(createNativeRelayApplicationRuntime)
    .mockReset()
    .mockImplementation(async (runtimeInput) => runtimeFor(runtimeInput));
  mocks.createAccount
    .mockReset()
    .mockImplementation(async ({ application }) => accountFor(application));
});

afterEach(() => {
  retireNativeRelayConnectionOwners();
});

test('retiring a ready owner publishes its account removal even after its route becomes stale', async () => {
  let selectionCurrent = true;
  const selected = {
    ...input(),
    selectionIsCurrent: () => selectionCurrent,
  };
  const key = nativeRelayAccountScopeKey(selected);
  const owner = await prepareNativeRelayConnectionOwner(selected);
  await owner.login({ username: 'member', password: 'transient' });
  const observed = vi.fn();
  const unsubscribe = subscribeNativeRelayAccountScope(observed);

  selectionCurrent = false;
  retireNativeRelayConnectionOwners();

  expect(observed).toHaveBeenCalled();
  expect(getNativeRelayAccountScope(key)?.account).toBeNull();
  expect(captureNativeRelayConnectionOwner(key)).toBeNull();
  expect(owner.isCurrent()).toBe(false);
  unsubscribe();
});

test('a ready owner that loses currentness is retired before a same-key preparation', async () => {
  let selectionEpoch = 1;
  const base = input();
  const oldSelection = {
    ...base,
    selectionIsCurrent: () => selectionEpoch === 1,
  };
  const newSelection = {
    ...base,
    selectionIsCurrent: () => selectionEpoch === 2,
  };
  const oldOwner = await prepareNativeRelayConnectionOwner(oldSelection);
  selectionEpoch = 2;

  expect(oldOwner.isCurrent()).toBe(false);
  const currentOwner = await prepareNativeRelayConnectionOwner(newSelection);

  expect(currentOwner).not.toBe(oldOwner);
  expect(createNativeRelayApplicationRuntime).toHaveBeenCalledTimes(2);
  expect(
    captureNativeRelayConnectionOwner(nativeRelayAccountScopeKey(base)),
  ).toBe(currentOwner);
});

test('late completion and disposal of a retired pending owner cannot remove or clear its same-key replacement', async () => {
  const selected = input();
  const key = nativeRelayAccountScopeKey(selected);
  const entered = deferred<AbortSignal>();
  const oldRuntime =
    deferred<Awaited<ReturnType<typeof createNativeRelayApplicationRuntime>>>();
  vi.mocked(createNativeRelayApplicationRuntime).mockImplementationOnce(
    async (runtimeInput) => {
      entered.resolve(runtimeInput.signal);
      return oldRuntime.promise;
    },
  );

  const oldPreparation = prepareNativeRelayConnectionOwner(selected);
  const oldSignal = await entered.promise;
  retireNativeRelayConnectionOwners();
  expect(oldSignal.aborted).toBe(true);

  const replacementPreparation = prepareNativeRelayConnectionOwner(selected);
  await vi.waitFor(() =>
    expect(createNativeRelayApplicationRuntime).toHaveBeenCalledTimes(2),
  );
  const replacement = await replacementPreparation;
  await replacement.login({ username: 'replacement', password: 'transient' });
  const replacementScope = getNativeRelayAccountScope(key);
  expect(replacementScope?.account?.instanceId).toBe('session-instance');

  oldRuntime.resolve(
    runtimeFor({
      ...selected,
      signal: oldSignal,
    }),
  );
  await expect(oldPreparation).rejects.toThrow(
    'native_relay_connection_owner_retired',
  );

  expect(captureNativeRelayConnectionOwner(key)).toBe(replacement);
  expect(getNativeRelayAccountScope(key)).toBe(replacementScope);
  expect(replacement.isCurrent()).toBe(true);
});
