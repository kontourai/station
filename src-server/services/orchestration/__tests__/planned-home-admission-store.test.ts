import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import {
  checkChannelAdmissions,
  MAX_PLANNED_HOME_ADMISSIONS,
  type PlannedHomeAdmissionRecord,
} from '../planned-home-admission-schema.js';
import {
  createPlannedHomeAdmissionStore,
  type PlannedHomeAdmissionStoreResult,
} from '../planned-home-admission-store.js';
import { createSqlitePlannedHomeTransferStore } from '../planned-home-transfer-store.js';

const roots: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    try {
      database.close();
    } catch {}
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const owner = {
  tenantId: 'tenant-a',
  channelId: 'channel-a',
  homeRef: 'home-a',
  policyRevision: 'policy-1',
  revision: 0,
};
const admission = {
  tenantId: owner.tenantId,
  channelId: owner.channelId,
  admissionId: 'admission-a',
  ownerRevision: owner.revision,
  homeRef: owner.homeRef,
  kind: 'room-write' as const,
  intentDigest: 'a'.repeat(64),
};
const receiptDigest = 'b'.repeat(64);

function stored<T>(result: PlannedHomeAdmissionStoreResult<T>): T {
  expect(result.kind).toBe('stored');
  if (result.kind !== 'stored') throw new Error('Missing stored admission');
  return result.value;
}

function fixture(authorize: () => boolean = () => true) {
  const root = mkdtempSync(join(tmpdir(), 'station-home-admission-'));
  roots.push(root);
  const path = join(root, 'authority.sqlite');
  const open = () => {
    const database = new DatabaseSync(path);
    databases.push(database);
    return database;
  };
  const database = open();
  const transferStore = createSqlitePlannedHomeTransferStore(database);
  const initialized = transferStore.initialize(owner);
  expect(initialized.kind).toBe('stored');
  const store = createPlannedHomeAdmissionStore(database, authorize);
  return { database, open, store, transferStore };
}

test('requires the exact current owner home and revision', () => {
  const { store } = fixture();
  expect(store.begin({ ...admission, homeRef: 'other' }).kind).toBe('conflict');
  expect(store.begin({ ...admission, ownerRevision: 1 }).kind).toBe('conflict');
  expect(store.begin({ ...admission, channelId: 'other' }).kind).toBe(
    'conflict',
  );
  expect(stored(store.begin(admission))).toEqual({
    ...admission,
    state: 'unresolved',
  });
});

test('a pending transfer freezes new admissions but an identical unresolved admission resumes', () => {
  const { store, transferStore } = fixture();
  const unresolved = stored(store.begin(admission));
  expect(
    transferStore.prepare({
      tenantId: owner.tenantId,
      channelId: owner.channelId,
      operationId: 'move-a',
      sourceHomeRef: owner.homeRef,
      targetHomeRef: 'home-b',
      policyRevision: owner.policyRevision,
      expectedRevision: owner.revision,
    }).kind,
  ).toBe('stored');
  expect(stored(store.begin(admission))).toEqual(unresolved);
  expect(store.begin({ ...admission, admissionId: 'admission-b' }).kind).toBe(
    'conflict',
  );
});

test('finish retries only the same exact identity and receipt digest', () => {
  const { store } = fixture();
  stored(store.begin(admission));
  const finished = stored(store.finish({ ...admission, receiptDigest }));
  expect(finished).toEqual({
    ...admission,
    state: 'finished',
    receiptDigest,
  });
  expect(stored(store.finish({ ...admission, receiptDigest }))).toEqual(
    finished,
  );
  expect(
    store.finish({ ...admission, receiptDigest: 'c'.repeat(64) }).kind,
  ).toBe('conflict');
  expect(
    store.finish({
      ...admission,
      intentDigest: 'd'.repeat(64),
      receiptDigest,
    }).kind,
  ).toBe('conflict');
  expect(stored(store.begin(admission))).toEqual(finished);
});

test('an unfinished admission remains unresolved after reopening without expiry or reclamation', () => {
  const { database, open, store } = fixture();
  const unresolved = stored(store.begin(admission));
  database.close();
  const reopened = createPlannedHomeAdmissionStore(open(), () => true);
  expect(stored(reopened.begin(admission))).toEqual(unresolved);
  expect(checkChannelAdmissions(open(), owner.tenantId, owner.channelId)).toBe(
    'pending',
  );
  expect(
    Object.keys(unresolved).some((key) =>
      /expir|deadline|pid|lease|ownerProcess/i.test(key),
    ),
  ).toBe(false);
});

test('revocation before commit rolls the admission write back', () => {
  let checks = 0;
  const { database, store } = fixture(() => {
    checks += 1;
    return checks < 3;
  });
  expect(store.begin(admission).kind).toBe('denied');
  expect(
    database
      .prepare('SELECT 1 FROM planned_home_admissions WHERE admission_id=?')
      .get(admission.admissionId),
  ).toBeUndefined();
});

test('false, throwing, and asynchronous guards fail closed without writes', () => {
  for (const authorize of [
    () => false,
    () => {
      throw new Error('authority unavailable');
    },
    (() => Promise.resolve(true)) as unknown as () => boolean,
  ]) {
    const { database, store } = fixture(authorize);
    expect(['denied', 'unavailable']).toContain(store.begin(admission).kind);
    expect(
      database
        .prepare('SELECT count(*) AS count FROM planned_home_admissions')
        .get(),
    ).toEqual({ count: 0 });
  }
});

test.each([
  ['not-json', 'not-json'],
  ['oversized', 'x'.repeat(9000)],
])(
  'corrupt or oversized %s records are unavailable, never empty',
  (_case, json) => {
    const { database, store } = fixture();
    stored(store.begin(admission));
    database
      .prepare(
        'UPDATE planned_home_admissions SET record_json=? WHERE admission_id=?',
      )
      .run(json, admission.admissionId);
    expect(store.begin(admission).kind).toBe('unavailable');
    expect(() =>
      checkChannelAdmissions(database, owner.tenantId, owner.channelId),
    ).toThrow();
  },
);

test('column and JSON identity disagreement fails closed', () => {
  const { database, store } = fixture();
  stored(store.begin(admission));
  database
    .prepare(
      'UPDATE planned_home_admissions SET home_ref=? WHERE admission_id=?',
    )
    .run('different-home', admission.admissionId);
  expect(store.begin(admission).kind).toBe('unavailable');
});

test('routing-key corruption anywhere in the journal fails every channel scan closed', () => {
  const { database, store } = fixture();
  stored(store.begin(admission));
  database
    .prepare(
      'UPDATE planned_home_admissions SET channel_id=? WHERE admission_id=?',
    )
    .run('moved-by-corruption', admission.admissionId);
  expect(() =>
    checkChannelAdmissions(database, owner.tenantId, owner.channelId),
  ).toThrow();
  expect(() =>
    checkChannelAdmissions(database, 'unrelated-tenant', 'unrelated-channel'),
  ).toThrow();
  expect(store.begin({ ...admission, admissionId: 'new' }).kind).toBe(
    'unavailable',
  );
});

test('an empty admission ID inserted outside the store is corrupt, never clear', () => {
  const { database } = fixture();
  const corrupt = { ...admission, admissionId: '', state: 'unresolved' };
  database
    .prepare('INSERT INTO planned_home_admissions VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(
      corrupt.tenantId,
      corrupt.channelId,
      corrupt.admissionId,
      corrupt.ownerRevision,
      corrupt.homeRef,
      corrupt.kind,
      corrupt.intentDigest,
      corrupt.state,
      null,
      JSON.stringify(corrupt),
    );
  expect(() =>
    checkChannelAdmissions(database, owner.tenantId, owner.channelId),
  ).toThrow();
});

test('authorization callbacks cannot mutate begin or finish identity', () => {
  const beginInput = { ...admission };
  let mutateBegin = true;
  const beginFixture = fixture(() => {
    if (mutateBegin) beginInput.homeRef = 'guard-mutated';
    return true;
  });
  const unresolved = stored(beginFixture.store.begin(beginInput));
  expect(unresolved.homeRef).toBe(owner.homeRef);

  mutateBegin = false;
  const finishInput = { ...admission, receiptDigest };
  const finishStore = createPlannedHomeAdmissionStore(
    beginFixture.database,
    () => {
      finishInput.receiptDigest = 'c'.repeat(64);
      return true;
    },
  );
  expect(stored(finishStore.finish(finishInput)).receiptDigest).toBe(
    receiptDigest,
  );
});

test('finished channel records are clear and retain exact bounded metadata', () => {
  const { database, store } = fixture();
  stored(store.begin(admission));
  const finished = stored(store.finish({ ...admission, receiptDigest }));
  expect(
    checkChannelAdmissions(database, owner.tenantId, owner.channelId),
  ).toBe('clear');
  expect(Object.keys(finished).sort()).toEqual(
    [
      'tenantId',
      'channelId',
      'admissionId',
      'ownerRevision',
      'homeRef',
      'kind',
      'intentDigest',
      'state',
      'receiptDigest',
    ].sort(),
  );
});

test('schema helper detects pending state across multiple retained admissions', () => {
  const { database, store } = fixture();
  stored(store.begin(admission));
  stored(
    store.begin({
      ...admission,
      admissionId: 'admission-b',
      kind: 'execution',
      intentDigest: 'c'.repeat(64),
    }),
  );
  stored(store.finish({ ...admission, receiptDigest }));
  expect(
    checkChannelAdmissions(database, owner.tenantId, owner.channelId),
  ).toBe('pending');
});

test('the bounded journal keeps exact replay and finish available at capacity', () => {
  const { database, store } = fixture();
  const insert = database.prepare(
    'INSERT INTO planned_home_admissions VALUES(?,?,?,?,?,?,?,?,?,?)',
  );
  database.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index < MAX_PLANNED_HOME_ADMISSIONS; index += 1) {
      const record: PlannedHomeAdmissionRecord = {
        ...admission,
        admissionId: index === 0 ? admission.admissionId : `retained-${index}`,
        intentDigest: index.toString(16).padStart(64, '0'),
        state: 'unresolved',
      };
      insert.run(
        record.tenantId,
        record.channelId,
        record.admissionId,
        record.ownerRevision,
        record.homeRef,
        record.kind,
        record.intentDigest,
        record.state,
        null,
        JSON.stringify(record),
      );
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }

  const exact = { ...admission, intentDigest: '0'.repeat(64) };
  expect(stored(store.begin(exact)).state).toBe('unresolved');
  expect(
    store.begin({
      ...admission,
      admissionId: 'over-capacity',
      intentDigest: 'f'.repeat(64),
    }).kind,
  ).toBe('conflict');
  const finished = stored(store.finish({ ...exact, receiptDigest }));
  expect(finished.state).toBe('finished');
  expect(stored(store.begin(exact))).toEqual(finished);
  expect(
    database
      .prepare('SELECT count(*) AS count FROM planned_home_admissions')
      .get(),
  ).toEqual({ count: MAX_PLANNED_HOME_ADMISSIONS });
});

test('a journal beyond the hard cap is corrupt and unavailable', () => {
  const { database, store } = fixture();
  const insert = database.prepare(
    'INSERT INTO planned_home_admissions VALUES(?,?,?,?,?,?,?,?,?,?)',
  );
  database.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index <= MAX_PLANNED_HOME_ADMISSIONS; index += 1) {
      const record: PlannedHomeAdmissionRecord = {
        ...admission,
        admissionId: `excess-${index}`,
        intentDigest: index.toString(16).padStart(64, '0'),
        state: 'finished',
        receiptDigest,
      };
      insert.run(
        record.tenantId,
        record.channelId,
        record.admissionId,
        record.ownerRevision,
        record.homeRef,
        record.kind,
        record.intentDigest,
        record.state,
        record.receiptDigest ?? null,
        JSON.stringify(record),
      );
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  expect(() =>
    checkChannelAdmissions(database, owner.tenantId, owner.channelId),
  ).toThrow('capacity exceeded');
  expect(store.begin(admission).kind).toBe('unavailable');
});

test('the journal never accepts extra input fields as authority metadata', () => {
  const { store } = fixture();
  expect(
    store.begin({
      ...admission,
      publicGrant: true,
    } as typeof admission).kind,
  ).toBe('conflict');
  expect(
    store.finish({
      ...admission,
      receiptDigest,
      verified: true,
    } as typeof admission & { receiptDigest: string }).kind,
  ).toBe('conflict');
});

test('the required guard cannot be omitted', () => {
  const { database } = fixture();
  expect(() =>
    createPlannedHomeAdmissionStore(
      database,
      undefined as unknown as () => boolean,
    ),
  ).toThrow('Home admission authorization guard is required');
});

test('missing finish records are not created', () => {
  const { store } = fixture();
  const result: PlannedHomeAdmissionStoreResult<PlannedHomeAdmissionRecord> =
    store.finish({ ...admission, receiptDigest });
  expect(result.kind).toBe('not-found');
});
