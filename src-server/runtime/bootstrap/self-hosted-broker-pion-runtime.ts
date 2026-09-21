import { serveApplicationChannel } from '@kontourai/station-connect/application-channel';
import type {
  ApprovedStationConnectionTrust,
  StationConnectionProofBinding,
} from '@kontourai/station-contracts/connection-proof';
import type { SelfHostedBrokerScopeV1 } from '@kontourai/station-contracts/self-hosted-broker';
import { connectionDescriptionDigest } from '@kontourai/station-shared/connection-proof';
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
  if (
    values.length !== 1 ||
    !/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(values[0]!)
  )
    throw new Error('broker_runtime_fingerprint_invalid');
  const value = values[0]!;
  return value;
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
  const scope = Object.freeze(structuredClone(input.scope));
  const credential = Object.freeze(structuredClone(input.connectorCredential));
  const turn = Object.freeze(structuredClone(input.turn));
  const peers = new Set<
    Awaited<ReturnType<typeof startPionApplicationAdapter>>
  >();
  const client = new SelfHostedBrokerClient(
    input.brokerOrigin,
    scope,
    credential,
  );
  const connector = new SelfHostedBrokerConnector(
    scope,
    client,
    input.trust,
    async (offer, trust, signal) => {
      if (peers.size >= input.maxPeers)
        throw new Error('broker_runtime_peer_capacity');
      const adapter = await dependencies.startAdapter({
        executable: input.executable,
        profile: 'application',
        applicationChannelLabel: 'station-application-v1',
        offer: { type: 'offer', sdp: offer.offerSdp },
        certificatePem: input.certificatePem,
        privateKeyPem: input.privateKeyPem,
        turn,
        accept: (channel) =>
          serveApplicationChannel(
            channel,
            input.applicationOrigin,
            application,
          ),
        signal,
        maxLifetimeMs: input.maxPeerLifetimeMs,
      });
      try {
        const binding: StationConnectionProofBinding = {
          stationId: trust.stationId,
          enrollmentId: trust.enrollmentId,
          generation: trust.generation,
          connectionId: offer.clientId,
          clientNonce: offer.nonce,
          clientFingerprint: fingerprint(offer.offerSdp),
          stationFingerprint: fingerprint(adapter.answer.sdp),
          offerSha256: await connectionDescriptionDigest(offer.offerSdp),
          answerSha256: await connectionDescriptionDigest(adapter.answer.sdp),
        };
        peers.add(adapter);
        const dispose = async () => {
          peers.delete(adapter);
          await adapter.close();
        };
        return {
          answerSdp: adapter.answer.sdp,
          stationProof: await input.issuer.issue(binding),
          dispose,
        };
      } catch (error) {
        await adapter.close();
        throw error;
      }
    },
  );
  const lifecycle = {
    register: (signal: AbortSignal) => connector.register(signal),
    renew: (signal: AbortSignal) => connector.renew(signal),
    poll: (signal: AbortSignal) => connector.poll(signal),
    withdraw: async (signal: AbortSignal) => {
      await connector.withdraw(signal);
      const results = await Promise.allSettled(
        [...peers].map((peer) => peer.close()),
      );
      peers.clear();
      const failed = results.filter((result) => result.status === 'rejected');
      if (failed.length)
        throw new AggregateError(
          failed.map((result) => (result as PromiseRejectedResult).reason),
          'broker_runtime_peer_cleanup_failed',
        );
    },
  };
  return new SelfHostedBrokerRuntime({
    origin: input.applicationOrigin,
    configuredOrigin: input.scope.browserOrigin,
    application,
    connector: lifecycle,
    heartbeatMs: input.heartbeatMs,
    renewMs: input.renewMs,
    pollMs: input.pollMs,
  });
}
