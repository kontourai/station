import {
  createNativeVerifiedPeerTransport,
  type NativeVerifiedPeer,
  type NativeVerifiedPeerSignaling,
} from '@kontourai/station-connect/native-application';
import type { NativeEnrollmentOpenedPeer } from '@kontourai/station-connect/native-enrollment';
import type { ApprovedStationConnectionTrust } from '@kontourai/station-contracts/connection-proof';
import type {
  SelfHostedBrokerNativeClientSurfaceV2,
  SelfHostedBrokerNativeScopeV2,
} from '@kontourai/station-contracts/self-hosted-broker';
import { createNativeRelayIceConfigurationBridge } from './nativeRelayIceConfigurationBridge';
import {
  createNativeRelayBindingOwner,
  type NativeRelayBindingDto,
  type TauriInvoker,
} from './nativeRelaySignalingBridge';

type Dict = Record<string, unknown>;
const PEER_HANDLE = /^[A-Za-z0-9_-]{43}$/u;
const MAX_OWNED_ENROLLMENT_PEERS = 4;
const MAX_HOST_PEER_LIFETIME_MS = 120_000;
const CONNECT_PEER_LIFETIME_MS = 45_000;
const BINDING_COMMAND = 'station_native_relay_enrollment_binding';
const PREPARE_COMMAND = 'station_native_enrollment_peer_prepare';
const OPEN_COMMAND = 'station_native_enrollment_peer_open';
const READ_COMMAND = 'station_native_enrollment_peer_read';
const CLOSE_COMMAND = 'station_native_enrollment_peer_close';

let pendingPeerPreparations = 0;
const ownedPeerHandles = new Map<string, number>();
const peerCloseTasks = new Map<string, Promise<void>>();
const pendingPeerCleanups = new Set<string>();

export interface NativeEnrollmentSignalingBridgeInput {
  readonly profileName: string;
  readonly expectedProfileRevision: number;
  readonly stationAudience: string;
  readonly signal: AbortSignal;
  readonly invoke: TauriInvoker;
  readonly now?: () => number;
}

export interface NativeEnrollmentSignalingBridge {
  open(signal: AbortSignal): Promise<NativeEnrollmentOpenedPeer>;
}

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Dict, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function sameSurface(
  value: unknown,
  expected: SelfHostedBrokerNativeClientSurfaceV2,
): boolean {
  if (
    !isDict(value) ||
    !exactKeys(value, [
      'kind',
      'appIdentifier',
      'channel',
      'clientInstanceId',
      'keyThumbprint',
    ])
  )
    return false;
  return (
    value.kind === expected.kind &&
    value.appIdentifier === expected.appIdentifier &&
    value.channel === expected.channel &&
    value.clientInstanceId === expected.clientInstanceId &&
    value.keyThumbprint === expected.keyThumbprint
  );
}

function sameScope(
  value: unknown,
  expected: SelfHostedBrokerNativeScopeV2,
): boolean {
  if (
    !isDict(value) ||
    !exactKeys(value, ['stationId', 'enrollmentId', 'routingGeneration'])
  )
    return false;
  return (
    value.stationId === expected.stationId &&
    value.enrollmentId === expected.enrollmentId &&
    value.routingGeneration === expected.routingGeneration
  );
}

function sameTrust(
  value: unknown,
  binding: NativeRelayBindingDto,
  expected: ApprovedStationConnectionTrust,
): boolean {
  if (
    !isDict(value) ||
    !exactKeys(value, [
      'stationId',
      'enrollmentId',
      'generation',
      'signingKey',
    ]) ||
    value.stationId !== binding.stationId ||
    value.enrollmentId !== binding.enrollmentId ||
    value.generation !== binding.generation ||
    value.stationId !== expected.stationId ||
    value.enrollmentId !== expected.enrollmentId ||
    value.generation !== expected.generation ||
    !isDict(value.signingKey) ||
    !exactKeys(value.signingKey, ['kty', 'crv', 'x', 'y'])
  )
    return false;
  return (
    value.signingKey.kty === binding.signingKey.kty &&
    value.signingKey.crv === binding.signingKey.crv &&
    value.signingKey.x === binding.signingKey.x &&
    value.signingKey.y === binding.signingKey.y &&
    value.signingKey.kty === expected.signingKey.kty &&
    value.signingKey.crv === expected.signingKey.crv &&
    value.signingKey.x === expected.signingKey.x &&
    value.signingKey.y === expected.signingKey.y
  );
}

function extractPeerHandle(value: unknown): string | null {
  if (!isDict(value)) return null;
  const handle = value.peerHandle;
  return typeof handle === 'string' && PEER_HANDLE.test(handle) ? handle : null;
}

function boundedPeerExpiry(value: unknown, now: number): number {
  if (isDict(value) && Number.isSafeInteger(value.expiresAt)) {
    const expiresAt = value.expiresAt as number;
    if (expiresAt > 0 && expiresAt <= now + MAX_HOST_PEER_LIFETIME_MS)
      return expiresAt;
  }
  return now + MAX_HOST_PEER_LIFETIME_MS;
}

function pruneExpiredPeerHandles(now: number): void {
  for (const [peerHandle, expiresAt] of ownedPeerHandles) {
    if (expiresAt <= now) {
      ownedPeerHandles.delete(peerHandle);
      pendingPeerCleanups.delete(peerHandle);
    }
  }
}

function ownPeerHandle(value: unknown, peerHandle: string, now: number): void {
  pruneExpiredPeerHandles(now);
  if (ownedPeerHandles.has(peerHandle))
    throw new Error('native_enrollment_peer_duplicate');
  ownedPeerHandles.set(peerHandle, boundedPeerExpiry(value, now));
}

function comparePreparedPeer(
  value: unknown,
  binding: NativeRelayBindingDto,
  expectedTrust: ApprovedStationConnectionTrust,
  stationAudience: string,
  iceExpiresAt: number,
  now: number,
): { peer: NativeVerifiedPeer; stationAudience: string } {
  if (
    !isDict(value) ||
    !exactKeys(value, [
      'version',
      'peerHandle',
      'nonce',
      'connectionId',
      'expiresAt',
      'scope',
      'surface',
      'stationAudience',
      'trust',
    ])
  )
    throw new Error('native_enrollment_peer_invalid');

  const handle = value.peerHandle;
  const nonce = value.nonce;
  const connectionId = value.connectionId;
  const expiresAt = value.expiresAt;
  if (
    value.version !== 'station-native-enrollment-peer/v1' ||
    typeof handle !== 'string' ||
    !PEER_HANDLE.test(handle) ||
    typeof nonce !== 'string' ||
    !PEER_HANDLE.test(nonce) ||
    connectionId !== binding.surface.clientInstanceId ||
    !Number.isSafeInteger(expiresAt) ||
    (expiresAt as number) <= now ||
    (expiresAt as number) > now + MAX_HOST_PEER_LIFETIME_MS ||
    (expiresAt as number) > iceExpiresAt ||
    value.stationAudience !== stationAudience ||
    !sameScope(value.scope, binding.scope) ||
    !sameSurface(value.surface, binding.surface) ||
    !sameTrust(value.trust, binding, expectedTrust)
  )
    throw new Error('native_enrollment_peer_binding_mismatch');

  return {
    peer: Object.freeze({
      version: 'station-native-enrollment-peer/v1',
      peerHandle: handle,
      nonce,
      connectionId,
      expiresAt: expiresAt as number,
    }),
    stationAudience,
  };
}

function raceWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', aborted);
    const aborted = () => {
      cleanup();
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function closeOwnedPeer(
  invoke: TauriInvoker,
  peerHandle: string,
  now: () => number,
): Promise<void> {
  pruneExpiredPeerHandles(now());
  if (!ownedPeerHandles.has(peerHandle)) return;
  const existing = peerCloseTasks.get(peerHandle);
  if (existing) return existing;
  pendingPeerCleanups.add(peerHandle);
  const task = Promise.resolve()
    .then(() => invoke.invoke(CLOSE_COMMAND, { peerHandle }))
    .then(() => {
      ownedPeerHandles.delete(peerHandle);
      pendingPeerCleanups.delete(peerHandle);
    });
  peerCloseTasks.set(peerHandle, task);
  try {
    await task;
  } finally {
    peerCloseTasks.delete(peerHandle);
  }
}

async function retryPendingPeerCleanups(
  invoke: TauriInvoker,
  now: () => number,
  signal: AbortSignal,
): Promise<void> {
  pruneExpiredPeerHandles(now());
  for (const peerHandle of [...pendingPeerCleanups]) {
    signal.throwIfAborted();
    try {
      await raceWithSignal(closeOwnedPeer(invoke, peerHandle, now), signal);
    } catch {
      signal.throwIfAborted();
    }
  }
}

function reservePeerPreparation(now: () => number): () => void {
  pruneExpiredPeerHandles(now());
  if (
    ownedPeerHandles.size + pendingPeerPreparations >=
    MAX_OWNED_ENROLLMENT_PEERS
  )
    throw new Error('native_enrollment_peer_capacity_reached');
  pendingPeerPreparations += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pendingPeerPreparations -= 1;
  };
}

export function createNativeEnrollmentSignalingBridge(
  input: NativeEnrollmentSignalingBridgeInput,
): NativeEnrollmentSignalingBridge {
  const profileName = input.profileName;
  const expectedProfileRevision = input.expectedProfileRevision;
  const stationAudience = input.stationAudience;
  const lifetimeSignal = input.signal;
  const invoke = input.invoke;
  const now = input.now ?? Date.now;
  const iceBridge = createNativeRelayIceConfigurationBridge(
    (command, args) => invoke.invoke(command, args),
    now,
  );

  return {
    async open(signal) {
      const ownedSignal = AbortSignal.any([lifetimeSignal, signal]);
      ownedSignal.throwIfAborted();
      if (!stationAudience || stationAudience.length > 2048)
        throw new Error('native_enrollment_audience_invalid');

      const owner = await raceWithSignal(
        createNativeRelayBindingOwner({
          bindingCommand: BINDING_COMMAND,
          bindingArguments: 'flat',
          errorPrefix: 'native_enrollment',
          profileName,
          profileRevision: expectedProfileRevision,
          invoke,
        }),
        ownedSignal,
      );
      const expectedTrust = owner.trust.current();
      if (!expectedTrust)
        throw new Error('native_enrollment_trust_unavailable');

      const assertBindingCurrent = async (checkSignal: AbortSignal) => {
        checkSignal.throwIfAborted();
        if (!owner.trust.isCurrent(expectedTrust))
          throw new Error('native_enrollment_binding_retired');
        const current = await raceWithSignal(
          owner.trust.recheck(expectedTrust, 'checkpoint'),
          checkSignal,
        );
        checkSignal.throwIfAborted();
        if (!current || !owner.trust.isCurrent(expectedTrust))
          throw new Error('native_enrollment_binding_retired');
      };

      await assertBindingCurrent(ownedSignal);
      const peerDeadline = now() + CONNECT_PEER_LIFETIME_MS;
      const ice = await raceWithSignal(
        iceBridge.get({
          profileName,
          expectedProfileRevision,
          scope: owner.binding.scope,
          surface: owner.binding.surface,
          peerDeadline,
          signal: ownedSignal,
        }),
        ownedSignal,
      );
      await assertBindingCurrent(ownedSignal);

      const preparedPeer: {
        value: {
          peer: NativeVerifiedPeer;
          stationAudience: string;
        } | null;
      } = { value: null };
      const signalingOwner: NativeVerifiedPeerSignaling = {
        scope: owner.binding.scope,
        surface: owner.binding.surface,
        async prepare(prepareSignal) {
          prepareSignal.throwIfAborted();
          await assertBindingCurrent(prepareSignal);
          await retryPendingPeerCleanups(invoke, now, prepareSignal);
          const releaseSlot = reservePeerPreparation(now);
          let deferRelease = false;
          let rawPromise: Promise<unknown>;
          try {
            rawPromise = invoke.invoke(PREPARE_COMMAND, {
              profileName,
              expectedProfileRevision,
            });
          } catch (error) {
            releaseSlot();
            throw error;
          }
          try {
            const raw = await raceWithSignal(rawPromise, prepareSignal);
            const peerHandle = extractPeerHandle(raw);
            if (peerHandle) {
              ownPeerHandle(raw, peerHandle, now());
            }
            try {
              prepareSignal.throwIfAborted();
              if (!peerHandle)
                throw new Error('native_enrollment_peer_invalid');
              const decoded = comparePreparedPeer(
                raw,
                owner.binding,
                expectedTrust,
                stationAudience,
                ice.expiresAt,
                now(),
              );
              ownedPeerHandles.set(peerHandle, decoded.peer.expiresAt);
              await assertBindingCurrent(prepareSignal);
              prepareSignal.throwIfAborted();
              preparedPeer.value = decoded;
              return decoded.peer;
            } catch (error) {
              if (peerHandle) await closeOwnedPeer(invoke, peerHandle, now);
              throw error;
            }
          } catch (error) {
            if (prepareSignal.aborted) {
              deferRelease = true;
              void rawPromise
                .then(async (raw) => {
                  const peerHandle = extractPeerHandle(raw);
                  if (!peerHandle) return;
                  try {
                    ownPeerHandle(raw, peerHandle, now());
                  } catch {
                    return;
                  }
                  await closeOwnedPeer(invoke, peerHandle, now);
                })
                .catch(() => {})
                .finally(releaseSlot);
            }
            throw error;
          } finally {
            if (!deferRelease) releaseSlot();
          }
        },
        async open(peerHandle, offerSdp, openSignal) {
          openSignal.throwIfAborted();
          const currentPrepared = preparedPeer.value;
          if (
            !currentPrepared ||
            currentPrepared.peer.peerHandle !== peerHandle
          )
            throw new Error('native_enrollment_peer_unavailable');
          await assertBindingCurrent(openSignal);
          const receipt = await raceWithSignal(
            invoke.invoke(OPEN_COMMAND, { peerHandle, offerSdp }),
            openSignal,
          );
          openSignal.throwIfAborted();
          if (
            !isDict(receipt) ||
            !exactKeys(receipt, ['expiresAt']) ||
            !Number.isSafeInteger(receipt.expiresAt) ||
            (receipt.expiresAt as number) <= now()
          )
            throw new Error('native_enrollment_peer_open_receipt_invalid');
          await assertBindingCurrent(openSignal);
          return receipt.expiresAt as number;
        },
        async read(peerHandle, readSignal) {
          readSignal.throwIfAborted();
          const currentPrepared = preparedPeer.value;
          if (
            !currentPrepared ||
            currentPrepared.peer.peerHandle !== peerHandle
          )
            throw new Error('native_enrollment_peer_unavailable');
          await assertBindingCurrent(readSignal);
          const answer = await raceWithSignal(
            invoke.invoke(READ_COMMAND, { peerHandle }),
            readSignal,
          );
          readSignal.throwIfAborted();
          await assertBindingCurrent(readSignal);
          return answer;
        },
        close: (peerHandle) => closeOwnedPeer(invoke, peerHandle, now),
      };
      const signaling = Object.freeze(signalingOwner);

      const transport = createNativeVerifiedPeerTransport({
        signaling,
        peerVersion: 'station-native-enrollment-peer/v1',
        origin: stationAudience,
        signal: ownedSignal,
        trust: owner.trust,
        configuration: ice.configuration,
        now,
      });
      let opened: Awaited<
        ReturnType<typeof transport.openVerifiedPeer>
      > | null = null;
      try {
        opened = await raceWithSignal(
          transport.openVerifiedPeer(ownedSignal),
          ownedSignal,
        );
        const currentPrepared = preparedPeer.value;
        if (
          !currentPrepared ||
          currentPrepared.peer.peerHandle !== opened.peer.peerHandle ||
          currentPrepared.stationAudience !== stationAudience ||
          opened.peer.expiresAt > ice.expiresAt
        )
          throw new Error('native_enrollment_peer_binding_mismatch');

        const active = opened;
        const peer = Object.freeze({
          peerHandle: active.peer.peerHandle,
          stationAudience: currentPrepared.stationAudience,
          expiresAt: active.peer.expiresAt,
        });
        let closeTask: Promise<void> | null = null;
        const close = () => {
          if (!closeTask) {
            const task = (async () => {
              await active.close();
              if (ownedPeerHandles.has(peer.peerHandle))
                await closeOwnedPeer(invoke, peer.peerHandle, now);
            })();
            closeTask = task;
            void task.catch(() => {
              if (closeTask === task) closeTask = null;
            });
          }
          return closeTask;
        };

        return Object.freeze({
          peer,
          channel: active.channel,
          assertCurrent: () => assertBindingCurrent(ownedSignal),
          close,
        });
      } catch (error) {
        if (opened) await opened.close().catch(() => {});
        const peerHandle =
          opened?.peer.peerHandle ?? preparedPeer.value?.peer.peerHandle;
        if (peerHandle)
          await closeOwnedPeer(invoke, peerHandle, now).catch(() => {});
        throw error;
      }
    },
  };
}
