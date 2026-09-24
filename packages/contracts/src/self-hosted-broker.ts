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

/** A native installation surface. This metadata is bound to a separately held P-256 proof key. */
export interface SelfHostedBrokerNativeClientSurfaceV2 {
  readonly kind: 'station-native';
  readonly appIdentifier: string;
  readonly channel: 'dev' | 'stable' | 'beta' | 'nightly';
  readonly clientInstanceId: string;
  readonly keyThumbprint: string;
}

/** Native routing scope deliberately has no browser Origin field. */
export interface SelfHostedBrokerNativeScopeV2 {
  readonly stationId: string;
  readonly enrollmentId: string;
  readonly routingGeneration: number;
}

/** A native invitation is routing-only and can be redeemed only by its bound proof key. */
export interface SelfHostedBrokerNativeRouteInvitationV2 {
  readonly version: 'station-broker-native-route-invitation/v2';
  readonly brokerOrigin: string;
  readonly scope: SelfHostedBrokerNativeScopeV2;
  readonly stationSigningKeyId: string;
  readonly stationSigningGeneration: number;
  readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
  readonly invitationId: string;
  readonly invitationSecret: string;
  readonly expiresAt: number;
}

/** Proof covers the exact invitation and surface using an ES256 compact JWS. */
export interface SelfHostedBrokerNativeRedemptionProofV2 {
  readonly publicKey: {
    readonly kty: 'EC';
    readonly crv: 'P-256';
    readonly x: string;
    readonly y: string;
  };
  readonly nonce: string;
  /** Compact ES256 JWS with typ `station-broker-native-redemption+jws`. */
  readonly jws: string;
}

/** Independently revocable native route grant; it carries no Station or app authority. */
export interface SelfHostedBrokerNativeClientGrantV2 {
  readonly version: 'station-broker-native-client-grant/v2';
  readonly brokerOrigin: string;
  readonly scope: SelfHostedBrokerNativeScopeV2;
  readonly stationSigningKeyId: string;
  readonly stationSigningGeneration: number;
  readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
  readonly proofPublicKey: SelfHostedBrokerNativeRedemptionProofV2['publicKey'];
  readonly credential: { readonly id: string; readonly secret: string };
  readonly expiresAt: number;
}

export const SELF_HOSTED_BROKER_INVITATION_VERSION =
  'station-broker-route-invitation/v1' as const;
export const SELF_HOSTED_BROKER_CLIENT_GRANT_VERSION =
  'station-broker-client-grant/v1' as const;
export const SELF_HOSTED_BROKER_PROTOCOL_VERSION =
  'station-self-hosted-broker/v1' as const;
export const SELF_HOSTED_BROKER_NATIVE_INVITATION_VERSION =
  'station-broker-native-route-invitation/v2' as const;
export const SELF_HOSTED_BROKER_NATIVE_CLIENT_GRANT_VERSION =
  'station-broker-native-client-grant/v2' as const;
