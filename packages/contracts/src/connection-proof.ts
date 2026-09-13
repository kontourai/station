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

export interface ApprovedStationConnectionTrust {
  readonly stationId: string;
  readonly enrollmentId: string;
  readonly generation: number;
  readonly signingKey: StationConnectionSigningKey;
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
export const STATION_CONNECTION_PROOF_LIFETIME_SECONDS = 30;
export const STATION_CONNECTION_PROOF_MAX_BYTES = 4096;
