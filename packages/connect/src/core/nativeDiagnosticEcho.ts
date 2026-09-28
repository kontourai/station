import type {
  ApprovedStationConnectionTrust,
  StationConnectionProofBinding,
} from '@kontourai/station-contracts/connection-proof';
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
  composeOwnedSignal,
  delayBrowserTransport,
  raceOwnedLifetime,
  waitForBrowserTransport,
} from './browserTransportWait.js';

const SDP_LIMIT = 64 * 1024;
const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u;
const ECHO_CHANNEL = 'station-lab-v1';
const ECHO_BYTES = 32;

export interface NativeDiagnosticSignalOpen {
  readonly version: 'station-broker-native-connection-open/v2';
  readonly scope: SelfHostedBrokerNativeScopeV2;
  readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
  readonly nonce: string;
  readonly offerSdp: string;
}

export interface NativeDiagnosticSignalAnswer {
  readonly version: 'station-broker-native-connection-answer/v2';
  readonly expiresAt: number;
  readonly answerSdp: string | null;
  readonly stationProof: string | null;
}

/** Host bridge contract. It carries signaling only and owns its routing grant. */
export interface NativeDiagnosticSignaling {
  readonly scope: SelfHostedBrokerNativeScopeV2;
  readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
  open(input: NativeDiagnosticSignalOpen, signal: AbortSignal): Promise<number>;
  read(
    input: {
      readonly version: 'station-broker-native-connection-read/v2';
      readonly scope: SelfHostedBrokerNativeScopeV2;
      readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
      readonly nonce: string;
    },
    signal: AbortSignal,
  ): Promise<NativeDiagnosticSignalAnswer>;
}

export interface NativeDiagnosticEchoInput {
  readonly signaling: NativeDiagnosticSignaling;
  readonly trust: {
    current(): ApprovedStationConnectionTrust | null;
    isCurrent(value: ApprovedStationConnectionTrust): boolean;
    /**
     * Refresh persisted native trust through its authoritative owner (for
     * example station_native_relay_key_approval_status). The local sync check
     * alone cannot observe a revocation made by the native key owner.
     */
    recheck(
      value: ApprovedStationConnectionTrust,
      stage: 'checkpoint' | 'before-remote-description',
    ): Promise<boolean>;
  };
  readonly createPeer?: (configuration: RTCConfiguration) => RTCPeerConnection;
  readonly configuration?: RTCConfiguration;
  readonly now?: () => number;
}

function fingerprint(sdp: string) {
  if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > SDP_LIMIT)
    throw new Error('native_diagnostic_sdp_invalid');
  const values = [...sdp.matchAll(/^a=fingerprint:sha-256 (.+)$/gm)].map(
    (match) => match[1]!.trim(),
  );
  const distinct = [...new Set(values)];
  if (distinct.length !== 1 || !FINGERPRINT.test(distinct[0]!))
    throw new Error('native_diagnostic_fingerprint_invalid');
  return distinct[0]!;
}

function base64url(value: Uint8Array) {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function nonce() {
  if (!globalThis.crypto?.getRandomValues)
    throw new Error('native_diagnostic_secure_context_required');
  const bytes = new Uint8Array(ECHO_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return base64url(bytes);
}

function sameTrust(
  left: ApprovedStationConnectionTrust,
  right: ApprovedStationConnectionTrust,
) {
  return (
    left.stationId === right.stationId &&
    left.enrollmentId === right.enrollmentId &&
    left.generation === right.generation &&
    JSON.stringify(left.signingKey) === JSON.stringify(right.signingKey)
  );
}

/**
 * One-shot, opt-in native diagnostic handshake. This never creates an
 * application channel and returns only after the station-lab-v1 echo matches.
 */
export function createNativeDiagnosticEchoClient(
  input: NativeDiagnosticEchoInput,
) {
  const signaling = input.signaling;
  const trustOwner = input.trust;
  const createPeer =
    input.createPeer ??
    ((configuration: RTCConfiguration) => new RTCPeerConnection(configuration));
  const configuration = structuredClone(input.configuration ?? {});
  const now = input.now ?? Date.now;

  return Object.freeze({
    async run(
      signal: AbortSignal,
    ): Promise<{ stationId: string; echoed: true }> {
      const lifetime = composeOwnedSignal(signal, 45_000);
      const owned = lifetime.signal;
      let peer: RTCPeerConnection | undefined;
      let channel: RTCDataChannel | undefined;
      const close = () => {
        try {
          channel?.close();
        } catch {
          /* already closed */
        }
        try {
          peer?.close();
        } catch {
          /* already closed */
        }
      };
      owned.addEventListener('abort', close, { once: true });
      const assertCurrent = async (
        expected: ApprovedStationConnectionTrust,
        stage: 'checkpoint' | 'before-remote-description' = 'checkpoint',
      ) => {
        owned.throwIfAborted();
        const valid = trustOwner.isCurrent(expected);
        if (!valid) throw new Error('native_diagnostic_trust_retired');
        const current = trustOwner.current();
        if (!current || !sameTrust(current, expected))
          throw new Error('native_diagnostic_trust_retired');
        const authoritative = await raceOwnedLifetime(
          trustOwner.recheck(expected, stage),
          owned,
        );
        owned.throwIfAborted();
        const authoritativeCurrent = trustOwner.current();
        if (
          authoritative !== true ||
          !trustOwner.isCurrent(expected) ||
          !authoritativeCurrent ||
          !sameTrust(authoritativeCurrent, expected)
        )
          throw new Error('native_diagnostic_trust_retired');
      };
      try {
        const captured = trustOwner.current();
        if (!captured) throw new Error('native_diagnostic_trust_unavailable');
        const authority = captured;
        const trust = copyStationConnectionTrust(captured);
        const scope = structuredClone(signaling.scope);
        const surface = structuredClone(signaling.surface);
        if (
          scope.stationId !== trust.stationId ||
          scope.enrollmentId !== trust.enrollmentId ||
          surface.kind !== 'station-native'
        )
          throw new Error('native_diagnostic_trust_mismatch');
        await assertCurrent(authority);

        peer = createPeer(configuration);
        const peerOwner = peer;
        channel = peer.createDataChannel(ECHO_CHANNEL, { ordered: true });
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
        const clientId = surface.clientInstanceId;
        if (typeof clientId !== 'string' || !clientId)
          throw new Error('native_diagnostic_surface_invalid');
        const clientNonce = nonce();
        const offer = await raceOwnedLifetime(peer.createOffer(), owned);
        await assertCurrent(authority);
        await raceOwnedLifetime(peer.setLocalDescription(offer), owned);
        await assertCurrent(authority);
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
        await assertCurrent(authority);
        if (!peer.localDescription?.sdp)
          throw new Error('native_diagnostic_offer_unavailable');
        const offerSdp = peer.localDescription.sdp;
        fingerprint(offerSdp);
        await assertCurrent(authority);
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
          throw new Error('native_diagnostic_signal_expired');
        await assertCurrent(authority);

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
          await assertCurrent(authority);
          if (
            value.version !== 'station-broker-native-connection-answer/v2' ||
            value.expiresAt !== expiresAt
          )
            throw new Error('native_diagnostic_signal_invalid');
          if (value.answerSdp !== null || value.stationProof !== null) {
            if (
              typeof value.answerSdp !== 'string' ||
              typeof value.stationProof !== 'string'
            )
              throw new Error('native_diagnostic_signal_invalid');
            answer = value;
          } else {
            if (now() + 100 >= expiresAt)
              throw new Error('native_diagnostic_signal_expired');
            const poll = composeOwnedSignal(owned, 1_000);
            try {
              await delayBrowserTransport(poll.signal, 100);
            } finally {
              poll.dispose();
            }
            await assertCurrent(authority);
          }
        }

        const offerSha256 = await raceOwnedLifetime(
          connectionDescriptionDigest(offerSdp),
          owned,
        );
        await assertCurrent(authority);
        const answerSha256 = await raceOwnedLifetime(
          connectionDescriptionDigest(answer.answerSdp!),
          owned,
        );
        await assertCurrent(authority);
        const binding: StationConnectionProofBinding = {
          stationId: trust.stationId,
          enrollmentId: trust.enrollmentId,
          generation: trust.generation,
          connectionId: clientId,
          clientNonce,
          clientFingerprint: fingerprint(offerSdp),
          stationFingerprint: fingerprint(answer.answerSdp!),
          offerSha256,
          answerSha256,
        };
        await assertCurrent(authority);
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
        await assertCurrent(authority);
        verifier.assertStillCurrent();
        // Proof, nonce, identities, fingerprints and exact SDP digests have all
        // been checked before the untrusted answer reaches the WebRTC stack.
        await assertCurrent(authority, 'before-remote-description');
        verifier.assertStillCurrent();
        await raceOwnedLifetime(
          peer.setRemoteDescription({ type: 'answer', sdp: answer.answerSdp! }),
          owned,
        );
        await assertCurrent(authority);
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
        await assertCurrent(authority);
        if (wrongChannel || localChannel.label !== ECHO_CHANNEL)
          throw new Error('native_diagnostic_channel_invalid');
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
        await assertCurrent(authority);
        if (channel.bufferedAmount > 1024 || channel.readyState !== 'open')
          throw new Error('native_diagnostic_echo_unavailable');
        const echo = base64url(
          globalThis.crypto.getRandomValues(new Uint8Array(ECHO_BYTES)),
        );
        const echoWaitController = new AbortController();
        const abortEchoWait = () =>
          echoWaitController.abort(
            owned.reason ?? new Error('native_diagnostic_retired'),
          );
        owned.addEventListener('abort', abortEchoWait, { once: true });
        const echoResult = waitForBrowserTransport(
          echoWaitController.signal,
          (finish, fail) => {
            const message = (event: MessageEvent) => {
              if (typeof event.data !== 'string' || event.data.length > 128)
                fail();
              else if (event.data === echo) finish();
              else fail();
            };
            channel!.addEventListener('message', message);
            channel!.addEventListener('error', fail);
            channel!.addEventListener('close', fail);
            return () => {
              channel!.removeEventListener('message', message);
              channel!.removeEventListener('error', fail);
              channel!.removeEventListener('close', fail);
            };
          },
          5_000,
        );
        try {
          try {
            channel.send(echo);
          } catch (error) {
            echoWaitController.abort(error);
            await echoResult.catch(() => {});
            throw error;
          }
          await echoResult;
        } finally {
          owned.removeEventListener('abort', abortEchoWait);
        }
        await assertCurrent(authority);
        verifier.assertStillCurrent();
        return { stationId: trust.stationId, echoed: true };
      } finally {
        owned.removeEventListener('abort', close);
        close();
        lifetime.dispose();
      }
    },
  });
}
