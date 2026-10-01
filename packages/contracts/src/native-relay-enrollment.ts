import type { NativeDeviceBindingCandidateV1 } from './native-device-proof.js';
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
export const NATIVE_RELAY_ENROLLMENT_FINALIZE_PATH =
  `${NATIVE_RELAY_ENROLLMENT_BASE_PATH}/finalize` as const;
export const NATIVE_RELAY_ENROLLMENT_ACTIVATE_PATH =
  `${NATIVE_RELAY_ENROLLMENT_BASE_PATH}/activate` as const;
export const NATIVE_RELAY_ENROLLMENT_CANCEL_PATH =
  `${NATIVE_RELAY_ENROLLMENT_BASE_PATH}/cancel` as const;
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
  readonly recipient: NativeRelayEnrollmentRecipient;
}

export interface NativeRelayEnrollmentChallenge
  extends NativeRelayEnrollmentBinding {
  readonly version: typeof NATIVE_RELAY_ENROLLMENT_VERSION;
  readonly nonce: string;
  readonly expiresAt: number;
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
}

/** Signed only through fixed host operations after validating the exact challenge. */
export interface NativeRelayEnrollmentProofClaims
  extends NativeRelayEnrollmentBinding {
  readonly version: typeof NATIVE_RELAY_ENROLLMENT_VERSION;
  readonly purpose: 'login' | 'finalize' | 'activate' | 'cancel';
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
  readonly enrollmentId: string;
}
