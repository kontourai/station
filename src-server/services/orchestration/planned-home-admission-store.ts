import {
  MAX_PLANNED_HOME_ADMISSIONS,
  PLANNED_HOME_ADMISSION_SCHEMA_SQL,
  type PlannedHomeAdmissionRecord,
  plannedHomeAdmissionRecordValid,
  readPlannedHomeAdmissionJournal,
} from './planned-home-admission-schema.js';
import {
  assertDurableHomeTransferDatabase,
  type HomeTransferDurableDatabase,
  readPlannedHomeOwner,
} from './planned-home-transfer-store.js';

export type PlannedHomeAdmissionBegin = Omit<
  PlannedHomeAdmissionRecord,
  'state' | 'receiptDigest'
>;
export type PlannedHomeAdmissionFinish = PlannedHomeAdmissionBegin & {
  receiptDigest: string;
};
export type PlannedHomeAdmissionStoreResult<T> =
  | { kind: 'stored'; value: T }
  | { kind: 'conflict' | 'not-found' | 'unavailable' | 'denied' };

const DIGEST = /^[a-f0-9]{64}$/;

function exact(value: unknown, keys: string[]): boolean {
  if (value === null || typeof value !== 'object') return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return (
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).every((key) => typeof key === 'string') &&
    Object.keys(descriptors).length === keys.length &&
    keys.every(
      (key) =>
        Object.hasOwn(descriptors, key) &&
        'value' in descriptors[key]! &&
        descriptors[key]!.enumerable === true,
    )
  );
}

function beginValid(value: PlannedHomeAdmissionBegin): boolean {
  return (
    exact(value, [
      'tenantId',
      'channelId',
      'admissionId',
      'ownerRevision',
      'homeRef',
      'kind',
      'intentDigest',
    ]) && plannedHomeAdmissionRecordValid({ ...value, state: 'unresolved' })
  );
}

function snapshotBegin(
  value: PlannedHomeAdmissionBegin,
): PlannedHomeAdmissionBegin | undefined {
  if (!beginValid(value)) return undefined;
  return {
    tenantId: value.tenantId,
    channelId: value.channelId,
    admissionId: value.admissionId,
    ownerRevision: value.ownerRevision,
    homeRef: value.homeRef,
    kind: value.kind,
    intentDigest: value.intentDigest,
  };
}

function finishValid(value: PlannedHomeAdmissionFinish): boolean {
  return (
    exact(value, [
      'tenantId',
      'channelId',
      'admissionId',
      'ownerRevision',
      'homeRef',
      'kind',
      'intentDigest',
      'receiptDigest',
    ]) &&
    typeof value.receiptDigest === 'string' &&
    DIGEST.test(value.receiptDigest) &&
    beginValid({
      tenantId: value.tenantId,
      channelId: value.channelId,
      admissionId: value.admissionId,
      ownerRevision: value.ownerRevision,
      homeRef: value.homeRef,
      kind: value.kind,
      intentDigest: value.intentDigest,
    })
  );
}

function snapshotFinish(
  value: PlannedHomeAdmissionFinish,
): PlannedHomeAdmissionFinish | undefined {
  if (!finishValid(value)) return undefined;
  return {
    tenantId: value.tenantId,
    channelId: value.channelId,
    admissionId: value.admissionId,
    ownerRevision: value.ownerRevision,
    homeRef: value.homeRef,
    kind: value.kind,
    intentDigest: value.intentDigest,
    receiptDigest: value.receiptDigest,
  };
}

function sameIdentity(
  record: PlannedHomeAdmissionRecord,
  input: PlannedHomeAdmissionBegin,
): boolean {
  return (
    record.tenantId === input.tenantId &&
    record.channelId === input.channelId &&
    record.admissionId === input.admissionId &&
    record.ownerRevision === input.ownerRevision &&
    record.homeRef === input.homeRef &&
    record.kind === input.kind &&
    record.intentDigest === input.intentDigest
  );
}

class AdmissionAuthorizationDenied extends Error {}

/**
 * Private durable admission bookkeeping only. A returned record is neither an
 * execution grant nor receipt verification; the caller owns both decisions.
 */
export function createPlannedHomeAdmissionStore(
  database: HomeTransferDurableDatabase,
  requireSynchronousAuthorization: () => boolean,
) {
  if (typeof requireSynchronousAuthorization !== 'function')
    throw new Error('Home admission authorization guard is required');

  function checkAuthorization(): void {
    const allowed = requireSynchronousAuthorization();
    if (allowed !== true) {
      void Promise.resolve(allowed).catch(() => {});
      throw new AdmissionAuthorizationDenied();
    }
  }

  assertDurableHomeTransferDatabase(database);
  database.exec(PLANNED_HOME_ADMISSION_SCHEMA_SQL);

  function ownerMatches(input: PlannedHomeAdmissionBegin): boolean {
    const owner = readPlannedHomeOwner(
      database,
      input.tenantId,
      input.channelId,
    );
    return (
      owner?.homeRef === input.homeRef && owner.revision === input.ownerRevision
    );
  }

  function save(record: PlannedHomeAdmissionRecord): void {
    if (!plannedHomeAdmissionRecordValid(record))
      throw new Error('Invalid home admission record');
    const json = JSON.stringify(record);
    if (Buffer.byteLength(json) > 8192)
      throw new Error('Oversized home admission record');
    database
      .prepare(
        `INSERT INTO planned_home_admissions VALUES(?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(tenant_id,admission_id) DO UPDATE SET
           admission_state=excluded.admission_state,
           receipt_digest=excluded.receipt_digest,
           record_json=excluded.record_json`,
      )
      .run(
        record.tenantId,
        record.channelId,
        record.admissionId,
        record.ownerRevision,
        record.homeRef,
        record.kind,
        record.intentDigest,
        record.state,
        record.receiptDigest ?? null,
        json,
      );
  }

  function transaction<T>(
    run: () => PlannedHomeAdmissionStoreResult<T>,
  ): PlannedHomeAdmissionStoreResult<T> {
    let began = false;
    try {
      checkAuthorization();
      database.exec('BEGIN IMMEDIATE');
      began = true;
      assertDurableHomeTransferDatabase(database);
      checkAuthorization();
      const result = run();
      checkAuthorization();
      database.exec('COMMIT');
      began = false;
      return result;
    } catch (error) {
      if (began) {
        try {
          database.exec('ROLLBACK');
        } catch {}
      }
      return {
        kind:
          error instanceof AdmissionAuthorizationDenied
            ? 'denied'
            : 'unavailable',
      };
    }
  }

  return {
    begin(
      input: PlannedHomeAdmissionBegin,
    ): PlannedHomeAdmissionStoreResult<PlannedHomeAdmissionRecord> {
      const snapshot = snapshotBegin(input);
      return transaction<PlannedHomeAdmissionRecord>(() => {
        if (!snapshot) return { kind: 'conflict' };
        const journal = readPlannedHomeAdmissionJournal(database);
        const prior = journal.find(
          (record) =>
            record.tenantId === snapshot.tenantId &&
            record.admissionId === snapshot.admissionId,
        );
        if (prior) {
          if (!sameIdentity(prior, snapshot)) return { kind: 'conflict' };
          if (prior.state === 'finished')
            return { kind: 'stored', value: prior };
          return ownerMatches(snapshot)
            ? { kind: 'stored', value: prior }
            : { kind: 'conflict' };
        }
        if (journal.length >= MAX_PLANNED_HOME_ADMISSIONS)
          return { kind: 'conflict' };
        if (!ownerMatches(snapshot)) return { kind: 'conflict' };
        if (
          database
            .prepare(
              `SELECT 1 FROM planned_home_transfers
               WHERE tenant_id=? AND channel_id=? AND pending=1`,
            )
            .get(snapshot.tenantId, snapshot.channelId)
        )
          return { kind: 'conflict' };
        const record: PlannedHomeAdmissionRecord = {
          ...snapshot,
          state: 'unresolved',
        };
        save(record);
        return { kind: 'stored', value: record };
      });
    },

    finish(
      input: PlannedHomeAdmissionFinish,
    ): PlannedHomeAdmissionStoreResult<PlannedHomeAdmissionRecord> {
      const snapshot = snapshotFinish(input);
      return transaction<PlannedHomeAdmissionRecord>(() => {
        if (!snapshot) return { kind: 'conflict' };
        const prior = readPlannedHomeAdmissionJournal(database).find(
          (record) =>
            record.tenantId === snapshot.tenantId &&
            record.admissionId === snapshot.admissionId,
        );
        if (!prior) return { kind: 'not-found' };
        if (!sameIdentity(prior, snapshot)) return { kind: 'conflict' };
        if (prior.state === 'finished')
          return prior.receiptDigest === snapshot.receiptDigest
            ? { kind: 'stored', value: prior }
            : { kind: 'conflict' };
        if (!ownerMatches(snapshot)) return { kind: 'conflict' };
        const record: PlannedHomeAdmissionRecord = {
          ...prior,
          state: 'finished',
          receiptDigest: snapshot.receiptDigest,
        };
        save(record);
        return { kind: 'stored', value: record };
      });
    },
  };
}
