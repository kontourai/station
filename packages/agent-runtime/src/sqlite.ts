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
  decode,
  digestBytes,
  encode,
  projectionSchema,
  RuntimeError,
  runKey,
} from './encoding.js';
import { fixedPolicy, type ModelPolicy } from './policy.js';
import {
  emptyState,
  type ModelState,
  outboxRecordSchema,
  receiptSchema,
  runRecordSchema,
} from './records.js';
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
CREATE TABLE agent_runtime_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL CHECK(schema_version=1), writer_format TEXT NOT NULL CHECK(writer_format='runtime-model/1')) STRICT;
INSERT INTO agent_runtime_meta VALUES(1,1,'runtime-model/1');
CREATE TABLE agent_runtime_bodies(codec TEXT NOT NULL, digest TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length>0 AND byte_length<=33554432), bytes BLOB NOT NULL CHECK(length(bytes)=byte_length), format INTEGER NOT NULL CHECK(format=1), PRIMARY KEY(codec,digest)) STRICT;
CREATE TABLE agent_runtime_runs(id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
CREATE TABLE agent_runtime_receipts(id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
CREATE TABLE agent_runtime_outbox(id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
CREATE TABLE agent_runtime_projection(id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
CREATE TRIGGER agent_runtime_immutable_body BEFORE UPDATE ON agent_runtime_bodies BEGIN SELECT RAISE(ABORT,'immutable runtime body'); END;
`;
const expectedTables = [
  'agent_runtime_meta',
  'agent_runtime_bodies',
  'agent_runtime_runs',
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
function prepare(database: DatabaseSync, policy: ModelPolicy) {
  idle(database);
  fixedPolicy(policy);
  if (
    database.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal' ||
    database.prepare('PRAGMA synchronous').get()?.synchronous !== 2 ||
    database.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1
  )
    throw new RuntimeError('DURABLE_SQLITE_POLICY_REQUIRED');
  transaction(database, true, () => {
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name LIKE 'agent_runtime_%' AND type='table'",
      )
      .all()
      .map((r) => r.name)
      .sort();
    if (!tables.length) database.exec(SCHEMA);
    else if (!same(tables, expectedTables))
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
      meta[0]?.schema_version !== 1 ||
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
      transaction(database, true, () => {
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
      return transaction(database, false, () =>
        readBody(database, policy, ref),
      );
    },
    async close() {
      closed = true;
    },
  };
}
const stored = z.object({ id: z.string(), record: z.string() });
function loadState(database: DatabaseSync): ModelState {
  const result = emptyState();
  for (const row of database
    .prepare('SELECT id,record FROM agent_runtime_runs')
    .all()) {
    const value = stored.parse(row);
    const record = runRecordSchema.parse(
      decode(new TextEncoder().encode(value.record)),
    );
    if (value.id !== keyOf(record.spec.key))
      throw new RuntimeError('DURABLE_RECORD_DAMAGED');
    result.runs.set(value.id, record);
  }
  for (const row of database
    .prepare('SELECT id,record FROM agent_runtime_receipts')
    .all()) {
    const value = stored.parse(row);
    result.receipts.set(
      value.id,
      receiptSchema.parse(JSON.parse(value.record)),
    );
  }
  for (const row of database
    .prepare('SELECT id,record FROM agent_runtime_outbox')
    .all()) {
    const value = stored.parse(row);
    const record = outboxRecordSchema.parse(JSON.parse(value.record));
    if (
      record.projection.id !== value.id ||
      projectionId(record.projection) !== value.id
    )
      throw new RuntimeError('DURABLE_RECORD_DAMAGED');
    result.outbox.set(value.id, record);
  }
  return result;
}
function validateLinks(
  database: DatabaseSync,
  policy: ModelPolicy,
  state: ModelState,
) {
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
          readBody(database, policy, part);
        }
        if (attempt.tape) {
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
    if (projection.body) readBody(database, policy, projection.body);
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
  transaction(database, false, () =>
    validateLinks(database, policy, loadState(database)),
  );
  let closed = false;
  const participants = [...(options.participants ?? [])];
  return {
    async execute<C extends ModelCommand>(
      command: C,
      context: ModelContext,
    ): Promise<ModelResult<C>> {
      if (closed) throw new RuntimeError('DURABLE_STORAGE_CLOSED');
      validateCommand(command);
      return transaction(
        database,
        !isRead(command) || participants.some((p) => p.observeReads),
        () => {
          const key = command.type === 'open' ? command.spec.key : command.key;
          let admission: CurrentAdmission;
          try {
            admission = options.host(key, operationFor(command));
            canonical(admission);
            bindingSchema.parse(admission.binding);
            if (!admission.writerGeneration)
              throw new Error('writer unavailable');
          } catch {
            return { kind: 'refused', reason: 'unavailable' };
          }
          const state = loadState(database);
          validateLinks(database, policy, state);
          for (const ref of commandBodies(command))
            readBody(database, policy, ref);
          const participantsForCommand = participants.filter(
            (p) => !isRead(command) || p.observeReads,
          );
          for (const participant of participantsForCommand)
            if (participant.admit?.(command, database))
              throw new RuntimeError('DURABLE_PARTICIPANT_REFUSED');
          const result = decideModel(command, {
            state,
            context,
            policy,
            admission,
            now: Date.now(),
            readBody: (ref) => readBody(database, policy, ref),
          });
          if (result.kind === 'refused') return result;
          if (!isRead(command)) {
            const putRun = database.prepare(
              'INSERT INTO agent_runtime_runs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record',
            );
            for (const [id, record] of state.runs)
              putRun.run(id, canonical(record));
            const putReceipt = database.prepare(
              'INSERT INTO agent_runtime_receipts VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record',
            );
            for (const [id, record] of state.receipts)
              putReceipt.run(id, canonical(record));
            const putOutbox = database.prepare(
              'INSERT INTO agent_runtime_outbox VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record',
            );
            for (const [id, record] of state.outbox)
              putOutbox.run(id, canonical(record));
          }
          for (const participant of participantsForCommand) {
            const returned: unknown = participant.commit?.(
              { command, result },
              database,
            );
            if (returned !== undefined)
              throw new RuntimeError('DURABLE_ASYNC_PARTICIPANT');
          }
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
    idle(database);
    const admission = options.host(key, 'project');
    bindingSchema.parse(admission.binding);
    const run = loadState(database).runs.get(keyOf(key));
    if (
      !run ||
      !same(admission.binding, run.spec.binding) ||
      admission.writerGeneration !== run.writerGeneration
    )
      throw new RuntimeError('DURABLE_UNAVAILABLE');
    return run;
  };
  return {
    async apply(entry) {
      canonical(entry);
      projectionSchema.parse(entry);
      check(entry.key);
      transaction(database, true, () => {
        if (projectionId(entry) !== entry.id)
          throw new RuntimeError('DURABLE_CONFLICT');
        const expected = loadState(database).outbox.get(entry.id);
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
      check(key);
      return transaction(database, false, () =>
        database
          .prepare('SELECT record FROM agent_runtime_projection ORDER BY rowid')
          .all()
          .map((row) =>
            projectionSchema.parse(JSON.parse(z.string().parse(row.record))),
          )
          .filter((p) => same(p.key, key)),
      );
    },
    async readModelContext(key) {
      check(key);
      return transaction(database, false, () => {
        const state = loadState(database);
        const run = state.runs.get(keyOf(key))!;
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
        for (const pin of run.pins)
          for (const a of pin.attempts) {
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
              if (
                !state.outbox.has(id) ||
                !database
                  .prepare('SELECT id FROM agent_runtime_projection WHERE id=?')
                  .get(id)
              )
                return { kind: 'unavailable' };
              readBody(database, policy, a.tape);
              tapes.push(a.tape);
            } else return { kind: 'unavailable' };
          }
        return { kind: 'ready', tapes };
      });
    },
    async close() {
      closed = true;
    },
  };
}
