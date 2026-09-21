import {
  type ApplicationChannel,
  serveApplicationChannel,
} from '@kontourai/station-connect/application-channel';
import type {
  ApprovedStationConnectionTrust,
  StationConnectionProofBinding,
} from '@kontourai/station-contracts/connection-proof';
import type { SelfHostedBrokerScopeV1 } from '@kontourai/station-contracts/self-hosted-broker';
import {
  connectionDescriptionDigest,
  createStationConnectionProofVerifier,
} from '@kontourai/station-shared/connection-proof';
import { startPionApplicationAdapter } from '../../services/connections/pion-application-adapter.js';
import { SelfHostedBrokerClient } from '../../services/connections/self-hosted-broker-client.js';
import { SelfHostedBrokerConnector } from '../../services/connections/self-hosted-broker-connector.js';
import type { BrokerCredential } from '../../services/connections/self-hosted-broker-service.js';
import type { VirtualApplication } from '../../services/connections/virtual-application.js';
import { SelfHostedBrokerRuntime } from './self-hosted-broker-runtime.js';

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
  turn: { url: string; username: string; password: string };
  trust: {
    current(): ApprovedStationConnectionTrust | null;
    isCurrent(value: ApprovedStationConnectionTrust): boolean;
  };
  issuer: { issue(binding: StationConnectionProofBinding): Promise<string> };
  heartbeatMs: number;
  renewMs: number;
  pollMs: number;
  maxPeerLifetimeMs: number;
  maxPeers: number;
}
export interface SelfHostedBrokerPionRuntimeDependencies {
  startAdapter: typeof startPionApplicationAdapter;
}

type Adapter = Awaited<ReturnType<typeof startPionApplicationAdapter>>;
interface PeerEntry {
  adapter: Adapter;
  /** This peer's captured descriptor — never the latest global trust. */
  descriptor: ApprovedStationConnectionTrust;
  /** Confirmed resource cleanup (adapter-owned receipt settled). */
  cleanupConfirmed: boolean;
  cleanupError?: unknown;
  operationalError?: unknown;
  serverCloses: Set<() => void>;
  retireTask?: Promise<void>;
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
  const turn = Object.freeze(structuredClone(input.turn));
  const trustOwner = input.trust;
  const issuerOwner = input.issuer;
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

  // Request dispatch gated against the peer's captured descriptor (outgoing
  // application-data direction alongside the channel send/subscribe gates).
  function gatedFetchFor(entry: PeerEntry): VirtualApplication {
    return Object.freeze({
      signal: applicationSignal,
      fetch: async (request: Request) => {
        if (!trustOwner.isCurrent(entry.descriptor)) {
          retirePeer(entry);
          return Response.json(
            { error: { code: 'broker_trust_retired' } },
            { status: 503, headers: { 'Cache-Control': 'no-store' } },
          );
        }
        return applicationFetch(request);
      },
    });
  }

  async function closeAndConfirm(entry: PeerEntry): Promise<void> {
    await retireTaskFor(entry);
  }

  const client = new SelfHostedBrokerClient(brokerOrigin, scope, credential);
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
        adapter = await dependencies.startAdapter({
          executable,
          profile: 'application',
          applicationChannelLabel: 'station-application-v1',
          offer: { type: 'offer', sdp: offer.offerSdp },
          certificatePem,
          privateKeyPem,
          turn,
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
          maxLifetimeMs: maxPeerLifetimeMs,
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
  );
  const lifecycle = {
    register: (signal: AbortSignal) => connector.register(signal),
    renew: (signal: AbortSignal) => connector.renew(signal),
    poll: (signal: AbortSignal) => connector.poll(signal),
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
  });
}
