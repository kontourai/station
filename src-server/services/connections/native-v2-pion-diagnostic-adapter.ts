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
interface DiagnosticOperation {
  readonly controller: AbortController;
  readonly startupComplete: Promise<void>;
  cancel(reason: unknown): void;
  peer?: DiagnosticPeer;
  retirement?: Promise<void>;
}

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
  const retiredPeers = new WeakSet<DiagnosticPeer>();
  const peerSignals = new WeakMap<DiagnosticPeer, AbortSignal>();
  const operations = new Set<DiagnosticOperation>();
  let closed = false;
  let closeTask: Promise<void> | undefined;

  const assertCurrent = (
    expected: ApprovedStationConnectionTrust,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
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
      let finishStartup!: () => void;
      const startupComplete = new Promise<void>((resolve) => {
        finishStartup = resolve;
      });
      let cancellation: unknown;
      const operation: DiagnosticOperation = {
        controller,
        startupComplete,
        cancel: (reason) => {
          if (cancellation !== undefined) return;
          cancellation = reason;
          if (operation.peer) {
            operation.retirement = retirePeer(operation.peer);
            void operation.retirement.catch(() => {});
          } else {
            controller.abort(reason);
          }
        },
      };
      operations.add(operation);
      const abortFromCaller = () => operation.cancel(signal.reason);
      signal.addEventListener('abort', abortFromCaller, { once: true });
      if (signal.aborted) abortFromCaller();
      let peer: DiagnosticPeer | undefined;
      let disposed = false;
      const dispose = async () => {
        if (disposed) return;
        disposed = true;
        operation.cancel(new Error('native_pion_diagnostic_peer_retired'));
        signal.removeEventListener('abort', abortFromCaller);
        if (peer) {
          operation.retirement ??= retirePeer(peer);
          await operation.retirement;
        }
      };
      const assertOperationCurrent = () => {
        if (cancellation !== undefined) throw cancellation;
        assertCurrent(captured, controller.signal);
      };

      try {
        assertOperationCurrent();
        const stationSigningKeyId =
          await stationConnectionSigningKeyId(captured);
        assertOperationCurrent();
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
        operation.peer = peer;
        peers.add(peer);
        peerSignals.set(peer, controller.signal);
        finishStartup();
        void peer.cleanupComplete.then(
          () => peers.delete(peer!),
          () => {},
        );
        assertOperationCurrent();

        const offerSha256 = await connectionDescriptionDigest(offer.offerSdp);
        assertOperationCurrent();
        const answerSha256 = await connectionDescriptionDigest(peer.answer.sdp);
        assertOperationCurrent();
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
        assertOperationCurrent();
        const verifier = createStationConnectionProofVerifier({
          trust: captured,
          expected: binding,
          isCurrent: () => trustOwner.isCurrent(captured),
        });
        await verifier.verifyAndConsume(stationProof);
        assertOperationCurrent();
        return {
          answerSdp: peer.answer.sdp,
          stationProof,
          dispose,
        };
      } catch (error) {
        finishStartup();
        try {
          await dispose();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'native_pion_diagnostic_cleanup_failed',
          );
        }
        throw error;
      } finally {
        signal.removeEventListener('abort', abortFromCaller);
        operations.delete(operation);
      }
    },
  });

  return {
    adapter,
    get activePeerCount() {
      return peers.size;
    },
    get retiringPeerCount() {
      return retirements.size;
    },
    close() {
      if (!closeTask) {
        closeTask = (async () => {
          closed = true;
          const pending = [...operations];
          const reason = new Error('native_pion_diagnostic_adapter_closed');
          for (const operation of pending) operation.cancel(reason);
          await Promise.all(
            pending.map((operation) => operation.startupComplete),
          );
          const errors: unknown[] = [];
          for (const operation of pending) {
            if (!operation.retirement) continue;
            try {
              await operation.retirement;
            } catch (error) {
              errors.push(error);
            }
          }
          for (const peer of [...peers]) {
            try {
              await retirePeer(peer);
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length)
            throw new AggregateError(
              errors,
              'native_pion_diagnostic_close_failed',
            );
        })();
      }
      return closeTask;
    },
  };

  async function retirePeer(peer: DiagnosticPeer) {
    const existing = retirements.get(peer);
    if (existing) return await existing;
    if (retiredPeers.has(peer)) return;
    const task = (async () => {
      let closeError: unknown;
      if (peerSignals.get(peer)?.aborted) {
        // Pion owns its abort listener and has already begun closing. Calling
        // close again would surface the expected abort as an operational
        // error, so join its cleanup receipt instead.
        await peer.cleanupComplete;
        peers.delete(peer);
        retiredPeers.add(peer);
        return;
      } else {
        try {
          await peer.close();
        } catch (error) {
          closeError = error;
        }
      }
      try {
        await peer.cleanupComplete;
        peers.delete(peer);
        retiredPeers.add(peer);
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
      retirements.delete(peer);
    } catch (error) {
      retirements.delete(peer);
      throw error;
    }
  }
}
