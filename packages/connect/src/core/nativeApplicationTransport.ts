import type { ApprovedStationConnectionTrust } from '@kontourai/station-contracts/connection-proof';
import { STATION_CONNECTION_PROOF_MAX_BYTES } from '@kontourai/station-contracts/connection-proof';
import {
  NATIVE_DEVICE_PROOF_HEADER,
  NATIVE_DEVICE_PROOF_MAX_LENGTH,
} from '@kontourai/station-contracts/native-device-proof';
import type {
  SelfHostedBrokerNativeClientSurfaceV2,
  SelfHostedBrokerNativeScopeV2,
} from '@kontourai/station-contracts/self-hosted-broker';
import {
  connectionDescriptionDigest,
  copyStationConnectionTrust,
  createStationConnectionProofVerifier,
} from '@kontourai/station-shared/connection-proof';
import {
  type ApplicationChannel,
  browserApplicationChannel,
  createApplicationChannelFetch,
} from './applicationChannel.js';
import {
  composeOwnedSignal,
  delayBrowserTransport,
  raceOwnedLifetime,
  waitForBrowserTransport,
} from './browserTransportWait.js';
import { fingerprint, sameTrust } from './nativeConnectionShared.js';

/**
 * The only DataChannel label this client will ever open or adopt. Any other
 * label, including the diagnostic echo channel, is rejected and closed.
 */
export const APPLICATION_TRANSPORT_CHANNEL = 'station-application-v1';

/** Host-issued, opaque native Pion peer handle. No private owner fields cross. */
export interface NativeApplicationPeer {
  readonly version: 'station-native-application-peer/v1';
  readonly peerHandle: string;
  readonly nonce: string;
  readonly connectionId: string;
  readonly expiresAt: number;
}

/** Readback returned only after the host validates its complete peer transcript. */
export interface NativeApplicationPeerAnswer {
  readonly version: 'station-broker-native-connection-answer/v2';
  readonly answerSdp: string | null;
  readonly stationProof: string | null;
  readonly expiresAt: number;
}

/** Host-owned native Pion lifecycle and per-request Device proof signing. */
export interface NativeApplicationSignaling {
  readonly scope: SelfHostedBrokerNativeScopeV2;
  readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
  prepare(signal: AbortSignal): Promise<NativeApplicationPeer>;
  open(
    peerHandle: string,
    offerSdp: string,
    signal: AbortSignal,
  ): Promise<number>;
  read(
    peerHandle: string,
    signal: AbortSignal,
  ): Promise<NativeApplicationPeerAnswer>;
  sign(
    peerHandle: string,
    method: string,
    path: string,
    body: Uint8Array,
    signal: AbortSignal,
  ): Promise<string>;
  close(peerHandle: string): Promise<void>;
}

const NATIVE_APPLICATION_PEER_HANDLE = /^[A-Za-z0-9_-]{43}$/u;
const NATIVE_APPLICATION_CLIENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const NATIVE_APPLICATION_PEER_TTL_MS = 120_000;
const NATIVE_APPLICATION_SDP_LIMIT_BYTES = 64 * 1024;
const NATIVE_APPLICATION_STATION_PROOF_LIMIT_BYTES =
  STATION_CONNECTION_PROOF_MAX_BYTES;
const NATIVE_APPLICATION_PATH_LIMIT_BYTES = 2048;
const NATIVE_APPLICATION_BODY_LIMIT_BYTES = 16 * 1024;

function peerHandleFrom(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const handle = (value as { peerHandle?: unknown }).peerHandle;
  return typeof handle === 'string' &&
    NATIVE_APPLICATION_PEER_HANDLE.test(handle)
    ? handle
    : undefined;
}

function validatePeer(
  value: unknown,
  expectedConnectionId: string,
  now: number,
): NativeApplicationPeer {
  const keys = ['version', 'peerHandle', 'nonce', 'connectionId', 'expiresAt'];
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    throw new Error('native_application_peer_invalid');
  const peer = value as NativeApplicationPeer;
  if (
    peer.version !== 'station-native-application-peer/v1' ||
    !NATIVE_APPLICATION_PEER_HANDLE.test(peer.peerHandle) ||
    !NATIVE_APPLICATION_PEER_HANDLE.test(peer.nonce) ||
    !NATIVE_APPLICATION_CLIENT_ID.test(peer.connectionId) ||
    peer.connectionId !== expectedConnectionId ||
    !Number.isSafeInteger(peer.expiresAt) ||
    peer.expiresAt <= now ||
    peer.expiresAt > now + NATIVE_APPLICATION_PEER_TTL_MS
  )
    throw new Error('native_application_peer_invalid');
  return Object.freeze({ ...peer });
}

function validatePeerAnswer(
  value: unknown,
  peer: NativeApplicationPeer,
  priorDeadline: number | undefined,
  now: number,
): NativeApplicationPeerAnswer {
  const keys = ['version', 'answerSdp', 'stationProof', 'expiresAt'];
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    throw new Error('native_application_signal_invalid');
  const answer = value as NativeApplicationPeerAnswer;
  if (
    answer.version !== 'station-broker-native-connection-answer/v2' ||
    (answer.answerSdp !== null && typeof answer.answerSdp !== 'string') ||
    (answer.stationProof !== null && typeof answer.stationProof !== 'string') ||
    (typeof answer.answerSdp === 'string' &&
      answer.answerSdp.length > NATIVE_APPLICATION_SDP_LIMIT_BYTES) ||
    (typeof answer.stationProof === 'string' &&
      answer.stationProof.length >
        NATIVE_APPLICATION_STATION_PROOF_LIMIT_BYTES) ||
    !Number.isSafeInteger(answer.expiresAt) ||
    answer.expiresAt <= now ||
    answer.expiresAt > peer.expiresAt ||
    (priorDeadline !== undefined && answer.expiresAt > priorDeadline)
  )
    throw new Error('native_application_signal_invalid');
  return answer;
}

function validateRequestProof(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > NATIVE_DEVICE_PROOF_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value)
  )
    throw new Error('native_application_request_proof_invalid');
  return value;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error === code || (error instanceof Error && error.message === code);
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

export interface NativeApplicationTrustOwner {
  current(): ApprovedStationConnectionTrust | null;
  isCurrent(value: ApprovedStationConnectionTrust): boolean;
  /**
   * Refresh persisted native trust through its authoritative owner. The local
   * sync check alone cannot observe a revocation made by the native key owner.
   */
  recheck(
    value: ApprovedStationConnectionTrust,
    stage: 'checkpoint' | 'before-remote-description',
  ): Promise<boolean>;
}

export interface NativeApplicationTransportInput {
  readonly signaling: NativeApplicationSignaling;
  /** Canonical Station origin every application request is pinned to. */
  readonly origin: string;
  /** Client lifetime; aborting it closes any in-flight or open channel. */
  readonly signal: AbortSignal;
  readonly trust: NativeApplicationTrustOwner;
  readonly createPeer?: (configuration: RTCConfiguration) => RTCPeerConnection;
  readonly configuration?: RTCConfiguration;
  readonly now?: () => number;
}

/**
 * Opt-in native application transport client. The handshake reuses the
 * host-owned native v2 signaling, verifies the exact approved Station proof
 * before setRemoteDescription, and exposes application traffic only through
 * createApplicationChannelFetch on a station-application-v1 channel. The
 * routing grant and bearer stay inside the native host bridge; this client
 * never reads or returns them and has no HTTP fallback.
 */
export function createNativeApplicationTransport(
  input: NativeApplicationTransportInput,
) {
  const signaling = input.signaling;
  const trustOwner = input.trust;
  const createPeer =
    input.createPeer ??
    ((configuration: RTCConfiguration) => new RTCPeerConnection(configuration));
  const configuration = structuredClone(input.configuration ?? {});
  const now = input.now ?? Date.now;

  const assertCurrent = async (
    expected: ApprovedStationConnectionTrust,
    stage: 'checkpoint' | 'before-remote-description' = 'checkpoint',
    owned?: AbortSignal,
  ) => {
    const checkSignal = owned ?? input.signal;
    checkSignal.throwIfAborted();
    if (!trustOwner.isCurrent(expected))
      throw new Error('native_application_trust_retired');
    const current = trustOwner.current();
    if (!current || !sameTrust(current, expected))
      throw new Error('native_application_trust_retired');
    const authoritative = await raceOwnedLifetime(
      trustOwner.recheck(expected, stage),
      checkSignal,
    );
    checkSignal.throwIfAborted();
    const authoritativeCurrent = trustOwner.current();
    if (
      authoritative !== true ||
      !trustOwner.isCurrent(expected) ||
      !authoritativeCurrent ||
      !sameTrust(authoritativeCurrent, expected)
    )
      throw new Error('native_application_trust_retired');
  };

  /**
   * One handshake per channel: capture trust, verify the exact Station proof,
   * apply the answer SDP only after verification, and adopt only an open,
   * reliable, ordered station-application-v1 channel.
   */
  const openChannel = async (
    signal: AbortSignal,
  ): Promise<ApplicationChannel> => {
    const lifetime = composeOwnedSignal(
      AbortSignal.any([input.signal, signal]),
      45_000,
    );
    const owned = lifetime.signal;
    let peer: RTCPeerConnection | undefined;
    let channel: RTCDataChannel | undefined;
    let hostPeerHandle: string | undefined;
    let hostPeer: NativeApplicationPeer | undefined;
    let hostPeerClose: Promise<void> | undefined;
    let closed = false;
    const closeHostPeer = (handle = hostPeerHandle): Promise<void> => {
      if (!handle) return Promise.resolve();
      if (hostPeerClose) return hostPeerClose;
      hostPeerClose = Promise.resolve(signaling.close(handle)).catch(() => {});
      return hostPeerClose;
    };
    const close = () => {
      if (closed) return;
      closed = true;
      try {
        channel?.close();
      } catch {
        /* already closed */
      }
      owned.removeEventListener('abort', close);
      lifetime.dispose();
      try {
        peer?.close();
      } catch {
        /* already closed */
      }
      void closeHostPeer();
    };
    owned.addEventListener('abort', close, { once: true });
    let completed = false;
    try {
      const captured = trustOwner.current();
      if (!captured) throw new Error('native_application_trust_unavailable');
      const authority = captured;
      const trust = copyStationConnectionTrust(captured);
      const scope = structuredClone(signaling.scope);
      const surface = structuredClone(signaling.surface);
      if (
        scope.stationId !== trust.stationId ||
        scope.enrollmentId !== trust.enrollmentId ||
        surface.kind !== 'station-native'
      )
        throw new Error('native_application_trust_mismatch');
      const clientId = surface.clientInstanceId;
      if (typeof clientId !== 'string' || !clientId)
        throw new Error('native_application_surface_invalid');
      await assertCurrent(authority, 'checkpoint', owned);

      const preparePromise = signaling.prepare(owned);
      try {
        const rawPeer = await raceOwnedLifetime(preparePromise, owned);
        hostPeerHandle = peerHandleFrom(rawPeer);
        hostPeer = validatePeer(rawPeer, clientId, now());
      } catch (error) {
        if (owned.aborted) {
          void preparePromise
            .then((latePeer) => {
              const lateHandle = peerHandleFrom(latePeer);
              if (lateHandle) return closeHostPeer(lateHandle);
            })
            .catch(() => {});
        }
        throw error;
      }

      peer = createPeer(configuration);
      const peerOwner = peer;
      channel = peer.createDataChannel(APPLICATION_TRANSPORT_CHANNEL, {
        ordered: true,
      });
      const localChannel = channel;
      let wrongChannel = false;
      peer.ondatachannel = (event) => {
        wrongChannel = true;
        try {
          event.channel.close();
        } catch {
          /* already closed */
        }
      };
      const offer = await raceOwnedLifetime(peer.createOffer(), owned);
      await assertCurrent(authority, 'checkpoint', owned);
      await raceOwnedLifetime(peer.setLocalDescription(offer), owned);
      await assertCurrent(authority, 'checkpoint', owned);
      await waitForBrowserTransport(
        owned,
        (finish, fail) => {
          const changed = () => {
            if (peerOwner.iceGatheringState === 'complete') finish();
            else if (peerOwner.connectionState === 'failed') fail();
          };
          peerOwner.addEventListener('icegatheringstatechange', changed);
          peerOwner.addEventListener('connectionstatechange', changed);
          changed();
          return () => {
            peerOwner.removeEventListener('icegatheringstatechange', changed);
            peerOwner.removeEventListener('connectionstatechange', changed);
          };
        },
        10_000,
      );
      await assertCurrent(authority, 'checkpoint', owned);
      if (!peer.localDescription?.sdp)
        throw new Error('native_application_offer_unavailable');
      const offerSdp = peer.localDescription.sdp;
      const clientFingerprint = fingerprint(offerSdp);
      const activeHostPeer = hostPeer;
      const activePeerHandle = hostPeerHandle;
      if (!activeHostPeer || !activePeerHandle)
        throw new Error('native_application_peer_unavailable');
      const clientNonce = activeHostPeer.nonce;
      let expiresAt: number | undefined;
      try {
        expiresAt = await raceOwnedLifetime(
          signaling.open(activePeerHandle, offerSdp, owned),
          owned,
        );
      } catch (error) {
        if (!isErrorCode(error, 'native_application_peer_open_unknown'))
          throw error;
        // The host may have received the one open request even though its
        // response was lost. Keep this exact handle/nonce/offer and recover
        // with read; never submit a second offer.
      }
      if (
        expiresAt !== undefined &&
        (!Number.isSafeInteger(expiresAt) ||
          expiresAt <= now() ||
          expiresAt > activeHostPeer.expiresAt)
      )
        throw new Error('native_application_signal_expired');
      await assertCurrent(authority, 'checkpoint', owned);

      let answer: NativeApplicationPeerAnswer | undefined;
      while (!answer) {
        const value = validatePeerAnswer(
          await raceOwnedLifetime(
            signaling.read(activePeerHandle, owned),
            owned,
          ),
          activeHostPeer,
          expiresAt,
          now(),
        );
        expiresAt = Math.min(expiresAt ?? value.expiresAt, value.expiresAt);
        await assertCurrent(authority, 'checkpoint', owned);
        if (value.answerSdp !== null || value.stationProof !== null) {
          if (
            typeof value.answerSdp !== 'string' ||
            typeof value.stationProof !== 'string'
          )
            throw new Error('native_application_signal_invalid');
          answer = value;
        } else {
          if (now() + 100 >= expiresAt)
            throw new Error('native_application_signal_expired');
          const poll = composeOwnedSignal(owned, 1_000);
          try {
            await delayBrowserTransport(poll.signal, 100);
          } finally {
            poll.dispose();
          }
          await assertCurrent(authority, 'checkpoint', owned);
        }
      }

      const offerSha256 = await raceOwnedLifetime(
        connectionDescriptionDigest(offerSdp),
        owned,
      );
      await assertCurrent(authority, 'checkpoint', owned);
      const answerSha256 = await raceOwnedLifetime(
        connectionDescriptionDigest(answer.answerSdp!),
        owned,
      );
      await assertCurrent(authority, 'checkpoint', owned);
      const binding = {
        stationId: trust.stationId,
        enrollmentId: trust.enrollmentId,
        generation: trust.generation,
        connectionId: activeHostPeer.connectionId,
        clientNonce,
        clientFingerprint,
        stationFingerprint: fingerprint(answer.answerSdp!),
        offerSha256,
        answerSha256,
      };
      await assertCurrent(authority, 'checkpoint', owned);
      const verifier = createStationConnectionProofVerifier({
        trust,
        expected: binding,
        now: () => Math.floor(now() / 1000),
        isCurrent: () => trustOwner.isCurrent(authority),
      });
      await raceOwnedLifetime(
        verifier.verifyAndConsume(answer.stationProof!),
        owned,
      );
      await assertCurrent(authority, 'checkpoint', owned);
      verifier.assertStillCurrent();
      await assertCurrent(authority, 'before-remote-description', owned);
      verifier.assertStillCurrent();
      // The exact proof, nonce, identities, fingerprints and SDP digests have
      // all been checked before the untrusted answer reaches the WebRTC stack.
      await raceOwnedLifetime(
        peer.setRemoteDescription({ type: 'answer', sdp: answer.answerSdp! }),
        owned,
      );
      await assertCurrent(authority, 'checkpoint', owned);
      verifier.assertStillCurrent();

      await waitForBrowserTransport(
        owned,
        (finish, fail) => {
          const changed = () => {
            if (wrongChannel) fail();
            else if (peerOwner.connectionState === 'connected') finish();
            else if (
              peerOwner.connectionState === 'failed' ||
              peerOwner.connectionState === 'closed'
            )
              fail();
          };
          peerOwner.addEventListener('connectionstatechange', changed);
          changed();
          return () =>
            peerOwner.removeEventListener('connectionstatechange', changed);
        },
        15_000,
      );
      await assertCurrent(authority, 'checkpoint', owned);
      if (wrongChannel || localChannel.label !== APPLICATION_TRANSPORT_CHANNEL)
        throw new Error('native_application_channel_invalid');
      await waitForBrowserTransport(
        owned,
        (finish, fail) => {
          const opened = () => finish();
          const failed = () => fail();
          channel!.addEventListener('open', opened);
          channel!.addEventListener('error', failed);
          channel!.addEventListener('close', failed);
          if (channel!.readyState === 'open') finish();
          return () => {
            channel!.removeEventListener('open', opened);
            channel!.removeEventListener('error', failed);
            channel!.removeEventListener('close', failed);
          };
        },
        10_000,
      );
      await assertCurrent(authority, 'checkpoint', owned);
      if (
        localChannel.bufferedAmount > 1024 ||
        localChannel.readyState !== 'open'
      )
        throw new Error('native_application_channel_unavailable');
      // The adopted channel is the owned peer's application channel; closing
      // it must also release the peer.
      const adopted = browserApplicationChannel(localChannel);
      const assertBoundCurrent = () => {
        const latest = trustOwner.current();
        if (
          closed ||
          owned.aborted ||
          !latest ||
          !trustOwner.isCurrent(authority) ||
          !sameTrust(latest, authority)
        ) {
          close();
          throw new Error('native_application_trust_retired');
        }
      };
      completed = true;
      const applicationChannel: ApplicationChannel = {
        ...adopted,
        async prepareRequest(request) {
          assertBoundCurrent();
          request.signal.throwIfAborted();
          await assertCurrent(authority, 'checkpoint', request.signal);
          if (
            request.headers.has('authorization') ||
            request.headers.has('cookie') ||
            request.headers.has(NATIVE_DEVICE_PROOF_HEADER)
          )
            throw new Error('native_application_request_credential_conflict');
          if (
            request.method !== request.method.toUpperCase() ||
            !request.path.startsWith('/') ||
            new TextEncoder().encode(request.path).byteLength >
              NATIVE_APPLICATION_PATH_LIMIT_BYTES ||
            hasUnsafeRequestPathCharacter(request.path)
          )
            throw new Error('native_application_request_invalid');
          const body = request.body.slice();
          if (body.byteLength > NATIVE_APPLICATION_BODY_LIMIT_BYTES)
            throw new Error('native_application_request_too_large');
          const proof = await raceOwnedLifetime(
            signaling.sign(
              activeHostPeer.peerHandle,
              request.method,
              request.path,
              body,
              request.signal,
            ),
            request.signal,
          );
          request.signal.throwIfAborted();
          await assertCurrent(authority, 'checkpoint', request.signal);
          assertBoundCurrent();
          return [[NATIVE_DEVICE_PROOF_HEADER, validateRequestProof(proof)]];
        },
        send: (message: string) => {
          assertBoundCurrent();
          adopted.send(message);
        },
        subscribe: (message, onClosed) =>
          adopted.subscribe(
            (value) => {
              try {
                assertBoundCurrent();
                message(value);
              } catch {
                close();
                onClosed();
              }
            },
            () => {
              close();
              onClosed();
            },
          ),
        close: () => {
          adopted.close();
          close();
        },
      };
      return applicationChannel;
    } finally {
      if (!completed) close();
    }
  };

  const fetchApplication = createApplicationChannelFetch({
    origin: input.origin,
    signal: input.signal,
    open: openChannel,
    assertCurrent: async () => {
      const expected = trustOwner.current();
      if (!expected) throw new Error('native_application_trust_unavailable');
      await assertCurrent(expected, 'checkpoint');
    },
  });

  return Object.freeze({
    fetch: fetchApplication,
    openChannel,
  });
}
