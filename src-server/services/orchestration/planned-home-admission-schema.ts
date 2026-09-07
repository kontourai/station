import { plainDataObject } from './bounded-json.js';

export interface PlannedHomeAdmissionDatabase {
  prepare(sql: string): {
    all(...values: Array<string | number>): unknown[];
  };
}

export interface PlannedHomeAdmissionRecord {
  tenantId: string;
  channelId: string;
  admissionId: string;
  ownerRevision: number;
  homeRef: string;
  kind: 'room-write' | 'execution';
  intentDigest: string;
  state: 'unresolved' | 'finished';
  receiptDigest?: string;
}

export const PLANNED_HOME_ADMISSION_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS planned_home_admissions (
  tenant_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  admission_id TEXT NOT NULL,
  owner_revision INTEGER NOT NULL,
  home_ref TEXT NOT NULL,
  admission_kind TEXT NOT NULL CHECK(admission_kind IN ('room-write','execution')),
  intent_digest TEXT NOT NULL,
  admission_state TEXT NOT NULL CHECK(admission_state IN ('unresolved','finished')),
  receipt_digest TEXT,
  record_json TEXT NOT NULL,
  PRIMARY KEY(tenant_id,admission_id),
  CHECK((admission_state='unresolved' AND receipt_digest IS NULL) OR
        (admission_state='finished' AND receipt_digest IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_planned_home_admissions_channel
ON planned_home_admissions(tenant_id,channel_id,admission_state);`;

const RECORD_LIMIT = 8192;
export const MAX_PLANNED_HOME_ADMISSIONS = 4096;
const DIGEST = /^[a-f0-9]{64}$/;

function exact(value: unknown, keys: string[]): boolean {
  return (
    plainDataObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function plannedHomeAdmissionIdentifier(
  value: unknown,
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 256 &&
    !Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}

export function plannedHomeAdmissionRecordValid(
  value: unknown,
): value is PlannedHomeAdmissionRecord {
  if (!plainDataObject(value)) return false;
  const state = value.state;
  const keys = [
    'tenantId',
    'channelId',
    'admissionId',
    'ownerRevision',
    'homeRef',
    'kind',
    'intentDigest',
    'state',
  ];
  if (state === 'finished') keys.push('receiptDigest');
  return (
    exact(value, keys) &&
    [value.tenantId, value.channelId, value.admissionId, value.homeRef].every(
      plannedHomeAdmissionIdentifier,
    ) &&
    Number.isSafeInteger(value.ownerRevision) &&
    (value.ownerRevision as number) >= 0 &&
    (value.ownerRevision as number) < Number.MAX_SAFE_INTEGER &&
    (value.kind === 'room-write' || value.kind === 'execution') &&
    typeof value.intentDigest === 'string' &&
    DIGEST.test(value.intentDigest) &&
    (state === 'unresolved' ||
      (state === 'finished' &&
        typeof value.receiptDigest === 'string' &&
        DIGEST.test(value.receiptDigest)))
  );
}

interface AdmissionRow {
  tenant_id?: unknown;
  channel_id?: unknown;
  admission_id?: unknown;
  owner_revision?: unknown;
  home_ref?: unknown;
  admission_kind?: unknown;
  intent_digest?: unknown;
  admission_state?: unknown;
  receipt_digest?: unknown;
  record_json?: unknown;
}

export function parsePlannedHomeAdmissionRow(
  row: unknown,
): PlannedHomeAdmissionRecord | undefined {
  if (row === undefined) return undefined;
  const columns = row as AdmissionRow;
  if (typeof columns.record_json !== 'string')
    throw new Error('Invalid home admission record');
  const value = JSON.parse(columns.record_json) as unknown;
  if (
    !plannedHomeAdmissionRecordValid(value) ||
    value.tenantId !== columns.tenant_id ||
    value.channelId !== columns.channel_id ||
    value.admissionId !== columns.admission_id ||
    value.ownerRevision !== columns.owner_revision ||
    value.homeRef !== columns.home_ref ||
    value.kind !== columns.admission_kind ||
    value.intentDigest !== columns.intent_digest ||
    value.state !== columns.admission_state ||
    (value.receiptDigest ?? null) !== columns.receipt_digest
  )
    throw new Error('Invalid home admission record');
  return value;
}

const READ_COLUMNS = `tenant_id,channel_id,admission_id,owner_revision,home_ref,
  admission_kind,intent_digest,admission_state,receipt_digest,
  CASE WHEN length(CAST(record_json AS BLOB))<=${RECORD_LIMIT}
    THEN record_json END AS record_json`;

/**
 * This preview journal is deliberately capacity bounded. Retained finished
 * rows are never silently deleted or reclaimed; reaching the bound requires a
 * later, explicitly designed retention policy.
 */
export function readPlannedHomeAdmissionJournal(
  database: PlannedHomeAdmissionDatabase,
): PlannedHomeAdmissionRecord[] {
  const rows = database
    .prepare(
      `SELECT ${READ_COLUMNS} FROM planned_home_admissions
       ORDER BY tenant_id,admission_id LIMIT ${MAX_PLANNED_HOME_ADMISSIONS + 1}`,
    )
    .all();
  if (rows.length > MAX_PLANNED_HOME_ADMISSIONS)
    throw new Error('Home admission journal capacity exceeded');
  return rows.map((row) => {
    const value = parsePlannedHomeAdmissionRow(row);
    if (!value) throw new Error('Invalid home admission record');
    return value;
  });
}

/** Fails closed when any admission row for the channel is malformed. */
export function checkChannelAdmissions(
  database: PlannedHomeAdmissionDatabase,
  tenantId: string,
  channelId: string,
): 'clear' | 'pending' {
  return readPlannedHomeAdmissionJournal(database).some(
    (value) =>
      value.tenantId === tenantId &&
      value.channelId === channelId &&
      value.state === 'unresolved',
  )
    ? 'pending'
    : 'clear';
}
