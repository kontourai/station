import type {
  ApprovedStationConnectionTrust,
  StationConnectionKeyCandidateClaimsV1,
  StationConnectionKeyCandidateExpectationV1,
  StationConnectionKeyCandidateV1,
  VerifiedStationConnectionKeyCandidateV1,
} from '@kontourai/station-contracts/connection-proof';
import {
  copyStationConnectionTrust,
  stationConnectionKeyConfirmationCode,
  stationConnectionSigningKeyId,
  verifyStationConnectionKeyCandidate,
} from '@kontourai/station-shared/connection-proof';

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const CLIENT_INSTANCE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_THUMBPRINT = /^[A-Za-z0-9_-]{43}$/;

class StationConnectionKeyCandidateError extends Error {
  constructor(
    readonly code:
      | 'candidate_invalid'
      | 'candidate_stale'
      | 'candidate_key_unavailable',
  ) {
    super(code);
  }
}

export interface StationConnectionKeyCandidateIssueV1 {
  readonly candidate: StationConnectionKeyCandidateV1;
  readonly keyId: string;
  readonly confirmationCode: string;
  /** Unix epoch seconds. */
  readonly expiresAt: number;
}

export interface StationConnectionKeyCandidateCustody {
  readDescriptor(): ApprovedStationConnectionTrust | null;
  signConnectionKeyCandidate(
    claims: StationConnectionKeyCandidateClaimsV1,
  ): Promise<StationConnectionKeyCandidateV1>;
}

interface NormalizedCandidateRequest {
  brokerOrigin: string;
  expectedStationId: string;
  expectedEnrollmentId: string;
  challenge: string;
  clientInstanceId: string;
  clientKeyThumbprint: string;
}

/**
 * Issues a short-lived, Station-signed public-key candidate. A verified result
 * proves possession of that candidate key only; approval remains a separate
 * Device/user-owned operation.
 */
export class ConnectionKeyCandidateIssuer {
  constructor(
    private readonly custody: StationConnectionKeyCandidateCustody,
    private readonly now: () => number = Date.now,
  ) {}

  async issue(input: {
    brokerOrigin: string;
    expectedStationId: string;
    expectedEnrollmentId: string;
    challenge: string;
    clientInstanceId: string;
    clientKeyThumbprint: string;
  }): Promise<StationConnectionKeyCandidateIssueV1> {
    const request = normalizeCandidateRequest(input);
    const trust = this.custody.readDescriptor();
    if (!trust)
      throw new StationConnectionKeyCandidateError('candidate_key_unavailable');
    const copiedTrust = copyStationConnectionTrust(trust);
    if (
      copiedTrust.stationId !== input.expectedStationId ||
      copiedTrust.enrollmentId !== input.expectedEnrollmentId
    )
      throw new StationConnectionKeyCandidateError('candidate_stale');
    const keyId = await stationConnectionSigningKeyId(copiedTrust);
    const confirmationCode =
      await stationConnectionKeyConfirmationCode(copiedTrust);
    const issuedAt = Math.floor(this.now() / 1000);
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0)
      throw new StationConnectionKeyCandidateError('candidate_invalid');
    const claims: StationConnectionKeyCandidateClaimsV1 = {
      version: 'station-connection-key-candidate/v1',
      aud: 'urn:station:connection-key-candidate:v1',
      purpose: 'advertise-station-connection-key',
      brokerOrigin: request.brokerOrigin,
      challenge: request.challenge,
      clientInstanceId: request.clientInstanceId,
      clientKeyThumbprint: request.clientKeyThumbprint,
      confirmationCode,
      candidate: copiedTrust,
      keyId,
      iat: issuedAt,
      exp: issuedAt + 60,
    };
    const candidate = await this.custody.signConnectionKeyCandidate(claims);
    const expectation: StationConnectionKeyCandidateExpectationV1 = {
      brokerOrigin: request.brokerOrigin,
      stationId: request.expectedStationId,
      enrollmentId: request.expectedEnrollmentId,
      challenge: request.challenge,
      clientInstanceId: request.clientInstanceId,
      clientKeyThumbprint: request.clientKeyThumbprint,
      now: Math.floor(this.now() / 1000),
    };
    let verified: VerifiedStationConnectionKeyCandidateV1;
    try {
      verified = await verifyStationConnectionKeyCandidate(
        candidate,
        expectation,
      );
    } catch {
      throw new StationConnectionKeyCandidateError('candidate_stale');
    }
    const current = this.custody.readDescriptor();
    if (!current || !sameTrust(current, copiedTrust))
      throw new StationConnectionKeyCandidateError('candidate_stale');
    return {
      candidate,
      keyId: verified.claims.keyId,
      confirmationCode: verified.claims.confirmationCode,
      expiresAt: verified.claims.exp,
    };
  }
}

function normalizeCandidateRequest(input: {
  brokerOrigin: string;
  expectedStationId: string;
  expectedEnrollmentId: string;
  challenge: string;
  clientInstanceId: string;
  clientKeyThumbprint: string;
}): NormalizedCandidateRequest {
  if (
    !input ||
    typeof input.brokerOrigin !== 'string' ||
    typeof input.expectedStationId !== 'string' ||
    !CLIENT_INSTANCE_ID.test(input.expectedStationId) ||
    typeof input.expectedEnrollmentId !== 'string' ||
    !CLIENT_INSTANCE_ID.test(input.expectedEnrollmentId) ||
    typeof input.challenge !== 'string' ||
    !CHALLENGE.test(input.challenge) ||
    typeof input.clientInstanceId !== 'string' ||
    !CLIENT_INSTANCE_ID.test(input.clientInstanceId) ||
    typeof input.clientKeyThumbprint !== 'string' ||
    !KEY_THUMBPRINT.test(input.clientKeyThumbprint)
  )
    throw new StationConnectionKeyCandidateError('candidate_invalid');
  return {
    brokerOrigin: canonicalBrokerOrigin(input.brokerOrigin),
    expectedStationId: input.expectedStationId,
    expectedEnrollmentId: input.expectedEnrollmentId,
    challenge: input.challenge,
    clientInstanceId: input.clientInstanceId,
    clientKeyThumbprint: input.clientKeyThumbprint,
  };
}

function canonicalBrokerOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new StationConnectionKeyCandidateError('candidate_invalid');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(
    url.hostname.toLowerCase(),
  );
  if (
    url.origin !== input ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
  )
    throw new StationConnectionKeyCandidateError('candidate_invalid');
  return url.origin;
}

function sameTrust(
  left: ApprovedStationConnectionTrust,
  right: ApprovedStationConnectionTrust,
) {
  return (
    left.stationId === right.stationId &&
    left.enrollmentId === right.enrollmentId &&
    left.generation === right.generation &&
    left.signingKey.x === right.signingKey.x &&
    left.signingKey.y === right.signingKey.y
  );
}
