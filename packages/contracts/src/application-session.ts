import type { PrincipalRef } from './principal.js';
import type { SelfHostedBrokerNativeClientSurfaceV2 } from './self-hosted-broker.js';

export const APPLICATION_SESSION_VERSION =
  'station.application-session/v1' as const;
export const ACCOUNT_AUTHENTICATION_FAILURE_HEADER =
  'X-Station-Authentication-Failure' as const;
export const APPLICATION_SESSION_BASE_PATH =
  '/api/account-auth/continuations' as const;
export const APPLICATION_SESSION_HEADER =
  'X-Station-Account-Continuation' as const;
export const APPLICATION_SESSION_PROOF_HEADER =
  'X-Station-Account-Proof' as const;
export const APPLICATION_SESSION_PROOF_TYPE =
  'station.application-session+jwt' as const;
export const APPLICATION_SESSION_NATIVE_VERSION =
  'station.application-session-native/v1' as const;
export const APPLICATION_SESSION_NATIVE_PROOF_TYPE =
  'station.application-session-native+jwt' as const;
export const APPLICATION_SESSION_NATIVE_BASE_PATH =
  `${APPLICATION_SESSION_BASE_PATH}/native` as const;
export const APPLICATION_SESSION_NATIVE_CHALLENGE_PATH =
  `${APPLICATION_SESSION_NATIVE_BASE_PATH}/challenge` as const;
export const APPLICATION_SESSION_NATIVE_EXCHANGE_PATH =
  `${APPLICATION_SESSION_NATIVE_BASE_PATH}/exchange` as const;
export const APPLICATION_SESSION_NATIVE_REVOKE_PATH =
  `${APPLICATION_SESSION_NATIVE_BASE_PATH}/revoke` as const;
export interface NativeApplicationSessionRevocation {
  readonly revoked: true;
}
export const APPLICATION_SESSION_NATIVE_HEADER =
  'X-Station-Native-Account-Continuation' as const;
export const APPLICATION_SESSION_NATIVE_PROOF_HEADER =
  'X-Station-Native-Account-Proof' as const;

/** Public half only. SDK implementations retain the non-extractable signing key. */
export interface ApplicationSessionPublicKey {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}
export interface ApplicationSessionChallenge {
  version: typeof APPLICATION_SESSION_VERSION;
  challengeId: string;
  nonce: string;
  expiresAt: string;
  stationId: string;
  requestOrigin: string;
}
/** Not a bearer or a Device grant. The existing Device credential is also required. */
export interface ApplicationSessionContinuation {
  version: typeof APPLICATION_SESSION_VERSION;
  credential: string;
  /** Stable across renewal; changes with the account session, Device or proof key. */
  authorityKey: string;
  stationId: string;
  deviceId: string;
  principal: PrincipalRef;
  requestOrigin: string;
  clientOrigin: string;
  keyThumbprint: string;
  nonce: string;
  expiresAt: string;
}
/** Browser cookie adoption result; raw cookies are never copied into the body. */
export interface ApplicationSessionCookieAdoption {
  version: typeof APPLICATION_SESSION_VERSION;
  aliasCredential: string;
  aliasId: string;
  aliasExpiresAt: string;
  continuation: ApplicationSessionContinuation;
}
export interface ApplicationSessionCapabilities {
  version: typeof APPLICATION_SESSION_VERSION;
  cookieExchange: boolean;
  cookieAdoption: boolean;
  virtualLogin: boolean;
  proofAlgorithm: 'ES256';
  stationId: string;
  requestOrigin: string;
}

/** Native continuation has a Station and signed client surface, never a fabricated web Origin. */
export interface NativeApplicationSessionTargetV1 {
  readonly kind: 'station-native';
  readonly stationId: string;
  /** Canonical Station service audience from trusted VAI facts; never a client Origin. */
  readonly audience: string;
  readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
}

export interface NativeApplicationSessionChallengeV1 {
  readonly version: typeof APPLICATION_SESSION_NATIVE_VERSION;
  readonly challengeId: string;
  readonly nonce: string;
  readonly expiresAt: string;
  readonly target: NativeApplicationSessionTargetV1;
  readonly deviceId: string;
  /** Thumbprint of the independent account-session proof key. */
  readonly keyThumbprint: string;
}

export interface NativeApplicationSessionChallengeRequestV1 {
  readonly version: typeof APPLICATION_SESSION_NATIVE_VERSION;
  readonly publicKey: ApplicationSessionPublicKey;
}

/** Credentials go only to the configured provider-native login adapter over the encrypted application path. */
export interface NativeApplicationSessionExchangeV1 {
  readonly version: typeof APPLICATION_SESSION_NATIVE_VERSION;
  readonly challengeId: string;
  readonly credentials: Readonly<Record<string, unknown>>;
  readonly proof: string;
}

/** Native proof claims bind one exact Station, surface, Device and path without HTTP Origin. */
export interface NativeApplicationSessionProofClaimsV1 {
  readonly version: typeof APPLICATION_SESSION_NATIVE_VERSION;
  readonly purpose: 'exchange' | 'request';
  readonly aud: string;
  readonly stationId: string;
  readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
  readonly deviceId: string;
  readonly nonce: string;
  readonly method: string;
  readonly path: string;
  readonly credentialHash?: string;
  readonly challengeIdHash?: string;
  /** SHA-256 of JSON.stringify of the parsed credentials object, only for exchange proofs. */
  readonly credentialsHash?: string;
  readonly jti: string;
  readonly iat: number;
}

export interface NativeApplicationSessionContinuationV1 {
  readonly version: typeof APPLICATION_SESSION_NATIVE_VERSION;
  readonly credential: string;
  readonly authorityKey: string;
  readonly target: NativeApplicationSessionTargetV1;
  readonly deviceId: string;
  readonly principal: PrincipalRef;
  readonly keyThumbprint: string;
  readonly nonce: string;
  readonly expiresAt: string;
}
