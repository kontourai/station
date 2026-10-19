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
import { validateReceipts } from './receipts.js';
import {
  emptyState,
  type ModelState,
  outboxRecordSchema,
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
function validateNamespace(database: DatabaseSync, policy: ModelPolicy) {
  validateDurability(database);
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
    validateNamespace(database, policy);
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
function loadState(
  database: DatabaseSync,
  before?: BeforeImage,
  captureProbe = true,
): ModelState {
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
    before?.runs.set(value.id, recordImage(value.record, record, captureProbe));
  }
  for (const row of database
    .prepare('SELECT id,record FROM agent_runtime_retired')
    .all()) {
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
  for (const row of database
    .prepare('SELECT id,record FROM agent_runtime_receipts')
    .all()) {
    const value = stored.parse(row);
    const record = receiptSchema.parse(JSON.parse(value.record));
    result.receipts.set(value.id, record);
    before?.receipts.set(
      value.id,
      recordImage(value.record, record, captureProbe),
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
          auditRefs.set(canonical(part), part);
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
      auditRefs.set(canonical(projection.body), projection.body);
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
  runtimeTransaction(database, policy, false, () =>
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
      command = structuredClone(command);
      return runtimeTransaction(
        database,
        policy,
        !isRead(command) || participants.some((p) => p.observeReads),
        () => {
          const key = command.type === 'open' ? command.spec.key : command.key;
          let admission: CurrentAdmission;
          try {
            admission = options.host(
              structuredClone(key),
              operationFor(command),
            );
            canonical(admission);
            bindingSchema.parse(admission.binding);
            if (!admission.writerGeneration)
              throw new Error('writer unavailable');
          } catch {
            return { kind: 'refused', reason: 'unavailable' };
          }
          const before: BeforeImage = {
            runs: new Map(),
            retired: new Map(),
            receipts: new Map(),
            outbox: new Map(),
          };
          const state = loadState(
            database,
            before,
            command.type !== 'acknowledge',
          );
          validateLinks(database, policy, state);
          for (const ref of commandBodies(command))
            readBody(database, policy, ref);
          const participantsForCommand = participants.filter(
            (p) => !isRead(command) || p.observeReads,
          );
          for (const participant of participantsForCommand)
            if (participant.admit?.(structuredClone(command), database))
              throw new RuntimeError('DURABLE_PARTICIPANT_REFUSED');
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
            readBody: (ref) => readBody(database, policy, ref),
          });
          const verifyParticipantState = () => {
            if (participantsForCommand.length)
              validateLinks(database, policy, loadState(database));
          };
          if (result.kind === 'refused' && !maintained) {
            verifyParticipantState();
            return result;
          }
          if (command.type === 'acknowledge' && !maintained) {
            const receiptId = canonical([keyOf(key), command.operationId]);
            const receipt = state.receipts.get(receiptId);
            const outbox = state.outbox.get(command.projectionId);
            if (!receipt || !outbox)
              throw new RuntimeError('DURABLE_RECORD_DAMAGED');
            const receiptImage = before.receipts.get(receiptId);
            if (!unchanged(receiptImage, receipt)) {
              const text = canonical(receipt);
              if (receiptImage?.text !== text)
                database
                  .prepare(
                    'INSERT INTO agent_runtime_receipts VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record',
                  )
                  .run(receiptId, text);
            }
            const outboxImage = before.outbox.get(command.projectionId);
            if (!unchanged(outboxImage, outbox)) {
              const text = canonical(outbox);
              if (outboxImage?.text !== text)
                database
                  .prepare(
                    'INSERT INTO agent_runtime_outbox VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record',
                  )
                  .run(command.projectionId, text);
            }
          } else if (!isRead(command)) {
            for (const [id, record] of state.retired) {
              const image = before.retired.get(id);
              if (unchanged(image, record)) continue;
              const value = canonical(record);
              if (image?.text === value) continue;
              database
                .prepare('DELETE FROM agent_runtime_runs WHERE id=?')
                .run(id);
              database
                .prepare(
                  'INSERT INTO agent_runtime_retired VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record',
                )
                .run(id, value);
            }
            const putRun = database.prepare(
              'INSERT INTO agent_runtime_runs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record',
            );
            for (const [id, record] of state.runs) {
              const image = before.runs.get(id);
              if (unchanged(image, record)) continue;
              const value = canonical(record);
              if (image?.text !== value) putRun.run(id, value);
            }
            const putReceipt = database.prepare(
              'INSERT INTO agent_runtime_receipts VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record',
            );
            for (const [id, record] of state.receipts) {
              const image = before.receipts.get(id);
              if (unchanged(image, record)) continue;
              const value = canonical(record);
              if (image?.text !== value) putReceipt.run(id, value);
            }
            const putOutbox = database.prepare(
              'INSERT INTO agent_runtime_outbox VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record',
            );
            for (const [id, record] of state.outbox) {
              const image = before.outbox.get(id);
              if (unchanged(image, record)) continue;
              const value = canonical(record);
              if (image?.text !== value) putOutbox.run(id, value);
            }
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
    const admission = options.host(structuredClone(key), 'project');
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
        return database
          .prepare('SELECT record FROM agent_runtime_projection ORDER BY rowid')
          .all()
          .map((row) =>
            projectionSchema.parse(JSON.parse(z.string().parse(row.record))),
          )
          .filter((p) => same(p.key, key));
      });
    },
    async readModelContext(key) {
      return runtimeTransaction(database, policy, false, () => {
        check(key);
        const state = loadState(database);
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
