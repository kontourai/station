import type { UsageReceipt } from './usage-rollup.js';

/** Source mutation snapshot carried separately from the page and grant revision. */
export const USAGE_EXPORT_SOURCE_REVISION_HEADER =
  'x-station-usage-source-revision';

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

/** Journal positions are independent of event commit positions and carry no authority. */
export interface UsageInvalidationRequest {
  scope: UsageExportScope;
  after?: number;
  streamEpoch?: string;
  pageSize?: number;
  cursor?: string;
}
export interface UsageInvalidationPage {
  protocol: 'station-usage-invalidations/v1';
  stationId: string;
  scope: UsageExportScope;
  streamEpoch: string;
  highWater: number;
  retainedAfter: number;
  nextAfter: number;
  invalidations: Array<{
    revision: number;
    threadId: string;
    reason: 'thread-deleted' | 'scope-changed' | 'scope-entered';
    observedAt: string;
  }>;
  nextCursor?: string;
  coverage: 'retained-invalidations-only';
}

/** Captured page identity; it carries no authorization. */
export interface UsageExportSnapshot {
  streamEpoch: string;
  highWater: number;
  afterGlobalSequence: number;
}
export interface UsageExportQuery extends UsageExportRequest {
  expectedStationId: string;
  snapshot?: UsageExportSnapshot;
}
function wireObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}
const wireText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;
const wireSequence = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const wireAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const wireDay = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const wireTime = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
    value,
  ) &&
  wireDay(value.slice(0, 10)) &&
  Number.isFinite(Date.parse(value));
const wireCursor = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 2048 &&
  /^[A-Za-z0-9_-]+$/.test(value);
function optionalFields(
  value: Record<string, unknown>,
  keys: readonly string[],
  check: (input: unknown) => boolean,
) {
  return keys.every((key) => value[key] === undefined || check(value[key]));
}
function wireMoney(value: unknown, estimated: boolean) {
  return (
    wireObject(
      value,
      estimated
        ? ['amount', 'currency', 'pricingSnapshotId']
        : ['amount', 'currency'],
      estimated ? ['pricingSnapshotObservedAt', 'pricingSnapshotSource'] : [],
    ) &&
    wireAmount(value.amount) &&
    wireText(value.currency) &&
    (!estimated ||
      (wireText(value.pricingSnapshotId) &&
        optionalFields(value, ['pricingSnapshotObservedAt'], wireTime) &&
        optionalFields(value, ['pricingSnapshotSource'], wireText)))
  );
}
function wireReceipt(value: unknown): value is UsageReceipt {
  return (
    wireObject(
      value,
      ['id', 'stationId', 'provider', 'observedAt', 'pricing'],
      [
        'sourceEventId',
        'sourceSequence',
        'model',
        'accountKey',
        'threadId',
        'turnId',
        'conversationId',
        'taskId',
        'occurredAt',
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'cacheWriteTokens',
        'reportedCost',
        'estimatedCost',
      ],
    ) &&
    wireText(value.id) &&
    wireText(value.stationId) &&
    wireText(value.provider) &&
    wireTime(value.observedAt) &&
    optionalFields(
      value,
      [
        'sourceEventId',
        'model',
        'accountKey',
        'threadId',
        'turnId',
        'conversationId',
        'taskId',
      ],
      wireText,
    ) &&
    optionalFields(value, ['sourceSequence'], wireSequence) &&
    optionalFields(value, ['occurredAt'], wireTime) &&
    optionalFields(
      value,
      ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'],
      wireAmount,
    ) &&
    (value.reportedCost === undefined ||
      wireMoney(value.reportedCost, false)) &&
    (value.estimatedCost === undefined ||
      wireMoney(value.estimatedCost, true)) &&
    wireObject(
      value.pricing,
      ['status'],
      [
        'pricingSnapshotId',
        'pricingSnapshotCapturedAt',
        'pricingSnapshotSource',
        'provider',
        'model',
        'currency',
      ],
    ) &&
    typeof value.pricing.status === 'string' &&
    ['priced', 'partial', 'unpriced'].includes(value.pricing.status) &&
    optionalFields(
      value.pricing,
      [
        'pricingSnapshotId',
        'pricingSnapshotSource',
        'provider',
        'model',
        'currency',
      ],
      wireText,
    ) &&
    optionalFields(value.pricing, ['pricingSnapshotCapturedAt'], wireTime)
  );
}
function wirePage(value: unknown): value is UsageExportPage {
  return (
    wireObject(
      value,
      [
        'schemaVersion',
        'stationId',
        'streamEpoch',
        'highWater',
        'scope',
        'window',
        'observations',
        'coverage',
      ],
      ['nextCursor'],
    ) &&
    value.schemaVersion === 1 &&
    wireText(value.stationId) &&
    wireText(value.streamEpoch) &&
    wireSequence(value.highWater) &&
    (value.scope === 'individual' || value.scope === 'personal-account') &&
    wireObject(value.window, ['from', 'to', 'clock']) &&
    wireDay(value.window.from) &&
    wireDay(value.window.to) &&
    value.window.clock === 'station-observed-utc' &&
    Array.isArray(value.observations) &&
    value.observations.length <= 100 &&
    value.observations.every(
      (item) =>
        wireObject(item, ['globalSequence', 'receipts']) &&
        wireSequence(item.globalSequence) &&
        Array.isArray(item.receipts) &&
        item.receipts.every(wireReceipt),
    ) &&
    (value.nextCursor === undefined || wireCursor(value.nextCursor)) &&
    wireObject(value.coverage, ['state', 'reason']) &&
    value.coverage.state === 'unknown' &&
    value.coverage.reason ===
      'retained-observations-do-not-prove-provider-or-deletion-coverage'
  );
}
/** Strict canonical wire decoder shared by SDK and receiving sync. Unknown/content fields refuse. */
export function parseUsageExportPage(
  value: unknown,
  input: UsageExportQuery,
): UsageExportPage {
  if (!wirePage(value))
    throw new Error('Usage export is invalid or unsupported');
  if (
    value.stationId !== input.expectedStationId ||
    value.scope !== input.scope ||
    value.window.from !== input.from ||
    value.window.to !== input.to ||
    value.observations.length > (input.pageSize ?? 100) ||
    (input.snapshot &&
      (value.streamEpoch !== input.snapshot.streamEpoch ||
        value.highWater !== input.snapshot.highWater))
  )
    throw new Error('Usage export does not match the captured request');
  let previous = input.snapshot?.afterGlobalSequence ?? 0;
  const from = Date.parse(`${input.from}T00:00:00.000Z`),
    to = Date.parse(`${input.to}T23:59:59.999Z`);
  for (const observation of value.observations) {
    if (
      observation.globalSequence <= previous ||
      observation.globalSequence > value.highWater ||
      observation.receipts.some(
        (item) =>
          item.stationId !== value.stationId ||
          item.observedAt === undefined ||
          Date.parse(item.observedAt) < from ||
          Date.parse(item.observedAt) > to,
      )
    )
      throw new Error(
        'Usage export observations do not match the captured source order',
      );
    previous = observation.globalSequence;
  }
  if (
    value.nextCursor &&
    (!value.observations.length || value.nextCursor === input.cursor)
  )
    throw new Error('Usage export continuation did not advance');
  return value;
}

/** Stable JSON for immutable analytics payloads, independent of object insertion order. */
export function canonicalUsageExportJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
      throw new Error('Unsupported analytics JSON value');
    return encoded;
  }
  if (Array.isArray(value))
    return `[${value.map(canonicalUsageExportJson).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([key, item]) =>
        `${JSON.stringify(key)}:${canonicalUsageExportJson(item)}`,
    )
    .join(',')}}`;
}

/** Historical page delivery status; it does not grant current source/query authority. */
export interface AnalyticsSourceSyncStatus {
  operationId: string;
  recipientId: string;
  installationId: string;
  from: string;
  to: string;
  credentialRevision: number;
  phase:
    | 'prepared'
    | 'pending'
    | 'page-stored'
    | 'facts-captured'
    | 'cancelled'
    | 'unconfirmed';
  checkpoint?: PrivateUsageCheckpoint;
  inserted?: number;
  alreadyPresent?: number;
  storedAt?: string;
  sourceAuthority: 'not-established-by-status';
}

/** Opaque storage capability ownership is separate from current source/person authorization in Core. */
export interface PrivateUsageCommit {
  protocol: 'station-private-usage-commit/v1';
  expectedReceiverEpoch: string;
  operationId: string;
  expectedCheckpoint: number;
  restartSnapshot?: boolean;
  binding: {
    sourceStationId: string;
    sourceApprovalId: string;
    recipientId: string;
    scope: UsageExportScope;
    expiresAt: string;
    retention: AnalyticsSourceEnrollmentIntent['retention'];
  };
  query: UsageExportQuery;
  page: UsageExportPage;
  sourceRevision: number;
}
export interface PrivateUsageCheckpoint {
  receiverEpoch: string;
  revision: number;
  streamEpoch: string;
  highWater: number;
  afterGlobalSequence: number;
  nextCursor?: string;
  sourceRevision: number;
  completeThroughHighWater: boolean;
}
export interface PrivateUsageCommitReceipt {
  protocol: 'station-private-usage-commit-receipt/v1';
  operationId: string;
  checkpoint: PrivateUsageCheckpoint;
  inserted: number;
  alreadyPresent: number;
  storedAt: string;
}
function privateCommitShape(value: unknown): value is PrivateUsageCommit {
  const uuid = (input: unknown) =>
    typeof input === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      input,
    );
  if (
    !wireObject(
      value,
      [
        'protocol',
        'expectedReceiverEpoch',
        'operationId',
        'expectedCheckpoint',
        'binding',
        'query',
        'page',
        'sourceRevision',
      ],
      ['restartSnapshot'],
    ) ||
    value.protocol !== 'station-private-usage-commit/v1' ||
    !uuid(value.expectedReceiverEpoch) ||
    !uuid(value.operationId) ||
    !wireSequence(value.expectedCheckpoint) ||
    !wireSequence(value.sourceRevision) ||
    (value.restartSnapshot !== undefined &&
      typeof value.restartSnapshot !== 'boolean') ||
    !wireObject(value.binding, [
      'sourceStationId',
      'sourceApprovalId',
      'recipientId',
      'scope',
      'expiresAt',
      'retention',
    ]) ||
    !wireText(value.binding.sourceStationId) ||
    !uuid(value.binding.sourceApprovalId) ||
    !uuid(value.binding.recipientId) ||
    (value.binding.scope !== 'individual' &&
      value.binding.scope !== 'personal-account') ||
    !wireTime(value.binding.expiresAt)
  )
    return false;
  const retention = value.binding.retention;
  if (
    !(wireObject(retention, ['mode']) && retention.mode === 'live-mirror') &&
    !(
      wireObject(retention, ['mode', 'days']) &&
      retention.mode === 'retained-copy' &&
      wireSequence(retention.days) &&
      retention.days >= 1 &&
      retention.days <= 90
    )
  )
    return false;
  const query = value.query;
  if (
    !wireObject(
      query,
      ['from', 'to', 'scope', 'expectedStationId'],
      ['pageSize', 'cursor', 'snapshot'],
    ) ||
    !wireDay(query.from) ||
    !wireDay(query.to) ||
    query.from > query.to ||
    Date.parse(query.to) - Date.parse(query.from) > 365 * 86400000 ||
    query.scope !== value.binding.scope ||
    query.expectedStationId !== value.binding.sourceStationId ||
    (query.pageSize !== undefined &&
      (!wireSequence(query.pageSize) ||
        query.pageSize < 1 ||
        query.pageSize > 100)) ||
    (query.cursor !== undefined && !wireCursor(query.cursor)) ||
    (query.cursor !== undefined) !== (query.snapshot !== undefined) ||
    (value.restartSnapshot === true && query.cursor !== undefined)
  )
    return false;
  if (
    query.snapshot !== undefined &&
    (!wireObject(query.snapshot, [
      'streamEpoch',
      'highWater',
      'afterGlobalSequence',
    ]) ||
      !wireText(query.snapshot.streamEpoch) ||
      !wireSequence(query.snapshot.highWater) ||
      !wireSequence(query.snapshot.afterGlobalSequence) ||
      query.snapshot.afterGlobalSequence > query.snapshot.highWater)
  )
    return false;
  return wirePage(value.page);
}
/** Strict summary-only storage boundary; authorization stays with the actual Core caller. */
export function parsePrivateUsageCommit(value: unknown): PrivateUsageCommit {
  if (!privateCommitShape(value))
    throw new Error('Private usage commit is invalid');
  parseUsageExportPage(value.page, value.query);
  return value;
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
  phase: 'candidate' | 'expired' | 'cancelled' | 'credential-stored';
  storedCredential?: AnalyticsStoredSourceCredential;
  sync?: AnalyticsSourceSyncStatus;
  sourceConfirmation?: {
    assurance: 'person-approved-https-origin';
    origin: string;
    stationId: string;
    revision: number;
    approvedAt: string;
  };
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

/** Encrypted transport only; source admission and current eligibility are separate. */
export interface AnalyticsSourceCredentialDelivery {
  protocol: 'station-analytics-source-delivery/v1';
  sourceApprovalId: string;
  sourceOperationId: string;
  sourceStationId: string;
  destinationStationId: string;
  recipientId: string;
  revision: number;
  expiresAt: string;
  envelope: string;
  exportAuthority: false;
}
export interface AnalyticsStoredSourceCredential {
  deliveryProof?: {
    claims: {
      protocol: 'station-analytics-delivery-proof/v1';
      sourceApprovalId: string;
      sourceStationId: string;
      recipientId: string;
      recipientBindingSha256: string;
      revision: number;
      credentialSha256: string;
      expiresAt: string;
    };
    signature: string;
  };
  sourceApprovalId: string;
  sourceStationId: string;
  recipientId: string;
  revision: number;
  expiresAt: string;
  credentialStored: true;
  sourceVerified: false;
  exportAuthority: false;
}
