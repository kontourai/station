import type { DatabaseSync } from 'node:sqlite';
import type { AtomicParticipant } from '@kontourai/monument/testing';
import { z } from 'zod';
import {
  entryData,
  ownFields,
  prefixDigest,
  readTape,
  validateBody,
} from './codecs.js';
import {
  commandBodies,
  operationFor,
  validateCommand,
} from './command-codec.js';
import {
  decideModel,
  isRead,
  keyOf,
  type ModelCommand,
  type ModelResult,
  projectionId,
  same,
} from './decisions.js';
import {
  bindingSchema,
  bodyRef,
  canonical,
  codecId,
  digestBytes,
  encode,
  projectionSchema,
  RuntimeError,
  runKey,
} from './encoding.js';
import {
  DEFAULT_MODEL_POLICY,
  fixedPolicy,
  type ModelPolicy,
} from './policy.js';
import { validateReceipts } from './receipts.js';
import {
  emptyState,
  type ModelState,
  outboxRecordSchema,
  type RunRecord,
  receiptSchema,
  runRecordSchema,
} from './records.js';
import { maintainGeneration, retiredSchema } from './retention.js';
import type {
  Bodies,
  BodyRef,
  CodecId,
  CurrentAdmission,
  ModelContext,
  ModelProtocol,
  ModelStorage,
  Refused,
  RunKey,
  RuntimeProjectionSink,
} from './types.js';

const SCHEMA = `
CREATE TABLE agent_runtime_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL CHECK(schema_version=2), writer_format TEXT NOT NULL CHECK(writer_format='runtime-model/1')) STRICT;
INSERT INTO agent_runtime_meta VALUES(1,2,'runtime-model/1');
CREATE TABLE agent_runtime_bodies(codec TEXT NOT NULL, digest TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length>0 AND byte_length<=33554432), bytes BLOB NOT NULL CHECK(length(bytes)=byte_length), format INTEGER NOT NULL CHECK(format=1), PRIMARY KEY(codec,digest)) STRICT;
CREATE TABLE agent_runtime_runs(id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
CREATE TABLE agent_runtime_retired(id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
CREATE TABLE agent_runtime_receipts(id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
CREATE TABLE agent_runtime_outbox(id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
CREATE TABLE agent_runtime_projection(id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
CREATE TRIGGER agent_runtime_immutable_body BEFORE UPDATE ON agent_runtime_bodies BEGIN SELECT RAISE(ABORT,'immutable runtime body'); END;
`;
const unresolvedPredicate = `CASE
  WHEN json_valid(record)=0 THEN 1
  WHEN json_type(record,'$.state') IS NOT 'text' THEN 1
  WHEN json_extract(record,'$.state') NOT IN ('completed','cancelled','blocked') THEN 1
  WHEN json_type(record,'$.settledAt') IS NOT 'integer' THEN 1
  ELSE 0 END=1`;
const unresolvedIndex = `CREATE INDEX agent_runtime_unresolved ON agent_runtime_runs(id) WHERE ${unresolvedPredicate}`;
const expectedTables = [
  'agent_runtime_meta',
  'agent_runtime_bodies',
  'agent_runtime_runs',
  'agent_runtime_retired',
  'agent_runtime_receipts',
  'agent_runtime_outbox',
  'agent_runtime_projection',
].sort();
const active = new WeakSet<DatabaseSync>();
function idle(database: DatabaseSync) {
  if (active.has(database) || database.isTransaction)
    throw new RuntimeError('DURABLE_NESTED_TRANSACTION');
}
function transaction<T>(
  database: DatabaseSync,
  write: boolean,
  operation: () => T,
): T {
  idle(database);
  active.add(database);
  try {
    database.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const result = operation();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    }
  } finally {
    active.delete(database);
  }
}
function validateDurability(database: DatabaseSync) {
  if (
    database.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal' ||
    database.prepare('PRAGMA synchronous').get()?.synchronous !== 2 ||
    database.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1
  )
    throw new RuntimeError('DURABLE_SQLITE_POLICY_REQUIRED');
}
function validateNamespace(
  database: DatabaseSync,
  policy: ModelPolicy,
  requireIndex = true,
) {
  validateDurability(database);
  if (
    database
      .prepare(
        "SELECT 1 FROM temp.sqlite_schema WHERE lower(name) GLOB 'agent_runtime_*' OR lower(tbl_name) GLOB 'agent_runtime_*'",
      )
      .get()
  )
    throw new RuntimeError('DURABLE_SCHEMA_UNSUPPORTED');
  const objects = database
    .prepare(
      "SELECT name,type,tbl_name,sql FROM main.sqlite_schema WHERE lower(name) GLOB 'agent_runtime_*' OR lower(tbl_name) GLOB 'agent_runtime_*'",
    )
    .all();
  for (const object of objects) {
    if (object.type === 'table' && expectedTables.includes(String(object.name)))
      continue;
    if (
      object.type === 'index' &&
      object.sql === null &&
      String(object.name).startsWith('sqlite_autoindex_')
    )
      continue;
    if (
      object.name === 'agent_runtime_immutable_body' &&
      object.type === 'trigger'
    )
      continue;
    if (
      object.name === 'agent_runtime_unresolved' &&
      object.type === 'index' &&
      object.sql === unresolvedIndex
    )
      continue;
    throw new RuntimeError('DURABLE_SCHEMA_UNSUPPORTED');
  }
  if (
    requireIndex &&
    !objects.some(
      (object) =>
        object.name === 'agent_runtime_unresolved' &&
        object.sql === unresolvedIndex,
    )
  )
    throw new RuntimeError('DURABLE_SCHEMA_UNSUPPORTED');
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE name LIKE 'agent_runtime_%' AND type='table'",
    )
    .all()
    .map((r) => r.name)
    .sort();
  if (!same(tables, expectedTables))
    throw new RuntimeError('DURABLE_SCHEMA_UNSUPPORTED');
  const expectedSQL = SCHEMA.split(';')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('CREATE TABLE'));
  const actualSQL = database
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type='table' AND name LIKE 'agent_runtime_%' ORDER BY name",
    )
    .all()
    .map((row) => row.sql);
  if (!same([...actualSQL].sort(), expectedSQL.sort()))
    throw new RuntimeError('DURABLE_SCHEMA_UNSUPPORTED');
  const meta = database.prepare('SELECT * FROM agent_runtime_meta').all();
  if (
    meta.length !== 1 ||
    meta[0]?.schema_version !== 2 ||
    meta[0]?.writer_format !== policy.writerFormat
  )
    throw new RuntimeError('DURABLE_WRITER_UNSUPPORTED');
  const ddl = database
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE name='agent_runtime_immutable_body'",
    )
    .get();
  if (
    ddl?.sql !==
    SCHEMA.slice(SCHEMA.indexOf('CREATE TRIGGER')).trim().slice(0, -1)
  )
    throw new RuntimeError('DURABLE_SCHEMA_UNSUPPORTED');
}
function runtimeTransaction<T>(
  database: DatabaseSync,
  policy: ModelPolicy,
  write: boolean,
  operation: () => T,
): T {
  return transaction(database, write, () => {
    validateNamespace(database, policy);
    const result = operation();
    validateNamespace(database, policy);
    return result;
  });
}
function prepare(database: DatabaseSync, policy: ModelPolicy) {
  idle(database);
  fixedPolicy(policy);
  validateDurability(database);
  transaction(database, true, () => {
    const existing = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name LIKE 'agent_runtime_%' AND type='table'",
      )
      .all();
    if (!existing.length) database.exec(SCHEMA);
    validateNamespace(database, policy, false);
    if (
      !database
        .prepare(
          "SELECT 1 FROM main.sqlite_schema WHERE name='agent_runtime_unresolved'",
        )
        .get()
    )
      database.exec(unresolvedIndex);
  });
}
function readBody(
  database: DatabaseSync,
  policy: ModelPolicy,
  ref: BodyRef,
): Uint8Array {
  bodyRef.parse(ref);
  if (ref.byteLength > policy.maxBlobBytes)
    throw new RuntimeError('DURABLE_CAPACITY');
  const row = database
    .prepare(
      'SELECT codec,digest,byte_length,bytes,format FROM agent_runtime_bodies WHERE codec=? AND digest=?',
    )
    .get(ref.codec, ref.digest);
  if (
    !row ||
    !(row.bytes instanceof Uint8Array) ||
    row.format !== 1 ||
    row.byte_length !== ref.byteLength ||
    row.bytes.length !== ref.byteLength ||
    digestBytes(row.bytes) !== ref.digest
  )
    throw new RuntimeError('DURABLE_BODY_DAMAGED');
  const result = new Uint8Array(row.bytes);
  validateBody(ref.codec, result);
  return result;
}
export function openSqliteRuntimeBodies(options: {
  database: DatabaseSync;
  policy: ModelPolicy;
}): Bodies & { close(): Promise<void> } {
  ownFields(options, ['database', 'policy']);
  const { database } = options;
  const policy = fixedPolicy(options.policy);
  prepare(database, policy);
  let closed = false;
  const check = () => {
    if (closed) throw new RuntimeError('DURABLE_STORAGE_CLOSED');
    idle(database);
  };
  return {
    async put(codec: CodecId, bytes: Uint8Array) {
      check();
      codecId.parse(codec);
      const copy = new Uint8Array(bytes);
      if (!copy.length || copy.length > policy.maxBlobBytes)
        throw new RuntimeError('DURABLE_CAPACITY');
      validateBody(codec, copy);
      const ref: BodyRef = {
        codec,
        digest: digestBytes(copy),
        byteLength: copy.length,
      };
      runtimeTransaction(database, policy, true, () => {
        const old = database
          .prepare(
            'SELECT byte_length,bytes FROM agent_runtime_bodies WHERE codec=? AND digest=?',
          )
          .get(codec, ref.digest);
        if (old) {
          if (
            !(old.bytes instanceof Uint8Array) ||
            old.byte_length !== copy.length ||
            !Buffer.from(old.bytes).equals(copy)
          )
            throw new RuntimeError('DURABLE_BODY_COLLISION');
        } else
          database
            .prepare('INSERT INTO agent_runtime_bodies VALUES(?,?,?,?,1)')
            .run(codec, ref.digest, copy.length, copy);
        readBody(database, policy, ref);
      });
      return ref;
    },
    async read(ref) {
      check();
      return runtimeTransaction(database, policy, false, () =>
        readBody(database, policy, ref),
      );
    },
    async close() {
      closed = true;
    },
  };
}
const stored = z.object({ id: z.string(), record: z.string() });
type RecordImage = { text: string; probe?: string };
type BeforeImage = {
  runs: Map<string, RecordImage>;
  retired: Map<string, RecordImage>;
  receipts: Map<string, RecordImage>;
  outbox: Map<string, RecordImage>;
};
// Only strict-decoded private records reach this transaction-local probe.
// Host callbacks receive detached views; changed records retain canonical writes.
function recordImage(
  text: string,
  record: object,
  captureProbe: boolean,
): RecordImage {
  return captureProbe ? { text, probe: JSON.stringify(record) } : { text };
}
function unchanged(image: RecordImage | undefined, record: object): boolean {
  if (!image) return false;
  if (image.probe !== undefined) return image.probe === JSON.stringify(record);
  return canonical(JSON.parse(image.text)) === canonical(record);
}
type RecordTable = 'runs' | 'retired' | 'receipts' | 'outbox' | 'projection';
function selectedRows(
  database: DatabaseSync,
  table: RecordTable,
  key?: RunKey,
) {
  const name = `agent_runtime_${table}`;
  if (!key)
    return database
      .prepare(`SELECT id,record FROM ${name} ORDER BY rowid`)
      .all();
  const id = keyOf(key);
  if (table === 'runs' || table === 'retired')
    return database.prepare(`SELECT id,record FROM ${name} WHERE id=?`).all(id);
  const prefix =
    table === 'receipts'
      ? `[${JSON.stringify(id)},`
      : [key.scopeId, key.conversationId, key.invocationId]
          .map((value) => `${Buffer.byteLength(value)}:${value}`)
          .join('');
  const lower = table === 'receipts' ? prefix : `${prefix}0`;
  const upper = table === 'receipts' ? `${prefix.slice(0, -1)}-` : `${prefix}:`;
  return database
    .prepare(
      `SELECT id,record FROM ${name} WHERE id>=? COLLATE BINARY AND id<? COLLATE BINARY ORDER BY rowid`,
    )
    .all(lower, upper);
}
function beforeImage(): BeforeImage {
  return {
    runs: new Map(),
    retired: new Map(),
    receipts: new Map(),
    outbox: new Map(),
  };
}
function assertImage(
  database: DatabaseSync,
  key: RunKey,
  expected: BeforeImage,
) {
  for (const table of ['runs', 'retired', 'receipts', 'outbox'] as const) {
    const rows = selectedRows(database, table, key);
    if (
      rows.length !== expected[table].size ||
      rows.some(
        (row) => expected[table].get(String(row.id))?.text !== row.record,
      )
    )
      throw new RuntimeError('DURABLE_SELECTED_STATE_CHANGED');
  }
}
function putSelected(
  database: DatabaseSync,
  table: Exclude<RecordTable, 'projection'>,
  id: string,
  text: string,
  image: BeforeImage,
) {
  const old = image[table].get(id);
  if (old?.text === text) return;
  if (old) {
    const result = database
      .prepare(
        `UPDATE agent_runtime_${table} SET record=? WHERE id=? AND record=?`,
      )
      .run(text, id, old.text);
    if (result.changes !== 1)
      throw new RuntimeError('DURABLE_SELECTED_STATE_CHANGED');
  } else
    database
      .prepare(`INSERT INTO agent_runtime_${table} VALUES(?,?)`)
      .run(id, text);
}
function unresolvedHeader(run: RunRecord): boolean {
  const unresolved = run.state === 'open' || run.state === 'running';
  if (unresolved !== (run.settledAt === null))
    throw new RuntimeError('DURABLE_RECORD_DAMAGED');
  return unresolved;
}
function validateRawRunHeader(
  database: DatabaseSync,
  text: string,
  run: RunRecord,
) {
  unresolvedHeader(run);
  const values = database
    .prepare(
      "SELECT key,type,value FROM json_each(?) WHERE key IN ('state','settledAt')",
    )
    .all(text);
  const states = values.filter((value) => value.key === 'state');
  const settlements = values.filter((value) => value.key === 'settledAt');
  if (
    states.length !== 1 ||
    settlements.length !== 1 ||
    states[0]?.type !== 'text' ||
    states[0]?.value !== run.state ||
    settlements[0]?.type !== (run.settledAt === null ? 'null' : 'integer') ||
    settlements[0]?.value !== run.settledAt
  )
    throw new RuntimeError('DURABLE_RECORD_DAMAGED');
}
function unresolvedRuns(database: DatabaseSync): Map<string, RunRecord> {
  const rows = database
    .prepare(
      `SELECT id,record FROM agent_runtime_runs INDEXED BY agent_runtime_unresolved WHERE ${unresolvedPredicate} LIMIT ?`,
    )
    .all(DEFAULT_MODEL_POLICY.maxOpenRuns + 1);
  if (rows.length > DEFAULT_MODEL_POLICY.maxOpenRuns)
    throw new RuntimeError('DURABLE_CAPACITY');
  const result = new Map<string, RunRecord>();
  for (const row of rows) {
    const value = stored.parse(row);
    const run = runRecordSchema.parse(JSON.parse(value.record));
    validateRawRunHeader(database, value.record, run);
    if (value.id !== keyOf(run.spec.key) || !unresolvedHeader(run))
      throw new RuntimeError('DURABLE_RECORD_DAMAGED');
    result.set(value.id, run);
  }
  return result;
}
type Controls = Set<string>;
function unresolvedControls(database: DatabaseSync): Controls {
  const result: Controls = new Set();
  for (const row of database
    .prepare(
      `SELECT id FROM agent_runtime_runs INDEXED BY agent_runtime_unresolved WHERE ${unresolvedPredicate}`,
    )
    .all()) {
    if (typeof row.id !== 'string')
      throw new RuntimeError('DURABLE_RECORD_DAMAGED');
    result.add(row.id);
  }
  return result;
}
function assertControls(database: DatabaseSync, expected: Controls) {
  const actual = unresolvedControls(database);
  if (
    actual.size !== expected.size ||
    [...actual].some((id) => !expected.has(id))
  )
    throw new RuntimeError('DURABLE_SELECTED_STATE_CHANGED');
}
function openFacts(database: DatabaseSync, key: RunKey) {
  const runs = unresolvedRuns(database);
  return {
    activeCount: runs.size,
    conversationBusy: [...runs.keys()].some((id) => {
      const [scopeId, conversationId] = JSON.parse(id);
      return scopeId === key.scopeId && conversationId === key.conversationId;
    }),
  };
}
function assertSelectedIdentities(
  database: DatabaseSync,
  key: RunKey,
  state: ModelState,
) {
  for (const table of ['runs', 'retired', 'receipts', 'outbox'] as const) {
    const rows = selectedRows(database, table, key);
    if (
      rows.length !== state[table].size ||
      rows.some(
        (row) => typeof row.id !== 'string' || !state[table].has(row.id),
      )
    )
      throw new RuntimeError('DURABLE_SELECTED_STATE_CHANGED');
  }
}
function loadState(
  database: DatabaseSync,
  before?: BeforeImage,
  captureProbe = true,
  key?: RunKey,
): ModelState {
  const result = emptyState();
  for (const row of selectedRows(database, 'runs', key)) {
    const value = stored.parse(row);
    const record = runRecordSchema.parse(JSON.parse(value.record));
    validateRawRunHeader(database, value.record, record);
    if (value.id !== keyOf(record.spec.key))
      throw new RuntimeError('DURABLE_RECORD_DAMAGED');
    result.runs.set(value.id, record);
    before?.runs.set(value.id, recordImage(value.record, record, captureProbe));
  }
  for (const row of selectedRows(database, 'retired', key)) {
    const value = stored.parse(row);
    const retired = retiredSchema.parse(JSON.parse(value.record));
    if (keyOf(retired.key) !== value.id || result.runs.has(value.id))
      throw new RuntimeError('DURABLE_RECORD_DAMAGED');
    result.retired.set(value.id, retired);
    before?.retired.set(
      value.id,
      recordImage(value.record, retired, captureProbe),
    );
  }
  for (const row of selectedRows(database, 'receipts', key)) {
    const value = stored.parse(row);
    const record = receiptSchema.parse(JSON.parse(value.record));
    if (key && JSON.parse(value.id)[0] !== keyOf(key))
      throw new RuntimeError('DURABLE_RECORD_DAMAGED');
    result.receipts.set(value.id, record);
    before?.receipts.set(
      value.id,
      recordImage(value.record, record, captureProbe),
    );
  }
  for (const row of selectedRows(database, 'outbox', key)) {
    const value = stored.parse(row);
    const record = outboxRecordSchema.parse(JSON.parse(value.record));
    if (
      (key && keyOf(record.projection.key) !== keyOf(key)) ||
      record.projection.id !== value.id ||
      projectionId(record.projection) !== value.id
    )
      throw new RuntimeError('DURABLE_RECORD_DAMAGED');
    result.outbox.set(value.id, record);
    before?.outbox.set(
      value.id,
      recordImage(value.record, record, captureProbe),
    );
  }
  const positions = new Map<string, number[]>();
  for (const row of result.outbox.values()) {
    const id = keyOf(row.projection.key);
    const list = positions.get(id) ?? [];
    list.push(row.position);
    positions.set(id, list);
  }
  for (const list of positions.values())
    if (
      list.sort((a, b) => a - b).some((position, index) => position !== index)
    )
      throw new RuntimeError('DURABLE_RECORD_DAMAGED');
  validateReceipts(result);
  return result;
}
/** Journal completion authority, independent of sink application/readiness. */
function completedProjection(
  state: ModelState,
  key: RunKey,
  requestId: string,
  attempt: number,
  tape: BodyRef,
) {
  const identity = {
    key,
    requestId,
    attempt,
    sequence: 0,
    kind: 'completed' as const,
  };
  const expected = { ...identity, id: projectionId(identity), body: tape };
  const committed = state.outbox.get(expected.id);
  if (!committed || !same(committed.projection, expected))
    throw new RuntimeError('DURABLE_RECORD_DAMAGED');
  return committed;
}
function validateLinks(
  database: DatabaseSync,
  policy: ModelPolicy,
  state: ModelState,
) {
  // Every ref was strictly decoded by this current loadState pass.
  const auditRefs = new Map<string, BodyRef>();
  for (const run of state.runs.values()) {
    const entry = entryData(
      run.spec.entry.body.codec,
      readBody(database, policy, run.spec.entry.body),
    );
    if (
      !same(entry.binding, run.spec.binding) ||
      prefixDigest(entry) !== run.spec.entry.effectivePrefixDigest ||
      entry.sourceCutoff !== run.spec.entry.sourceCutoff ||
      entry.authoredDigest !== run.spec.entry.originalAuthoredDigest
    )
      throw new RuntimeError('DURABLE_RECORD_DAMAGED');
    let previous: string | null = null;
    for (const [index, pin] of run.pins.entries()) {
      if (
        pin.pin.ordinal !== index ||
        pin.pin.entryDigest !== run.spec.entry.body.digest ||
        pin.pin.previousResponseDigest !== previous ||
        pin.pin.request.codec !== 'runtime-ai-sdk-v3-request/1'
      )
        throw new RuntimeError('DURABLE_RECORD_DAMAGED');
      readBody(database, policy, pin.pin.request);
      for (const [number, attempt] of pin.attempts.entries()) {
        if (
          attempt.attempt.requestId !== pin.pin.requestId ||
          attempt.attempt.number !== number + 1 ||
          (attempt.state === 'completed') !== (attempt.tape !== null)
        )
          throw new RuntimeError('DURABLE_RECORD_DAMAGED');
        for (const part of attempt.partials) {
          if (part.codec !== 'runtime-ai-sdk-v3-part/1')
            throw new RuntimeError('DURABLE_RECORD_DAMAGED');
          auditRefs.set(
            JSON.stringify([part.codec, part.digest, part.byteLength]),
            part,
          );
        }
        if (attempt.tape) {
          completedProjection(
            state,
            run.spec.key,
            pin.pin.requestId,
            attempt.attempt.number,
            attempt.tape,
          );
          const tape = readTape(readBody(database, policy, attempt.tape));
          if (
            tape.requestId !== attempt.attempt.requestId ||
            tape.attempt !== attempt.attempt.number ||
            attempt.partials.some(
              (part, i) =>
                !tape.parts[i] ||
                digestBytes(encode(tape.parts[i])) !== part.digest,
            )
          )
            throw new RuntimeError('DURABLE_RECORD_DAMAGED');
        }
      }
      if (
        pin.attempts.filter((a) => a.state === 'completed').length > 1 ||
        pin.attempts.filter((a) => a.state === 'running').length > 1
      )
        throw new RuntimeError('DURABLE_RECORD_DAMAGED');
      previous =
        pin.attempts.find((a) => a.state === 'completed')?.tape?.digest ?? null;
      if (index < run.pins.length - 1 && previous === null)
        throw new RuntimeError('DURABLE_RECORD_DAMAGED');
    }
  }
  for (const { projection } of state.outbox.values())
    if (projection.body)
      auditRefs.set(
        JSON.stringify([
          projection.body.codec,
          projection.body.digest,
          projection.body.byteLength,
        ]),
        projection.body,
      );
  for (const ref of auditRefs.values()) readBody(database, policy, ref);
}
export function openSqliteModelStorage(options: {
  database: DatabaseSync;
  policy: ModelPolicy;
  host: (
    key: RunKey,
    operation: 'execute' | 'recover' | 'read' | 'cancel' | 'project',
  ) => CurrentAdmission;
  participants?: readonly AtomicParticipant<
    ModelProtocol,
    DatabaseSync,
    Refused
  >[];
}): ModelStorage {
  ownFields(options, ['database', 'policy', 'host', 'participants']);
  const { database } = options;
  const policy = fixedPolicy(options.policy);
  prepare(database, policy);
  runtimeTransaction(database, policy, false, () => {
    const unresolved = unresolvedRuns(database);
    for (const run of unresolved.values())
      validateLinks(
        database,
        policy,
        loadState(database, undefined, true, run.spec.key),
      );
  });
  let closed = false;
  const participants = [...(options.participants ?? [])];
  return {
    async execute<C extends ModelCommand>(
      command: C,
      context: ModelContext,
    ): Promise<ModelResult<C>> {
      if (closed) throw new RuntimeError('DURABLE_STORAGE_CLOSED');
      validateCommand(command);
      command = structuredClone(command);
      return runtimeTransaction(
        database,
        policy,
        !isRead(command) || participants.some((p) => p.observeReads),
        () => {
          const key = command.type === 'open' ? command.spec.key : command.key;
          let admission: CurrentAdmission;
          try {
            const observed = options.host(
              structuredClone(key),
              operationFor(command),
            );
            canonical(observed);
            admission = structuredClone(observed);
            canonical(admission);
            bindingSchema.parse(admission.binding);
            if (
              typeof admission.writerGeneration !== 'string' ||
              !admission.writerGeneration
            )
              throw new Error('writer unavailable');
          } catch {
            return { kind: 'refused', reason: 'unavailable' };
          }
          const before = beforeImage();
          const state = loadState(
            database,
            before,
            command.type !== 'acknowledge',
            key,
          );
          validateLinks(database, policy, state);
          for (const ref of commandBodies(command))
            readBody(database, policy, ref);
          const participantsForCommand = participants.filter(
            (p) => !isRead(command) || p.observeReads,
          );
          const previousRun = state.runs.get(keyOf(key));
          const wasUnresolved =
            previousRun?.state === 'open' || previousRun?.state === 'running';
          const globalControls =
            !isRead(command) || participantsForCommand.length
              ? unresolvedControls(database)
              : undefined;
          for (const participant of participantsForCommand)
            if (participant.admit?.(structuredClone(command), database))
              throw new RuntimeError('DURABLE_PARTICIPANT_REFUSED');
          if (participantsForCommand.length) {
            assertImage(database, key, before);
            validateLinks(
              database,
              policy,
              loadState(database, undefined, true, key),
            );
          }
          if (globalControls && participantsForCommand.length)
            assertControls(database, globalControls);
          const globalOpen =
            command.type === 'open' &&
            globalControls &&
            !state.runs.has(keyOf(key)) &&
            !state.retired.has(keyOf(key))
              ? openFacts(database, key)
              : undefined;
          const maintained = maintainGeneration(
            command,
            state,
            policy,
            admission,
            Date.now(),
            (projection) =>
              database
                .prepare(
                  'SELECT record FROM agent_runtime_projection WHERE id=?',
                )
                .get(projection.id)?.record === canonical(projection),
          );
          const result = decideModel(command, {
            state,
            context,
            policy,
            admission,
            now: Date.now(),
            globalOpen,
            readBody: (ref) => readBody(database, policy, ref),
          });
          // Liveness and SQL authorizers can run after loading R as well.
          assertImage(database, key, before);
          if (globalControls) assertControls(database, globalControls);
          const expectedControls = globalControls
            ? new Set(globalControls)
            : undefined;
          // Refusals do not mutate decision state; only R's decided membership delta is permitted.
          if (expectedControls) {
            const currentRun = state.runs.get(keyOf(key));
            const nowUnresolved =
              currentRun?.state === 'open' || currentRun?.state === 'running';
            if (nowUnresolved !== wasUnresolved) {
              if (nowUnresolved) expectedControls.add(keyOf(key));
              else expectedControls.delete(keyOf(key));
            }
          }
          const verifyParticipantState = () => {
            if (participantsForCommand.length) {
              assertSelectedIdentities(database, key, state);
              const actual = loadState(database, undefined, true, key);
              if (
                (['runs', 'retired', 'receipts', 'outbox'] as const).some(
                  (table) =>
                    actual[table].size !== state[table].size ||
                    [...actual[table]].some(
                      ([id, record]) =>
                        !state[table].has(id) ||
                        !same(record, state[table].get(id)),
                    ),
                )
              )
                throw new RuntimeError('DURABLE_SELECTED_STATE_CHANGED');
              validateLinks(database, policy, actual);
            }
            if (expectedControls) assertControls(database, expectedControls);
          };
          if (result.kind === 'refused' && !maintained) {
            verifyParticipantState();
            return result;
          }
          if (command.type === 'acknowledge' && !maintained) {
            const id = canonical([keyOf(key), command.operationId]);
            const receipt = state.receipts.get(id);
            const outbox = state.outbox.get(command.projectionId);
            if (!receipt || !outbox)
              throw new RuntimeError('DURABLE_RECORD_DAMAGED');
            if (!unchanged(before.receipts.get(id), receipt))
              putSelected(database, 'receipts', id, canonical(receipt), before);
            if (!unchanged(before.outbox.get(command.projectionId), outbox))
              putSelected(
                database,
                'outbox',
                command.projectionId,
                canonical(outbox),
                before,
              );
          } else if (!isRead(command)) {
            for (const [id, record] of state.retired) {
              if (unchanged(before.retired.get(id), record)) continue;
              const run = before.runs.get(id);
              if (
                run &&
                database
                  .prepare(
                    'DELETE FROM agent_runtime_runs WHERE id=? AND record=?',
                  )
                  .run(id, run.text).changes !== 1
              )
                throw new RuntimeError('DURABLE_SELECTED_STATE_CHANGED');
              putSelected(database, 'retired', id, canonical(record), before);
            }
            for (const table of ['runs', 'receipts', 'outbox'] as const)
              for (const [id, record] of state[table])
                if (!unchanged(before[table].get(id), record))
                  putSelected(database, table, id, canonical(record), before);
          }
          if (result.kind === 'refused') {
            for (const participant of participantsForCommand) {
              const returned: unknown = participant.maintenance?.(
                { command: structuredClone(command) },
                database,
              );
              if (returned !== undefined)
                throw new RuntimeError('DURABLE_ASYNC_PARTICIPANT');
            }
            verifyParticipantState();
            return result;
          }
          for (const participant of participantsForCommand) {
            const participantResult: ModelResult<ModelCommand> =
              structuredClone(result);
            if (participantResult.kind === 'refused')
              throw new RuntimeError('DURABLE_PARTICIPANT_REFUSED');
            const returned: unknown = participant.commit?.(
              { command: structuredClone(command), result: participantResult },
              database,
            );
            if (returned !== undefined)
              throw new RuntimeError('DURABLE_ASYNC_PARTICIPANT');
          }
          verifyParticipantState();
          return result;
        },
      );
    },
    async close() {
      closed = true;
    },
  };
}
export function openSqliteRuntimeProjection(options: {
  database: DatabaseSync;
  bodies: Bodies;
  policy: ModelPolicy;
  host: (
    key: RunKey,
    operation: 'execute' | 'recover' | 'read' | 'cancel' | 'project',
  ) => CurrentAdmission;
}): RuntimeProjectionSink {
  ownFields(options, ['database', 'bodies', 'policy', 'host']);
  const { database } = options;
  const policy = fixedPolicy(options.policy);
  prepare(database, policy);
  let closed = false;
  const check = (key: RunKey) => {
    if (closed) throw new RuntimeError('DURABLE_STORAGE_CLOSED');
    runKey.parse(key);
    const observed = options.host(structuredClone(key), 'project');
    canonical(observed);
    const admission = structuredClone(observed);
    bindingSchema.parse(admission.binding);
    const id = keyOf(key);
    const runRow = database
      .prepare('SELECT record FROM agent_runtime_runs WHERE id=?')
      .get(id);
    const retiredRow = database
      .prepare('SELECT record FROM agent_runtime_retired WHERE id=?')
      .get(id);
    const run = runRow
      ? runRecordSchema.parse(JSON.parse(z.string().parse(runRow.record)))
      : undefined;
    const retired = retiredRow
      ? retiredSchema.parse(JSON.parse(z.string().parse(retiredRow.record)))
      : undefined;
    if (
      (run && keyOf(run.spec.key) !== id) ||
      (retired && keyOf(retired.key) !== id) ||
      (run && retired)
    )
      throw new RuntimeError('DURABLE_RECORD_DAMAGED');
    if (
      (!run && !retired) ||
      !same(admission.binding, run?.spec.binding ?? retired?.binding) ||
      admission.writerGeneration !==
        (run?.writerGeneration ?? retired?.writerGeneration)
    )
      throw new RuntimeError('DURABLE_UNAVAILABLE');
    return run;
  };
  return {
    async apply(entry) {
      canonical(entry);
      projectionSchema.parse(entry);
      runtimeTransaction(database, policy, true, () => {
        check(entry.key);
        validateLinks(
          database,
          policy,
          loadState(database, undefined, true, entry.key),
        );
        if (projectionId(entry) !== entry.id)
          throw new RuntimeError('DURABLE_CONFLICT');
        const row = database
          .prepare('SELECT record FROM agent_runtime_outbox WHERE id=?')
          .get(entry.id);
        const expected = row
          ? outboxRecordSchema.parse(JSON.parse(z.string().parse(row.record)))
          : undefined;
        if (!expected || !same(expected.projection, entry))
          throw new RuntimeError('DURABLE_CONFLICT');
        if (entry.body) readBody(database, policy, entry.body);
        const old = database
          .prepare('SELECT record FROM agent_runtime_projection WHERE id=?')
          .get(entry.id);
        if (old && old.record !== canonical(entry))
          throw new RuntimeError('DURABLE_CONFLICT');
        if (!old)
          database
            .prepare('INSERT INTO agent_runtime_projection VALUES(?,?)')
            .run(entry.id, canonical(entry));
      });
    },
    async readAudit(key) {
      return runtimeTransaction(database, policy, false, () => {
        check(key);
        return selectedRows(database, 'projection', key).map((row) => {
          const projection = projectionSchema.parse(
            JSON.parse(z.string().parse(row.record)),
          );
          if (
            row.id !== projection.id ||
            projectionId(projection) !== row.id ||
            keyOf(projection.key) !== keyOf(key)
          )
            throw new RuntimeError('DURABLE_RECORD_DAMAGED');
          const committed = database
            .prepare('SELECT record FROM agent_runtime_outbox WHERE id=?')
            .get(projection.id);
          if (
            !committed ||
            !same(
              outboxRecordSchema.parse(
                JSON.parse(z.string().parse(committed.record)),
              ).projection,
              projection,
            )
          )
            throw new RuntimeError('DURABLE_RECORD_DAMAGED');
          if (projection.body) readBody(database, policy, projection.body);
          return projection;
        });
      });
    },
    async readModelContext(key) {
      return runtimeTransaction(database, policy, false, () => {
        check(key);
        const state = loadState(database, undefined, true, key);
        validateLinks(database, policy, state);
        const run = state.runs.get(keyOf(key));
        if (
          !run ||
          (run.settledAt !== null &&
            Date.now() >= run.settledAt + policy.settledRetentionMs)
        )
          return { kind: 'unavailable' };
        if (run.state === 'open' || run.state === 'running')
          return { kind: 'unavailable' };
        for (const row of state.outbox.values())
          if (same(row.projection.key, key)) {
            const applied = database
              .prepare('SELECT record FROM agent_runtime_projection WHERE id=?')
              .get(row.projection.id);
            if (
              !row.acknowledged ||
              applied?.record !== canonical(row.projection)
            )
              return { kind: 'unavailable' };
          }
        const tapes: BodyRef[] = [];
        let previous: string | null = null;
        for (const [ordinal, pin] of run.pins.entries()) {
          if (
            pin.pin.ordinal !== ordinal ||
            pin.pin.entryDigest !== run.spec.entry.body.digest ||
            pin.pin.previousResponseDigest !== previous ||
            pin.pin.request.codec !== 'runtime-ai-sdk-v3-request/1'
          )
            throw new RuntimeError('DURABLE_RECORD_DAMAGED');
          readBody(database, policy, pin.pin.request);
          let completed: string | null = null;
          for (const [number, a] of pin.attempts.entries()) {
            if (
              a.attempt.requestId !== pin.pin.requestId ||
              a.attempt.number !== number + 1
            )
              throw new RuntimeError('DURABLE_RECORD_DAMAGED');
            const identity = {
              key,
              requestId: a.attempt.requestId,
              attempt: a.attempt.number,
              sequence: 0,
            };
            if (a.state === 'aborted') {
              const id = projectionId({ ...identity, kind: 'aborted' });
              if (
                !state.outbox.has(id) ||
                !database
                  .prepare('SELECT id FROM agent_runtime_projection WHERE id=?')
                  .get(id)
              )
                return { kind: 'unavailable' };
            } else if (a.state === 'completed' && a.tape) {
              const id = projectionId({ ...identity, kind: 'completed' });
              const committed = completedProjection(
                state,
                key,
                pin.pin.requestId,
                a.attempt.number,
                a.tape,
              );
              const applied = database
                .prepare(
                  'SELECT record FROM agent_runtime_projection WHERE id=?',
                )
                .get(id);
              if (
                !committed.acknowledged ||
                applied?.record !== canonical(committed.projection)
              )
                throw new RuntimeError('DURABLE_RECORD_DAMAGED');
              if (
                a.tape.codec !== 'runtime-ai-sdk-v3-tape/1' ||
                completed !== null
              )
                throw new RuntimeError('DURABLE_RECORD_DAMAGED');
              const tape = readTape(readBody(database, policy, a.tape));
              if (
                tape.requestId !== pin.pin.requestId ||
                tape.requestId !== a.attempt.requestId ||
                tape.attempt !== a.attempt.number
              )
                throw new RuntimeError('DURABLE_RECORD_DAMAGED');
              for (const [sequence, part] of a.partials.entries()) {
                if (
                  part.codec !== 'runtime-ai-sdk-v3-part/1' ||
                  !tape.parts[sequence] ||
                  digestBytes(encode(tape.parts[sequence])) !== part.digest
                )
                  throw new RuntimeError('DURABLE_RECORD_DAMAGED');
                readBody(database, policy, part);
                const partialId = projectionId({
                  ...identity,
                  kind: 'partial',
                  sequence,
                });
                const partial = state.outbox.get(partialId);
                if (
                  !partial ||
                  !same(partial.projection, {
                    ...identity,
                    id: partialId,
                    kind: 'partial',
                    sequence,
                    body: part,
                  })
                )
                  throw new RuntimeError('DURABLE_RECORD_DAMAGED');
              }
              completed = a.tape.digest;
              tapes.push(a.tape);
            } else return { kind: 'unavailable' };
          }
          if (completed === null && ordinal < run.pins.length - 1)
            throw new RuntimeError('DURABLE_RECORD_DAMAGED');
          previous = completed;
        }
        return { kind: 'ready', tapes };
      });
    },
    async close() {
      closed = true;
    },
  };
}

export interface RuntimeStoreAudit {
  readonly status: 'clean' | 'damaged' | 'incomplete';
  readonly complete: boolean;
  readonly issues: readonly {
    readonly category:
      | 'sqlite'
      | 'namespace'
      | 'record'
      | 'relationship'
      | 'body'
      | 'projection';
    readonly table: string;
    readonly identityDigest?: string;
    readonly code: string;
    readonly disposition: 'damage' | 'unavailable';
  }[];
}

/** Explicit quiescent diagnostic; never creates, repairs, or admits effects. */
export async function auditAgentRuntimeStore(options: {
  database: DatabaseSync;
  policy: ModelPolicy;
}): Promise<RuntimeStoreAudit> {
  ownFields(options, ['database', 'policy']);
  const { database } = options;
  const policy = fixedPolicy(options.policy);
  const issues: RuntimeStoreAudit['issues'][number][] = [];
  let complete = true;
  let damageDetected = false;
  const report = (
    category: RuntimeStoreAudit['issues'][number]['category'],
    table: string,
    error: unknown,
    id?: unknown,
    explicitDisposition?: RuntimeStoreAudit['issues'][number]['disposition'],
  ) => {
    const sqliteDamage =
      error instanceof Error &&
      'errcode' in error &&
      typeof error.errcode === 'number' &&
      Number.isInteger(error.errcode) &&
      [11, 26].includes(error.errcode & 0xff);
    const disposition = sqliteDamage
      ? 'damage'
      : (explicitDisposition ??
        (error instanceof z.ZodError ||
        error instanceof SyntaxError ||
        (error instanceof RuntimeError &&
          [
            'DURABLE_RECORD_DAMAGED',
            'DURABLE_BODY_DAMAGED',
            'DURABLE_INDEX_DAMAGED',
            'DURABLE_SQLITE_DAMAGED',
            'DURABLE_UNSUPPORTED',
          ].includes(error.code))
          ? 'damage'
          : 'unavailable'));
    if (disposition === 'damage') damageDetected = true;
    else complete = false;
    if (issues.length >= 128) {
      complete = false;
      return;
    }
    issues.push({
      category: sqliteDamage ? 'sqlite' : category,
      table: sqliteDamage ? 'database' : table,
      disposition,
      ...(typeof id === 'string'
        ? { identityDigest: digestBytes(encode(id)) }
        : {}),
      code: sqliteDamage
        ? 'DURABLE_SQLITE_DAMAGED'
        : error instanceof RuntimeError
          ? error.code
          : disposition === 'damage'
            ? 'DURABLE_RECORD_DAMAGED'
            : 'DURABLE_AUDIT_UNAVAILABLE',
    });
  };
  try {
    transaction(database, false, () => {
      try {
        validateNamespace(database, policy);
      } catch (error) {
        report('namespace', 'sqlite_schema', error, undefined, 'unavailable');
        complete = false;
        return;
      }
      const checks = database.prepare('PRAGMA integrity_check').all();
      if (checks.length !== 1 || checks[0]?.integrity_check !== 'ok')
        report(
          'sqlite',
          'database',
          new RuntimeError('DURABLE_SQLITE_DAMAGED'),
        );
      const decoded = emptyState();
      const rawRuns = database
        .prepare(
          `SELECT id,record,(${unresolvedPredicate}) AS unresolved FROM agent_runtime_runs NOT INDEXED ORDER BY rowid`,
        )
        .all();
      const indexed = database
        .prepare(
          `SELECT id FROM agent_runtime_runs INDEXED BY agent_runtime_unresolved WHERE ${unresolvedPredicate}`,
        )
        .all();
      const indexedIds = new Set(
        indexed.map((row) => z.string().parse(row.id)),
      );
      const rawIds = new Set<string>();
      for (const raw of rawRuns) {
        try {
          const row = stored.parse(raw);
          rawIds.add(row.id);
          if (indexedIds.has(row.id) !== (raw.unresolved === 1))
            report(
              'relationship',
              'agent_runtime_runs',
              new RuntimeError('DURABLE_INDEX_DAMAGED'),
              row.id,
            );
          const run = runRecordSchema.parse(JSON.parse(row.record));
          validateRawRunHeader(database, row.record, run);
          if (row.id !== keyOf(run.spec.key))
            throw new RuntimeError('DURABLE_RECORD_DAMAGED');
          const expected = unresolvedHeader(run);
          if (expected !== (raw.unresolved === 1))
            throw new RuntimeError('DURABLE_INDEX_DAMAGED');
          decoded.runs.set(row.id, run);
        } catch (error) {
          complete = false;
          report('record', 'agent_runtime_runs', error, raw.id);
        }
      }
      for (const id of indexedIds)
        if (!rawIds.has(id))
          report(
            'relationship',
            'agent_runtime_runs',
            new RuntimeError('DURABLE_INDEX_DAMAGED'),
            id,
          );
      if (indexedIds.size > DEFAULT_MODEL_POLICY.maxOpenRuns)
        report(
          'relationship',
          'agent_runtime_runs',
          new RuntimeError('DURABLE_CAPACITY'),
          undefined,
          'damage',
        );
      for (const raw of selectedRows(database, 'retired')) {
        try {
          const row = stored.parse(raw);
          const retired = retiredSchema.parse(JSON.parse(row.record));
          if (keyOf(retired.key) !== row.id || decoded.runs.has(row.id))
            throw new RuntimeError('DURABLE_RECORD_DAMAGED');
          decoded.retired.set(row.id, retired);
        } catch (error) {
          complete = false;
          report('record', 'agent_runtime_retired', error, raw.id);
        }
      }
      for (const raw of selectedRows(database, 'receipts')) {
        let decodedReceipt = false;
        try {
          const row = stored.parse(raw);
          const receipt = receiptSchema.parse(JSON.parse(row.record));
          decodedReceipt = true;
          validateReceipts({
            ...decoded,
            receipts: new Map([[row.id, receipt]]),
          });
        } catch (error) {
          if (!decodedReceipt) complete = false;
          report('record', 'agent_runtime_receipts', error, raw.id);
        }
      }
      for (const raw of selectedRows(database, 'outbox')) {
        let decodedOutbox = false;
        try {
          const row = stored.parse(raw);
          const outbox = outboxRecordSchema.parse(JSON.parse(row.record));
          decodedOutbox = true;
          if (
            row.id !== outbox.projection.id ||
            projectionId(outbox.projection) !== row.id ||
            (!decoded.runs.has(keyOf(outbox.projection.key)) &&
              !decoded.retired.has(keyOf(outbox.projection.key)))
          )
            throw new RuntimeError('DURABLE_RECORD_DAMAGED');
          if (outbox.projection.body)
            readBody(database, policy, outbox.projection.body);
        } catch (error) {
          if (!decodedOutbox) complete = false;
          report('record', 'agent_runtime_outbox', error, raw.id);
        }
      }
      const keys = [
        ...[...decoded.runs.values()].map((run) => run.spec.key),
        ...[...decoded.retired.values()].map((retired) => retired.key),
      ];
      for (const key of keys) {
        try {
          validateLinks(
            database,
            policy,
            loadState(database, undefined, true, key),
          );
        } catch (error) {
          complete = false;
          report('relationship', 'journal', error, keyOf(key));
        }
      }
      for (const raw of database
        .prepare(
          'SELECT codec,digest,byte_length,bytes,format FROM agent_runtime_bodies',
        )
        .iterate()) {
        try {
          const ref = bodyRef.parse({
            codec: raw.codec,
            digest: raw.digest,
            byteLength: raw.byte_length,
          });
          readBody(database, policy, ref);
        } catch (error) {
          report('body', 'agent_runtime_bodies', error, raw.digest);
        }
      }
      for (const raw of selectedRows(database, 'projection')) {
        try {
          const row = stored.parse(raw);
          const projection = projectionSchema.parse(JSON.parse(row.record));
          if (projection.id !== row.id || projectionId(projection) !== row.id)
            throw new RuntimeError('DURABLE_RECORD_DAMAGED');
          const outbox = database
            .prepare('SELECT record FROM agent_runtime_outbox WHERE id=?')
            .get(row.id);
          const expected = outboxRecordSchema.parse(
            JSON.parse(z.string().parse(outbox?.record)),
          );
          if (!same(projection, expected.projection))
            throw new RuntimeError('DURABLE_RECORD_DAMAGED');
          if (projection.body) readBody(database, policy, projection.body);
        } catch (error) {
          report('projection', 'agent_runtime_projection', error, raw.id);
        }
      }
    });
  } catch (error) {
    complete = false;
    report('sqlite', 'database', error, undefined, 'unavailable');
  }
  return {
    status: damageDetected ? 'damaged' : complete ? 'clean' : 'incomplete',
    complete,
    issues,
  };
}
