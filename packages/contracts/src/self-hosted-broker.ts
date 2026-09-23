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
  /** Authenticated routing grant Origin, or the legacy lease Origin. */
  browserOrigin: string;
}

/** A short-lived routing invitation. Its secret grants only one broker exchange. */
export interface SelfHostedBrokerRouteInvitationV1 {
  readonly version: 'station-broker-route-invitation/v1';
  readonly brokerOrigin: string;
  readonly scope: SelfHostedBrokerScopeV1;
  /** Must match a separately approved Station trust record before exchange. */
  readonly stationSigningKeyId: string;
  readonly stationSigningGeneration: number;
  readonly invitationId: string;
  readonly invitationSecret: string;
  readonly expiresAt: number;
}

/** Routing-only credential. Account, Device and Project authority remain separate. */
export interface SelfHostedBrokerClientGrantV1 {
  readonly version: 'station-broker-client-grant/v1';
  readonly brokerOrigin: string;
  readonly scope: SelfHostedBrokerScopeV1;
  readonly stationSigningKeyId: string;
  readonly stationSigningGeneration: number;
  readonly credential: { readonly id: string; readonly secret: string };
  readonly expiresAt: number;
}

export const SELF_HOSTED_BROKER_INVITATION_VERSION =
  'station-broker-route-invitation/v1' as const;
export const SELF_HOSTED_BROKER_CLIENT_GRANT_VERSION =
  'station-broker-client-grant/v1' as const;
export const SELF_HOSTED_BROKER_PROTOCOL_VERSION =
  'station-self-hosted-broker/v1' as const;
