import type { UsageReceipt } from './usage-rollup.js';

/** Scope selection only narrows the request's verified read authority. */
export type UsageExportScope = 'individual' | 'personal-account';

export interface UsageExportRequest {
  from: string;
  to: string;
  scope: UsageExportScope;
  pageSize?: number;
  cursor?: string;
}

/** A page of retained canonical facts, not proof of complete provider history. */
export interface UsageExportPage {
  schemaVersion: 1;
  stationId: string;
  streamEpoch: string;
  highWater: number;
  scope: UsageExportScope;
  window: { from: string; to: string; clock: 'station-observed-utc' };
  observations: Array<{ globalSequence: number; receipts: UsageReceipt[] }>;
  nextCursor?: string;
  coverage: {
    state: 'unknown';
    reason: 'retained-observations-do-not-prove-provider-or-deletion-coverage';
  };
}

/** A saved proposal only. It grants no export, ingestion or destination access. */
export interface AnalyticsSourceEnrollmentIntent {
  protocol: 'station-analytics-source-enrollment-intent/v1';
  operationId: string;
  sourceStationId: string;
  proposedDestination: { stationId: string; origin: string };
  destinationVerified: false;
  scope: UsageExportScope;
  expiresAt: string;
  retention: { mode: 'live-mirror' } | { mode: 'retained-copy'; days: number };
  phase: 'prepared' | 'cancelled';
  createdAt: string;
  exportAuthority: false;
}

export const ANALYTICS_RECIPIENT_CANDIDATE_PROTOCOL =
  'station-analytics-recipient-candidate/v1' as const;

/** A receiving key candidate, not remote identity authentication or export authority. */
export interface AnalyticsRecipientCandidateClaims {
  protocol: typeof ANALYTICS_RECIPIENT_CANDIDATE_PROTOCOL;
  recipientId: string;
  sourceOperationId: string;
  sourceStationId: string;
  sourceIntentSha256: string;
  proposedSourceOrigin: string;
  destinationStationId: string;
  proposedDestinationOrigin: string;
  recipientPrincipalId: string;
  recipientBindingSha256: string;
  encryptionKey: { kty: 'OKP'; crv: 'X25519'; x: string };
  proofKey: { kty: 'OKP'; crv: 'Ed25519'; x: string };
  createdAt: number;
  expiresAt: number;
}
export interface AnalyticsRecipientCandidate {
  claims: AnalyticsRecipientCandidateClaims;
  signature: string;
}
export interface AnalyticsRecipientCandidateView {
  observedAt: string;
  sourceIntent: AnalyticsSourceEnrollmentIntent;
  phase: 'candidate' | 'expired' | 'cancelled';
  verification: 'key-possession-only';
  sourceVerified: false;
  exportAuthority: false;
  confirmationCode: string;
  candidate: AnalyticsRecipientCandidate;
}

/** Recorded source-user approval, not an active export credential. */
export interface AnalyticsSourceApproval {
  protocol: 'station-analytics-source-approval/v1';
  operationId: string;
  sourceOperationId: string;
  sourceStationId: string;
  destinationStationId: string;
  recipientId: string;
  recipientPrincipalId: string;
  scope: UsageExportScope;
  expiresAt: string;
  retention: AnalyticsSourceEnrollmentIntent['retention'];
  phase: 'approved' | 'revoked';
  approvedAt: string;
  approvalTransactionId: string;
  sourceApproved: true;
  exportAuthority: false;
  recipientAssurance: 'source-user-approved-key';
}
