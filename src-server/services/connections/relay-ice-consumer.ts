import { parseRelayIceConfiguration } from '@kontourai/station-connect/relay-ice';
import type { RelayIceConfigurationV1 } from '@kontourai/station-contracts/relay-ice';
import type { SelfHostedBrokerNativeScopeV2 } from '@kontourai/station-contracts/self-hosted-broker';
import type { PionApplicationAdapterInput } from './pion-application-adapter.js';

export type PionTurnSource =
  | PionApplicationAdapterInput['turn']
  | {
      readonly source: 'broker';
      capture(signal: AbortSignal): Promise<RelayIceConfigurationV1>;
    };

/** Per-offer capture; provider credentials never extend the peer's deadline. */
export async function capturePionTurn(
  source: PionTurnSource,
  scope: SelfHostedBrokerNativeScopeV2,
  signal: AbortSignal,
  maxLifetimeMs: number,
): Promise<Pick<PionApplicationAdapterInput, 'turn' | 'maxLifetimeMs'>> {
  signal.throwIfAborted();
  if (!('source' in source))
    return { turn: structuredClone(source), maxLifetimeMs };
  const raw = await source.capture(signal);
  signal.throwIfAborted();
  const receipt = parseRelayIceConfiguration(raw, {
    scope: {
      stationId: scope.stationId,
      enrollmentId: scope.enrollmentId,
      routingGeneration: scope.routingGeneration,
    },
  });
  const remaining = receipt.expiresAt - Date.now() - 5000;
  if (remaining < 1000) throw new Error('broker_ice_peer_lifetime_uncovered');
  const candidates = receipt.iceServers.flatMap((server) =>
    server.urls.map((url) => ({
      url,
      username: server.username,
      password: server.credential,
    })),
  );
  const turn =
    candidates.find((server) =>
      /^turns:[^?]+:443\?transport=tcp$/u.test(server.url),
    ) ??
    candidates.find((server) => server.url.startsWith('turns:')) ??
    candidates[0];
  if (!turn) throw new Error('broker_ice_unavailable');
  return {
    turn: Object.freeze({ ...turn }),
    maxLifetimeMs: Math.min(maxLifetimeMs, remaining),
  };
}
