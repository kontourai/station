import type { SavedConnection } from '@kontourai/station-connect';
import { createNativeApplicationTransport } from '@kontourai/station-connect/native-application';
import type { ApprovedStationConnectionTrust } from '@kontourai/station-contracts/connection-proof';
import { isNativeManagementRequest } from '@kontourai/station-sdk/application-session-native';
import { createNativeApplicationSignalingBridge } from './nativeApplicationSignalingBridge';
import { createNativeRelayIceConfigurationBridge } from './nativeRelayIceConfigurationBridge';
import {
  createNativeRelayBindingOwner,
  type TauriInvoker,
} from './nativeRelaySignalingBridge';
import { invokeTauri } from './tauriInvoke';

type NativeRoute = NonNullable<SavedConnection['nativeBrokerRoute']>;
const defaultInvoker: TauriInvoker = {
  invoke: (command, args) => invokeTauri<unknown>(command, args),
};
const READ_LEAVES = [
  /^\/\.well-known\/station\/v1$/u,
  /^\/api\/system\/(status|identity)$/u,
  /^\/api\/auth\/authority$/u,
  /^\/api\/projects$/u,
  /^\/api\/projects\/[A-Za-z0-9_-]{1,128}$/u,
  /^\/api\/projects\/[A-Za-z0-9_-]{1,128}\/shared-work$/u,
  /^\/api\/projects\/[A-Za-z0-9_-]{1,128}\/shared-work\/[A-Za-z0-9_-]{1,128}\/(document|history|publication)$/u,
];

function sameTrust(
  left: ApprovedStationConnectionTrust | null,
  right: ApprovedStationConnectionTrust,
) {
  return (
    !!left &&
    left.stationId === right.stationId &&
    left.enrollmentId === right.enrollmentId &&
    left.generation === right.generation &&
    left.signingKey.kty === right.signingKey.kty &&
    left.signingKey.crv === right.signingKey.crv &&
    left.signingKey.x === right.signingKey.x &&
    left.signingKey.y === right.signingKey.y
  );
}

/** Actual native application owner; every fetch obtains fresh ICE and a fresh peer. */
export async function createNativeRelayApplicationRuntime(input: {
  route: NativeRoute;
  origin: string;
  bindingId: string;
  signal: AbortSignal;
  selectionIsCurrent(): boolean;
  invoke?: TauriInvoker;
}) {
  const route = Object.freeze({ ...input.route });
  const origin = input.origin;
  const invoke = input.invoke ?? defaultInvoker;
  const signal = input.signal;
  const selectionIsCurrent = input.selectionIsCurrent;
  const owner = await createNativeRelayBindingOwner({
    bindingCommand: 'station_native_relay_application_binding',
    bindingArguments: 'request',
    errorPrefix: 'native_application',
    profileName: route.profileName,
    profileRevision: route.profileRevision,
    invoke,
  });
  signal.throwIfAborted();
  const initial = owner.trust.current();
  if (
    !initial ||
    owner.binding.stationId !== route.stationId ||
    owner.binding.enrollmentId !== route.enrollmentId ||
    !selectionIsCurrent()
  )
    throw new Error('native_relay_application_owner_retired');
  const scope = Object.freeze({ ...owner.binding.scope });
  const surface = Object.freeze({ ...owner.binding.surface });
  const authorityIdentity = JSON.stringify([
    input.bindingId,
    route,
    origin,
    owner.binding.trustRevision,
    initial,
    scope,
    surface,
  ]);
  const isCurrent = () =>
    !signal.aborted &&
    selectionIsCurrent() &&
    owner.trust.isCurrent(initial) &&
    sameTrust(owner.trust.current(), initial);
  const assertCurrent = async () => {
    if (
      !isCurrent() ||
      !(await owner.trust.recheck(initial, 'checkpoint')) ||
      !isCurrent()
    )
      throw new Error('native_relay_application_owner_retired');
  };
  const fetch: typeof globalThis.fetch = async (request, init) => {
    const url = new URL(
      request instanceof Request ? request.url : request.toString(),
    );
    const method = (
      init?.method ?? (request instanceof Request ? request.method : 'GET')
    ).toUpperCase();
    if (
      url.origin !== origin ||
      url.hash ||
      url.username ||
      url.password ||
      `${url.pathname}${url.search}`.length > 2048 ||
      ((method === 'GET' || method === 'HEAD') &&
        (init?.body != null ||
          (request instanceof Request && request.body !== null))) ||
      (!isNativeManagementRequest(method, `${url.pathname}${url.search}`) &&
        !(
          (method === 'GET' || method === 'HEAD') &&
          READ_LEAVES.some((leaf) => leaf.test(url.pathname))
        ) &&
        !(
          method === 'POST' &&
          [
            '/api/account-auth/continuations/native/challenge',
            '/api/account-auth/continuations/native/exchange',
            '/api/account-auth/continuations/native/revoke',
            '/api/account-auth/accept-invitation',
          ].includes(url.pathname)
        ))
    )
      throw new Error('native_relay_resource_not_supported');
    await assertCurrent();
    const activeSignal = AbortSignal.any([
      signal,
      init?.signal ??
        (request instanceof Request
          ? request.signal
          : new AbortController().signal),
    ]);
    const bridge = await createNativeApplicationSignalingBridge(
      route.profileName,
      route.profileRevision,
      invoke,
    );
    if (
      !sameTrust(bridge.trust.current(), initial) ||
      JSON.stringify(bridge.signaling.scope) !== JSON.stringify(scope) ||
      JSON.stringify(bridge.signaling.surface) !== JSON.stringify(surface)
    )
      throw new Error('native_relay_application_owner_retired');
    const ice = await createNativeRelayIceConfigurationBridge(
      invoke.invoke.bind(invoke),
    ).get({
      profileName: route.profileName,
      expectedProfileRevision: route.profileRevision,
      scope,
      surface,
      peerDeadline: Date.now() + 120_000,
      signal: activeSignal,
    });
    await assertCurrent();
    return createNativeApplicationTransport({
      ...bridge,
      origin,
      signal: activeSignal,
      configuration: ice.configuration,
    }).fetch(request, { ...init, signal: activeSignal });
  };
  return Object.freeze({
    origin,
    scope,
    surface,
    authorityIdentity,
    isCurrent,
    assertCurrent,
    fetch,
  });
}
