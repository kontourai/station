import { APPLICATION_SESSION_VERSION } from './application-session.js';
import type { PrincipalRef } from './principal.js';

/** Candidate-only, operator-approved fresh Device enrollment over a verified relay. */
export const RELAY_ENROLLMENT_VERSION = 'station.relay-enrollment/v1' as const;
export const RELAY_ENROLLMENT_PROOF_TYPE =
  'station-relay-enrollment+jwt' as const;
export const RELAY_ENROLLMENT_PROOF_AUDIENCE =
  'urn:station:relay-enrollment:v1' as const;
export const RELAY_ENROLLMENT_BASE_PATH =
  '/.well-known/station/v1/relay/enrollment' as const;

/** These paths are reserved for the versioned flow; production mounts them only after the full ACK lifecycle lands. */
export const RELAY_ENROLLMENT_BEGIN_PATH =
  `${RELAY_ENROLLMENT_BASE_PATH}/begin` as const;
export const RELAY_ENROLLMENT_LOGIN_PATH =
  `${RELAY_ENROLLMENT_BASE_PATH}/login` as const;
export const RELAY_ENROLLMENT_FINALIZE_PATH =
  `${RELAY_ENROLLMENT_BASE_PATH}/finalize` as const;
export const RELAY_ENROLLMENT_ACTIVATE_PATH =
  `${RELAY_ENROLLMENT_BASE_PATH}/activate` as const;

/** Public verification material only. The client signing key never leaves its non-extractable custody. */
export interface RelayEnrollmentPublicKey {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
}

/** Exact JSON body for the password-free challenge allocation request. */
export interface RelayEnrollmentBeginRequest {
  readonly publicKey: RelayEnrollmentPublicKey;
}

/** Fresh challenge binding returned before any account credential reaches Station. */
export interface RelayEnrollmentChallenge {
  readonly version: typeof RELAY_ENROLLMENT_VERSION;
  readonly stationId: string;
  readonly requestOrigin: string;
  readonly clientOrigin: string;
  readonly enrollmentId: string;
  readonly publicKey: RelayEnrollmentPublicKey;
  readonly keyThumbprint: string;
  readonly nonce: string;
  readonly purpose: 'login';
  readonly expiresAt: string;
}

/** Provider login credentials stay in the bounded POST body and are never copied to generic authentication state. */
export interface RelayEnrollmentLoginCredentials {
  readonly username: string;
  readonly password: string;
}

export interface RelayEnrollmentLoginRequest {
  readonly enrollmentId: string;
  /** Compact ES256 JWS under `RELAY_ENROLLMENT_PROOF_TYPE`. */
  readonly proof: string;
  readonly credentials: RelayEnrollmentLoginCredentials;
}

/** No provider identity, offer proof, cookie, Device credential, or continuation is returned while approval is pending. */
export interface RelayEnrollmentPendingResponse {
  readonly version: typeof RELAY_ENROLLMENT_VERSION;
  readonly state: 'pending';
  readonly enrollmentId: string;
  readonly requestId: string;
  readonly expiresAt: string;
}

export interface RelayEnrollmentFinalizeRequest {
  readonly enrollmentId: string;
  readonly proof: string;
}

export interface RelayEnrollmentAwaitingApprovalResponse {
  readonly version: typeof RELAY_ENROLLMENT_VERSION;
  readonly state: 'pending';
  readonly enrollmentId: string;
  readonly expiresAt: string;
}

export interface RelayEnrollmentContinuationBundle {
  readonly stationId: string;
  readonly deviceId: string;
  readonly deviceCredential: string;
  readonly continuation: {
    readonly version: typeof APPLICATION_SESSION_VERSION;
    readonly credential: string;
    readonly authorityKey: string;
    readonly stationId: string;
    readonly deviceId: string;
    readonly principal: PrincipalRef;
    readonly requestOrigin: string;
    readonly clientOrigin: string;
    readonly keyThumbprint: string;
    readonly nonce: string;
    readonly expiresAt: string;
  };
}

/** Credentials are delivered only after operator approval and remain inert until signed activation. */
export interface RelayEnrollmentDeliveredResponse {
  readonly version: typeof RELAY_ENROLLMENT_VERSION;
  readonly state: 'delivered';
  readonly enrollmentId: string;
  readonly activationNonce: string;
  readonly bundleDigest: string;
  readonly bundle: RelayEnrollmentContinuationBundle;
  readonly expiresAt: string;
}

export type RelayEnrollmentFinalizeResponse =
  | RelayEnrollmentAwaitingApprovalResponse
  | RelayEnrollmentDeliveredResponse;

export interface RelayEnrollmentActivateRequest {
  readonly enrollmentId: string;
  readonly activationNonce: string;
  readonly deviceId: string;
  readonly authorityKey: string;
  readonly bundleDigest: string;
  readonly proof: string;
}

export interface RelayEnrollmentActivatedResponse {
  readonly version: typeof RELAY_ENROLLMENT_VERSION;
  readonly state: 'active';
  readonly enrollmentId: string;
  readonly deviceId: string;
  readonly receiptDigest: string;
  readonly receiptExpiresAt: string;
}

/** Strict proof claims signed by a non-extractable P-256 key. */
export interface RelayEnrollmentProofClaims {
  readonly v: typeof RELAY_ENROLLMENT_VERSION;
  readonly aud: typeof RELAY_ENROLLMENT_PROOF_AUDIENCE;
  readonly stationId: string;
  readonly enrollmentId: string;
  readonly clientOrigin: string;
  readonly keyThumbprint: string;
  readonly nonce: string;
  readonly purpose: 'login' | 'finalize' | 'activate';
  readonly htm: 'POST';
  readonly htu: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
  readonly deviceId?: string;
  readonly authorityKey?: string;
  readonly bundleDigest?: string;
}
