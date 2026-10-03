import type {
  SelfHostedBrokerNativeClientSurfaceV2,
  SelfHostedBrokerNativeScopeV2,
} from './self-hosted-broker.js';

export const RELAY_ICE_CONFIGURATION_VERSION =
  'station-relay-ice-configuration/v1' as const;
export const RELAY_ICE_MAX_TTL_SECONDS = 600;

/** End-user TURN credentials only; no issuer credential or application grant. */
export interface RelayIceServerV1 {
  readonly urls: readonly string[];
  readonly username: string;
  readonly credential: string;
}

export interface RelayIceConfigurationV1 {
  readonly version: typeof RELAY_ICE_CONFIGURATION_VERSION;
  readonly scope: SelfHostedBrokerNativeScopeV2;
  /** Present for an installation-scoped native routing grant. */
  readonly surface?: SelfHostedBrokerNativeClientSurfaceV2;
  readonly iceTransportPolicy: 'relay';
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly iceServers: readonly RelayIceServerV1[];
}
