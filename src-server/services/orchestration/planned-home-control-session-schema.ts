import { plainDataObject } from './bounded-json.js';
import { pairedHomeRef } from './personal-home-authority-identity.js';
import { plannedHomeAdmissionIdentifier as identifier } from './planned-home-admission-schema.js';

export interface PlannedHomeControlSessionDatabase {
  prepare(sql: string): {
    all(...values: Array<string | number | null>): unknown[];
  };
}

export interface PlannedHomeControlSessionRecord {
  tenantId: string;
  homeRef: string;
  pairedDeviceId: string;
  homeControlGrantRevision: number;
  openId: string;
  generation: number;
  state: 'active' | 'retired';
  capabilityDigest: string;
  replaySecretDigest: string;
}

export const MAX_PLANNED_HOME_CONTROL_SESSIONS = 4096;
const RECORD_LIMIT = 8192;
const DIGEST = /^[a-f0-9]{64}$/;

export const PLANNED_HOME_CONTROL_SESSION_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS planned_home_control_sessions (
  tenant_id TEXT NOT NULL,
  home_ref TEXT NOT NULL,
  paired_device_id TEXT NOT NULL,
  home_control_grant_revision INTEGER NOT NULL,
  open_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  session_state TEXT NOT NULL CHECK(session_state IN ('active','retired')),
  capability_digest TEXT NOT NULL,
  replay_secret_digest TEXT NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY(tenant_id,home_ref)
);`;

function exact(value: unknown, keys: string[]): boolean {
  return (
    plainDataObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function plannedHomeControlSessionRecordValid(
  value: unknown,
): value is PlannedHomeControlSessionRecord {
  if (!plainDataObject(value)) return false;
  return (
    exact(value, [
      'tenantId',
      'homeRef',
      'pairedDeviceId',
      'homeControlGrantRevision',
      'openId',
      'generation',
      'state',
      'capabilityDigest',
      'replaySecretDigest',
    ]) &&
    [value.tenantId, value.homeRef, value.pairedDeviceId, value.openId].every(
      identifier,
    ) &&
    value.homeRef === pairedHomeRef(value.pairedDeviceId as string) &&
    Number.isSafeInteger(value.homeControlGrantRevision) &&
    (value.homeControlGrantRevision as number) > 0 &&
    (value.homeControlGrantRevision as number) < Number.MAX_SAFE_INTEGER &&
    Number.isSafeInteger(value.generation) &&
    (value.generation as number) > 0 &&
    (value.generation as number) < Number.MAX_SAFE_INTEGER &&
    (value.state === 'active' || value.state === 'retired') &&
    typeof value.capabilityDigest === 'string' &&
    DIGEST.test(value.capabilityDigest) &&
    typeof value.replaySecretDigest === 'string' &&
    DIGEST.test(value.replaySecretDigest)
  );
}

interface SessionRow {
  tenant_id?: unknown;
  home_ref?: unknown;
  paired_device_id?: unknown;
  home_control_grant_revision?: unknown;
  open_id?: unknown;
  generation?: unknown;
  session_state?: unknown;
  capability_digest?: unknown;
  replay_secret_digest?: unknown;
  record_json?: unknown;
}

function parseRow(row: unknown): PlannedHomeControlSessionRecord {
  const columns = row as SessionRow;
  if (typeof columns.record_json !== 'string')
    throw new Error('Invalid home control session record');
  const value = JSON.parse(columns.record_json) as unknown;
  if (
    !plannedHomeControlSessionRecordValid(value) ||
    value.tenantId !== columns.tenant_id ||
    value.homeRef !== columns.home_ref ||
    value.pairedDeviceId !== columns.paired_device_id ||
    value.homeControlGrantRevision !== columns.home_control_grant_revision ||
    value.openId !== columns.open_id ||
    value.generation !== columns.generation ||
    value.state !== columns.session_state ||
    value.capabilityDigest !== columns.capability_digest ||
    value.replaySecretDigest !== columns.replay_secret_digest
  )
    throw new Error('Invalid home control session record');
  return value;
}

export function readPlannedHomeControlSessionJournal(
  database: PlannedHomeControlSessionDatabase,
): PlannedHomeControlSessionRecord[] {
  const rows = database
    .prepare(
      `SELECT tenant_id,home_ref,paired_device_id,home_control_grant_revision,
       open_id,generation,
       session_state,capability_digest,replay_secret_digest,
       CASE WHEN length(CAST(record_json AS BLOB))<=${RECORD_LIMIT}
         THEN record_json END AS record_json
       FROM planned_home_control_sessions
       ORDER BY tenant_id,home_ref
       LIMIT ${MAX_PLANNED_HOME_CONTROL_SESSIONS + 1}`,
    )
    .all();
  if (rows.length > MAX_PLANNED_HOME_CONTROL_SESSIONS)
    throw new Error('Home control session journal capacity exceeded');
  return rows.map(parseRow);
}
