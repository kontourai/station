import type { ApprovedStationConnectionTrust } from '@kontourai/station-contracts/connection-proof';
import type { NativeRelayLinkRoute } from '@kontourai/station-contracts/native-relay-link';
import type { SelfHostedBrokerNativeRouteInvitationV2 } from '@kontourai/station-contracts/self-hosted-broker';
import type { NativeSurfaceTuple } from './native-surface-registry.js';

/** Runtime-owned credential custody; operator routes receive only public routing facts. */
export interface RelayInvitationOwner {
  describe(signal: AbortSignal): Promise<{
    route: NativeRelayLinkRoute;
    trust: ApprovedStationConnectionTrust;
    routingGeneration: number;
  }>;
  prepare(value: unknown): Promise<NativeSurfaceTuple>;
  issueNativeInvitation(
    prepare: unknown,
    signal: AbortSignal,
    invitationTtlMs?: number | null,
  ): Promise<SelfHostedBrokerNativeRouteInvitationV2>;
}
