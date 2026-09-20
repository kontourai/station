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
  const value = sdp.match(/^a=fingerprint:sha-256 (.+)$/m)?.[1]?.trim();
  if (!value) throw new Error('broker_runtime_fingerprint_missing');
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
}
export function createSelfHostedBrokerPionRuntime(
  input: SelfHostedBrokerPionRuntimeInput,
  application: VirtualApplication,
) {
  const client = new SelfHostedBrokerClient(
    input.brokerOrigin,
    input.scope,
    input.connectorCredential,
  );
  const connector = new SelfHostedBrokerConnector(
    input.scope,
    client,
    input.trust,
    async (offer, trust, signal) => {
      const adapter = await startPionApplicationAdapter({
        executable: input.executable,
        profile: 'application',
        applicationChannelLabel: 'station-application-v1',
        offer: { type: 'offer', sdp: offer.offerSdp },
        certificatePem: input.certificatePem,
        privateKeyPem: input.privateKeyPem,
        turn: input.turn,
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
        return {
          answerSdp: adapter.answer.sdp,
          stationProof: await input.issuer.issue(binding),
          dispose: adapter.close,
        };
      } catch (error) {
        await adapter.close();
        throw error;
      }
    },
  );
  return new SelfHostedBrokerRuntime({
    origin: input.applicationOrigin,
    configuredOrigin: input.scope.browserOrigin,
    application,
    connector,
    heartbeatMs: input.heartbeatMs,
    renewMs: input.renewMs,
    pollMs: input.pollMs,
  });
}
