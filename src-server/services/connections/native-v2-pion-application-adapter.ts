import {
  type ApplicationChannel,
  serveApplicationChannel,
} from '@kontourai/station-connect/application-channel';
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
import type {
  ApprovedNativeSurface,
  NativeSurfaceRegistry,
} from './native-surface-registry.js';
import { startPionApplicationAdapter } from './pion-application-adapter.js';
import { capturePionTurn, type PionTurnSource } from './relay-ice-consumer.js';
import type {
  BrokerNativeOfferAdapter,
  BrokerNativeOfferResolver,
} from './self-hosted-broker-connector.js';
import type {
  VerifiedNativePionApplicationRequestFacts,
  VirtualApplication,
} from './virtual-application.js';

const SDP_LIMIT = 64 * 1024;
const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const PROOF_NONCE = /^[A-Za-z0-9_-]{43}$/;
const APPLICATION_CHANNEL_LIMIT = 32;
const APP_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;
const CLIENT_INSTANCE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SURFACE_KEY_THUMBPRINT = /^[A-Za-z0-9_-]{43}$/;
const NATIVE_CHANNELS = new Set(['dev', 'stable', 'beta', 'nightly']);

/** Resolve only operator-approved surfaces; each peer retains its immutable approval. */
export function createResolvedNativeV2PionApplicationAdapter(
  input: Omit<NativeV2PionApplicationAdapterInput, 'surface'> & {
    registry: Pick<NativeSurfaceRegistry, 'approvedSurfaces'>;
  },
  dependencies?: NativeV2PionApplicationAdapterDependencies,
) {
  const owned = new Map<
    string,
    ReturnType<typeof createNativeV2PionApplicationAdapter>
  >();
  let closed = false;
  const currentAdmission = (
    admission: ApprovedNativeSurface,
    offer: SelfHostedBrokerNativeConnectionOfferV2,
  ) => {
    if (
      closed ||
      !admission.isCurrent() ||
      !sameSurface(admission.surface, offer.surface) ||
      admission.scope.stationId !== offer.scope.stationId ||
      admission.scope.enrollmentId !== offer.scope.enrollmentId ||
      admission.scope.routingGeneration !== offer.scope.routingGeneration
    )
      throw new Error('native_pion_application_surface_unapproved');
  };
  const adapter: BrokerNativeOfferResolver = Object.freeze({
    approvedSurfaces: () => (closed ? [] : input.registry.approvedSurfaces()),
    async answer(
      offer: SelfHostedBrokerNativeConnectionOfferV2,
      trust: ApprovedStationConnectionTrust,
      signal: AbortSignal,
      admission: ApprovedNativeSurface,
    ) {
      currentAdmission(admission, offer);
      let target = owned.get(admission.approvalId);
      if (!target) {
        if (owned.size >= 16)
          throw new Error('native_pion_application_surface_capacity');
        const captured = Object.freeze({
          ...admission,
          surface: Object.freeze({ ...admission.surface }),
          scope: Object.freeze({ ...admission.scope }),
        });
        target = createNativeV2PionApplicationAdapter(
          {
            ...input,
            surface: captured.surface,
            trust: {
              current: () =>
                !closed && captured.isCurrent() ? input.trust.current() : null,
              isCurrent: (value) =>
                !closed && captured.isCurrent() && input.trust.isCurrent(value),
            },
          },
          dependencies,
        );
        owned.set(admission.approvalId, target);
      }
      const result = await target.adapter.answer(offer, trust, signal);
      try {
        currentAdmission(admission, offer);
        return result;
      } catch (error) {
        await result.dispose();
        throw error;
      }
    },
  });
  return {
    adapter,
    get activePeerCount() {
      return [...owned.values()].reduce(
        (sum, value) => sum + value.activePeerCount,
        0,
      );
    },
    get retiringPeerCount() {
      return [...owned.values()].reduce(
        (sum, value) => sum + value.retiringPeerCount,
        0,
      );
    },
    async close() {
      closed = true;
      const results = await Promise.allSettled(
        [...owned.values()].map((value) => value.close()),
      );
      const errors = results.flatMap((value) =>
        value.status === 'rejected' ? [value.reason] : [],
      );
      if (errors.length)
        throw new AggregateError(
          errors,
          'native_pion_application_cleanup_failed',
        );
      owned.clear();
    },
  };
}

function fingerprint(sdp: string) {
  const values = [...sdp.matchAll(/^a=fingerprint:sha-256 (.+)$/gm)].map(
    (match) => match[1]!.trim(),
  );
  const distinct = [...new Set(values)];
  if (distinct.length !== 1 || !FINGERPRINT.test(distinct[0]!))
    throw new Error('native_pion_application_fingerprint_invalid');
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

const verifiedNativeRequests = new WeakMap<
  Request,
  VerifiedNativePionApplicationRequestFacts
>();

/** Read-only per-Request proof that this request came from one admitted native peer. */
export function readVerifiedNativePionApplicationRequest(
  request: Request,
): VerifiedNativePionApplicationRequestFacts | undefined {
  const facts = verifiedNativeRequests.get(request);
  if (
    !facts ||
    request.signal.aborted ||
    facts.signal.aborted ||
    !facts.isCurrent() ||
    request.headers.has('origin') ||
    new URL(request.url).origin !== facts.stationOrigin
  )
    return undefined;
  return facts;
}

interface NativeApplicationPeer {
  readonly peer: Awaited<ReturnType<typeof startPionApplicationAdapter>>;
  readonly controller: AbortController;
  readonly closeServers: Set<() => void>;
  readonly isCurrent: () => boolean;
  cancellation?: unknown;
  retirement?: Promise<void>;
}

interface NativeApplicationOperation {
  readonly controller: AbortController;
  readonly startupComplete: Promise<void>;
  cancel(reason: unknown): void;
  cancellation?: unknown;
  startupError?: unknown;
  peer?: NativeApplicationPeer;
  retirement?: Promise<void>;
}

export interface NativeV2PionApplicationAdapterInput {
  surface: SelfHostedBrokerNativeClientSurfaceV2;
  applicationOrigin: string;
  application: VirtualApplication;
  executable: string;
  certificatePem: string;
  privateKeyPem: string;
  turn: PionTurnSource;
  trust: {
    current(): ApprovedStationConnectionTrust | null;
    isCurrent(value: ApprovedStationConnectionTrust): boolean;
  };
  issuer: {
    issue(binding: StationConnectionProofBinding): Promise<string>;
  };
}

export interface NativeV2PionApplicationAdapterDependencies {
  startAdapter: typeof startPionApplicationAdapter;
  serve: typeof serveApplicationChannel;
}

/**
 * Explicit native-v2 application adapter. Creating it is an opt-in only; it is
 * not installed by StationRuntime. Each application Request is associated with
 * the exact admitted peer through a module-owned WeakMap before virtual ingress.
 */
export function createNativeV2PionApplicationAdapter(
  input: NativeV2PionApplicationAdapterInput,
  dependencies: NativeV2PionApplicationAdapterDependencies = {
    startAdapter: startPionApplicationAdapter,
    serve: serveApplicationChannel,
  },
) {
  const origin = new URL(input.applicationOrigin).origin;
  if (
    origin !== input.applicationOrigin ||
    !['http:', 'https:'].includes(new URL(origin).protocol)
  )
    throw new Error('native_pion_application_origin_invalid');
  if (input.application.signal.aborted)
    throw new Error('native_pion_application_unavailable');

  const surface = Object.freeze(structuredClone(input.surface));
  if (
    surface.kind !== 'station-native' ||
    !APP_IDENTIFIER.test(surface.appIdentifier) ||
    !NATIVE_CHANNELS.has(surface.channel) ||
    !CLIENT_INSTANCE_ID.test(surface.clientInstanceId) ||
    !SURFACE_KEY_THUMBPRINT.test(surface.keyThumbprint)
  )
    throw new Error('native_pion_application_surface_invalid');
  const application = input.application;
  const applicationFetch = application.fetch.bind(application);
  const executable = input.executable;
  const certificatePem = input.certificatePem;
  const privateKeyPem = input.privateKeyPem;
  const turn: PionTurnSource =
    'source' in input.turn
      ? Object.freeze({ source: 'broker', capture: input.turn.capture })
      : Object.freeze(structuredClone(input.turn));
  const trustOwner = input.trust;
  const issuerOwner = input.issuer;
  const peers = new Set<NativeApplicationPeer>();
  const retirements = new Map<NativeApplicationPeer, Promise<void>>();
  const retiredPeers = new WeakSet<NativeApplicationPeer>();
  const operations = new Set<NativeApplicationOperation>();
  let closed = false;
  let closeTask: Promise<void> | undefined;

  const retirePeer = async (entry: NativeApplicationPeer): Promise<void> => {
    const existing = retirements.get(entry);
    if (existing) return await existing;
    if (retiredPeers.has(entry)) return;
    const task = (async () => {
      for (const closeServer of [...entry.closeServers]) {
        entry.closeServers.delete(closeServer);
        try {
          closeServer();
        } catch {
          // Closing the peer below owns final cleanup.
        }
      }
      let closeError: unknown;
      if (entry.controller.signal.aborted) {
        await entry.peer.cleanupComplete;
      } else {
        try {
          await entry.peer.close();
        } catch (error) {
          closeError = error;
        }
        try {
          await entry.peer.cleanupComplete;
        } catch (cleanupError) {
          throw closeError === undefined
            ? cleanupError
            : new AggregateError(
                [closeError, cleanupError],
                'native_pion_application_cleanup_failed',
              );
        }
      }
      peers.delete(entry);
      retiredPeers.add(entry);
      if (closeError !== undefined) throw closeError;
    })();
    retirements.set(entry, task);
    try {
      await task;
      retirements.delete(entry);
    } catch (error) {
      retirements.delete(entry);
      throw error;
    }
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
        throw new Error('native_pion_application_offer_invalid');

      const captured = trustOwner.current();
      if (
        !captured ||
        !sameDescriptor(captured, approved) ||
        !trustOwner.isCurrent(approved)
      )
        throw new Error('native_pion_application_trust_unavailable');

      // Scalar is copied from the authenticated offer before any await; the
      // offer object itself is never retained for later reads.
      const peerNonce = offer.nonce;
      const clientFingerprint = fingerprint(offer.offerSdp);
      const routingGeneration = offer.scope.routingGeneration;
      const controller = new AbortController();
      let finishStartup!: () => void;
      const startupComplete = new Promise<void>((resolve) => {
        finishStartup = resolve;
      });
      const operation: NativeApplicationOperation = {
        controller,
        startupComplete,
        cancel: (reason) => {
          if (operation.cancellation !== undefined) return;
          operation.cancellation = reason;
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
      const abortFromApplication = () =>
        operation.cancel(application.signal.reason);
      let callerListenerRemoved = false;
      const removeCallerListener = () => {
        if (callerListenerRemoved) return;
        callerListenerRemoved = true;
        signal.removeEventListener('abort', abortFromCaller);
      };
      signal.addEventListener('abort', abortFromCaller, { once: true });
      application.signal.addEventListener('abort', abortFromApplication, {
        once: true,
      });
      if (signal.aborted) abortFromCaller();
      if (application.signal.aborted) abortFromApplication();
      let peer: NativeApplicationPeer | undefined;
      let admitted = false;
      let disposed = false;
      const assertCurrent = () => {
        if (operation.cancellation !== undefined) throw operation.cancellation;
        signal.throwIfAborted();
        controller.signal.throwIfAborted();
        if (closed || !trustOwner.isCurrent(captured))
          throw new Error('native_pion_application_trust_retired');
      };
      const dispose = async () => {
        if (disposed) return;
        disposed = true;
        operation.cancel(new Error('native_pion_application_peer_retired'));
        removeCallerListener();
        application.signal.removeEventListener('abort', abortFromApplication);
        if (peer) {
          operation.retirement ??= retirePeer(peer);
          await operation.retirement;
        }
      };
      const accept = (channel: ApplicationChannel) => {
        if (!admitted || !peer?.isCurrent()) {
          channel.close();
          return;
        }
        if (peer.closeServers.size >= APPLICATION_CHANNEL_LIMIT) {
          channel.close();
          return;
        }
        let closeServer: (() => void) | undefined;
        let channelClosed = false;
        const onClosed = () => {
          channelClosed = true;
          if (closeServer) peer!.closeServers.delete(closeServer);
        };
        const guardedChannel: ApplicationChannel = {
          send(message) {
            if (!peer!.isCurrent()) {
              void retirePeer(peer!).catch(() => {});
              throw new Error('native_pion_application_peer_retired');
            }
            channel.send(message);
          },
          close() {
            onClosed();
            channel.close();
          },
          subscribe(message, closedChannel) {
            return channel.subscribe(
              (value) => {
                if (!peer!.isCurrent()) {
                  void retirePeer(peer!).catch(() => {});
                  return;
                }
                message(value);
              },
              () => {
                try {
                  onClosed();
                } finally {
                  closedChannel();
                }
              },
            );
          },
        };
        const requestApplication: VirtualApplication = Object.freeze({
          signal: application.signal,
          fetch: async (request: Request) => {
            if (!peer!.isCurrent()) {
              void retirePeer(peer!).catch(() => {});
              return Response.json(
                { error: { code: 'native_application_peer_retired' } },
                { status: 403, headers: { 'Cache-Control': 'no-store' } },
              );
            }
            if (
              request.signal.aborted ||
              new URL(request.url).origin !== origin ||
              request.headers.has('origin')
            )
              return Response.json(
                { error: { code: 'native_application_request_invalid' } },
                { status: 403, headers: { 'Cache-Control': 'no-store' } },
              );
            verifiedNativeRequests.set(
              request,
              Object.freeze({
                peerNonce,
                stationId: captured.stationId,
                connectionEnrollmentId: captured.enrollmentId,
                routingGeneration,
                connectionId: offer.clientId,
                stationOrigin: origin,
                surface,
                signal: controller.signal,
                isCurrent: peer!.isCurrent,
              }),
            );
            return applicationFetch(request);
          },
        });
        closeServer = dependencies.serve(
          guardedChannel,
          origin,
          requestApplication,
        );
        if (channelClosed) {
          try {
            closeServer();
          } catch {
            // Peer retirement still owns process cleanup.
          }
          return;
        }
        peer.closeServers.add(closeServer);
      };

      try {
        assertCurrent();
        const signingKeyId = await stationConnectionSigningKeyId(captured);
        assertCurrent();
        if (
          offer.stationSigningKeyId !== signingKeyId ||
          offer.stationSigningGeneration !== captured.generation
        )
          throw new Error('native_pion_application_station_binding_mismatch');

        const peerTurn = await capturePionTurn(
          turn,
          offer.scope,
          controller.signal,
          90_000,
        );
        assertCurrent();
        const started = await dependencies.startAdapter({
          executable,
          profile: 'application',
          applicationChannelLabel: 'station-application-v1',
          offer: { type: 'offer', sdp: offer.offerSdp },
          certificatePem,
          privateKeyPem,
          ...peerTurn,
          accept,
          signal: controller.signal,
        });
        const entry: NativeApplicationPeer = {
          peer: started,
          controller,
          closeServers: new Set(),
          isCurrent: () =>
            admitted &&
            operation.cancellation === undefined &&
            !controller.signal.aborted &&
            !application.signal.aborted &&
            !closed &&
            trustOwner.isCurrent(captured),
        };
        peer = entry;
        operation.peer = entry;
        peers.add(entry);
        finishStartup();
        const settlePeer = (confirmed: boolean) => {
          admitted = false;
          if (!controller.signal.aborted)
            controller.abort(new Error('native_pion_application_peer_ended'));
          for (const closeServer of [...entry.closeServers]) {
            entry.closeServers.delete(closeServer);
            try {
              closeServer();
            } catch {
              // The cleanup receipt remains the resource owner.
            }
          }
          removeCallerListener();
          application.signal.removeEventListener('abort', abortFromApplication);
          if (confirmed) {
            peers.delete(entry);
            retiredPeers.add(entry);
          }
          // An unconfirmed cleanup stays in peers so close() reports its error.
        };
        void started.cleanupComplete.then(
          () => settlePeer(true),
          () => settlePeer(false),
        );
        assertCurrent();

        const offerSha256 = await connectionDescriptionDigest(offer.offerSdp);
        assertCurrent();
        const answerSha256 = await connectionDescriptionDigest(
          started.answer.sdp,
        );
        assertCurrent();
        const binding: StationConnectionProofBinding = {
          stationId: captured.stationId,
          enrollmentId: captured.enrollmentId,
          generation: captured.generation,
          connectionId: offer.clientId,
          clientNonce: offer.nonce,
          clientFingerprint,
          stationFingerprint: fingerprint(started.answer.sdp),
          offerSha256,
          answerSha256,
        };
        const stationProof = await issuerOwner.issue(binding);
        assertCurrent();
        const verifier = createStationConnectionProofVerifier({
          trust: captured,
          expected: binding,
          isCurrent: () => trustOwner.isCurrent(captured),
        });
        await verifier.verifyAndConsume(stationProof);
        verifier.assertStillCurrent();
        assertCurrent();
        // Application messages are served only after the exact proof verified.
        admitted = true;
        return {
          answerSdp: started.answer.sdp,
          stationProof,
          dispose,
        };
      } catch (error) {
        if (!peer) operation.startupError = error;
        finishStartup();
        try {
          await dispose();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'native_pion_application_cleanup_failed',
          );
        }
        throw error;
      } finally {
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
          const reason = new Error('native_pion_application_adapter_closed');
          for (const operation of pending) operation.cancel(reason);
          await Promise.all(
            pending.map((operation) => operation.startupComplete),
          );
          const errors: unknown[] = [];
          for (const operation of pending) {
            if (
              operation.startupError !== undefined &&
              operation.startupError !== operation.cancellation
            )
              errors.push(operation.startupError);
            if (operation.retirement) {
              try {
                await operation.retirement;
              } catch (error) {
                errors.push(error);
              }
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
              'native_pion_application_close_failed',
            );
        })();
      }
      return closeTask;
    },
  };
}
