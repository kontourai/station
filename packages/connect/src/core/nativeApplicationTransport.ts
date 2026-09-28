import type { ApprovedStationConnectionTrust } from '@kontourai/station-contracts/connection-proof';
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
import {
  fingerprint,
  randomNonce,
  sameTrust,
} from './nativeConnectionShared.js';
import type {
  NativeDiagnosticSignalAnswer,
  NativeDiagnosticSignaling,
} from './nativeDiagnosticEcho.js';

const NONCE_BYTES = 32;

/**
 * The only DataChannel label this client will ever open or adopt. Any other
 * label, including the diagnostic echo channel, is rejected and closed.
 */
export const APPLICATION_TRANSPORT_CHANNEL = 'station-application-v1';

/** Host bridge contract. It carries signaling only and owns its routing grant. */
export type NativeApplicationSignaling = NativeDiagnosticSignaling;

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
    let closed = false;
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
      const clientNonce = randomNonce(NONCE_BYTES);
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
      const expiresAt = await raceOwnedLifetime(
        signaling.open(
          {
            version: 'station-broker-native-connection-open/v2',
            scope,
            surface,
            nonce: clientNonce,
            offerSdp,
          },
          owned,
        ),
        owned,
      );
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= now())
        throw new Error('native_application_signal_expired');
      await assertCurrent(authority, 'checkpoint', owned);

      let answer: NativeDiagnosticSignalAnswer | undefined;
      while (!answer) {
        const value = await raceOwnedLifetime(
          signaling.read(
            {
              version: 'station-broker-native-connection-read/v2',
              scope,
              surface,
              nonce: clientNonce,
            },
            owned,
          ),
          owned,
        );
        await assertCurrent(authority, 'checkpoint', owned);
        if (
          value.version !== 'station-broker-native-connection-answer/v2' ||
          value.expiresAt !== expiresAt
        )
          throw new Error('native_application_signal_invalid');
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
        connectionId: clientId,
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
      return {
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
