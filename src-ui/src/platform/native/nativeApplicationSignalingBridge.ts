import type {
  NativeApplicationPeer,
  NativeApplicationPeerAnswer,
  NativeApplicationSignaling,
  NativeApplicationTrustOwner,
} from '@kontourai/station-connect/native-application';
import { STATION_CONNECTION_PROOF_MAX_BYTES } from '@kontourai/station-contracts/connection-proof';
import { NATIVE_DEVICE_PROOF_MAX_LENGTH } from '@kontourai/station-contracts/native-device-proof';
import type { TauriInvoker } from './nativeRelaySignalingBridge';
import { createNativeRelaySignalingBridge } from './nativeRelaySignalingBridge';
import { invokeTauri } from './tauriInvoke';

const PEER_HANDLE = /^[A-Za-z0-9_-]{43}$/u;
const CLIENT_INSTANCE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_OFFER_BYTES = 64 * 1024;
const MAX_STATION_PROOF_BYTES = STATION_CONNECTION_PROOF_MAX_BYTES;
const MAX_PATH_BYTES = 2048;
const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const PEER_TTL_MS = 120_000;
const MAX_PEERS = 16;

const defaultInvoker: TauriInvoker = {
  invoke: (command, args) => invokeTauri<unknown>(command, args),
};

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function handleOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const peerHandle = (value as { peerHandle?: unknown }).peerHandle;
  return typeof peerHandle === 'string' && PEER_HANDLE.test(peerHandle)
    ? peerHandle
    : undefined;
}

function peerExpiryForTracking(value: unknown, now: number): number {
  if (typeof value !== 'object' || value === null) return now + PEER_TTL_MS;
  const expiresAt = (value as { expiresAt?: unknown }).expiresAt;
  if (!Number.isSafeInteger(expiresAt)) return now + PEER_TTL_MS;
  if ((expiresAt as number) <= now) return now;
  return (expiresAt as number) <= now + PEER_TTL_MS
    ? (expiresAt as number)
    : now + PEER_TTL_MS;
}

function validatePeer(
  value: unknown,
  clientInstanceId: string,
): NativeApplicationPeer {
  if (
    !exactKeys(value, [
      'version',
      'peerHandle',
      'nonce',
      'connectionId',
      'expiresAt',
    ])
  )
    throw new Error('native_application_peer_invalid');
  const peer = value as NativeApplicationPeer;
  const now = Date.now();
  if (
    peer.version !== 'station-native-application-peer/v1' ||
    !PEER_HANDLE.test(peer.peerHandle) ||
    !PEER_HANDLE.test(peer.nonce) ||
    !CLIENT_INSTANCE_ID.test(peer.connectionId) ||
    peer.connectionId !== clientInstanceId ||
    !Number.isSafeInteger(peer.expiresAt) ||
    peer.expiresAt <= now ||
    peer.expiresAt > now + PEER_TTL_MS
  )
    throw new Error('native_application_peer_invalid');
  return Object.freeze({ ...peer });
}

function validateOpenReceipt(
  value: unknown,
  peer: NativeApplicationPeer,
): number {
  if (!exactKeys(value, ['expiresAt']))
    throw new Error('native_application_open_invalid');
  const expiresAt = (value as { expiresAt: unknown }).expiresAt;
  if (
    !Number.isSafeInteger(expiresAt) ||
    (expiresAt as number) <= Date.now() ||
    (expiresAt as number) > peer.expiresAt
  )
    throw new Error('native_application_open_invalid');
  return expiresAt as number;
}

function validateReadReceipt(
  value: unknown,
  peer: NativeApplicationPeer,
): NativeApplicationPeerAnswer {
  if (!exactKeys(value, ['version', 'answerSdp', 'stationProof', 'expiresAt']))
    throw new Error('native_application_read_invalid');
  const answer = value as NativeApplicationPeerAnswer;
  if (
    answer.version !== 'station-broker-native-connection-answer/v2' ||
    (answer.answerSdp !== null && typeof answer.answerSdp !== 'string') ||
    (answer.stationProof !== null && typeof answer.stationProof !== 'string') ||
    (typeof answer.answerSdp === 'string' &&
      answer.answerSdp.length > MAX_OFFER_BYTES) ||
    (typeof answer.stationProof === 'string' &&
      answer.stationProof.length > MAX_STATION_PROOF_BYTES) ||
    !Number.isSafeInteger(answer.expiresAt) ||
    answer.expiresAt <= Date.now() ||
    answer.expiresAt > peer.expiresAt
  )
    throw new Error('native_application_read_invalid');
  return Object.freeze({ ...answer });
}

function validateSignedProof(value: unknown): string {
  if (!exactKeys(value, ['version', 'proof']))
    throw new Error('native_application_sign_invalid');
  const result = value as { version: unknown; proof: unknown };
  if (
    result.version !== 'station-native-device-request-proof-result/v1' ||
    typeof result.proof !== 'string' ||
    result.proof.length === 0 ||
    result.proof.length > NATIVE_DEVICE_PROOF_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(result.proof)
  )
    throw new Error('native_application_sign_invalid');
  return result.proof;
}

function isOpenUnknown(error: unknown): boolean {
  return (
    error === 'native_application_peer_open_unknown' ||
    (error instanceof Error &&
      error.message === 'native_application_peer_open_unknown')
  );
}

function hasUnsafeRequestPathCharacter(path: string): boolean {
  return (
    path.includes('#') ||
    [...path].some((character) => {
      const codePoint = character.charCodeAt(0);
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  );
}

/**
 * Creates the opt-in application peer bridge for one exact saved profile.
 * The prior application-binding command supplies only its public trust/scope
 * view; a separate host peer handle owns the nonce, Pion transcript and
 * per-request Device proof operations. The diagnostic signaling commands are
 * never invoked by this adapter.
 */
export async function createNativeApplicationSignalingBridge(
  profileName: string,
  profileRevision: number,
  invoke: TauriInvoker = defaultInvoker,
): Promise<{
  signaling: NativeApplicationSignaling;
  trust: NativeApplicationTrustOwner;
}> {
  const binding = await createNativeRelaySignalingBridge({
    bindingCommand: 'station_native_relay_application_binding',
    openCommand: 'station_native_relay_application_open',
    readCommand: 'station_native_relay_application_read',
    errorPrefix: 'native_application',
    profileName,
    profileRevision,
    invoke,
  });
  const scope = Object.freeze({ ...binding.signaling.scope });
  const surface = Object.freeze({ ...binding.signaling.surface });
  const handles = new Map<string, NativeApplicationPeer>();
  const closing = new Map<string, Promise<void>>();
  let pendingPrepares = 0;

  const pruneExpiredHandles = () => {
    const now = Date.now();
    for (const [peerHandle, peer] of handles) {
      if (peer.expiresAt <= now) handles.delete(peerHandle);
    }
  };

  const closePeer = (peerHandle: string): Promise<void> => {
    pruneExpiredHandles();
    const existing = closing.get(peerHandle);
    if (existing) return existing;
    if (!handles.has(peerHandle)) return Promise.resolve();
    const task = invoke
      .invoke('station_native_application_peer_close', { peerHandle })
      .then(() => {
        handles.delete(peerHandle);
      })
      .catch(() => {
        throw new Error('native_application_peer_close_failed');
      })
      .finally(() => {
        closing.delete(peerHandle);
      });
    closing.set(peerHandle, task);
    return task;
  };

  const signaling: NativeApplicationSignaling = Object.freeze({
    scope,
    surface,
    async prepare(signal: AbortSignal) {
      signal.throwIfAborted();
      pruneExpiredHandles();
      if (handles.size + pendingPrepares >= MAX_PEERS)
        throw new Error('native_application_peer_invalid');
      pendingPrepares++;
      try {
        const raw = await invoke.invoke(
          'station_native_application_peer_prepare',
          {
            profileName,
            expectedProfileRevision: profileRevision,
          },
        );
        const rawHandle = handleOf(raw);
        try {
          const peer = validatePeer(raw, surface.clientInstanceId);
          if (signal.aborted) signal.throwIfAborted();
          if (!rawHandle || handles.has(rawHandle))
            throw new Error('native_application_peer_invalid');
          handles.set(rawHandle, peer);
          return peer;
        } catch (error) {
          if (rawHandle && !handles.has(rawHandle)) {
            handles.set(rawHandle, {
              version: 'station-native-application-peer/v1',
              peerHandle: rawHandle,
              nonce: '',
              connectionId: surface.clientInstanceId,
              expiresAt: peerExpiryForTracking(raw, Date.now()),
            });
            await closePeer(rawHandle).catch(() => {});
          }
          if (signal.aborted) signal.throwIfAborted();
          if (
            error instanceof Error &&
            error.message.startsWith('native_application_')
          )
            throw error;
          throw new Error('native_application_peer_invalid');
        }
      } finally {
        pendingPrepares--;
      }
    },
    async open(peerHandle: string, offerSdp: string, signal: AbortSignal) {
      signal.throwIfAborted();
      pruneExpiredHandles();
      const peer = handles.get(peerHandle);
      if (!peer || !PEER_HANDLE.test(peerHandle))
        throw new Error('native_application_peer_invalid');
      if (
        typeof offerSdp !== 'string' ||
        offerSdp.length === 0 ||
        offerSdp.length > MAX_OFFER_BYTES
      )
        throw new Error('native_application_offer_invalid');
      try {
        const expiresAt = validateOpenReceipt(
          await invoke.invoke('station_native_application_peer_open', {
            peerHandle,
            offerSdp,
          }),
          peer,
        );
        signal.throwIfAborted();
        return expiresAt;
      } catch (error) {
        if (signal.aborted) signal.throwIfAborted();
        if (isOpenUnknown(error))
          throw new Error('native_application_peer_open_unknown');
        if (
          error instanceof Error &&
          error.message.startsWith('native_application_')
        )
          throw error;
        throw new Error('native_application_peer_open_failed');
      }
    },
    async read(peerHandle: string, signal: AbortSignal) {
      signal.throwIfAborted();
      pruneExpiredHandles();
      const peer = handles.get(peerHandle);
      if (!peer || !PEER_HANDLE.test(peerHandle))
        throw new Error('native_application_peer_invalid');
      try {
        const raw = await invoke.invoke(
          'station_native_application_peer_read',
          {
            peerHandle,
          },
        );
        signal.throwIfAborted();
        return validateReadReceipt(raw, peer);
      } catch (error) {
        if (signal.aborted) signal.throwIfAborted();
        if (
          error instanceof Error &&
          error.message.startsWith('native_application_')
        )
          throw error;
        throw new Error('native_application_peer_read_failed');
      }
    },
    async sign(
      peerHandle: string,
      method: string,
      path: string,
      body: Uint8Array,
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      pruneExpiredHandles();
      if (!handles.has(peerHandle) || !PEER_HANDLE.test(peerHandle))
        throw new Error('native_application_peer_invalid');
      if (
        typeof method !== 'string' ||
        method !== method.toUpperCase() ||
        typeof path !== 'string' ||
        !path.startsWith('/') ||
        new TextEncoder().encode(path).byteLength > MAX_PATH_BYTES ||
        hasUnsafeRequestPathCharacter(path) ||
        !(body instanceof Uint8Array) ||
        body.byteLength > MAX_REQUEST_BODY_BYTES
      )
        throw new Error('native_application_sign_request_invalid');
      const exactBody = body.slice();
      try {
        const proof = validateSignedProof(
          await invoke.invoke('station_native_application_peer_sign', {
            peerHandle,
            method,
            path,
            body: Array.from(exactBody),
          }),
        );
        signal.throwIfAborted();
        return proof;
      } catch (error) {
        if (signal.aborted) signal.throwIfAborted();
        if (
          error instanceof Error &&
          error.message.startsWith('native_application_')
        )
          throw error;
        throw new Error('native_application_peer_sign_failed');
      }
    },
    close(peerHandle: string) {
      if (!PEER_HANDLE.test(peerHandle))
        return Promise.reject(new Error('native_application_peer_invalid'));
      return closePeer(peerHandle);
    },
  });

  return { signaling, trust: binding.trust };
}
