/** A transport binding only; never account, Project, operator or execution authority. */
export interface StationConnectionProofBinding {
  readonly stationId: string;
  readonly enrollmentId: string;
  readonly generation: number;
  readonly connectionId: string;
  readonly clientNonce: string;
  readonly clientFingerprint: string;
  readonly stationFingerprint: string;
  readonly offerSha256: string;
  readonly answerSha256: string;
}

/** Public signing key admitted independently of broker discovery/signaling. */
export interface StationConnectionSigningKey {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
}

export interface StationConnectionKeyDescriptorV1 {
  readonly stationId: string;
  readonly enrollmentId: string;
  readonly generation: number;
  readonly signingKey: StationConnectionSigningKey;
}

export interface ApprovedStationConnectionTrust
  extends StationConnectionKeyDescriptorV1 {}

/**
 * A Station-signed candidate courier may show proof of key possession, but is
 * not an approval or a trusted Station identity. Recipients still compare the
 * confirmation code out of band and persist approval in their own trust owner.
 */
export interface StationConnectionKeyCandidateClaimsV1 {
  readonly version: 'station-connection-key-candidate/v1';
  readonly aud: 'urn:station:connection-key-candidate:v1';
  readonly purpose: 'advertise-station-connection-key';
  readonly brokerOrigin: string;
  readonly challenge: string;
  readonly clientInstanceId: string;
  readonly clientKeyThumbprint: string;
  readonly confirmationCode: string;
  readonly candidate: StationConnectionKeyDescriptorV1;
  readonly keyId: string;
  /** Unix epoch seconds. The candidate is valid for at most 60 seconds. */
  readonly iat: number;
  readonly exp: number;
}

/** Opaque courier value. Verify its JWS before displaying any candidate field. */
export interface StationConnectionKeyCandidateV1 {
  readonly version: 'station-connection-key-candidate/v1';
  readonly compactJws: string;
}

/** Successful signature verification still yields a candidate, never trust. */
export interface VerifiedStationConnectionKeyCandidateV1 {
  readonly status: 'candidate';
  readonly claims: StationConnectionKeyCandidateClaimsV1;
}

export interface StationConnectionKeyCandidateExpectationV1 {
  readonly brokerOrigin: string;
  readonly challenge: string;
  readonly clientInstanceId: string;
  readonly clientKeyThumbprint: string;
  /** Selection constraints from the chosen route; they do not establish trust. */
  readonly stationId: string;
  readonly enrollmentId: string;
  readonly now?: number;
}

/** Device-local public trust state. Revocation retains the last generation. */
export interface DeviceConnectionTrustRecord {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly status: 'approved' | 'revoked';
  readonly trust: ApprovedStationConnectionTrust;
}

export const STATION_CONNECTION_PROOF_AUDIENCE =
  'urn:station:connection-proof:v1';
export const STATION_CONNECTION_PROOF_TYPE = 'station-connection-proof+jwt';
export const STATION_CONNECTION_KEY_CANDIDATE_AUDIENCE =
  'urn:station:connection-key-candidate:v1' as const;
export const STATION_CONNECTION_KEY_CANDIDATE_TYPE =
  'station-connection-key-candidate+jws' as const;
export const STATION_CONNECTION_KEY_CANDIDATE_VERSION =
  'station-connection-key-candidate/v1' as const;
export const STATION_CONNECTION_KEY_CANDIDATE_PURPOSE =
  'advertise-station-connection-key' as const;
export const STATION_CONNECTION_KEY_CANDIDATE_LIFETIME_SECONDS = 60;
export const STATION_CONNECTION_PROOF_LIFETIME_SECONDS = 30;
export const STATION_CONNECTION_PROOF_MAX_BYTES = 4096;
