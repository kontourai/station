import type { ApprovedStationConnectionTrust } from './connection-proof.js';
import type {
  NativeDeviceBindingCandidateV1,
  NativeDeviceProofSelfReceiptV1,
} from './native-device-proof.js';
import type {
  SelfHostedBrokerNativeClientSurfaceV2,
  SelfHostedBrokerNativeScopeV2,
} from './self-hosted-broker.js';

/** Additive native ceremony; these declarations do not mount or enable ingress. */
export const NATIVE_RELAY_ENROLLMENT_VERSION =
  'station.native-relay-enrollment/v1' as const;
export const NATIVE_RELAY_ENROLLMENT_BASE_PATH =
  '/.well-known/station/v1/relay/native-enrollment' as const;
export const NATIVE_RELAY_ENROLLMENT_BEGIN_PATH =
  `${NATIVE_RELAY_ENROLLMENT_BASE_PATH}/begin` as const;
export const NATIVE_RELAY_ENROLLMENT_LOGIN_PATH =
  `${NATIVE_RELAY_ENROLLMENT_BASE_PATH}/login` as const;
export const NATIVE_RELAY_ENROLLMENT_REGISTER_PATH =
  `${NATIVE_RELAY_ENROLLMENT_BASE_PATH}/register` as const;
export const NATIVE_RELAY_ENROLLMENT_FINALIZE_PATH =
  `${NATIVE_RELAY_ENROLLMENT_BASE_PATH}/finalize` as const;
export const NATIVE_RELAY_ENROLLMENT_ACTIVATE_PATH =
  `${NATIVE_RELAY_ENROLLMENT_BASE_PATH}/activate` as const;
export const NATIVE_RELAY_ENROLLMENT_CANCEL_PATH =
  `${NATIVE_RELAY_ENROLLMENT_BASE_PATH}/cancel` as const;
export const NATIVE_RELAY_ENROLLMENT_STATUS_PATH =
  `${NATIVE_RELAY_ENROLLMENT_BASE_PATH}/status` as const;
export const NATIVE_RELAY_ENROLLMENT_PATHS = [
  NATIVE_RELAY_ENROLLMENT_BEGIN_PATH,
  NATIVE_RELAY_ENROLLMENT_LOGIN_PATH,
  NATIVE_RELAY_ENROLLMENT_REGISTER_PATH,
  NATIVE_RELAY_ENROLLMENT_FINALIZE_PATH,
  NATIVE_RELAY_ENROLLMENT_ACTIVATE_PATH,
  NATIVE_RELAY_ENROLLMENT_STATUS_PATH,
  NATIVE_RELAY_ENROLLMENT_CANCEL_PATH,
] as const;
export const NATIVE_RELAY_ENROLLMENT_CHALLENGE_TYPE =
  'station-native-relay-enrollment-challenge+jws' as const;
export const NATIVE_RELAY_ENROLLMENT_RECEIPT_TYPE =
  'station-native-relay-enrollment-receipt+jws' as const;
export const NATIVE_RELAY_ENROLLMENT_STATUS_TYPE =
  'station-native-relay-enrollment-status+jws' as const;
export const NATIVE_RELAY_ENROLLMENT_PROOF_TYPE =
  'station-native-relay-enrollment+jwt' as const;
export const NATIVE_RELAY_ENROLLMENT_HPKE_SUITE = {
  kem: 0x0010,
  kdf: 0x0001,
  aead: 0x0001,
} as const;

/** SEC1 uncompressed P-256 public point, encoded canonical base64url. */
export interface NativeRelayEnrollmentRecipient {
  readonly suite: typeof NATIVE_RELAY_ENROLLMENT_HPKE_SUITE;
  readonly publicKey: string;
}

export interface NativeRelayEnrollmentBinding {
  readonly stationId: string;
  readonly stationAudience: string;
  readonly scope: SelfHostedBrokerNativeScopeV2;
  readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
  readonly peerNonce: string;
  readonly enrollmentId: string;
  /** Allocated by Station before the host creates its Device key. */
  readonly reservedDeviceId: string;
  readonly recipient: NativeRelayEnrollmentRecipient;
}

export interface NativeRelayEnrollmentBeginRequest {
  readonly version: typeof NATIVE_RELAY_ENROLLMENT_VERSION;
  /** Host-owned idempotence identity; retained before the first request can leave the host. */
  readonly clientAttemptId: string;
  readonly peerNonce: string;
  readonly expiresAt: number;
  readonly recipient: NativeRelayEnrollmentRecipient;
}

export interface NativeRelayEnrollmentChallenge
  extends NativeRelayEnrollmentBinding {
  readonly version: typeof NATIVE_RELAY_ENROLLMENT_VERSION;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly clientAttemptId: string;
  readonly responsePeerNonce: string;
  readonly requestedScope: 'orchestration:read';
  readonly registrationAvailable: boolean;
  readonly stationSigningGeneration: number;
  readonly stationProof: string;
}

export interface NativeRelayEnrollmentLoginRequest {
  readonly enrollmentId: string;
  readonly candidate: NativeDeviceBindingCandidateV1;
  readonly proof: string;
  readonly credentials: {
    readonly username: string;
    readonly password: string;
  };
}

export interface NativeRelayEnrollmentRegisterRequest
  extends NativeRelayEnrollmentLoginRequest {
  readonly invitation: string;
  readonly name?: string;
}

export interface NativeRelayEnrollmentPending {
  readonly version: typeof NATIVE_RELAY_ENROLLMENT_VERSION;
  readonly state: 'pending';
  readonly enrollmentId: string;
  readonly requestId: string;
  readonly expiresAt: number;
}

/** Only ciphertext crosses renderer IPC; Station proof authenticates the sealed tuple. */
export interface NativeRelayEnrollmentDelivery {
  readonly version: typeof NATIVE_RELAY_ENROLLMENT_VERSION;
  readonly state: 'delivered';
  readonly binding: NativeRelayEnrollmentBinding;
  readonly candidate: NativeDeviceBindingCandidateV1;
  readonly activationNonce: string;
  readonly bundleDigest: string;
  readonly expiresAt: number;
  readonly responsePeerNonce: string;
  readonly stationSigningGeneration: number;
  readonly enc: string;
  readonly ciphertext: string;
  readonly stationProof: string;
}

export interface NativeRelayEnrollmentPurposeRequest {
  readonly enrollmentId: string;
  readonly proof: string;
}

export interface NativeRelayEnrollmentActivateRequest
  extends NativeRelayEnrollmentPurposeRequest {
  readonly deviceId: string;
  readonly bindingId: string;
  readonly activationNonce: string;
  readonly bundleDigest: string;
}

export interface NativeRelayEnrollmentActivated {
  readonly version: typeof NATIVE_RELAY_ENROLLMENT_VERSION;
  readonly state: 'active';
  readonly enrollmentId: string;
  readonly deviceId: string;
  readonly bindingId: string;
  readonly receiptDigest: string;
  readonly receiptExpiresAt: number;
  readonly binding: NativeRelayEnrollmentBinding;
  readonly candidate: NativeDeviceBindingCandidateV1;
  readonly deviceReceipt: NativeDeviceProofSelfReceiptV1;
  readonly responsePeerNonce: string;
  readonly stationSigningGeneration: number;
  readonly stationProof: string;
}

export interface NativeRelayEnrollmentHostChallengeAccepted {
  readonly version: typeof NATIVE_RELAY_ENROLLMENT_VERSION;
  readonly enrollmentHandle: string;
  readonly candidate: NativeDeviceBindingCandidateV1;
  readonly registrationAvailable: boolean;
  readonly expiresAt: number;
}
export interface NativeRelayEnrollmentHostDeliveryAccepted {
  readonly version: typeof NATIVE_RELAY_ENROLLMENT_VERSION;
  readonly enrollmentHandle: string;
  readonly state: 'staged';
}
export interface NativeRelayEnrollmentHostActivationAccepted {
  readonly version: typeof NATIVE_RELAY_ENROLLMENT_VERSION;
  readonly enrollmentHandle: string;
  readonly state: 'active';
  readonly profileRevision: number;
  readonly transitionHandle: string;
}
export interface NativeRelayEnrollmentHostInactiveAccepted {
  readonly version: typeof NATIVE_RELAY_ENROLLMENT_VERSION;
  readonly enrollmentHandle: string;
  readonly state: 'pending' | 'cancelled' | 'expired' | 'revoked';
}

/** Public recovery hints; an active transition still requires host currentness verification. */
export interface NativeRelayEnrollmentHostResumeAttempt {
  readonly enrollmentHandle: string;
  readonly phase:
    | 'begin-required'
    | 'candidate'
    | 'staged'
    | 'activation-unknown'
    | 'active'
    | 'cancel-required';
  readonly profileRevision: number;
  readonly expiresAt: number;
  readonly registrationAvailable: boolean;
  readonly candidate: NativeDeviceBindingCandidateV1 | null;
  readonly transition: NativeRelayEnrollmentHostActivationAccepted | null;
}

export interface NativeRelayEnrollmentHostResumeProjection {
  readonly version: typeof NATIVE_RELAY_ENROLLMENT_VERSION;
  readonly attempts: readonly NativeRelayEnrollmentHostResumeAttempt[];
}

/** Signed only through fixed host operations after validating the exact challenge. */
export interface NativeRelayEnrollmentProofClaims
  extends NativeRelayEnrollmentBinding {
  readonly version: typeof NATIVE_RELAY_ENROLLMENT_VERSION;
  readonly requestedScope: 'orchestration:read';
  readonly purpose:
    | 'login'
    | 'register'
    | 'finalize'
    | 'activate'
    | 'status'
    | 'cancel';
  readonly candidate: NativeDeviceBindingCandidateV1;
  readonly nonce: string;
  readonly htm: 'POST';
  readonly htu: string;
  /** SHA-256 of RFC8785 canonical payload JSON with the proof member omitted. */
  readonly payloadSha256: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
}

export interface NativeRelayEnrollmentHostSelection {
  readonly profileName: string;
  readonly expectedProfileRevision: number;
}

/** Host-owned attempt identity, never a grant or private key. */
export interface NativeRelayEnrollmentHostPrepared {
  readonly version: typeof NATIVE_RELAY_ENROLLMENT_VERSION;
  readonly attemptHandle: string;
  readonly recipient: NativeRelayEnrollmentRecipient;
  readonly expiresAt: number;
}

export interface NativeRelayEnrollmentCancelled {
  readonly version: typeof NATIVE_RELAY_ENROLLMENT_VERSION;
  readonly state: 'cancelled';
  readonly binding: NativeRelayEnrollmentBinding;
  readonly candidate: NativeDeviceBindingCandidateV1;
  readonly responsePeerNonce: string;
  readonly observedAt: number;
  readonly stationSigningGeneration: number;
  readonly stationProof: string;
}
export type NativeRelayEnrollmentInactiveStatus =
  | NativeRelayEnrollmentCancelled
  | {
      readonly version: typeof NATIVE_RELAY_ENROLLMENT_VERSION;
      readonly state: 'pending' | 'expired' | 'revoked';
      readonly binding: NativeRelayEnrollmentBinding;
      readonly candidate: NativeDeviceBindingCandidateV1;
      readonly responsePeerNonce: string;
      readonly observedAt: number;
      readonly stationSigningGeneration: number;
      readonly stationProof: string;
    };

export type NativeRelayEnrollmentStatus =
  | NativeRelayEnrollmentActivated
  | NativeRelayEnrollmentInactiveStatus;

export type NativeRelayEnrollmentRequestPath =
  | typeof NATIVE_RELAY_ENROLLMENT_BEGIN_PATH
  | typeof NATIVE_RELAY_ENROLLMENT_LOGIN_PATH
  | typeof NATIVE_RELAY_ENROLLMENT_REGISTER_PATH
  | typeof NATIVE_RELAY_ENROLLMENT_FINALIZE_PATH
  | typeof NATIVE_RELAY_ENROLLMENT_ACTIVATE_PATH
  | typeof NATIVE_RELAY_ENROLLMENT_STATUS_PATH
  | typeof NATIVE_RELAY_ENROLLMENT_CANCEL_PATH;

/** Forward the exact body bytes on this one peer; no URL, method or header proxy. */
export interface NativeRelayEnrollmentPreparedRequest {
  readonly version: 'station-native-enrollment-request/v1';
  readonly requestHandle: string;
  readonly peerHandle: string;
  readonly enrollmentHandle?: string;
  readonly method: 'POST';
  readonly path: NativeRelayEnrollmentRequestPath;
  readonly headers: { readonly 'Content-Type': 'application/json' };
  readonly body: string;
}

/** Grant, profile and trust have been checked by the host; no Device binding is required. */
export interface NativeRelayEnrollmentPeerPrepared {
  readonly version: 'station-native-enrollment-peer/v1';
  readonly peerHandle: string;
  readonly nonce: string;
  readonly connectionId: string;
  readonly expiresAt: number;
  readonly scope: SelfHostedBrokerNativeScopeV2;
  readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
  readonly stationAudience: string;
  readonly trust: ApprovedStationConnectionTrust;
}
