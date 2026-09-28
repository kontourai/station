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
  /** Canonical HTTPS origin of the Station; proofs are audience-bound to it. */
  readonly stationAudience: string;
  /** The approved Device ID on that Station. */
  readonly deviceId: string;
  /** Random binding ID minted when this binding was approved. */
  readonly bindingId: string;
  /** Full native installation surface the binding is bound to. */
  readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
  /** Unique Pion peer nonce this binding is scoped to. */
  readonly peerNonce: string;
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

/** Opaque courier value. Its JWS is verified, against the approved binding, before any use. */
export interface NativeDeviceRequestProofV1 {
  readonly version: typeof NATIVE_DEVICE_PROOF_VERSION;
  readonly compactJws: string;
}
