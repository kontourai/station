import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import {
  createAuthorizedSqlitePlannedHomeTransferStore,
  createSqlitePlannedHomeTransferStore,
  type PlannedHomeTransfer,
  type TransferStoreResult,
} from '../planned-home-transfer-store.js';
import type { ProjectTaskRoomSourceSeal } from '../project-task-room-source-seal.js';

const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {}
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const owner = {
  tenantId: 'tenant-a',
  channelId: 'channel-a',
  homeRef: 'source',
  policyRevision: 'policy-1',
  revision: 0,
};
const intent = {
  tenantId: owner.tenantId,
  channelId: owner.channelId,
  operationId: 'move-1',
  sourceHomeRef: 'source',
  targetHomeRef: 'target',
  policyRevision: owner.policyRevision,
  expectedRevision: 0,
};
const closure: ProjectTaskRoomSourceSeal = {
  operationId: intent.operationId,
  sourceHomeRef: intent.sourceHomeRef,
  targetHomeRef: intent.targetHomeRef,
  checkpoint: {
    channelId: owner.channelId,
    epoch: 0,
    throughSeq: 1,
    checkpointDigest: 'a'.repeat(64),
    retainedAnchorSeq: 0,
    retainedAnchorDigest: 'b'.repeat(64),
  },
  workingStateDigest: 'c'.repeat(64),
};
function stored<T>(result: TransferStoreResult<T>): T {
  expect(result.kind).toBe('stored');
  if (result.kind !== 'stored') throw new Error('Missing stored result');
  return result.value;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-transfer-store-'));
  roots.push(root);
  const path = join(root, 'authority.sqlite');
  const open = () => {
    const db = new DatabaseSync(path);
    databases.push(db);
    return db;
  };
  const db = open();
  const store = createSqlitePlannedHomeTransferStore(db);
  stored(store.initialize(owner));
  return { db, store, open };
}
function ready(
  store: ReturnType<typeof createSqlitePlannedHomeTransferStore>,
): PlannedHomeTransfer {
  stored(store.prepare(intent));
  const closed = stored(
    store.recordClosure(owner.tenantId, intent.operationId, closure),
  );
  return stored(
    store.recordReady(
      owner.tenantId,
      intent.operationId,
      intent.targetHomeRef,
      closed.closureDigest!,
    ),
  );
}
test('only closure plus matching target readiness permits an ownership decision', () => {
  const { store } = fixture();
  stored(store.prepare(intent));
  expect(store.commit(owner.tenantId, intent.operationId).kind).toBe(
    'conflict',
  );
  const closed = stored(
    store.recordClosure(owner.tenantId, intent.operationId, closure),
  );
  expect(store.commit(owner.tenantId, intent.operationId).kind).toBe(
    'conflict',
  );
  expect(
    store.recordReady(
      owner.tenantId,
      intent.operationId,
      'other',
      closed.closureDigest!,
    ).kind,
  ).toBe('conflict');
  expect(
    store.recordReady(owner.tenantId, intent.operationId, 'target', 'wrong')
      .kind,
  ).toBe('conflict');
  expect(stored(store.inspect(owner.tenantId, owner.channelId))).toEqual(owner);
  stored(
    store.recordReady(
      owner.tenantId,
      intent.operationId,
      'target',
      closed.closureDigest!,
    ),
  );
  expect(
    stored(store.commit(owner.tenantId, intent.operationId)).committedRevision,
  ).toBe(1);
  expect(stored(store.inspect(owner.tenantId, owner.channelId))).toEqual({
    ...owner,
    homeRef: 'target',
    revision: 1,
  });
});
test('independent connections cannot reserve competing moves or reuse an operation for a different intent', () => {
  const { store, open } = fixture();
  const other = createSqlitePlannedHomeTransferStore(open());
  const prepared = stored(store.prepare(intent));
  expect(stored(other.prepare(intent))).toEqual(prepared);
  expect(other.prepare({ ...intent, operationId: 'competing' }).kind).toBe(
    'conflict',
  );
  expect(other.prepare({ ...intent, targetHomeRef: 'other' }).kind).toBe(
    'conflict',
  );
  expect(other.prepare({ ...intent, channelId: 'different' }).kind).toBe(
    'conflict',
  );
  expect(
    other.prepare({ ...intent, policyRevision: 'stale-policy' }).kind,
  ).toBe('conflict');
});
test('a lost commit response resolves to the same decision after reopening', () => {
  const { db, store, open } = fixture();
  ready(store);
  const committed = stored(store.commit(owner.tenantId, intent.operationId));
  db.close();
  const reopened = createSqlitePlannedHomeTransferStore(open());
  expect(stored(reopened.resolve(owner.tenantId, intent.operationId))).toEqual(
    committed,
  );
  expect(stored(reopened.commit(owner.tenantId, intent.operationId))).toEqual(
    committed,
  );
  expect(stored(reopened.prepare(intent))).toEqual(committed);
  expect(reopened.prepare({ ...intent, operationId: 'stale-move' }).kind).toBe(
    'conflict',
  );
  expect(reopened.initialize(owner).kind).toBe('conflict');
});
test('changed closure bytes never replace the recorded closing checkpoint', () => {
  const { store } = fixture();
  ready(store);
  expect(
    store.recordClosure(owner.tenantId, intent.operationId, {
      ...closure,
      workingStateDigest: 'd'.repeat(64),
    }).kind,
  ).toBe('conflict');
  expect(
    store.recordClosure(owner.tenantId, intent.operationId, {
      ...closure,
      checkpoint: { ...closure.checkpoint, channelId: 'other' },
    }).kind,
  ).toBe('conflict');
  const reordered = {
    workingStateDigest: closure.workingStateDigest,
    checkpoint: { ...closure.checkpoint },
    targetHomeRef: closure.targetHomeRef,
    sourceHomeRef: closure.sourceHomeRef,
    operationId: closure.operationId,
  };
  expect(
    stored(store.recordClosure(owner.tenantId, intent.operationId, reordered))
      .phase,
  ).toBe('target-ready');
});
test('identical channel and operation identifiers remain isolated by tenant', () => {
  const { store } = fixture();
  ready(store);
  const second = { ...owner, tenantId: 'tenant-b' };
  stored(store.initialize(second));
  expect(store.resolve(second.tenantId, intent.operationId).kind).toBe(
    'not-found',
  );
  stored(store.prepare({ ...intent, tenantId: second.tenantId }));
  stored(store.commit(owner.tenantId, intent.operationId));
  expect(stored(store.inspect(second.tenantId, second.channelId))).toEqual(
    second,
  );
  expect(store.commit(second.tenantId, intent.operationId).kind).toBe(
    'conflict',
  );
});
test('a write failure rolls ownership and operation state back together', () => {
  const { db, store } = fixture();
  ready(store);
  const faulted = createSqlitePlannedHomeTransferStore({
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        get: (...values) => statement.get(...values),
        run: (...values) => {
          if (
            sql.startsWith('INSERT INTO planned_home_transfers') &&
            String(values.at(-1)).includes('"phase":"committed"')
          )
            throw new Error('Injected persistence failure');
          return statement.run(...values);
        },
      };
    },
  });
  expect(faulted.commit(owner.tenantId, intent.operationId).kind).toBe(
    'unavailable',
  );
  expect(stored(store.inspect(owner.tenantId, owner.channelId))).toEqual(owner);
  expect(stored(store.resolve(owner.tenantId, intent.operationId)).phase).toBe(
    'target-ready',
  );
  expect(stored(store.commit(owner.tenantId, intent.operationId)).phase).toBe(
    'committed',
  );
});
test.each(['not-json', 'x'.repeat(10000)])(
  'corruption is unavailable, never absent or reinitialized (%s)',
  (json) => {
    const { db, store } = fixture();
    db.prepare('UPDATE planned_home_owners SET record_json=?').run(json);
    expect(store.inspect(owner.tenantId, owner.channelId).kind).toBe(
      'unavailable',
    );
    expect(store.initialize(owner).kind).toBe('unavailable');
    expect(store.prepare(intent).kind).toBe('unavailable');
  },
);

test('unknown fields and accessor input cannot enter durable authority records', () => {
  const { store } = fixture();
  expect(
    store.prepare({ ...intent, secret: 'must-not-be-stored' } as typeof intent)
      .kind,
  ).toBe('conflict');
  let invoked = false;
  const accessor = { ...intent };
  Object.defineProperty(accessor, 'targetHomeRef', {
    enumerable: true,
    get() {
      invoked = true;
      return 'target';
    },
  });
  expect(store.prepare(accessor).kind).toBe('conflict');
  expect(invoked).toBe(false);
  stored(store.prepare(intent));
  expect(
    store.recordClosure(owner.tenantId, intent.operationId, {
      ...closure,
      extra: 'must-not-be-stored',
    } as ProjectTaskRoomSourceSeal).kind,
  ).toBe('conflict');
});

test('an error after durable commit resolves without assigning a second revision', () => {
  const { db, store } = fixture();
  ready(store);
  const lostAcknowledgement = createSqlitePlannedHomeTransferStore({
    exec(sql) {
      db.exec(sql);
      if (sql === 'COMMIT')
        throw new Error('Injected lost commit acknowledgement');
    },
    prepare: (sql) => db.prepare(sql),
  });
  expect(
    lostAcknowledgement.commit(owner.tenantId, intent.operationId).kind,
  ).toBe('unavailable');
  const decision = stored(store.resolve(owner.tenantId, intent.operationId));
  expect(decision).toMatchObject({ phase: 'committed', committedRevision: 1 });
  expect(stored(store.commit(owner.tenantId, intent.operationId))).toEqual(
    decision,
  );
  expect(stored(store.inspect(owner.tenantId, owner.channelId))).toMatchObject({
    homeRef: 'target',
    revision: 1,
  });
});

test('refuses an in-memory authority database', () => {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  expect(() => createSqlitePlannedHomeTransferStore(db)).toThrow(
    'file-backed SQLite',
  );
});
test('a later durability downgrade cannot commit or silently reassign ownership', () => {
  const { db, store } = fixture();
  ready(store);
  db.exec('PRAGMA synchronous=OFF');
  expect(store.commit(owner.tenantId, intent.operationId).kind).toBe(
    'unavailable',
  );
  db.exec('PRAGMA synchronous=FULL');
  expect(stored(store.inspect(owner.tenantId, owner.channelId))).toEqual(owner);
  expect(stored(store.resolve(owner.tenantId, intent.operationId)).phase).toBe(
    'target-ready',
  );
  expect(
    stored(store.commit(owner.tenantId, intent.operationId)).committedRevision,
  ).toBe(1);
});

test('a denied caller cannot inspect or mutate transfer decisions', () => {
  const { db, store } = fixture();
  const decision = ready(store);
  const denied = createAuthorizedSqlitePlannedHomeTransferStore(
    db,
    () => false,
  );
  const results = [
    denied.initialize(owner),
    denied.inspect(owner.tenantId, owner.channelId),
    denied.resolve(owner.tenantId, intent.operationId),
    denied.prepare(intent),
    denied.recordClosure(owner.tenantId, intent.operationId, closure),
    denied.recordReady(
      owner.tenantId,
      intent.operationId,
      'target',
      decision.closureDigest!,
    ),
    denied.commit(owner.tenantId, intent.operationId),
  ];
  expect(results.every((result) => result.kind === 'denied')).toBe(true);
  expect(stored(store.inspect(owner.tenantId, owner.channelId))).toEqual(owner);
  expect(stored(store.resolve(owner.tenantId, intent.operationId))).toEqual(
    decision,
  );
});
test.each(['revoked', 'unavailable', 'async'] as const)(
  'authorization %s before commit rolls the whole transition back',
  (mode) => {
    const { db, store } = fixture();
    const decision = ready(store);
    let checks = 0;
    const guarded = createAuthorizedSqlitePlannedHomeTransferStore(db, (() => {
      if (++checks === 1) return true;
      if (mode === 'unavailable')
        throw new Error('Private authority backend detail');
      if (mode === 'async')
        return Promise.reject(new Error('Asynchronous guard is unsupported'));
      return false;
    }) as () => boolean);
    expect(guarded.commit(owner.tenantId, intent.operationId).kind).toBe(
      mode === 'unavailable' ? 'unavailable' : 'denied',
    );
    expect(checks).toBe(2);
    expect(stored(store.inspect(owner.tenantId, owner.channelId))).toEqual(
      owner,
    );
    expect(stored(store.resolve(owner.tenantId, intent.operationId))).toEqual(
      decision,
    );
    const allowed = createAuthorizedSqlitePlannedHomeTransferStore(
      db,
      () => true,
    );
    expect(
      stored(allowed.commit(owner.tenantId, intent.operationId))
        .committedRevision,
    ).toBe(1);
  },
);

test.each([undefined, null, false])(
  'the guarded entry rejects a missing guard (%s)',
  (guard) => {
    const { db } = fixture();
    expect(() =>
      createAuthorizedSqlitePlannedHomeTransferStore(
        db,
        guard as unknown as () => boolean,
      ),
    ).toThrow('guard is required');
  },
);
