import {
  type ApplicationChannel,
  createApplicationChannelFetch,
} from '@kontourai/station-connect/application-channel';
import type {
  ApprovedStationConnectionTrust,
  StationConnectionProofBinding,
} from '@kontourai/station-contracts/connection-proof';
import type { SelfHostedBrokerScopeV1 } from '@kontourai/station-contracts/self-hosted-broker';
import { createSelfHostedBrokerPionRuntime } from '../../src-server/runtime/bootstrap/self-hosted-broker-pion-runtime.js';
import { startPionApplicationAdapter } from '../../src-server/services/connections/pion-application-adapter.js';
import { startSelfHostedBrokerProcess } from './self-hosted-broker-process.js';

export interface SelfHostedBrokerLabInput {
  directory: string;
  browserOrigin: string;
  applicationOrigin: string;
  stationId: string;
  enrollmentId: string;
  routingGeneration?: number;
  heartbeatMs?: number;
  renewMs?: number;
  pollMs?: number;
  executable: string;
  certificatePem: string;
  privateKeyPem: string;
  turn: { url: string; username: string; password: string };
  trust: {
    current(): ApprovedStationConnectionTrust | null;
    isCurrent(value: ApprovedStationConnectionTrust): boolean;
  };
  issuer: { issue(binding: StationConnectionProofBinding): Promise<string> };
  openApplicationChannel: () =>
    | ApplicationChannel
    | Promise<ApplicationChannel>;
  signal: AbortSignal;
}

/** Run the actual broker CLI in its own process, with no Station application keys. */
export async function startSelfHostedBrokerLab(
  input: SelfHostedBrokerLabInput,
) {
  input.signal.throwIfAborted();
  const scope: SelfHostedBrokerScopeV1 = {
    stationId: input.stationId,
    enrollmentId: input.enrollmentId,
    routingGeneration: input.routingGeneration ?? 1,
    browserOrigin: input.browserOrigin,
  };
  const broker = await startSelfHostedBrokerProcess({
    directory: input.directory,
    scope,
    signal: input.signal,
  });
  const brokerOrigin = broker.brokerOrigin;
  let runtime: ReturnType<typeof createSelfHostedBrokerPionRuntime> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      const errors: unknown[] = [];
      try {
        await runtime?.shutdown();
      } catch (error) {
        errors.push(error);
      }
      try {
        await broker.stop();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length)
        throw new AggregateError(errors, 'Broker lab cleanup failed');
    })());
  try {
    input.signal.throwIfAborted();
    const adapterMetadata: Array<{
      provenance: Awaited<
        ReturnType<typeof startPionApplicationAdapter>
      >['provenance'];
      pair(): ReturnType<
        Awaited<
          ReturnType<typeof startPionApplicationAdapter>
        >['peer']['getSelectedCandidatePair']
      >;
    }> = [];
    const observingStart: typeof startPionApplicationAdapter = async (
      options,
    ) => {
      const adapter = await startPionApplicationAdapter(options);
      adapterMetadata.push({
        provenance: adapter.provenance,
        pair: () => adapter.peer.getSelectedCandidatePair(),
      });
      return adapter;
    };
    const channelFetch = createApplicationChannelFetch({
      origin: input.applicationOrigin,
      signal: input.signal,
      open: async () => input.openApplicationChannel(),
      assertCurrent: () => input.signal.throwIfAborted(),
    });
    runtime = createSelfHostedBrokerPionRuntime(
      {
        brokerOrigin,
        applicationOrigin: input.applicationOrigin,
        scope: broker.scope,
        connectorCredential: broker.bundle.connector,
        executable: input.executable,
        certificatePem: input.certificatePem,
        privateKeyPem: input.privateKeyPem,
        turn: input.turn,
        trust: input.trust,
        issuer: input.issuer,
        heartbeatMs: input.heartbeatMs ?? 5_000,
        renewMs: input.renewMs ?? 10_000,
        pollMs: input.pollMs ?? 1_000,
        maxPeerLifetimeMs: 300_000,
        maxPeers: 8,
      },
      {
        signal: input.signal,
        // Keep the Request's stream, abort signal and explicit headers intact.
        fetch: (request) => channelFetch(request),
      },
      { startAdapter: observingStart },
    );
    await runtime.start();
    return {
      brokerOrigin,
      scope: broker.scope,
      routing: { ...broker.bundle.routing },
      adapterMetadata,
      readLease: broker.readLease,
      preflight: broker.preflight,
      withdraw: () => runtime!.shutdown(),
      stop,
    };
  } catch (primary) {
    try {
      await stop();
    } catch (cleanup) {
      throw new AggregateError([primary, cleanup], 'Broker lab startup failed');
    }
    throw primary;
  }
}
