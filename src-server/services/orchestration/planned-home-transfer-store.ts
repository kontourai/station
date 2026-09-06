import { createHash } from 'node:crypto';
import { isProjectTaskRoomCheckpoint } from '@kontourai/station-contracts/project-task-room';
import { plainDataObject } from './bounded-json.js';
import type { ProjectTaskRoomSourceSeal } from './project-task-room-source-seal.js';

/** Storage decisions only. This adapter issues no leases or execution grants.
 * Its database must be centrally owned outside transferred home archives.
 * The composing service must authenticate both homes and authorize the scope. */
export interface PlannedHomeOwner {
  tenantId: string;
  channelId: string;
  homeRef: string;
  policyRevision: string;
  revision: number;
}
export interface PlannedHomeTransferIntent {
  tenantId: string;
  channelId: string;
  operationId: string;
  sourceHomeRef: string;
  targetHomeRef: string;
  policyRevision: string;
  expectedRevision: number;
}
export interface PlannedHomeTransfer {
  intent: PlannedHomeTransferIntent;
  phase: 'prepared' | 'source-closed' | 'target-ready' | 'committed';
  closure?: ProjectTaskRoomSourceSeal;
  closureDigest?: string;
  committedRevision?: number;
}
export type TransferStoreResult<T> =
  | { kind: 'stored'; value: T }
  | { kind: 'conflict' | 'not-found' | 'unavailable' };
interface Database {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...values: Array<string | number>): unknown;
    get(...values: Array<string | number>): unknown;
  };
}
const LIMIT = 8192;
function exact(value: unknown, keys: string[]): boolean {
  return (
    plainDataObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 256 &&
    !Array.from(value).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    )
  );
}
function revision(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) < Number.MAX_SAFE_INTEGER
  );
}
function validIntent(value: PlannedHomeTransferIntent): boolean {
  return (
    exact(value, [
      'tenantId',
      'channelId',
      'operationId',
      'sourceHomeRef',
      'targetHomeRef',
      'policyRevision',
      'expectedRevision',
    ]) &&
    [
      value.tenantId,
      value.channelId,
      value.operationId,
      value.sourceHomeRef,
      value.targetHomeRef,
      value.policyRevision,
    ].every(identifier) &&
    value.sourceHomeRef !== value.targetHomeRef &&
    revision(value.expectedRevision)
  );
}
function ownerValid(value: PlannedHomeOwner): boolean {
  return (
    exact(value, [
      'tenantId',
      'channelId',
      'homeRef',
      'policyRevision',
      'revision',
    ]) &&
    [
      value.tenantId,
      value.channelId,
      value.homeRef,
      value.policyRevision,
    ].every(identifier) &&
    revision(value.revision)
  );
}
function digest(closure: ProjectTaskRoomSourceSeal): string {
  // Canonical field order: insertion order of a caller's object is not identity.
  const c = closure.checkpoint;
  return createHash('sha256')
    .update(
      JSON.stringify([
        closure.operationId,
        closure.sourceHomeRef,
        closure.targetHomeRef,
        c.channelId,
        c.epoch,
        c.throughSeq,
        c.checkpointDigest,
        c.retainedAnchorSeq,
        c.retainedAnchorDigest,
        closure.workingStateDigest,
      ]),
    )
    .digest('hex');
}
function closureValid(
  closure: ProjectTaskRoomSourceSeal,
  intent: PlannedHomeTransferIntent,
): boolean {
  return (
    exact(closure, [
      'operationId',
      'sourceHomeRef',
      'targetHomeRef',
      'checkpoint',
      'workingStateDigest',
    ]) &&
    closure.operationId === intent.operationId &&
    closure.sourceHomeRef === intent.sourceHomeRef &&
    closure.targetHomeRef === intent.targetHomeRef &&
    isProjectTaskRoomCheckpoint(closure.checkpoint) &&
    closure.checkpoint.channelId === intent.channelId &&
    typeof closure.workingStateDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(closure.workingStateDigest)
  );
}
function transferValid(value: PlannedHomeTransfer): boolean {
  if (!plainDataObject(value) || !value.intent || !validIntent(value.intent))
    return false;
  const fields = ['intent', 'phase'];
  if (value.phase !== 'prepared') fields.push('closure', 'closureDigest');
  if (value.phase === 'committed') fields.push('committedRevision');
  if (!exact(value, fields)) return false;
  if (value.phase === 'prepared')
    return (
      value.closure === undefined &&
      value.closureDigest === undefined &&
      value.committedRevision === undefined
    );
  if (
    !['source-closed', 'target-ready', 'committed'].includes(value.phase) ||
    !value.closure ||
    !closureValid(value.closure, value.intent) ||
    digest(value.closure) !== value.closureDigest
  )
    return false;
  return value.phase === 'committed'
    ? value.committedRevision === value.intent.expectedRevision + 1
    : value.committedRevision === undefined;
}
function sameIntent(
  a: PlannedHomeTransferIntent,
  b: PlannedHomeTransferIntent,
): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.channelId === b.channelId &&
    a.operationId === b.operationId &&
    a.sourceHomeRef === b.sourceHomeRef &&
    a.targetHomeRef === b.targetHomeRef &&
    a.policyRevision === b.policyRevision &&
    a.expectedRevision === b.expectedRevision
  );
}

export function createSqlitePlannedHomeTransferStore(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS planned_home_owners (
    tenant_id TEXT NOT NULL, channel_id TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY(tenant_id,channel_id));
    CREATE TABLE IF NOT EXISTS planned_home_transfers (
    tenant_id TEXT NOT NULL, operation_id TEXT NOT NULL, channel_id TEXT NOT NULL,
    pending INTEGER NOT NULL CHECK(pending IN (0,1)), record_json TEXT NOT NULL,
    PRIMARY KEY(tenant_id,operation_id));
    CREATE UNIQUE INDEX IF NOT EXISTS idx_planned_home_pending
    ON planned_home_transfers(tenant_id,channel_id) WHERE pending=1;`);
  function parse<T>(
    row: unknown,
    validate: (value: T) => boolean,
  ): T | undefined {
    if (row === undefined) return undefined;
    const json = (row as { record_json?: unknown }).record_json;
    if (typeof json !== 'string') throw new Error('Invalid transfer record');
    const value = JSON.parse(json) as T;
    if (!value || !validate(value)) throw new Error('Invalid transfer record');
    return value;
  }
  function readOwner(
    tenant: string,
    channel: string,
  ): PlannedHomeOwner | undefined {
    return parse(
      db
        .prepare(`SELECT CASE WHEN length(CAST(record_json AS BLOB))<=${LIMIT}
      THEN record_json END AS record_json FROM planned_home_owners WHERE tenant_id=? AND channel_id=?`)
        .get(tenant, channel),
      (value: PlannedHomeOwner) =>
        ownerValid(value) &&
        value.tenantId === tenant &&
        value.channelId === channel,
    );
  }
  function readTransfer(
    tenant: string,
    operation: string,
  ): PlannedHomeTransfer | undefined {
    const row = db
      .prepare(`SELECT channel_id,pending,CASE WHEN length(CAST(record_json AS BLOB))<=${LIMIT}
      THEN record_json END AS record_json FROM planned_home_transfers WHERE tenant_id=? AND operation_id=?`)
      .get(tenant, operation);
    return parse(
      row,
      (value: PlannedHomeTransfer) =>
        transferValid(value) &&
        value.intent.tenantId === tenant &&
        value.intent.operationId === operation &&
        value.intent.channelId === (row as { channel_id: string }).channel_id &&
        (value.phase === 'committed' ? 0 : 1) ===
          (row as { pending: number }).pending,
    );
  }
  function saveTransfer(value: PlannedHomeTransfer): void {
    if (!transferValid(value)) throw new Error('Invalid transfer');
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > LIMIT) throw new Error('Oversized transfer');
    db.prepare(`INSERT INTO planned_home_transfers VALUES(?,?,?,?,?)
      ON CONFLICT(tenant_id,operation_id) DO UPDATE SET pending=excluded.pending,record_json=excluded.record_json`).run(
      value.intent.tenantId,
      value.intent.operationId,
      value.intent.channelId,
      value.phase === 'committed' ? 0 : 1,
      json,
    );
  }
  function transaction<T>(
    run: () => TransferStoreResult<T>,
  ): TransferStoreResult<T> {
    let began = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      began = true;
      const result = run();
      db.exec('COMMIT');
      began = false;
      return result;
    } catch {
      if (began) {
        try {
          db.exec('ROLLBACK');
        } catch {}
      }
      return { kind: 'unavailable' };
    }
  }
  function matches(
    owner: PlannedHomeOwner | undefined,
    intent: PlannedHomeTransferIntent,
  ): boolean {
    return (
      owner?.homeRef === intent.sourceHomeRef &&
      owner.policyRevision === intent.policyRevision &&
      owner.revision === intent.expectedRevision
    );
  }
  return {
    /** Initial administrative enrollment only; never replaces an existing owner. */
    initialize(owner: PlannedHomeOwner): TransferStoreResult<PlannedHomeOwner> {
      return transaction<PlannedHomeOwner>(() => {
        if (!ownerValid(owner) || owner.revision !== 0)
          return { kind: 'conflict' };
        const prior = readOwner(owner.tenantId, owner.channelId);
        if (prior)
          return prior.homeRef === owner.homeRef &&
            prior.policyRevision === owner.policyRevision &&
            prior.revision === owner.revision
            ? { kind: 'stored', value: prior }
            : { kind: 'conflict' };
        db.prepare('INSERT INTO planned_home_owners VALUES(?,?,?)').run(
          owner.tenantId,
          owner.channelId,
          JSON.stringify(owner),
        );
        return { kind: 'stored', value: structuredClone(owner) };
      });
    },
    inspect(
      tenant: string,
      channel: string,
    ): TransferStoreResult<PlannedHomeOwner> {
      return transaction<PlannedHomeOwner>(() => {
        if (!identifier(tenant) || !identifier(channel))
          return { kind: 'conflict' };
        const value = readOwner(tenant, channel);
        return value ? { kind: 'stored', value } : { kind: 'not-found' };
      });
    },
    resolve(
      tenant: string,
      operation: string,
    ): TransferStoreResult<PlannedHomeTransfer> {
      return transaction<PlannedHomeTransfer>(() => {
        if (!identifier(tenant) || !identifier(operation))
          return { kind: 'conflict' };
        const value = readTransfer(tenant, operation);
        return value ? { kind: 'stored', value } : { kind: 'not-found' };
      });
    },
    prepare(
      intent: PlannedHomeTransferIntent,
    ): TransferStoreResult<PlannedHomeTransfer> {
      return transaction<PlannedHomeTransfer>(() => {
        if (!validIntent(intent)) return { kind: 'conflict' };
        const prior = readTransfer(intent.tenantId, intent.operationId);
        if (prior)
          return sameIntent(prior.intent, intent)
            ? { kind: 'stored', value: prior }
            : { kind: 'conflict' };
        if (!matches(readOwner(intent.tenantId, intent.channelId), intent))
          return { kind: 'conflict' };
        if (
          db
            .prepare(
              'SELECT 1 FROM planned_home_transfers WHERE tenant_id=? AND channel_id=? AND pending=1',
            )
            .get(intent.tenantId, intent.channelId)
        )
          return { kind: 'conflict' };
        const value: PlannedHomeTransfer = {
          intent: structuredClone(intent),
          phase: 'prepared',
        };
        saveTransfer(value);
        return { kind: 'stored', value };
      });
    },
    /** Call only after the source owner authenticated and verified this seal. */
    recordClosure(
      tenant: string,
      operation: string,
      closure: ProjectTaskRoomSourceSeal,
    ): TransferStoreResult<PlannedHomeTransfer> {
      return transaction<PlannedHomeTransfer>(() => {
        const value = readTransfer(tenant, operation);
        if (!value) return { kind: 'not-found' };
        if (!closureValid(closure, value.intent)) return { kind: 'conflict' };
        if (value.closure)
          return value.closureDigest === digest(closure)
            ? { kind: 'stored', value }
            : { kind: 'conflict' };
        if (!matches(readOwner(tenant, value.intent.channelId), value.intent))
          return { kind: 'conflict' };
        value.closure = structuredClone(closure);
        value.closureDigest = digest(closure);
        value.phase = 'source-closed';
        saveTransfer(value);
        return { kind: 'stored', value };
      });
    },
    /** Target authentication and actual restored-store verification belong to the caller. */
    recordReady(
      tenant: string,
      operation: string,
      targetHomeRef: string,
      closureDigest: string,
    ): TransferStoreResult<PlannedHomeTransfer> {
      return transaction<PlannedHomeTransfer>(() => {
        const value = readTransfer(tenant, operation);
        if (!value) return { kind: 'not-found' };
        if (
          !value.closureDigest ||
          value.closureDigest !== closureDigest ||
          value.intent.targetHomeRef !== targetHomeRef
        )
          return { kind: 'conflict' };
        if (value.phase === 'committed' || value.phase === 'target-ready')
          return { kind: 'stored', value };
        if (!matches(readOwner(tenant, value.intent.channelId), value.intent))
          return { kind: 'conflict' };
        value.phase = 'target-ready';
        saveTransfer(value);
        return { kind: 'stored', value };
      });
    },
    commit(
      tenant: string,
      operation: string,
    ): TransferStoreResult<PlannedHomeTransfer> {
      return transaction<PlannedHomeTransfer>(() => {
        const value = readTransfer(tenant, operation);
        if (!value) return { kind: 'not-found' };
        if (value.phase === 'committed') return { kind: 'stored', value };
        if (
          value.phase !== 'target-ready' ||
          !matches(readOwner(tenant, value.intent.channelId), value.intent)
        )
          return { kind: 'conflict' };
        const owner: PlannedHomeOwner = {
          tenantId: tenant,
          channelId: value.intent.channelId,
          homeRef: value.intent.targetHomeRef,
          policyRevision: value.intent.policyRevision,
          revision: value.intent.expectedRevision + 1,
        };
        if (!ownerValid(owner)) return { kind: 'conflict' };
        db.prepare(
          'UPDATE planned_home_owners SET record_json=? WHERE tenant_id=? AND channel_id=?',
        ).run(JSON.stringify(owner), tenant, owner.channelId);
        value.phase = 'committed';
        value.committedRevision = owner.revision;
        saveTransfer(value);
        return { kind: 'stored', value };
      });
    },
  };
}

/** Consumers await operations so a remote or asynchronous database adapter can
 * implement the same boundary without changing the coordinator. */
export interface PlannedHomeTransferStore {
  initialize(
    owner: PlannedHomeOwner,
  ):
    | TransferStoreResult<PlannedHomeOwner>
    | Promise<TransferStoreResult<PlannedHomeOwner>>;
  inspect(
    tenant: string,
    channel: string,
  ):
    | TransferStoreResult<PlannedHomeOwner>
    | Promise<TransferStoreResult<PlannedHomeOwner>>;
  resolve(
    tenant: string,
    operation: string,
  ):
    | TransferStoreResult<PlannedHomeTransfer>
    | Promise<TransferStoreResult<PlannedHomeTransfer>>;
  prepare(
    intent: PlannedHomeTransferIntent,
  ):
    | TransferStoreResult<PlannedHomeTransfer>
    | Promise<TransferStoreResult<PlannedHomeTransfer>>;
  recordClosure(
    tenant: string,
    operation: string,
    closure: ProjectTaskRoomSourceSeal,
  ):
    | TransferStoreResult<PlannedHomeTransfer>
    | Promise<TransferStoreResult<PlannedHomeTransfer>>;
  recordReady(
    tenant: string,
    operation: string,
    targetHomeRef: string,
    closureDigest: string,
  ):
    | TransferStoreResult<PlannedHomeTransfer>
    | Promise<TransferStoreResult<PlannedHomeTransfer>>;
  commit(
    tenant: string,
    operation: string,
  ):
    | TransferStoreResult<PlannedHomeTransfer>
    | Promise<TransferStoreResult<PlannedHomeTransfer>>;
}
