import {
  type ApplicationChannel,
  serveApplicationChannel,
} from '@kontourai/station-connect/application-channel';
import type {
  ApprovedStationConnectionTrust,
  StationConnectionProofBinding,
} from '@kontourai/station-contracts/connection-proof';
import {
  STATION_ENVELOPE_HEADER,
  STATION_ENVELOPE_HEADER_VALUE,
} from '@kontourai/station-contracts/http';
import type {
  SelfHostedBrokerNativeClientSurfaceV2,
  SelfHostedBrokerScopeV1,
} from '@kontourai/station-contracts/self-hosted-broker';
import {
  connectionDescriptionDigest,
  createStationConnectionProofVerifier,
} from '@kontourai/station-shared/connection-proof';
import type { NativeSurfaceRegistry } from '../../services/connections/native-surface-registry.js';
import {
  createNativeV2PionApplicationAdapter,
  createResolvedNativeV2PionApplicationAdapter,
} from '../../services/connections/native-v2-pion-application-adapter.js';
import { startPionApplicationAdapter } from '../../services/connections/pion-application-adapter.js';
import {
  capturePionTurn,
  type PionTurnSource,
} from '../../services/connections/relay-ice-consumer.js';
import { SelfHostedBrokerClient } from '../../services/connections/self-hosted-broker-client.js';
import type {
  BrokerNativeOfferAdapter,
  BrokerNativeOfferResolver,
} from '../../services/connections/self-hosted-broker-connector.js';
import { SelfHostedBrokerConnector } from '../../services/connections/self-hosted-broker-connector.js';
import type { BrokerCredential } from '../../services/connections/self-hosted-broker-service.js';
import type {
  VerifiedPionApplicationRequestFacts,
  VirtualApplication,
} from '../../services/connections/virtual-application.js';
import type { ConnectionKeyCandidateIssuer } from '../../services/ssh/connection-key-candidate-issuer.js';
import {
  SelfHostedBrokerRuntime,
  type SelfHostedBrokerStatus,
} from './self-hosted-broker-runtime.js';

function fingerprint(sdp: string) {
  const values = [...sdp.matchAll(/^a=fingerprint:sha-256 (.+)$/gm)].map(
    (match) => match[1]!.trim(),
  );
  // Canonical SDP may repeat one identical fingerprint per m-section;
  // repeated identical values are permitted, any mismatch is refused.
  const distinct = [...new Set(values)];
  if (
    distinct.length !== 1 ||
    !/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(distinct[0]!)
  )
    throw new Error('broker_runtime_fingerprint_invalid');
  return distinct[0]!;
}

function sameDescriptor(
  left: ApprovedStationConnectionTrust,
  right: ApprovedStationConnectionTrust,
): boolean {
  return (
    left.stationId === right.stationId &&
    left.enrollmentId === right.enrollmentId &&
    left.generation === right.generation &&
    JSON.stringify(left.signingKey) === JSON.stringify(right.signingKey)
  );
}

export interface SelfHostedBrokerPionRuntimeInput {
  brokerOrigin: string;
  applicationOrigin: string;
  scope: SelfHostedBrokerScopeV1;
  connectorCredential: BrokerCredential;
  executable: string;
  certificatePem: string;
  privateKeyPem: string;
  turn:
    | { url: string; username: string; password: string }
    | { source: 'broker' };
  trust: {
    current(): ApprovedStationConnectionTrust | null;
    isCurrent(value: ApprovedStationConnectionTrust): boolean;
  };
  issuer: { issue(binding: StationConnectionProofBinding): Promise<string> };
  candidateIssuer?: ConnectionKeyCandidateIssuer;
  heartbeatMs: number;
  renewMs: number;
  pollMs: number;
  maxPeerLifetimeMs: number;
  maxPeers: number;
  /** Explicit opt-in native application lane; absent means never composed,
   * never polled, and no native offers are ever answered. */
  native?: {
    surface?: SelfHostedBrokerNativeClientSurfaceV2;
    registry?: NativeSurfaceRegistry;
    /** Live owned native peer ceiling; default 4, hard-capped at 32. */
    maxPeers?: number;
  };
  observeStatus?: (status: SelfHostedBrokerStatus) => void;
}
export interface SelfHostedBrokerPionRuntimeDependencies {
  startAdapter: typeof startPionApplicationAdapter;
  createNativeAdapter?: typeof createNativeV2PionApplicationAdapter;
}

type Adapter = Awaited<ReturnType<typeof startPionApplicationAdapter>>;
interface PeerEntry {
  adapter: Adapter;
  /** This peer's captured descriptor — never the latest global trust. */
  descriptor: ApprovedStationConnectionTrust;
  connectionId: string;
  /** Bound to this authenticated broker offer, never the connector's legacy Origin. */
  browserOrigin: string;
  readonly lifetime: AbortController;
  /** Confirmed resource cleanup (adapter-owned receipt settled). */
  cleanupConfirmed: boolean;
  cleanupError?: unknown;
  operationalError?: unknown;
  serverCloses: Set<() => void>;
  retireTask?: Promise<void>;
}

const verifiedPionRequests = new WeakMap<
  Request,
  VerifiedPionApplicationRequestFacts
>();

/** Read-only side of the Pion peer's per-Request provenance marker. */
export function readVerifiedPionApplicationRequest(
  request: Request,
): VerifiedPionApplicationRequestFacts | undefined {
  return verifiedPionRequests.get(request);
}

export function createSelfHostedBrokerPionRuntime(
  input: SelfHostedBrokerPionRuntimeInput,
  application: VirtualApplication,
  dependencies: SelfHostedBrokerPionRuntimeDependencies = {
    startAdapter: startPionApplicationAdapter,
  },
) {
  if (
    !Number.isSafeInteger(input.maxPeers) ||
    input.maxPeers < 1 ||
    input.maxPeers > 32
  )
    throw new Error('broker_runtime_peer_limit_invalid');
  // Snapshot ALL scalar config and owner references up front; closures below
  // read only these locals, never the mutable input object.
  const brokerOrigin = input.brokerOrigin;
  const applicationOrigin = input.applicationOrigin;
  const scope = Object.freeze(structuredClone(input.scope));
  const credential = Object.freeze(structuredClone(input.connectorCredential));
  const executable = input.executable;
  const certificatePem = input.certificatePem;
  const privateKeyPem = input.privateKeyPem;
  const configuredTurn = Object.freeze(structuredClone(input.turn));
  const trustOwner = input.trust;
  const issuerOwner = input.issuer;
  const candidateIssuer = input.candidateIssuer;
  const heartbeatMs = input.heartbeatMs;
  const renewMs = input.renewMs;
  const pollMs = input.pollMs;
  const maxPeerLifetimeMs = input.maxPeerLifetimeMs;
  const maxPeers = input.maxPeers;
  const applicationSignal = application.signal;
  const applicationFetch = application.fetch.bind(application);

  const peers = new Map<Adapter, PeerEntry>();
  // One reservation owner per admission attempt: in-flight claims plus live
  // entries bound capacity; exactly-once release, never negative.
  let claims = 0;
  function liveCount(): number {
    return peers.size + claims;
  }
  function tryClaim(): (() => void) | null {
    if (liveCount() >= maxPeers) return null;
    claims += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        claims -= 1;
      }
    };
  }

  // Single retirement owner per peer: server handlers are closed exactly
  // once, then the adapter-owned cleanupComplete receipt settles. Memoized
  // so duplicate retirePeer calls (trust gates, withdraw, natural
  // completion) join one close/join task instead of launching duplicates.
  // Rejects on unconfirmed cleanup; only confirmed peers release capacity.
  function retireTaskFor(entry: PeerEntry): Promise<void> {
    if (!entry.lifetime.signal.aborted)
      entry.lifetime.abort(new Error('broker_runtime_peer_retired'));
    entry.retireTask ??= Promise.resolve().then(async () => {
      for (const closeServer of [...entry.serverCloses]) {
        entry.serverCloses.delete(closeServer);
        try {
          closeServer();
        } catch {
          // Server closure is best-effort; adapter close below owns cleanup.
        }
      }
      try {
        await entry.adapter.close();
      } catch (error) {
        entry.operationalError ??= error;
        // Operational aborts may reject close() after resource cleanup
        // already completed: join the adapter-owned receipt, never guess.
      }
      try {
        await entry.adapter.cleanupComplete;
        entry.cleanupConfirmed = true;
        peers.delete(entry.adapter);
      } catch (error) {
        entry.cleanupError = error;
        throw error;
      }
    });
    return entry.retireTask;
  }

  function retirePeer(entry: PeerEntry): void {
    void retireTaskFor(entry).then(undefined, () => {
      // Failure evidence stays on the retained entry; never cleared.
    });
  }

  function gateChannelFor(
    entry: PeerEntry,
    raw: ApplicationChannel,
    onClosed: () => void,
  ): ApplicationChannel {
    const stale = (): boolean => {
      if (!trustOwner.isCurrent(entry.descriptor)) {
        retirePeer(entry);
        return true;
      }
      return false;
    };
    return {
      send(message: string): void {
        if (stale()) throw new Error('broker_runtime_trust_retired');
        raw.send(message);
      },
      close(): void {
        onClosed();
        raw.close();
      },
      subscribe(
        message: (value: unknown) => void,
        closed: () => void,
      ): () => void {
        return raw.subscribe(
          (value: unknown) => {
            // Incoming frames gated against THIS peer's captured descriptor:
            // a rotated trust retires the old peer instead of delivering.
            if (stale()) return;
            message(value);
          },
          () => {
            try {
              onClosed();
            } finally {
              closed();
            }
          },
        );
      },
    };
  }

  // These refusals are written outside the Hono app, so the runtime's marker
  // middleware never sees them; they carry the marker themselves (#2842).
  const OWN_REFUSAL_HEADERS = Object.freeze({
    'Cache-Control': 'no-store',
    [STATION_ENVELOPE_HEADER]: STATION_ENVELOPE_HEADER_VALUE,
  });

  // Request dispatch gated against the peer's captured descriptor (outgoing
  // application-data direction alongside the channel send/subscribe gates).
  function gatedFetchFor(entry: PeerEntry): VirtualApplication {
    return Object.freeze({
      signal: applicationSignal,
      fetch: async (request: Request) => {
        if (
          entry.lifetime.signal.aborted ||
          applicationSignal.aborted ||
          !trustOwner.isCurrent(entry.descriptor)
        ) {
          retirePeer(entry);
          return Response.json(
            { error: { code: 'broker_trust_retired' } },
            { status: 503, headers: OWN_REFUSAL_HEADERS },
          );
        }
        if (
          request.signal.aborted ||
          new URL(request.url).origin !== applicationOrigin ||
          request.headers.get('origin') !== entry.browserOrigin
        )
          return Response.json(
            { error: { code: 'broker_application_origin_forbidden' } },
            { status: 403, headers: OWN_REFUSAL_HEADERS },
          );
        verifiedPionRequests.set(
          request,
          Object.freeze({
            stationId: entry.descriptor.stationId,
            connectionEnrollmentId: entry.descriptor.enrollmentId,
            routingGeneration: entry.descriptor.generation,
            connectionId: entry.connectionId,
            stationOrigin: applicationOrigin,
            browserOrigin: entry.browserOrigin,
            signal: entry.lifetime.signal,
            isCurrent: () =>
              !entry.lifetime.signal.aborted &&
              !applicationSignal.aborted &&
              trustOwner.isCurrent(entry.descriptor),
          }),
        );
        return applicationFetch(request);
      },
    });
  }

  async function closeAndConfirm(entry: PeerEntry): Promise<void> {
    await retireTaskFor(entry);
  }

  // Explicit opt-in native application lane. Composition happens exactly
  // once against the SAME VirtualApplication, trust owner, and issuer as the
  // browser path; there is no separate authority and no fabricated Origin.
  const client = new SelfHostedBrokerClient(brokerOrigin, scope, credential);
  const turn: PionTurnSource =
    'source' in configuredTurn
      ? Object.freeze({
          source: 'broker' as const,
          capture: (signal: AbortSignal) => client.iceConfiguration(signal),
        })
      : configuredTurn;
  const nativeConfig = input.native;
  let nativeOwned:
    | ReturnType<typeof createNativeV2PionApplicationAdapter>
    | ReturnType<typeof createResolvedNativeV2PionApplicationAdapter>
    | null = null;
  let nativeMaxPeers = 0;
  let nativeClaims = 0;
  let closeNative: (() => Promise<void>) | undefined;
  if (nativeConfig) {
    nativeMaxPeers = nativeConfig.maxPeers ?? 4;
    if (
      !Number.isSafeInteger(nativeMaxPeers) ||
      nativeMaxPeers < 1 ||
      nativeMaxPeers > 32
    )
      throw new Error('broker_runtime_native_peer_limit_invalid');
    const createNativeAdapter =
      dependencies.createNativeAdapter ?? createNativeV2PionApplicationAdapter;
    const adapterInput = {
      applicationOrigin,
      application,
      executable,
      certificatePem,
      privateKeyPem,
      turn,
      trust: trustOwner,
      issuer: issuerOwner,
    };
    if (nativeConfig.registry) {
      nativeOwned = createResolvedNativeV2PionApplicationAdapter(
        { ...adapterInput, registry: nativeConfig.registry },
        {
          startAdapter: dependencies.startAdapter,
          serve: serveApplicationChannel,
        },
      );
    } else {
      if (!nativeConfig.surface)
        throw new Error('broker_runtime_native_surface_missing');
      nativeOwned = createNativeAdapter({
        ...adapterInput,
        surface: nativeConfig.surface,
      });
    }
    closeNative = async () => {
      await nativeOwned!.close();
      nativeConfig.registry?.close();
    };
  }
  // Capacity-wrapped native adapter: a live owned native peer (plus in-flight
  // admissions) counts against the explicit ceiling; at capacity the runtime
  // simply does not poll the native lane, so offers are left queued for a
  // later tick instead of failing the whole broker lifecycle.
  let nativeAdapter:
    | BrokerNativeOfferAdapter
    | BrokerNativeOfferResolver
    | undefined;
  if (nativeOwned) {
    const ownedAdapter = nativeOwned.adapter;
    const capacity = () => {
      if (nativeOwned!.activePeerCount + nativeClaims >= nativeMaxPeers)
        throw new Error('broker_runtime_native_peer_capacity');
    };
    if ('approvedSurfaces' in ownedAdapter) {
      nativeAdapter = {
        approvedSurfaces: () => ownedAdapter.approvedSurfaces(),
        answer: async (offer, approved, signal, admission) => {
          capacity();
          nativeClaims++;
          try {
            return await ownedAdapter.answer(
              offer,
              approved,
              signal,
              admission,
            );
          } finally {
            nativeClaims--;
          }
        },
      };
    } else {
      nativeAdapter = {
        surface: ownedAdapter.surface,
        answer: async (
          offer: Parameters<BrokerNativeOfferAdapter['answer']>[0],
          approved: ApprovedStationConnectionTrust,
          signal: AbortSignal,
        ) => {
          capacity();
          nativeClaims++;
          try {
            return await ownedAdapter.answer(offer, approved, signal);
          } finally {
            nativeClaims--;
          }
        },
      };
    }
  }

  const connector = new SelfHostedBrokerConnector(
    scope,
    client,
    trustOwner,
    async (offer, trust, signal) => {
      // Capture the exact descriptor from its owner; the connector-passed
      // object may be a fresh clone, so compare semantically, never by
      // reference identity.
      const exact = trustOwner.current();
      if (!exact || !trustOwner.isCurrent(exact))
        throw new Error('broker_runtime_trust_retired');
      if (!trustOwner.isCurrent(trust) || !sameDescriptor(trust, exact))
        throw new Error('broker_runtime_trust_retired');
      const captured: ApprovedStationConnectionTrust = Object.freeze(
        structuredClone(exact),
      );
      const releaseClaim = tryClaim();
      if (!releaseClaim) throw new Error('broker_runtime_peer_capacity');
      let adapter: Adapter | undefined;
      // Entry published at admission; channels opening mid-handshake resolve
      // through this pending slot so they are gated, never served ungated.
      let pendingEntry: PeerEntry | null = null;
      try {
        signal.throwIfAborted();
        if (!trustOwner.isCurrent(captured))
          throw new Error('broker_runtime_trust_retired');
        const peerTurn = await capturePionTurn(
          turn,
          scope,
          signal,
          maxPeerLifetimeMs,
        );
        signal.throwIfAborted();
        if (!trustOwner.isCurrent(captured))
          throw new Error('broker_runtime_trust_retired');
        adapter = await dependencies.startAdapter({
          executable,
          profile: 'application',
          applicationChannelLabel: 'station-application-v1',
          offer: { type: 'offer', sdp: offer.offerSdp },
          certificatePem,
          privateKeyPem,
          ...peerTurn,
          accept: (channel) => {
            const current: Adapter | undefined = adapter;
            const entry =
              (current !== undefined ? peers.get(current) : undefined) ??
              (pendingEntry?.adapter === current ? pendingEntry : undefined);
            // No entry (should not happen): close without admitting rather
            // than serving ungated.
            if (!entry || entry.retireTask) {
              channel.close();
              return;
            }
            // Closed-channel ownership: the wrapped `closed` below removes
            // this handler from the set, so only live handlers are retained.
            // A channel that closes synchronously during subscription never
            // enters the set, and retire drains each handler exactly once
            // (Set.delete before invoke defeats reentrant double-close).
            let closeServer: (() => void) | undefined;
            let channelClosed = false;
            const onChannelClosed = () => {
              channelClosed = true;
              if (closeServer !== undefined)
                entry.serverCloses.delete(closeServer);
            };
            closeServer = serveApplicationChannel(
              gateChannelFor(entry, channel, onChannelClosed),
              applicationOrigin,
              gatedFetchFor(entry),
            );
            if (channelClosed) {
              try {
                closeServer();
              } catch {
                // Best-effort; adapter close owns cleanup.
              }
              return;
            }
            if (entry.serverCloses.size >= 32) {
              // Bound simultaneous handlers consistently with the adapter
              // per-peer channel ceiling (32): refuse the newest, never grow.
              try {
                closeServer();
              } catch {
                // Best-effort; adapter close owns cleanup.
              }
              return;
            }
            entry.serverCloses.add(closeServer);
          },
          signal,
        });
        if (!trustOwner.isCurrent(captured))
          throw new Error('broker_runtime_trust_retired');
        signal.throwIfAborted();
        const binding: StationConnectionProofBinding = {
          stationId: captured.stationId,
          enrollmentId: captured.enrollmentId,
          generation: captured.generation,
          connectionId: offer.clientId,
          clientNonce: offer.nonce,
          clientFingerprint: fingerprint(offer.offerSdp),
          stationFingerprint: fingerprint(adapter.answer.sdp),
          offerSha256: await connectionDescriptionDigest(offer.offerSdp),
          answerSha256: await connectionDescriptionDigest(adapter.answer.sdp),
        };
        if (!trustOwner.isCurrent(captured))
          throw new Error('broker_runtime_trust_retired');
        signal.throwIfAborted();
        const stationProof = await issuerOwner.issue(binding);
        if (!trustOwner.isCurrent(captured))
          throw new Error('broker_runtime_trust_retired');
        signal.throwIfAborted();
        // Calling the issuer is not verification: cryptographically verify
        // the issued proof against the captured descriptor and exact binding
        // with the existing verifier before publishing.
        const verifier = createStationConnectionProofVerifier({
          trust: captured,
          expected: binding,
          isCurrent: () => trustOwner.isCurrent(captured),
        });
        await verifier.verifyAndConsume(stationProof);
        verifier.assertStillCurrent();
        // Publish: convert the claim into a live entry exactly once.
        const entry: PeerEntry = {
          adapter,
          descriptor: captured,
          connectionId: offer.clientId,
          browserOrigin: offer.browserOrigin,
          lifetime: new AbortController(),
          cleanupConfirmed: false,
          serverCloses: new Set(),
        };
        pendingEntry = entry;
        peers.set(adapter, entry);
        pendingEntry = null;
        releaseClaim();
        // Observe adapter completion so idle-expired peers are reaped and stop
        // poisoning capacity; unconfirmed cleanups retain evidence in place.
        // Natural completion retires through the same memoized task so
        // server handlers are drained exactly once, never double-closed.
        void adapter.cleanupComplete.then(
          () => {
            void retireTaskFor(entry).then(undefined, () => {});
          },
          (error: unknown) => {
            entry.cleanupError = error;
          },
        );
        const dispose = async () => {
          await closeAndConfirm(entry);
          peers.delete(adapter!);
        };
        return {
          answerSdp: adapter.answer.sdp,
          stationProof,
          dispose,
        };
      } catch (error) {
        releaseClaim();
        pendingEntry = null;
        if (adapter) {
          // Failed publish must not leak capacity: confirm cleanup, and on
          // unconfirmed cleanup retain the entry with evidence.
          const entry: PeerEntry = {
            adapter,
            descriptor: captured,
            connectionId: offer.clientId,
            browserOrigin: offer.browserOrigin,
            lifetime: new AbortController(),
            cleanupConfirmed: false,
            serverCloses: new Set(),
          };
          try {
            await closeAndConfirm(entry);
          } catch (cleanupError) {
            entry.cleanupError = cleanupError;
            peers.set(adapter, entry);
            throw new AggregateError(
              [error, cleanupError],
              'broker_runtime_admission_cleanup_failed',
            );
          }
        }
        throw error;
      }
    },
    // Fifth argument: the explicit native offer adapter, present only under
    // opt-in configuration; without it the connector refuses the native lane.
    nativeAdapter,
  );
  const lifecycle = {
    register: (signal: AbortSignal) => connector.register(signal),
    renew: (signal: AbortSignal) => connector.renew(signal),
    poll: async (signal: AbortSignal) => {
      if (candidateIssuer)
        await connector.pollNativeKeyCandidates(candidateIssuer, signal);
      return connector.poll(signal);
    },
    // The native lane exists only under explicit opt-in configuration: with
    // no native config the lifecycle has no pollNative at all, so the bounded
    // runtime loop never requests, answers, or dispatches a native offer.
    ...(nativeAdapter
      ? {
          pollNative: async (signal: AbortSignal) => {
            // At native capacity, skip this tick: leave offers queued rather
            // than answering beyond the owned-peer ceiling (and never crowd
            // the shared admission slot with an offer that cannot be served).
            if (nativeOwned!.activePeerCount + nativeClaims >= nativeMaxPeers)
              return { observed: 0, answered: 0 };
            try {
              return await connector.pollNative(signal);
            } catch (error) {
              // Capacity can also be reached mid-loop while the connector
              // drains its offer queue. The wrapper refuses BEFORE any peer
              // is started, so there is nothing to dispose: treat it as
              // backpressure for this tick instead of failing the broker.
              if (
                error instanceof Error &&
                error.message === 'broker_runtime_native_peer_capacity'
              )
                return { observed: 0, answered: 0 };
              throw error;
            }
          },
        }
      : {}),
    withdraw: async (signal: AbortSignal) => {
      let withdrawError: unknown;
      let withdrawFailed = false;
      try {
        await connector.withdraw(signal);
      } catch (error) {
        withdrawError = error;
        withdrawFailed = true;
      }
      // Lost withdraw reply must still attempt all peer cleanup. Confirmed
      // entries are released; unconfirmed ones are RETAINED with evidence,
      // never cleared, so ownership is never lost.
      const errors: unknown[] = withdrawFailed ? [withdrawError] : [];
      for (const entry of [...peers.values()]) {
        try {
          await closeAndConfirm(entry);
          peers.delete(entry.adapter);
        } catch (error) {
          entry.cleanupError = error;
          errors.push(error);
        }
      }
      // Join owned native peers exactly once: the adapter's own close
      // retires every live/retiring native peer and awaits its confirmed
      // cleanup receipts, so shutdown cannot strand an opt-in native peer.
      if (closeNative) {
        try {
          await closeNative();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 1)
        throw new AggregateError(errors, 'broker_runtime_peer_cleanup_failed');
      if (errors.length === 1) throw errors[0];
    },
  };
  return new SelfHostedBrokerRuntime({
    origin: applicationOrigin,
    configuredOrigin: scope.browserOrigin,
    application,
    connector: lifecycle,
    heartbeatMs,
    renewMs,
    pollMs,
    nativeOfferPolling: nativeAdapter !== undefined,
    observeStatus: input.observeStatus,
  });
}
