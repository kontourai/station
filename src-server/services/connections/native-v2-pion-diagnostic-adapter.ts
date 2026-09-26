import type {
  ApprovedStationConnectionTrust,
  StationConnectionProofBinding,
} from '@kontourai/station-contracts/connection-proof';
import type {
  SelfHostedBrokerNativeClientSurfaceV2,
  SelfHostedBrokerNativeConnectionOfferV2,
} from '@kontourai/station-contracts/self-hosted-broker';
import {
  connectionDescriptionDigest,
  createStationConnectionProofVerifier,
  stationConnectionSigningKeyId,
} from '@kontourai/station-shared/connection-proof';
import {
  type PionApplicationAdapterInput,
  startPionApplicationAdapter,
} from './pion-application-adapter.js';
import type { BrokerNativeOfferAdapter } from './self-hosted-broker-connector.js';

// The signed proof contract bounds each exact SDP digest input at 64 KiB.
const SDP_LIMIT = 64 * 1024;
const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const PROOF_NONCE = /^[A-Za-z0-9_-]{43}$/;

function fingerprint(sdp: string) {
  const values = [...sdp.matchAll(/^a=fingerprint:sha-256 (.+)$/gm)].map(
    (match) => match[1]!.trim(),
  );
  const distinct = [...new Set(values)];
  if (distinct.length !== 1 || !FINGERPRINT.test(distinct[0]!))
    throw new Error('native_pion_diagnostic_fingerprint_invalid');
  return distinct[0]!;
}

function sameSurface(
  left: SelfHostedBrokerNativeClientSurfaceV2,
  right: SelfHostedBrokerNativeClientSurfaceV2,
) {
  return (
    left.kind === right.kind &&
    left.appIdentifier === right.appIdentifier &&
    left.channel === right.channel &&
    left.clientInstanceId === right.clientInstanceId &&
    left.keyThumbprint === right.keyThumbprint
  );
}

function sameDescriptor(
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

type DiagnosticPeer = Awaited<ReturnType<typeof startPionApplicationAdapter>>;

export interface NativeV2PionDiagnosticAdapterInput {
  surface: SelfHostedBrokerNativeClientSurfaceV2;
  executable: string;
  certificatePem: string;
  privateKeyPem: string;
  turn: PionApplicationAdapterInput['turn'];
  trust: {
    current(): ApprovedStationConnectionTrust | null;
    isCurrent(value: ApprovedStationConnectionTrust): boolean;
  };
  issuer: {
    issue(binding: StationConnectionProofBinding): Promise<string>;
  };
}

export interface NativeV2PionDiagnosticAdapterDependencies {
  startAdapter: typeof startPionApplicationAdapter;
}

/**
 * Explicit v2 diagnosticEcho adapter. It answers one native offer with Pion's
 * bounded echo channel and a Station proof; it never dispatches application
 * requests or selects the application's DataChannel label.
 */
export function createNativeV2PionDiagnosticAdapter(
  input: NativeV2PionDiagnosticAdapterInput,
  dependencies: NativeV2PionDiagnosticAdapterDependencies = {
    startAdapter: startPionApplicationAdapter,
  },
) {
  const surface = Object.freeze(structuredClone(input.surface));
  const executable = input.executable;
  const certificatePem = input.certificatePem;
  const privateKeyPem = input.privateKeyPem;
  const turn = Object.freeze(structuredClone(input.turn));
  const trustOwner = input.trust;
  const issuerOwner = input.issuer;
  const peers = new Set<DiagnosticPeer>();
  const retirements = new Map<DiagnosticPeer, Promise<void>>();
  const lifetime = new AbortController();
  let closed = false;

  const assertCurrent = (
    expected: ApprovedStationConnectionTrust,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    lifetime.signal.throwIfAborted();
    if (closed || !trustOwner.isCurrent(expected))
      throw new Error('native_pion_diagnostic_trust_retired');
  };

  const adapter: BrokerNativeOfferAdapter = Object.freeze({
    surface,
    answer: async (
      offer: SelfHostedBrokerNativeConnectionOfferV2,
      approved: ApprovedStationConnectionTrust,
      signal: AbortSignal,
    ) => {
      if (
        closed ||
        offer.version !== 'station-broker-native-connection-offer/v2' ||
        !sameSurface(offer.surface, surface) ||
        offer.clientId !== surface.clientInstanceId ||
        offer.scope.stationId !== approved.stationId ||
        offer.scope.enrollmentId !== approved.enrollmentId ||
        offer.stationSigningGeneration !== approved.generation ||
        typeof offer.nonce !== 'string' ||
        !PROOF_NONCE.test(offer.nonce) ||
        !Number.isSafeInteger(offer.expiresAt) ||
        offer.expiresAt <= Date.now() ||
        typeof offer.offerSdp !== 'string' ||
        offer.offerSdp.length === 0 ||
        Buffer.byteLength(offer.offerSdp) > SDP_LIMIT
      )
        throw new Error('native_pion_diagnostic_offer_invalid');

      const captured = trustOwner.current();
      if (
        !captured ||
        !sameDescriptor(captured, approved) ||
        !trustOwner.isCurrent(approved)
      )
        throw new Error('native_pion_diagnostic_trust_unavailable');
      const clientFingerprint = fingerprint(offer.offerSdp);
      const controller = new AbortController();
      const abortFromCaller = () => controller.abort(signal.reason);
      const abortFromOwner = () => controller.abort(lifetime.signal.reason);
      signal.addEventListener('abort', abortFromCaller, { once: true });
      lifetime.signal.addEventListener('abort', abortFromOwner, { once: true });
      if (signal.aborted) abortFromCaller();
      if (lifetime.signal.aborted) abortFromOwner();
      let peer: DiagnosticPeer | undefined;
      let disposed = false;
      const dispose = async () => {
        if (disposed) return;
        disposed = true;
        controller.abort(new Error('native_pion_diagnostic_peer_retired'));
        signal.removeEventListener('abort', abortFromCaller);
        lifetime.signal.removeEventListener('abort', abortFromOwner);
        if (peer) {
          await retirePeer(peer);
        }
      };

      try {
        assertCurrent(captured, controller.signal);
        const stationSigningKeyId =
          await stationConnectionSigningKeyId(captured);
        assertCurrent(captured, controller.signal);
        if (
          offer.stationSigningKeyId !== stationSigningKeyId ||
          offer.stationSigningGeneration !== captured.generation
        )
          throw new Error('native_pion_diagnostic_station_binding_mismatch');

        peer = await dependencies.startAdapter({
          executable,
          profile: 'diagnosticEcho',
          offer: { type: 'offer', sdp: offer.offerSdp },
          certificatePem,
          privateKeyPem,
          turn,
          accept: () => {
            throw new Error(
              'native_pion_diagnostic_application_channel_forbidden',
            );
          },
          signal: controller.signal,
          maxLifetimeMs: 90_000,
        });
        peers.add(peer);
        void peer.cleanupComplete.then(
          () => peers.delete(peer!),
          () => {},
        );
        assertCurrent(captured, controller.signal);

        const offerSha256 = await connectionDescriptionDigest(offer.offerSdp);
        assertCurrent(captured, controller.signal);
        const answerSha256 = await connectionDescriptionDigest(peer.answer.sdp);
        assertCurrent(captured, controller.signal);
        const binding: StationConnectionProofBinding = {
          stationId: captured.stationId,
          enrollmentId: captured.enrollmentId,
          generation: captured.generation,
          connectionId: offer.clientId,
          clientNonce: offer.nonce,
          clientFingerprint,
          stationFingerprint: fingerprint(peer.answer.sdp),
          offerSha256,
          answerSha256,
        };
        const stationProof = await issuerOwner.issue(binding);
        assertCurrent(captured, controller.signal);
        const verifier = createStationConnectionProofVerifier({
          trust: captured,
          expected: binding,
          isCurrent: () => trustOwner.isCurrent(captured),
        });
        await verifier.verifyAndConsume(stationProof);
        assertCurrent(captured, controller.signal);
        return {
          answerSdp: peer.answer.sdp,
          stationProof,
          dispose,
        };
      } catch (error) {
        try {
          await dispose();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'native_pion_diagnostic_cleanup_failed',
          );
        }
        throw error;
      }
    },
  });

  return {
    adapter,
    get activePeerCount() {
      return peers.size;
    },
    async close() {
      if (!closed) {
        closed = true;
        lifetime.abort(new Error('native_pion_diagnostic_adapter_closed'));
      }
      const errors: unknown[] = [];
      for (const peer of [...peers]) {
        try {
          await retirePeer(peer);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(errors, 'native_pion_diagnostic_close_failed');
    },
  };

  async function retirePeer(peer: DiagnosticPeer) {
    const existing = retirements.get(peer);
    if (existing) return await existing;
    const task = (async () => {
      let closeError: unknown;
      try {
        await peer.close();
      } catch (error) {
        closeError = error;
      }
      try {
        await peer.cleanupComplete;
        peers.delete(peer);
      } catch (cleanupError) {
        throw closeError === undefined
          ? cleanupError
          : new AggregateError(
              [closeError, cleanupError],
              'native_pion_diagnostic_cleanup_failed',
            );
      }
      if (closeError !== undefined) throw closeError;
    })();
    retirements.set(peer, task);
    try {
      await task;
    } catch (error) {
      retirements.delete(peer);
      throw error;
    }
  }
}
