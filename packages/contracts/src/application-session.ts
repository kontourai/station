import type { PrincipalRef } from './principal.js';

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
export interface ApplicationSessionCapabilities {
  version: typeof APPLICATION_SESSION_VERSION;
  cookieExchange: boolean;
  virtualLogin: boolean;
  proofAlgorithm: 'ES256';
  stationId: string;
  requestOrigin: string;
}
