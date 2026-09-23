import { createHash } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { openPrivateSqlite } from '../../utils/private-sqlite.js';

const RELAY_ENROLLMENT_MAX_ACTIVE = 500;
const RELAY_ENROLLMENT_MAX_TOMBSTONES = 2_000;
export const RELAY_ENROLLMENT_ACK_REPLAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_RECORD_BYTES = 64 * 1024;
const FORMAT_VERSION = 1;
const APPLICATION_ID = 0x52454c59;

const RELAY_ENROLLMENT_STATES = [
  'challenge',
  'provider-creating',
  'provider-pending',
  'pairing-requested',
  'approved',
  'device-pending',
  'continuation-pending',
  'awaiting-ack',
  'activating',
  'committed',
  'cleaning',
  'failed',
  'denied',
  'expired',
] as const;
export type RelayEnrollmentState = (typeof RELAY_ENROLLMENT_STATES)[number];
export type RelayEnrollmentTerminalState = 'failed' | 'denied' | 'expired';

/** Private durable attempt data. It contains references and proofs, never Device or continuation credentials. */
export interface RelayEnrollmentRecord {
  version: 1;
  enrollmentId: string;
  stationId: string;
  clientOrigin: string;
  /** Canonical Station URL the signed method/path targets. */
  requestOrigin?: string;
  /** Immutable transport binding from an already verified Pion connection. */
  connectionEnrollmentId?: string;
  routingGeneration?: number;
  connectionId?: string;
  keyThumbprint: string;
  publicKey: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  nonce: string;
  expiresAt: number;
  state: RelayEnrollmentState;
  cleaningFrom?: RelayEnrollmentState;
  createdAt: number;
  updatedAt: number;
  providerSessionId?: string;
  loginJti?: string;
  issuer?: string;
  subject?: string;
  displayName?: string;
  offerId?: string;
  requestId?: string;
  offerProof?: string;
  deviceId?: string;
  authorityKey?: string;
  issuedScope?: string[];
  approvalPrincipalId?: string;
  approvalId?: string;
  activationNonce?: string;
  bundleDigest?: string;
  ackJti?: string;
  receiptDigest?: string;
  committedAt?: number;
  receiptExpiresAt?: number;
  terminalReason?: string;
}

/** Hash-only receipt retained after cleanup; lookup remains possible by enrollmentId. */
export interface RelayEnrollmentTombstone {
  version: 1;
  enrollmentIdHash: string;
  stationId: string;
  clientOrigin: string;
  keyThumbprint: string;
  publicKey: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  expiresAt: number;
  state: RelayEnrollmentTerminalState;
  terminalReason: string;
  createdAt: number;
  updatedAt: number;
}

export type RelayEnrollmentEntry =
  | RelayEnrollmentRecord
  | RelayEnrollmentTombstone;
type MutableRelayEnrollmentField = Exclude<
  keyof RelayEnrollmentRecord,
  | 'version'
  | 'enrollmentId'
  | 'stationId'
  | 'clientOrigin'
  | 'requestOrigin'
  | 'connectionEnrollmentId'
  | 'routingGeneration'
  | 'connectionId'
  | 'keyThumbprint'
  | 'publicKey'
  | 'nonce'
  | 'expiresAt'
  | 'state'
  | 'cleaningFrom'
  | 'createdAt'
  | 'updatedAt'
  | 'committedAt'
  | 'receiptExpiresAt'
>;
export type RelayEnrollmentPatch = Partial<
  Pick<RelayEnrollmentRecord, MutableRelayEnrollmentField>
>;
type JournalRow = {
  id_hash: string;
  record_json: string;
  state: string;
  expires_at: number;
  created_at: number;
  updated_at: number;
  is_tombstone: number;
  committed_at: number | null;
  receipt_expires_at: number | null;
};

export class RelayEnrollmentCapacityError extends Error {
  constructor(readonly capacity: 'active-attempts' | 'tombstones') {
    super(`Relay enrollment ${capacity} capacity is exhausted.`);
    this.name = 'RelayEnrollmentCapacityError';
  }
}

export interface RelayEnrollmentJournal {
  reserveChallenge(
    input: Pick<
      RelayEnrollmentRecord,
      | 'enrollmentId'
      | 'stationId'
      | 'clientOrigin'
      | 'requestOrigin'
      | 'connectionEnrollmentId'
      | 'routingGeneration'
      | 'connectionId'
      | 'keyThumbprint'
      | 'publicKey'
      | 'nonce'
      | 'expiresAt'
    >,
  ): RelayEnrollmentRecord;
  get(enrollmentId: string): RelayEnrollmentEntry | undefined;
  transition(input: {
    enrollmentId: string;
    expectedStates: readonly RelayEnrollmentState[];
    nextState: RelayEnrollmentState;
    patch?: RelayEnrollmentPatch;
  }): RelayEnrollmentRecord | null;
  listUnfinished(): RelayEnrollmentRecord[];
  listCommittedReceipts(): RelayEnrollmentRecord[];
  markCleanupComplete(
    enrollmentId: string,
    terminalState?: RelayEnrollmentTerminalState,
  ): RelayEnrollmentTombstone;
  pruneExpiredTombstones(now?: number): number;
  close(): void;
}

interface JournalOptions {
  dbPath: string;
  stationId: string;
  now?: () => number;
  maxActiveAttempts?: number;
  maxTombstones?: number;
  /** A narrow deterministic seam for proving transaction rollback on persistence faults. */
  faultInjector?: (
    operation: 'reserve' | 'transition' | 'cleanup' | 'prune',
  ) => void;
}

const recordKeys = new Set<string>([
  'version',
  'enrollmentId',
  'stationId',
  'clientOrigin',
  'requestOrigin',
  'connectionEnrollmentId',
  'routingGeneration',
  'connectionId',
  'keyThumbprint',
  'publicKey',
  'nonce',
  'expiresAt',
  'state',
  'cleaningFrom',
  'createdAt',
  'updatedAt',
  'providerSessionId',
  'loginJti',
  'issuer',
  'subject',
  'displayName',
  'offerId',
  'requestId',
  'offerProof',
  'deviceId',
  'authorityKey',
  'issuedScope',
  'approvalPrincipalId',
  'approvalId',
  'activationNonce',
  'bundleDigest',
  'ackJti',
  'receiptDigest',
  'terminalReason',
  'committedAt',
  'receiptExpiresAt',
]);
const patchKeys = new Set<string>(
  [...recordKeys].filter(
    (key) =>
      ![
        'version',
        'enrollmentId',
        'stationId',
        'clientOrigin',
        'requestOrigin',
        'connectionEnrollmentId',
        'routingGeneration',
        'connectionId',
        'keyThumbprint',
        'publicKey',
        'nonce',
        'expiresAt',
        'state',
        'cleaningFrom',
        'createdAt',
        'updatedAt',
        'committedAt',
        'receiptExpiresAt',
      ].includes(key),
  ),
);
const tombstoneStates = new Set<RelayEnrollmentState>([
  'failed',
  'denied',
  'expired',
]);
const terminalReasonCodes = new Set([
  'failed',
  'denied',
  'expired',
  'cancelled',
  'provider-rejected',
  'login-proof-rejected',
  'provider-unavailable',
  'pairing-timeout',
  'approval-denied',
  'scope-rejected',
  'activation-failed',
  'ack-invalid',
  'recovery-required',
  'policy-changed',
]);
const writeOnceFields = [
  'providerSessionId',
  'loginJti',
  'issuer',
  'subject',
  'displayName',
  'offerId',
  'requestId',
  'offerProof',
  'deviceId',
  'authorityKey',
  'issuedScope',
  'approvalPrincipalId',
  'approvalId',
  'activationNonce',
  'bundleDigest',
  'ackJti',
  'receiptDigest',
  'terminalReason',
] as const;
const requiredByState: Partial<
  Record<RelayEnrollmentState, readonly string[]>
> = {
  'provider-creating': ['issuer', 'loginJti'],
  'provider-pending': ['providerSessionId', 'issuer', 'subject'],
  'pairing-requested': [
    'providerSessionId',
    'issuer',
    'subject',
    'offerId',
    'requestId',
    'offerProof',
  ],
  approved: [
    'providerSessionId',
    'issuer',
    'subject',
    'offerId',
    'requestId',
    'offerProof',
    'approvalId',
    'approvalPrincipalId',
    'issuedScope',
  ],
  'device-pending': [
    'providerSessionId',
    'issuer',
    'subject',
    'offerId',
    'requestId',
    'offerProof',
    'approvalId',
    'approvalPrincipalId',
    'issuedScope',
    'deviceId',
  ],
  'continuation-pending': [
    'providerSessionId',
    'issuer',
    'subject',
    'offerId',
    'requestId',
    'offerProof',
    'approvalId',
    'approvalPrincipalId',
    'issuedScope',
    'deviceId',
    'authorityKey',
  ],
  'awaiting-ack': [
    'providerSessionId',
    'issuer',
    'subject',
    'offerId',
    'requestId',
    'offerProof',
    'approvalId',
    'approvalPrincipalId',
    'issuedScope',
    'deviceId',
    'authorityKey',
    'activationNonce',
    'bundleDigest',
  ],
  activating: [
    'providerSessionId',
    'issuer',
    'subject',
    'offerId',
    'requestId',
    'offerProof',
    'approvalId',
    'approvalPrincipalId',
    'issuedScope',
    'deviceId',
    'authorityKey',
    'activationNonce',
    'bundleDigest',
    'ackJti',
  ],
  committed: [
    'deviceId',
    'activationNonce',
    'bundleDigest',
    'ackJti',
    'receiptDigest',
  ],
};
const allowedTransitions: Readonly<
  Record<RelayEnrollmentState, ReadonlySet<RelayEnrollmentState>>
> = {
  challenge: new Set(['provider-creating', 'cleaning']),
  'provider-creating': new Set(['provider-pending', 'cleaning']),
  'provider-pending': new Set(['pairing-requested', 'cleaning']),
  'pairing-requested': new Set(['approved', 'cleaning']),
  approved: new Set(['device-pending', 'cleaning']),
  'device-pending': new Set(['continuation-pending', 'cleaning']),
  'continuation-pending': new Set(['awaiting-ack', 'cleaning']),
  'awaiting-ack': new Set(['activating', 'cleaning']),
  activating: new Set(['committed', 'cleaning']),
  committed: new Set(),
  cleaning: new Set(),
  failed: new Set(),
  denied: new Set(),
  expired: new Set(),
};

const META_TABLE_SQL =
  'CREATE TABLE relay_enrollment_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), format_version INTEGER NOT NULL, station_id TEXT NOT NULL)';
const JOURNAL_TABLE_SQL =
  'CREATE TABLE relay_enrollment_journal (id_hash TEXT PRIMARY KEY, record_json TEXT NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, is_tombstone INTEGER NOT NULL DEFAULT 0 CHECK(is_tombstone IN (0,1)), committed_at INTEGER, receipt_expires_at INTEGER)';
const expectedTableSql = new Map([
  ['relay_enrollment_meta', META_TABLE_SQL],
  ['relay_enrollment_journal', JOURNAL_TABLE_SQL],
]);

function normalizeSql(sql: string | null): string {
  return (sql ?? '').replace(/\s+/g, ' ').trim();
}

function enrollmentHash(enrollmentId: string): string {
  return createHash('sha256').update(enrollmentId, 'utf8').digest('hex');
}

function assertText(
  value: unknown,
  label: string,
  maximum = 4096,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes('\0')
  )
    throw new Error(`Invalid relay enrollment ${label}.`);
}

function validateRecord(
  value: unknown,
  stationId: string,
): RelayEnrollmentRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid relay enrollment record.');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (!recordKeys.has(key))
      throw new Error('Unknown relay enrollment record field.');
  if (
    record.version !== FORMAT_VERSION ||
    record.stationId !== stationId ||
    !RELAY_ENROLLMENT_STATES.includes(record.state as RelayEnrollmentState)
  )
    throw new Error('Invalid relay enrollment record closure.');
  assertText(record.enrollmentId, 'enrollment id', 512);
  if (
    record.enrollmentId.length < 32 ||
    !/^[A-Za-z0-9_-]+$/.test(record.enrollmentId)
  )
    throw new Error('Invalid relay enrollment enrollment id.');
  assertText(record.stationId, 'Station id', 512);
  assertText(record.clientOrigin, 'client origin', 2048);
  if (record.requestOrigin !== undefined) {
    assertText(record.requestOrigin, 'request origin', 2048);
    try {
      const requestOrigin = new URL(record.requestOrigin as string);
      if (
        requestOrigin.origin !== record.requestOrigin ||
        !['https:', 'http:'].includes(requestOrigin.protocol) ||
        (requestOrigin.protocol === 'http:' &&
          !['localhost', '127.0.0.1', '[::1]'].includes(requestOrigin.hostname))
      )
        throw new Error();
    } catch {
      throw new Error('Invalid relay enrollment canonical request origin.');
    }
  }
  const transportFields = [
    record.connectionEnrollmentId,
    record.routingGeneration,
    record.connectionId,
  ];
  if (transportFields.some((field) => field !== undefined)) {
    assertText(record.connectionEnrollmentId, 'connection enrollment id', 128);
    assertText(record.connectionId, 'Pion connection id', 128);
    if (
      !Number.isSafeInteger(record.routingGeneration) ||
      (record.routingGeneration as number) < 1 ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(record.connectionEnrollmentId as string) ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(record.connectionId as string) ||
      record.requestOrigin === undefined
    )
      throw new Error('Invalid relay enrollment Pion transport binding.');
  }
  assertText(record.keyThumbprint, 'key thumbprint', 256);
  if (
    record.keyThumbprint.length !== 43 ||
    !/^[A-Za-z0-9_-]+$/.test(record.keyThumbprint)
  )
    throw new Error('Invalid relay enrollment key thumbprint.');
  const publicKey =
    record.publicKey &&
    typeof record.publicKey === 'object' &&
    !Array.isArray(record.publicKey)
      ? (record.publicKey as Record<string, unknown>)
      : undefined;
  if (
    !publicKey ||
    Object.keys(publicKey).sort().join(',') !== 'crv,kty,x,y' ||
    publicKey.kty !== 'EC' ||
    publicKey.crv !== 'P-256' ||
    typeof publicKey.x !== 'string' ||
    typeof publicKey.y !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(publicKey.x) ||
    !/^[A-Za-z0-9_-]{43}$/.test(publicKey.y)
  )
    throw new Error('Invalid relay enrollment P-256 public key.');
  assertText(record.nonce, 'nonce', 1024);
  if (record.nonce.length < 24 || !/^[A-Za-z0-9_-]+$/.test(record.nonce))
    throw new Error('Invalid relay enrollment nonce.');
  try {
    const origin = new URL(record.clientOrigin as string);
    if (
      origin.origin !== record.clientOrigin ||
      !['https:', 'http:'].includes(origin.protocol) ||
      (origin.protocol === 'http:' &&
        !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
    )
      throw new Error();
  } catch {
    throw new Error('Invalid relay enrollment canonical client origin.');
  }
  if (
    ![record.expiresAt, record.createdAt, record.updatedAt].every(
      (v) => Number.isSafeInteger(v) && (v as number) >= 0,
    ) ||
    (record.updatedAt as number) < (record.createdAt as number)
  )
    throw new Error('Invalid relay enrollment timestamps.');
  for (const key of [
    'providerSessionId',
    'loginJti',
    'issuer',
    'subject',
    'displayName',
    'offerId',
    'requestId',
    'offerProof',
    'deviceId',
    'authorityKey',
    'approvalPrincipalId',
    'approvalId',
    'activationNonce',
    'bundleDigest',
    'ackJti',
    'receiptDigest',
    'terminalReason',
  ]) {
    if (record[key] !== undefined)
      assertText(record[key], key, key === 'offerProof' ? 8192 : 4096);
  }
  if (
    record.terminalReason !== undefined &&
    !terminalReasonCodes.has(record.terminalReason as string)
  )
    throw new Error('Invalid relay enrollment terminal reason code.');
  if (
    record.state !== 'committed' &&
    (record.committedAt !== undefined || record.receiptExpiresAt !== undefined)
  )
    throw new Error('Invalid relay enrollment commit receipt fields.');
  if (
    record.state === 'committed' &&
    ![record.committedAt, record.receiptExpiresAt].every(
      (value) => Number.isSafeInteger(value) && (value as number) >= 0,
    )
  )
    throw new Error(
      'Committed relay enrollment is missing receipt timestamps.',
    );
  if (
    record.issuedScope !== undefined &&
    (!Array.isArray(record.issuedScope) ||
      record.issuedScope.length > 64 ||
      record.issuedScope.some(
        (scope) =>
          typeof scope !== 'string' || scope.length === 0 || scope.length > 256,
      ))
  )
    throw new Error('Invalid relay enrollment issued scope.');
  for (const field of requiredByState[record.state as RelayEnrollmentState] ??
    []) {
    const fieldValue = record[field];
    if (
      fieldValue === undefined ||
      fieldValue === null ||
      fieldValue === '' ||
      (field === 'issuedScope' &&
        (!Array.isArray(fieldValue) || fieldValue.length === 0))
    )
      throw new Error(
        `Relay enrollment ${String(record.state)} state requires ${field}.`,
      );
  }
  if (record.state === 'cleaning') {
    const cleaningFrom = record.cleaningFrom;
    if (
      typeof cleaningFrom !== 'string' ||
      !RELAY_ENROLLMENT_STATES.includes(cleaningFrom as RelayEnrollmentState) ||
      ['cleaning', 'committed', 'failed', 'denied', 'expired'].includes(
        cleaningFrom,
      )
    )
      throw new Error('Cleaning relay enrollment is missing its source state.');
    for (const field of requiredByState[cleaningFrom as RelayEnrollmentState] ??
      []) {
      const fieldValue = record[field];
      if (
        fieldValue === undefined ||
        fieldValue === null ||
        fieldValue === '' ||
        (field === 'issuedScope' &&
          (!Array.isArray(fieldValue) || fieldValue.length === 0))
      )
        throw new Error(
          `Cleaning relay enrollment from ${cleaningFrom} is missing ${field}.`,
        );
    }
  } else if (record.cleaningFrom !== undefined) {
    throw new Error(
      'Non-cleaning relay enrollment contains a cleanup source state.',
    );
  }
  if (
    record.state === 'committed' &&
    [
      'providerSessionId',
      'loginJti',
      'issuer',
      'subject',
      'displayName',
      'offerId',
      'requestId',
      'offerProof',
      'authorityKey',
      'issuedScope',
      'approvalPrincipalId',
      'approvalId',
    ].some((field) => record[field] !== undefined)
  )
    throw new Error(
      'Committed relay enrollment contains pre-commit resource references.',
    );
  const json = JSON.stringify(record);
  if (Buffer.byteLength(json, 'utf8') > MAX_RECORD_BYTES)
    throw new Error('Relay enrollment record exceeds the size limit.');
  return structuredClone(record) as unknown as RelayEnrollmentRecord;
}

function decodeRecord(
  raw: unknown,
  stationId: string,
  idHash: string,
): RelayEnrollmentEntry {
  if (
    typeof raw !== 'string' ||
    Buffer.byteLength(raw, 'utf8') > MAX_RECORD_BYTES
  )
    throw new Error('Corrupt relay enrollment record.');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Corrupt relay enrollment record.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Corrupt relay enrollment record.');
  const row = value as Record<string, unknown>;
  if ('enrollmentIdHash' in row) {
    const allowed = new Set([
      'version',
      'enrollmentIdHash',
      'stationId',
      'clientOrigin',
      'keyThumbprint',
      'publicKey',
      'expiresAt',
      'state',
      'terminalReason',
      'createdAt',
      'updatedAt',
    ]);
    if (
      Object.keys(row).some((key) => !allowed.has(key)) ||
      row.version !== FORMAT_VERSION ||
      row.enrollmentIdHash !== idHash ||
      row.stationId !== stationId ||
      !tombstoneStates.has(row.state as RelayEnrollmentState)
    )
      throw new Error('Corrupt relay enrollment tombstone.');
    for (const key of ['clientOrigin', 'keyThumbprint', 'terminalReason'])
      assertText(row[key], key);
    if (
      (row.keyThumbprint as string).length !== 43 ||
      !/^[A-Za-z0-9_-]+$/.test(row.keyThumbprint as string)
    )
      throw new Error('Corrupt relay enrollment tombstone thumbprint.');
    try {
      const origin = new URL(row.clientOrigin as string);
      if (
        origin.origin !== row.clientOrigin ||
        !['https:', 'http:'].includes(origin.protocol) ||
        (origin.protocol === 'http:' &&
          !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
      )
        throw new Error();
    } catch {
      throw new Error('Corrupt relay enrollment tombstone origin.');
    }
    if (!terminalReasonCodes.has(row.terminalReason as string))
      throw new Error('Corrupt relay enrollment terminal reason code.');
    if (
      !row.publicKey ||
      typeof row.publicKey !== 'object' ||
      Array.isArray(row.publicKey) ||
      Object.keys(row.publicKey).sort().join(',') !== 'crv,kty,x,y' ||
      (row.publicKey as Record<string, unknown>).kty !== 'EC' ||
      (row.publicKey as Record<string, unknown>).crv !== 'P-256' ||
      !/^[A-Za-z0-9_-]{43}$/.test(
        String((row.publicKey as Record<string, unknown>).x),
      ) ||
      !/^[A-Za-z0-9_-]{43}$/.test(
        String((row.publicKey as Record<string, unknown>).y),
      )
    )
      throw new Error('Corrupt relay enrollment tombstone public key.');
    if (
      ![row.expiresAt, row.createdAt, row.updatedAt].every(
        (v) => Number.isSafeInteger(v) && (v as number) >= 0,
      ) ||
      (row.updatedAt as number) < (row.createdAt as number)
    )
      throw new Error('Corrupt relay enrollment tombstone timestamps.');
    return structuredClone(row) as unknown as RelayEnrollmentTombstone;
  }
  const record = validateRecord(value, stationId);
  if (tombstoneStates.has(record.state))
    throw new Error(
      'Corrupt relay enrollment terminal record was not tombstoned.',
    );
  if (enrollmentHash(record.enrollmentId) !== idHash)
    throw new Error('Relay enrollment index does not match record.');
  return record;
}

function decodeRow(
  row: {
    id_hash: string;
    record_json: string;
    state: string;
    expires_at: number;
    created_at: number;
    updated_at: number;
    is_tombstone: number;
    committed_at: number | null;
    receipt_expires_at: number | null;
  },
  stationId: string,
): RelayEnrollmentEntry {
  const entry = decodeRecord(row.record_json, stationId, row.id_hash);
  const committedAt =
    'committedAt' in entry ? (entry.committedAt ?? null) : null;
  const receiptExpiresAt =
    'receiptExpiresAt' in entry ? (entry.receiptExpiresAt ?? null) : null;
  if (
    entry.state !== row.state ||
    entry.expiresAt !== row.expires_at ||
    entry.createdAt !== row.created_at ||
    entry.updatedAt !== row.updated_at ||
    Number('enrollmentIdHash' in entry) !== row.is_tombstone ||
    committedAt !== row.committed_at ||
    receiptExpiresAt !== row.receipt_expires_at
  )
    throw new Error(
      'Relay enrollment journal index is inconsistent with its record.',
    );
  return entry;
}

function validateCapacity(
  value: number | undefined,
  hardMaximum: number,
  label: string,
): number {
  const capacity = value ?? hardMaximum;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > hardMaximum)
    throw new Error(`Invalid relay enrollment ${label} capacity.`);
  return capacity;
}

/** Private durable relay recovery journal. It stores no Device or continuation credential and grants no authority itself. */
export function openRelayEnrollmentJournal(
  options: JournalOptions,
): RelayEnrollmentJournal {
  assertText(options.stationId, 'Station id', 512);
  const now = options.now ?? Date.now;
  const maxActive = validateCapacity(
    options.maxActiveAttempts,
    RELAY_ENROLLMENT_MAX_ACTIVE,
    'active-attempt',
  );
  const maxTombstones = validateCapacity(
    options.maxTombstones,
    RELAY_ENROLLMENT_MAX_TOMBSTONES,
    'tombstone',
  );
  const db: DatabaseSync = openPrivateSqlite(
    options.dbPath,
    'RelayEnrollmentJournal',
  );
  const run = (sql: string, ...args: SQLInputValue[]) =>
    db.prepare(sql).run(...args);
  const one = <T>(sql: string, ...args: SQLInputValue[]) =>
    db.prepare(sql).get(...args) as T | undefined;
  const all = <T>(sql: string, ...args: SQLInputValue[]) =>
    db.prepare(sql).all(...args) as T[];
  const transaction = <T>(operation: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw error;
    }
  };
  try {
    const integrity = all<{ integrity_check: string }>(
      'PRAGMA integrity_check',
    );
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
      throw new Error('Relay enrollment journal integrity check failed.');
    const schemaObjects = all<{
      type: string;
      name: string;
      sql: string | null;
    }>(
      `SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`,
    );
    const applicationId =
      one<{ application_id: number }>('PRAGMA application_id')
        ?.application_id ?? 0;
    const userVersion =
      one<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0;
    const isFresh =
      schemaObjects.length === 0 && applicationId === 0 && userVersion === 0;
    if (isFresh) {
      transaction(() => {
        db.exec(
          `${META_TABLE_SQL}; ${JOURNAL_TABLE_SQL}; PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${FORMAT_VERSION};`,
        );
        run(
          'INSERT INTO relay_enrollment_meta(singleton,format_version,station_id) VALUES(1,?,?)',
          FORMAT_VERSION,
          options.stationId,
        );
      });
    } else {
      if (
        applicationId !== APPLICATION_ID ||
        userVersion !== FORMAT_VERSION ||
        schemaObjects.length !== expectedTableSql.size ||
        schemaObjects.some(
          (object) =>
            object.type !== 'table' ||
            !expectedTableSql.has(object.name) ||
            normalizeSql(object.sql) !== expectedTableSql.get(object.name),
        )
      )
        throw new Error('Relay enrollment journal schema is incompatible.');
    }
    {
      const meta = one<{ format_version: number; station_id: string }>(
        'SELECT format_version, station_id FROM relay_enrollment_meta WHERE singleton=1',
      );
      if (!meta)
        throw new Error(
          'Relay enrollment journal is missing Station identity metadata.',
        );
      if (
        meta.format_version !== FORMAT_VERSION ||
        meta.station_id !== options.stationId
      )
        throw new Error(
          'Relay enrollment journal belongs to a different Station identity or schema.',
        );
    }
    for (const row of all<{
      id_hash: string;
      record_json: string;
      state: string;
      expires_at: number;
      created_at: number;
      updated_at: number;
      is_tombstone: number;
      committed_at: number | null;
      receipt_expires_at: number | null;
    }>(
      'SELECT id_hash,record_json,state,expires_at,created_at,updated_at,is_tombstone,committed_at,receipt_expires_at FROM relay_enrollment_journal',
    ))
      decodeRow(row, options.stationId);
  } catch (error) {
    db.close();
    throw error;
  }

  const getRow = (id: string) =>
    one<{
      id_hash: string;
      record_json: string;
      state: string;
      expires_at: number;
      created_at: number;
      updated_at: number;
      is_tombstone: number;
      committed_at: number | null;
      receipt_expires_at: number | null;
    }>(
      'SELECT id_hash,record_json,state,expires_at,created_at,updated_at,is_tombstone,committed_at,receipt_expires_at FROM relay_enrollment_journal WHERE id_hash=?',
      enrollmentHash(id),
    );
  const get = (id: string) => {
    assertText(id, 'enrollment id', 512);
    const row = getRow(id);
    return row ? decodeRow(row, options.stationId) : undefined;
  };
  const allRows = () =>
    all<JournalRow>(
      'SELECT id_hash,record_json,state,expires_at,created_at,updated_at,is_tombstone,committed_at,receipt_expires_at FROM relay_enrollment_journal ORDER BY created_at,id_hash',
    );
  const validateAllRows = () =>
    allRows().map((row) => decodeRow(row, options.stationId));
  const save = (record: RelayEnrollmentEntry, idHash: string) => {
    const encoded = JSON.stringify(record);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_RECORD_BYTES)
      throw new Error('Relay enrollment record exceeds the size limit.');
    const tombstone = Number('enrollmentIdHash' in record);
    const committedAt =
      'committedAt' in record ? (record.committedAt ?? null) : null;
    const receiptExpiresAt =
      'receiptExpiresAt' in record ? (record.receiptExpiresAt ?? null) : null;
    run(
      `INSERT INTO relay_enrollment_journal(id_hash,record_json,state,expires_at,created_at,updated_at,is_tombstone,committed_at,receipt_expires_at) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id_hash) DO UPDATE SET record_json=excluded.record_json,state=excluded.state,expires_at=excluded.expires_at,created_at=excluded.created_at,updated_at=excluded.updated_at,is_tombstone=excluded.is_tombstone,committed_at=excluded.committed_at,receipt_expires_at=excluded.receipt_expires_at`,
      idHash,
      encoded,
      record.state,
      record.expiresAt,
      record.createdAt,
      record.updatedAt,
      tombstone,
      committedAt,
      receiptExpiresAt,
    );
  };

  return {
    reserveChallenge(input) {
      const allowedInput = new Set([
        'enrollmentId',
        'stationId',
        'clientOrigin',
        'requestOrigin',
        'connectionEnrollmentId',
        'routingGeneration',
        'connectionId',
        'keyThumbprint',
        'publicKey',
        'nonce',
        'expiresAt',
      ]);
      if (Object.keys(input).some((key) => !allowedInput.has(key)))
        throw new Error(
          'Relay enrollment challenge contains non-binding fields.',
        );
      const timestamp = now();
      const record = validateRecord(
        {
          ...input,
          version: 1,
          state: 'challenge',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        options.stationId,
      );
      if (
        !Number.isSafeInteger(timestamp) ||
        timestamp < 0 ||
        record.expiresAt <= timestamp
      )
        throw new Error(
          'Relay enrollment challenge must expire in the future.',
        );
      return transaction(() => {
        validateAllRows();
        db.prepare(
          `DELETE FROM relay_enrollment_journal WHERE is_tombstone=1 AND updated_at + ? <= ?`,
        ).run(RELAY_ENROLLMENT_ACK_REPLAY_WINDOW_MS, timestamp);
        db.prepare(
          `DELETE FROM relay_enrollment_journal WHERE state='committed' AND receipt_expires_at <= ?`,
        ).run(timestamp);
        const idHash = enrollmentHash(record.enrollmentId);
        if (
          one(
            'SELECT 1 AS present FROM relay_enrollment_journal WHERE id_hash=?',
            idHash,
          )
        )
          throw new Error('Relay enrollment already exists.');
        const active = one<{ count: number }>(
          `SELECT count(*) AS count FROM relay_enrollment_journal WHERE is_tombstone=0 AND state!='committed'`,
        );
        if ((active?.count ?? 0) >= maxActive)
          throw new RelayEnrollmentCapacityError('active-attempts');
        const retained = one<{ count: number }>(
          `SELECT count(*) AS count FROM relay_enrollment_journal WHERE is_tombstone=1 OR state='committed'`,
        );
        if ((retained?.count ?? 0) + (active?.count ?? 0) >= maxTombstones)
          throw new RelayEnrollmentCapacityError('tombstones');
        save(record, idHash);
        options.faultInjector?.('reserve');
        return structuredClone(record);
      });
    },
    get,
    transition(input) {
      assertText(input.enrollmentId, 'enrollment id', 512);
      if (
        !RELAY_ENROLLMENT_STATES.includes(input.nextState) ||
        input.expectedStates.length === 0 ||
        input.expectedStates.some(
          (state) => !RELAY_ENROLLMENT_STATES.includes(state),
        )
      )
        throw new Error('Invalid relay enrollment transition state.');
      const patch = input.patch ?? {};
      for (const key of Object.keys(patch))
        if (!patchKeys.has(key))
          throw new Error(
            'Relay enrollment transition cannot change immutable fields.',
          );
      return transaction(() => {
        validateAllRows();
        const entry = get(input.enrollmentId);
        if (
          !entry ||
          !('enrollmentId' in entry) ||
          !input.expectedStates.includes(entry.state)
        )
          return null;
        if (!allowedTransitions[entry.state].has(input.nextState))
          throw new Error('Invalid relay enrollment state transition.');
        for (const key of writeOnceFields) {
          const before = entry[key];
          const after = patch[key];
          if (
            before !== undefined &&
            after !== undefined &&
            JSON.stringify(before) !== JSON.stringify(after)
          )
            throw new Error(`Relay enrollment ${key} is immutable once set.`);
          if (
            before !== undefined &&
            after === undefined &&
            Object.hasOwn(patch, key)
          )
            throw new Error(`Relay enrollment ${key} cannot be cleared.`);
        }
        const timestamp = now();
        if (timestamp >= entry.expiresAt && input.nextState !== 'cleaning')
          throw new Error('Expired relay enrollment cannot advance.');
        let candidate: Record<string, unknown> = {
          ...entry,
          ...patch,
          state: input.nextState,
          updatedAt: timestamp,
        };
        if (input.nextState === 'cleaning')
          candidate.cleaningFrom = entry.state;
        if (input.nextState === 'committed') {
          for (const field of [
            'deviceId',
            'authorityKey',
            'activationNonce',
            'bundleDigest',
            'ackJti',
            'receiptDigest',
          ])
            if (!candidate[field])
              throw new Error(`Committed relay enrollment requires ${field}.`);
          candidate = {
            version: candidate.version,
            enrollmentId: candidate.enrollmentId,
            stationId: candidate.stationId,
            clientOrigin: candidate.clientOrigin,
            keyThumbprint: candidate.keyThumbprint,
            publicKey: candidate.publicKey,
            nonce: candidate.nonce,
            expiresAt: candidate.expiresAt,
            state: 'committed',
            createdAt: candidate.createdAt,
            updatedAt: timestamp,
            deviceId: candidate.deviceId,
            activationNonce: candidate.activationNonce,
            bundleDigest: candidate.bundleDigest,
            ackJti: candidate.ackJti,
            receiptDigest: candidate.receiptDigest,
            committedAt: timestamp,
            receiptExpiresAt: timestamp + RELAY_ENROLLMENT_ACK_REPLAY_WINDOW_MS,
          };
        }
        const next = validateRecord(candidate, options.stationId);
        save(next, enrollmentHash(input.enrollmentId));
        options.faultInjector?.('transition');
        return structuredClone(next);
      });
    },
    listUnfinished() {
      return validateAllRows().filter(
        (entry): entry is RelayEnrollmentRecord =>
          'enrollmentId' in entry && entry.state !== 'committed',
      );
    },
    listCommittedReceipts() {
      return validateAllRows().filter(
        (entry): entry is RelayEnrollmentRecord =>
          'enrollmentId' in entry && entry.state === 'committed',
      );
    },
    markCleanupComplete(enrollmentId, terminalState) {
      assertText(enrollmentId, 'enrollment id', 512);
      return transaction(() => {
        validateAllRows();
        const current = get(enrollmentId);
        if (current && 'enrollmentIdHash' in current) return current;
        if (
          !current ||
          !('enrollmentId' in current) ||
          current.state !== 'cleaning'
        )
          throw new Error(
            'Relay enrollment is not eligible for cleanup completion.',
          );
        const state = terminalState ?? 'failed';
        if (!tombstoneStates.has(state))
          throw new Error('Invalid relay enrollment tombstone state.');
        const timestamp = now();
        if (!Number.isSafeInteger(timestamp) || timestamp < current.createdAt)
          throw new Error('Invalid relay enrollment cleanup timestamp.');
        db.prepare(
          `DELETE FROM relay_enrollment_journal WHERE is_tombstone=1 AND updated_at + ? <= ?`,
        ).run(RELAY_ENROLLMENT_ACK_REPLAY_WINDOW_MS, timestamp);
        db.prepare(
          `DELETE FROM relay_enrollment_journal WHERE state='committed' AND receipt_expires_at <= ?`,
        ).run(timestamp);
        const count = one<{ count: number }>(
          `SELECT count(*) AS count FROM relay_enrollment_journal WHERE is_tombstone=1 OR state='committed'`,
        );
        if ((count?.count ?? 0) >= maxTombstones)
          throw new RelayEnrollmentCapacityError('tombstones');
        const reason = current.terminalReason ?? state;
        const tombstone: RelayEnrollmentTombstone = {
          version: 1,
          enrollmentIdHash: enrollmentHash(enrollmentId),
          stationId: options.stationId,
          clientOrigin: current.clientOrigin,
          keyThumbprint: current.keyThumbprint,
          publicKey: current.publicKey,
          expiresAt: current.expiresAt,
          state,
          terminalReason: reason,
          createdAt: current.createdAt,
          updatedAt: timestamp,
        };
        if (!terminalReasonCodes.has(reason))
          throw new Error('Invalid relay enrollment terminal reason code.');
        save(tombstone, tombstone.enrollmentIdHash);
        options.faultInjector?.('cleanup');
        return structuredClone(tombstone);
      });
    },
    pruneExpiredTombstones(at = now()) {
      if (!Number.isSafeInteger(at) || at < 0)
        throw new Error('Invalid relay enrollment prune time.');
      return transaction(() => {
        validateAllRows();
        const tombstones = db
          .prepare(
            `DELETE FROM relay_enrollment_journal WHERE is_tombstone=1 AND updated_at + ? <= ?`,
          )
          .run(RELAY_ENROLLMENT_ACK_REPLAY_WINDOW_MS, at) as {
          changes?: number;
        };
        // Committed ACK receipts are retained through their whole replay window.
        const receipts = db
          .prepare(
            `DELETE FROM relay_enrollment_journal WHERE state='committed' AND receipt_expires_at <= ?`,
          )
          .run(at) as { changes?: number };
        options.faultInjector?.('prune');
        return (tombstones.changes ?? 0) + (receipts.changes ?? 0);
      });
    },
    close() {
      db.close();
    },
  };
}
