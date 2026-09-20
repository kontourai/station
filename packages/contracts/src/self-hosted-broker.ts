/** Versioned routing metadata only; this contract carries no person or application authority. */
export interface SelfHostedBrokerScopeV1 {
  stationId: string;
  enrollmentId: string;
  routingGeneration: number;
  browserOrigin: string;
}
export interface SelfHostedBrokerConnectionOfferV1 {
  clientId: string;
  nonce: string;
  offerSdp: string;
  expiresAt: number;
}
export const SELF_HOSTED_BROKER_PROTOCOL_VERSION =
  'station-self-hosted-broker/v1' as const;
