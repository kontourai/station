import type { SelfHostedBrokerNativeClientSurfaceV2 } from './self-hosted-broker.js';

/**
 * Native Device request proofs, version and wire identities. These shapes are
 * protocol data only: verification, key custody and any server admission
 * decision live outside this contract. A proof authorizes nothing by itself.
 */
export const NATIVE_DEVICE_PROOF_VERSION =
  'station-native-device-proof/v1' as const;
export const NATIVE_DEVICE_PROOF_TYPE =
  'station-native-device-request+jws' as const;
export const NATIVE_DEVICE_PROOF_HEADER =
  'X-Station-Native-Device-Proof' as const;
export const NATIVE_DEVICE_PROOF_REQUEST_PURPOSE = 'request' as const;
/** One-use proofs: expiry must be no more than 30 seconds after issue. */
export const NATIVE_DEVICE_PROOF_LIFETIME_SECONDS = 30;
/** Maximum compact JWS character count, including its fixed-width signature. */
export const NATIVE_DEVICE_PROOF_MAX_LENGTH = 4096;

/** P-256 public key as a bare JWK; private key material never appears here. */
export interface NativeDeviceProofPublicKey {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
}

/**
 * Trusted snapshot of an approved native Device binding. It names one approved
 * Device on one Station, seen from one native installation surface, for one
 * WebRTC peer nonce; it carries no Device credential, route secret, provider
 * credential or account continuation.
 */
export interface NativeDeviceBindingSnapshot {
  /** The Station this binding was approved on. */
  readonly stationId: string;
  /** Canonical HTTPS or loopback HTTP Station origin; proofs are audience-bound to it. */
  readonly stationAudience: string;
  /** The approved Device ID on that Station. */
  readonly deviceId: string;
  /** Host-proposed canonical UUIDv4 binding ID approved at binding creation. */
  readonly bindingId: string;
  /** Approved Device proof key, independent of the route key in `surface`. */
  readonly deviceProofKeyThumbprint: string;
  /** Full native installation surface the binding is bound to. */
  readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
  /** Unique Pion peer nonce this binding is scoped to. */
  readonly peerNonce: string;
}

/**
 * Strict version identity for the host-proposed binding candidate. The
 * candidate is protocol data only: it carries the Device public key, never a
 * private scalar, route secret or Device credential, and approves nothing by
 * itself.
 */
export const NATIVE_DEVICE_BINDING_CANDIDATE_VERSION =
  'station-native-device-binding-candidate/v1' as const;

/**
 * Host-proposed binding candidate for the shared host/server boundary. The
 * native host mints a provisional canonical UUIDv4 `bindingId` before creating
 * its Device proof key so both sides observe the same ID; the Station operator
 * explicitly approves this exact tuple. The UUID itself grants nothing.
 */
export interface NativeDeviceBindingCandidateV1 {
  readonly version: typeof NATIVE_DEVICE_BINDING_CANDIDATE_VERSION;
  /** Exact Station this candidate is presented to. */
  readonly stationId: string;
  /** The approved Device ID on that Station. */
  readonly deviceId: string;
  /** Host-minted provisional canonical UUIDv4 binding ID. */
  readonly bindingId: string;
  /** Full native installation surface of the requesting installation. */
  readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
  /** Device proof public JWK; private key material never appears here. */
  readonly deviceProofJwk: NativeDeviceProofPublicKey;
  /** RFC 7638 thumbprint of `deviceProofJwk`; the server recomputes it. */
  readonly deviceProofKeyThumbprint: string;
}

/**
 * Operator-only HTTP readback of one binding's historical record. The
 * `currentDeviceBinding` flag reports only whether this Device proof binding
 * is current against Station's paired-Device state; it grants no account,
 * Project, or runtime authority.
 */
export interface NativeDeviceProofBindingReadbackV1 {
  readonly version: 'station-native-device-proof-binding-readback/v1';
  readonly binding: {
    readonly stationId: string;
    readonly deviceId: string;
    readonly bindingId: string;
    readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
    readonly deviceProofJwk: NativeDeviceProofPublicKey;
    readonly deviceProofKeyThumbprint: string;
    readonly state: 'active' | 'revoked';
    readonly createdAt: number;
    readonly approvedAt: number;
    readonly revokedAt?: number;
    readonly revocationReason?: 'operator-revoked' | 'replaced';
  };
  readonly currentDeviceBinding: boolean;
}

export const NATIVE_DEVICE_PROOF_SELF_RECEIPT_BASE_PATH =
  '/api/auth/native-device-bindings' as const;
export const NATIVE_DEVICE_PROOF_SELF_RECEIPT_VERSION =
  'station-native-device-proof-self-receipt/v1' as const;
export const NATIVE_DEVICE_PROOF_SELF_RECEIPT_ERROR_VERSION =
  'station-native-device-proof-self-receipt-error/v1' as const;

/** Distinguishes a binding observation error from an unrelated HTTP failure. */
export interface NativeDeviceProofSelfReceiptErrorV1 {
  readonly version: typeof NATIVE_DEVICE_PROOF_SELF_RECEIPT_ERROR_VERSION;
  readonly code:
    | 'not_found'
    | 'device_required'
    | 'invalid_request'
    | 'unavailable';
}

/**
 * One historical binding observed by its owning, currently paired Device.
 * The immutable public tuple identifies the approval; state and currentness
 * are observations, never account, Project or request authority. An absent
 * or failed read does not establish that a provisional key can be deleted.
 */
export interface NativeDeviceProofSelfReceiptV1 {
  readonly version: typeof NATIVE_DEVICE_PROOF_SELF_RECEIPT_VERSION;
  readonly binding: NativeDeviceProofBindingReadbackV1['binding'];
  readonly currentDeviceBinding: boolean;
}

/**
 * Exact claims signed by the native Device proof key for one request. The
 * proof key and purpose are distinct from account continuation, Station
 * signing and broker routing keys.
 */
export interface NativeDeviceRequestProofClaimsV1 {
  readonly version: typeof NATIVE_DEVICE_PROOF_VERSION;
  /** Canonical HTTPS Station audience the request targets. */
  readonly aud: string;
  readonly purpose: typeof NATIVE_DEVICE_PROOF_REQUEST_PURPOSE;
  readonly stationId: string;
  readonly deviceId: string;
  readonly bindingId: string;
  readonly deviceProofKeyThumbprint: string;
  readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
  readonly peerNonce: string;
  /** Uppercase HTTP method of the exact request. */
  readonly htm: string;
  /** Request path including query, without scheme or authority. */
  readonly htu: string;
  /** SHA-256 of the exact transmitted body bytes, encoded base64url. */
  readonly bodySha256: string;
  /** One-use proof ID, encoded base64url. */
  readonly jti: string;
  /** Unix epoch seconds. */
  readonly iat: number;
  /** Unix epoch seconds; at most 30 seconds after `iat`. */
  readonly exp: number;
}
