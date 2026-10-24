import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { findInvocationTerminal } from '../adapter.js';
import type {
  KernelCommand,
  KernelResult,
  TurnBoundaryAcceptInvocationCommand,
} from '../commands.js';
import {
  assertInvocationTerminalQuery,
  assertInvocationTerminalRetirement,
  sameTerminalData,
} from '../decisions/invocation-terminal.js';
import type {
  InvocationTerminalFact,
  InvocationTerminalQuery,
  InvocationTerminalRead,
  TurnBoundaryRecord,
} from '../records.js';
import {
  openSqliteKernelStorage,
  type SqliteInvocationTerminalFacts,
  type SqliteKernelDatabase,
  type SqliteTurnBoundaryTable,
} from '../sqlite.js';
import { createSqliteKernelLocation } from '../testing/index.js';

const owner = {
  id: 'owner',
  pid: 91,
  identityKind: 'exact',
  birth: 'birth',
} as const;
const context = { liveness: () => 'live' as const };
const intent = {
  invocationId: 'B',
  inputDigest: 'input',
  intentDigest: 'envelope',
  bodyRef: 'body',
};
const expected: TurnBoundaryRecord = {
  boundaryId: 'b',
  threadId: 't',
  state: 'invoking',
  purpose: 'turn',
  owner,
  createdAt: '10',
  updatedAt: '12',
  intent,
};
const command: TurnBoundaryAcceptInvocationCommand = {
  type: 'turnBoundary.acceptInvocation',
  expected,
  providerTurnId: 'N',
  now: '13',
};
const fact = (
  id: string,
  native?: string,
  retire = true,
): InvocationTerminalFact => ({
  threadId: 't',
  invocationId: 'B',
  terminalEventId: id,
  terminalCreatedAt: '01',
  retire,
  ...(native === undefined ? {} : { providerTurnId: native }),
});
const observation = (terminal: InvocationTerminalFact) =>
  ({
    type: 'turnBoundary.observeTerminal',
    ...terminal,
    sessionTerminal: false,
  }) as const;
const intentColumns = {
  invocationId: 'invocation_id',
  inputDigest: 'input_digest',
  intentDigest: 'intent_digest',
  bodyRef: 'body_ref',
  dedupKey: 'dedup_key',
} as const;
const schema = `
CREATE TABLE boundaries(boundary_id TEXT PRIMARY KEY, thread_id TEXT, state TEXT, purpose TEXT, provider_turn_id TEXT,
 owner_json TEXT, owner_id TEXT, owner_pid INTEGER, owner_identity_kind TEXT, owner_birth TEXT,
 created_at TEXT, updated_at TEXT, invocation_id TEXT, input_digest TEXT, intent_digest TEXT, body_ref TEXT, dedup_key TEXT);
CREATE UNIQUE INDEX active_boundary ON boundaries(thread_id) WHERE state IN ('reserved','prepared','invoking','indeterminate','lifecycle');
CREATE TABLE events(id TEXT PRIMARY KEY, thread_id TEXT, invocation_id TEXT, method TEXT, native_id TEXT, created_at TEXT, recovery INTEGER, deferred INTEGER, session_start_indeterminate INTEGER);
CREATE TABLE intents(invocation_id TEXT PRIMARY KEY, boundary_id TEXT, thread_id TEXT, envelope TEXT, body BLOB, retirement TEXT);
INSERT INTO intents VALUES ('B','b','t','unchanged envelope',X'0001ff',NULL);
`;
function decodeHostEvent(row: Record<string, unknown>): InvocationTerminalFact {
  return {
    threadId: String(row.thread_id),
    invocationId: String(row.invocation_id),
    terminalEventId: String(row.id),
    terminalCreatedAt: String(row.created_at),
    retire:
      ['turn.completed', 'turn.aborted', 'runtime.error'].includes(
        String(row.method),
      ) &&
      row.recovery === 0 &&
      row.deferred === 0 &&
      row.session_start_indeterminate === 0,
    ...(row.native_id === null
      ? {}
      : { providerTurnId: String(row.native_id) }),
  };
}
/** Real canonical columns and existing intent row; never a second terminal store. */
const hostFacts: SqliteInvocationTerminalFacts = {
  readObservation(database, thread, event) {
    const row = database
      .prepare('SELECT * FROM events WHERE thread_id = ? AND id = ?')
      .get(thread, event) as Record<string, unknown> | undefined;
    return row ? decodeHostEvent(row) : undefined;
  },
  find(database, query) {
    assertInvocationTerminalQuery(query);
    const rows = database
      .prepare('SELECT * FROM events WHERE thread_id = ? AND invocation_id = ?')
      .all(query.threadId, query.invocationId) as Array<
      Record<string, unknown>
    >;
    const terminals = rows.map(decodeHostEvent);
    return findInvocationTerminal(terminals, query);
  },
  readRetirement(database, thread, boundary) {
    const row = database
      .prepare(
        'SELECT retirement FROM intents WHERE thread_id = ? AND boundary_id = ?',
      )
      .get(thread, boundary) as { retirement: string | null } | undefined;
    if (!row?.retirement) return undefined;
    const witness: unknown = JSON.parse(row.retirement);
    assertInvocationTerminalRetirement(witness);
    return witness;
  },
  recordRetirement(database, witness) {
    assertInvocationTerminalRetirement(witness);
    const row = database
      .prepare(
        'SELECT retirement, boundary_id, thread_id FROM intents WHERE invocation_id = ?',
      )
      .get(witness.terminal.invocationId) as
      | { retirement: string | null; boundary_id: string; thread_id: string }
      | undefined;
    if (
      !row ||
      row.boundary_id !== witness.boundary.boundaryId ||
      row.thread_id !== witness.boundary.threadId
    )
      throw new Error('host intent association mismatch');
    if (row.retirement) {
      if (!sameTerminalData(JSON.parse(row.retirement), witness))
        throw new Error('host witness conflict');
      return;
    }
    database
      .prepare('UPDATE intents SET retirement = ? WHERE invocation_id = ?')
      .run(JSON.stringify(witness), witness.terminal.invocationId);
  },
};
function append(
  db: SqliteKernelDatabase,
  terminal: InvocationTerminalFact,
  extra: {
    method?: string;
    recovery?: number;
    deferred?: number;
    sessionStart?: number;
  } = {},
) {
  db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)').run(
    terminal.terminalEventId,
    terminal.threadId,
    terminal.invocationId,
    extra.method ?? 'turn.completed',
    terminal.providerTurnId ?? null,
    terminal.terminalCreatedAt,
    extra.recovery ?? (terminal.retire ? 0 : 1),
    extra.deferred ?? 0,
    extra.sessionStart ?? 0,
  );
}
async function begin(
  run: <C extends KernelCommand>(command: C) => Promise<KernelResult<C>>,
  linked = false,
  inputDigest?: string,
) {
  if (linked)
    expect(
      await run({
        type: 'turnDedup.claim',
        key: 'k',
        owner,
        now: 1,
        tracking: 'tracked',
        ...(inputDigest === undefined ? {} : { inputDigest }),
      }),
    ).toEqual({ kind: 'claimed', reclaimed: false });
  expect(
    await run({
      type: 'turnBoundary.create',
      boundaryId: 'b',
      threadId: 't',
      state: 'reserved',
      purpose: 'turn',
      owner,
      now: '10',
    }),
  ).toEqual({ kind: 'applied' });
  const input = linked ? { ...intent, dedupKey: 'k' } : intent;
  expect(
    await run({
      type: 'turnBoundary.prepare',
      boundaryId: 'b',
      ownerId: owner.id,
      intent: input,
      ...(linked ? { dedupOwnerId: owner.id } : {}),
      now: '11',
    }),
  ).toEqual({ kind: 'applied' });
  expect(
    await run({
      type: 'turnBoundary.beginInvocation',
      boundaryId: 'b',
      ownerId: owner.id,
      intent: input,
      ...(linked ? { dedupOwnerId: owner.id } : {}),
      now: '12',
    }),
  ).toEqual({ kind: 'applied' });
}
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
function fixture(
  ownerEncoding: 'json' | 'columns',
  via: 'execute' | 'executeSync',
  bundle: SqliteInvocationTerminalFacts | undefined = hostFacts,
  boundDedup = false,
) {
  const db = new DatabaseSync(':memory:');
  cleanup.push(() => db.close());
  db.exec(schema);
  if (boundDedup)
    db.exec(
      'CREATE TABLE host_dedup(dedup_key TEXT PRIMARY KEY,value TEXT,created_at INTEGER NOT NULL,owner_json TEXT,input_digest TEXT); CREATE TABLE host_expired(dedup_key TEXT PRIMARY KEY,expired_at INTEGER NOT NULL)',
    );
  const binding: SqliteTurnBoundaryTable = {
    table: 'boundaries',
    ownerEncoding,
    terminalFacts: 'host',
    intentColumns,
    terminalSeen: () => false,
    ...(bundle ? { invocationTerminals: bundle } : {}),
  };
  const storage = openSqliteKernelStorage({
    database: db,
    tables: {
      turnBoundary: binding,
      ...(boundDedup
        ? {
            turnDedup: {
              table: 'host_dedup',
              tombstoneTable: 'host_expired',
              ownerIdField: 'token',
              inputDigestColumn: 'input_digest',
            },
          }
        : {}),
    },
  });
  cleanup.push(() => storage.close());
  const run = async <C extends KernelCommand>(
    input: C,
  ): Promise<KernelResult<C>> =>
    via === 'execute'
      ? storage.execute(input, context)
      : storage.executeSync(input, context);
  const rows = async () => {
    const result = await run({ type: 'turnBoundary.list' });
    if (result.kind !== 'records') throw new Error('list prerequisite');
    return result.records;
  };
  return { db, storage, binding, run, rows };
}

for (const layout of ['json', 'columns'] as const)
  for (const via of ['execute', 'executeSync'] as const)
    describe(`${layout} ${via} real host facts`, () => {
      it.each([false, true])(
        'preserves submitted digest through strict acceptance and full witnessed custody (bound dedup=%s)',
        async (boundDedup) => {
          const f = fixture(layout, via, hostFacts, boundDedup);
          const digest = 'station-turn-submission/v1:sha256:' + 'a'.repeat(64);
          await begin(f.run, true, digest);
          const dedup = await f.run({ type: 'turnDedup.read', key: 'k' });
          if (dedup.kind !== 'found')
            throw new Error('begun dedup prerequisite');
          expect(dedup.record).toMatchObject({
            invocation: 'begun',
            inputDigest: digest,
          });
          const accept = {
            ...command,
            expected: { ...expected, intent: { ...intent, dedupKey: 'k' } },
            expectedDedup: dedup.record,
          };
          // On the integration baseline this reaches strict record validation,
          // before any host-acceptance path or missing-witness branch.
          const table = boundDedup ? 'host_dedup' : 'monument_turn_dedup';
          const original = f.db
            .prepare(
              `SELECT input_digest,owner_json FROM ${table} WHERE dedup_key='k'`,
            )
            .get() as { input_digest: string; owner_json: string };
          expect(original.input_digest).toBe(digest);
          expect(JSON.parse(original.owner_json).inputDigest).toBe(digest);
          expect(await f.run(accept)).toEqual({ kind: 'accepted' });
          for (const inputDigest of [undefined, digest + 'changed']) {
            const { inputDigest: _original, ...without } = dedup.record;
            const expectedDedup =
              inputDigest === undefined ? without : { ...without, inputDigest };
            expect(await f.run({ ...accept, expectedDedup })).toEqual({
              kind: 'stale',
            });
          }
          for (const inputDigest of [undefined, digest + 'changed']) {
            const { inputDigest: _old, ...fields } = JSON.parse(
              original.owner_json,
            );
            f.db
              .prepare(
                `UPDATE ${table} SET input_digest=?,owner_json=? WHERE dedup_key='k'`,
              )
              .run(
                inputDigest ?? null,
                JSON.stringify({
                  ...fields,
                  ...(inputDigest === undefined ? {} : { inputDigest }),
                }),
              );
            expect(await f.run(accept)).toEqual({ kind: 'stale' });
          }
          f.db
            .prepare(
              `UPDATE ${table} SET input_digest=?,owner_json=? WHERE dedup_key='k'`,
            )
            .run(original.input_digest, original.owner_json);
          append(f.db, fact('digest-terminal', 'N'));
          expect(
            await f.run(observation(fact('digest-terminal', 'N'))),
          ).toEqual({
            kind: 'applied',
          });
          const witness = hostFacts.readRetirement(f.db, 't', 'b');
          expect(witness?.dedup).toEqual(dedup.record);
          if (!witness?.dedup) throw new Error('digest witness prerequisite');
          for (const inputDigest of [undefined, digest + 'changed']) {
            const { inputDigest: _old, ...without } = witness.dedup;
            f.db.prepare('UPDATE intents SET retirement = ?').run(
              JSON.stringify({
                ...witness,
                dedup: {
                  ...without,
                  ...(inputDigest === undefined ? {} : { inputDigest }),
                },
              }),
            );
            expect(await f.run(accept)).toEqual({ kind: 'stale' });
          }
          f.db
            .prepare('UPDATE intents SET retirement = ?')
            .run(JSON.stringify(witness));
          expect(await f.run(accept)).toEqual({
            kind: 'terminal',
            terminal: fact('digest-terminal', 'N'),
          });
          expect(await f.rows()).toEqual([]);
        },
      );
      it('selects after actual-target native eligibility, in code-point order, and acknowledges the exact witnessed event', async () => {
        const f = fixture(layout, via);
        await begin(f.run);
        expect(await f.run(command)).toEqual({ kind: 'accepted' });
        append(f.db, fact('e0'));
        expect(await f.run(command)).toEqual({ kind: 'accepted' });
        expect((await f.rows())[0]?.state).toBe('accepted');
        expect(hostFacts.readRetirement(f.db, 't', 'b')).toBeUndefined();
        append(f.db, fact('\u{10000}', 'N'));
        append(f.db, fact('\uE000', 'N'));
        expect(await f.run(command)).toEqual({
          kind: 'terminal',
          terminal: fact('\uE000', 'N'),
        });
        expect(await f.rows()).toEqual([]);
        const witness = hostFacts.readRetirement(f.db, 't', 'b');
        expect(witness?.boundary).toEqual({
          ...expected,
          state: 'accepted',
          providerTurnId: 'N',
          updatedAt: '13',
        });
        expect(await f.run(command)).toEqual({
          kind: 'terminal',
          terminal: fact('\uE000', 'N'),
        });
        f.db.prepare('DELETE FROM events WHERE id = ?').run('\uE000');
        expect(await f.run(command)).toEqual({ kind: 'stale' });
        expect(hostFacts.readRetirement(f.db, 't', 'b')).toEqual(witness);
      });
      it('checks the complete invocation set before provider/event filters and blocks late contradictory acknowledgement', async () => {
        const f = fixture(layout, via);
        await begin(f.run);
        append(f.db, fact('eM', 'M'));
        const query = {
          threadId: 't',
          invocationId: 'B',
          providerTurnId: 'N',
          allowMissingProviderTurnId: true,
        };
        expect(hostFacts.find(f.db, query)).toEqual({ kind: 'unknown' });
        expect(await f.run(command)).toEqual({ kind: 'stale' });
        expect(await f.rows()).toEqual([expected]);
        append(f.db, fact('eN', 'N'));
        expect(
          hostFacts.find(f.db, { ...query, terminalEventId: 'eN' }),
        ).toEqual({ kind: 'unknown' });
        expect(await f.run(observation(fact('eN', 'N')))).toEqual({
          kind: 'applied',
        });
        expect(await f.rows()).toEqual([expected]);
        f.db.prepare('DELETE FROM events WHERE id = ?').run('eM');
        expect(await f.run(command)).toEqual({
          kind: 'terminal',
          terminal: fact('eN', 'N'),
        });
        const witness = hostFacts.readRetirement(f.db, 't', 'b');
        append(f.db, fact('lateM', 'M'));
        expect(await f.run(command)).toEqual({ kind: 'stale' });
        expect(await f.rows()).toEqual([]);
        expect(hostFacts.readRetirement(f.db, 't', 'b')).toEqual(witness);
      });
      it('excludes actual recovery, deferred, session-start and nonterminal markers while preserving compatible missing-native facts', async () => {
        const f = fixture(layout, via);
        await begin(f.run);
        append(f.db, fact('recovery', 'M'), { recovery: 1 });
        append(f.db, fact('deferred', 'M'), {
          deferred: 1,
          method: 'runtime.error',
        });
        append(f.db, fact('session-start', 'M'), {
          sessionStart: 1,
          method: 'runtime.error',
        });
        append(f.db, fact('progress', 'M'), { method: 'turn.started' });
        append(f.db, { ...fact('A', 'M'), invocationId: 'A' });
        append(f.db, { ...fact('other-thread', 'M'), threadId: 'other' });
        append(f.db, fact('e0'));
        append(f.db, fact('eN', 'N'));
        const query = {
          threadId: 't',
          invocationId: 'B',
          providerTurnId: 'N',
          allowMissingProviderTurnId: true,
        };
        expect(hostFacts.find(f.db, query)).toEqual({
          kind: 'found',
          fact: fact('e0'),
        });
        expect(
          hostFacts.find(f.db, { ...query, allowMissingProviderTurnId: false }),
        ).toEqual({ kind: 'found', fact: fact('eN', 'N') });
        expect(
          hostFacts.find(f.db, { ...query, terminalEventId: 'recovery' }),
        ).toEqual({ kind: 'absent' });
        expect(await f.run(command)).toEqual({
          kind: 'terminal',
          terminal: fact('e0'),
        });
        expect(await f.run(command)).toEqual({
          kind: 'terminal',
          terminal: fact('e0'),
        });
      });
      it('rolls event, witness and deletion back with the outer host transaction', async () => {
        const f = fixture(layout, via);
        await begin(f.run);
        const before = f.db.prepare('SELECT * FROM intents').get();
        f.db.exec('BEGIN');
        append(f.db, fact('eN', 'N'));
        expect(
          f.storage.executeSync(observation(fact('eN', 'N')), context, {
            withinHostTransaction: true,
          }),
        ).toEqual({ kind: 'applied' });
        expect(hostFacts.readRetirement(f.db, 't', 'b')?.boundary).toEqual(
          expected,
        );
        f.db.exec('ROLLBACK');
        expect(f.db.prepare('SELECT * FROM events').all()).toEqual([]);
        expect(f.db.prepare('SELECT * FROM intents').get()).toEqual(before);
        expect(await f.rows()).toEqual([expected]);
        f.db.exec('BEGIN');
        append(f.db, fact('eN', 'N'));
        f.storage.executeSync(observation(fact('eN', 'N')), context, {
          withinHostTransaction: true,
        });
        f.db.exec('COMMIT');
        expect(await f.run(command)).toEqual({
          kind: 'terminal',
          terminal: fact('eN', 'N'),
        });
        expect(
          f.db
            .prepare(
              "SELECT name FROM sqlite_master WHERE name = 'monument_turn_terminals'",
            )
            .get(),
        ).toBeUndefined();
      });
      it('writes the witness before DELETE and restores every sibling byte after a real deletion trigger abort', async () => {
        const f = fixture(layout, via);
        await begin(f.run, true);
        const boundaryBefore = f.db.prepare('SELECT * FROM boundaries').get();
        const dedupBefore = f.db
          .prepare('SELECT * FROM monument_turn_dedup')
          .get();
        const auditBefore = f.db.prepare('SELECT * FROM intents').get();
        f.db.exec(`CREATE TRIGGER fail_retirement BEFORE DELETE ON boundaries BEGIN
      SELECT CASE WHEN (SELECT retirement FROM intents WHERE invocation_id = OLD.invocation_id) IS NULL THEN RAISE(ABORT, 'witness not reached') END;
      SELECT RAISE(ABORT, 'after witness'); END;`);
        f.db.exec('BEGIN');
        append(f.db, fact('eN', 'N'));
        expect(() =>
          f.storage.executeSync(observation(fact('eN', 'N')), context, {
            withinHostTransaction: true,
          }),
        ).toThrow('after witness');
        f.db.exec('ROLLBACK');
        expect(f.db.prepare('SELECT * FROM boundaries').get()).toEqual(
          boundaryBefore,
        );
        expect(f.db.prepare('SELECT * FROM monument_turn_dedup').get()).toEqual(
          dedupBefore,
        );
        expect(f.db.prepare('SELECT * FROM intents').get()).toEqual(
          auditBefore,
        );
        expect(f.db.prepare('SELECT * FROM events').all()).toEqual([]);
        f.db.exec('DROP TRIGGER fail_retirement');
        append(f.db, fact('eN', 'N'));
        expect(await f.run(observation(fact('eN', 'N')))).toEqual({
          kind: 'applied',
        });
        expect(await f.rows()).toEqual([]);
        expect(
          f.db.prepare('SELECT body, envelope FROM intents').get(),
        ).toEqual({
          body: new Uint8Array([0, 1, 255]),
          envelope: 'unchanged envelope',
        });
      });
    });

it('unknown blocks otherwise exact accepted and ambiguous images; bad source responses never become absence', async () => {
  let response: InvocationTerminalRead = { kind: 'absent' };
  let calls = 0;
  const f = fixture('json', 'executeSync', {
    ...hostFacts,
    find: () => {
      calls++;
      return response;
    },
  });
  await begin(f.run);
  expect(await f.run(command)).toEqual({ kind: 'accepted' });
  const accepted = await f.rows();
  response = { kind: 'unknown' };
  expect(await f.run(command)).toEqual({ kind: 'stale' });
  expect(await f.rows()).toEqual(accepted);
  for (const bad of [
    { kind: 'found', fact: { ...fact('e', 'N'), threadId: 'wrong' } },
    { kind: 'found', fact: { ...fact('e', 'N'), invocationId: 'wrong' } },
    { kind: 'found', fact: fact('e') },
    { kind: 'found', fact: { ...fact('e', 'N'), retire: false } },
    { kind: 'absent', fact: fact('e', 'N') },
    { kind: 'unsupported' },
    Object.create({ kind: 'absent' }),
  ]) {
    response = bad as InvocationTerminalRead;
    await expect(f.run(command)).rejects.toThrow();
    expect(await f.rows()).toEqual(accepted);
  }
  response = { kind: 'absent' };
  expect(
    await f.run({
      type: 'turnBoundary.transition',
      boundaryId: 'b',
      ownerId: owner.id,
      from: ['accepted'],
      to: 'indeterminate',
      providerTurnId: 'N',
      now: '14',
    }),
  ).toEqual({ kind: 'applied' });
  const ambiguous = await f.rows();
  response = { kind: 'unknown' };
  expect(
    await f.run({ ...command, expected: ambiguous[0]!, now: '14' }),
  ).toEqual({ kind: 'stale' });
  expect(await f.rows()).toEqual(ambiguous);
  const beforeCalls = calls;
  for (const bad of [
    { ...command, now: undefined },
    { ...command, expected: Object.create(expected) },
    { ...command, expected: { ...expected, owner: Object.create(owner) } },
    Object.defineProperty({ ...command }, 'providerTurnId', { get: () => 'N' }),
    { ...command, expectedDedup: undefined },
  ])
    await expect(
      f.run(bad as TurnBoundaryAcceptInvocationCommand),
    ).rejects.toThrow();
  expect(calls).toBe(beforeCalls);
});

it('strict source query data rejects missing/truthy/inherited/unknown/accessor identity fields', () => {
  const f = fixture('json', 'executeSync');
  const query = {
    threadId: 't',
    invocationId: 'B',
    allowMissingProviderTurnId: true,
  };
  const { allowMissingProviderTurnId: _missing, ...missing } = query;
  for (const bad of [
    missing,
    { ...query, allowMissingProviderTurnId: 1 },
    { ...query, providerTurnId: undefined },
    { ...query, providerTurnId: null },
    { ...query, terminalEventId: '' },
    Object.create(query),
    { ...query, constructor: 'extra' },
    { ...query, toString: 'extra' },
    Object.defineProperty({ ...query }, 'invocationId', { get: () => 'B' }),
  ])
    expect(() => hostFacts.find(f.db, bad as InvocationTerminalQuery)).toThrow(
      'query',
    );
});

it('compares every field of an absent-row witness and never substitutes another event or a new occupant', async () => {
  const f = fixture('json', 'executeSync');
  await begin(f.run);
  append(f.db, fact('eN', 'N'));
  expect(await f.run(command)).toEqual({
    kind: 'terminal',
    terminal: fact('eN', 'N'),
  });
  const witness = hostFacts.readRetirement(f.db, 't', 'b');
  expect(witness).toBeDefined();
  append(f.db, fact('other', 'N'));
  f.db
    .prepare("UPDATE events SET created_at = 'changed' WHERE id = 'eN'")
    .run();
  expect(await f.run(command)).toEqual({ kind: 'stale' });
  f.db.prepare("UPDATE events SET created_at = '01' WHERE id = 'eN'").run();
  expect(await f.run(command)).toEqual({
    kind: 'terminal',
    terminal: fact('eN', 'N'),
  });
  expect(
    await f.run({
      type: 'turnBoundary.create',
      boundaryId: 'b',
      threadId: 't',
      state: 'reserved',
      purpose: 'turn',
      owner: { ...owner, id: 'new-owner' },
      now: '20',
    }),
  ).toEqual({ kind: 'applied' });
  expect(await f.run(command)).toEqual({ kind: 'stale' });
  expect((await f.rows())[0]?.state).toBe('reserved');
  expect(hostFacts.readRetirement(f.db, 't', 'b')).toEqual(witness);
});

it('host witness-write and participant-after-dispatch failures roll back all writes', async () => {
  for (const point of ['witness', 'participant'] as const) {
    const f = fixture('columns', 'executeSync');
    await begin(f.run);
    const before = f.db.prepare('SELECT * FROM intents').get();
    await f.storage.close();
    const failing = openSqliteKernelStorage({
      database: f.db,
      tables: {
        turnBoundary: {
          ...f.binding,
          invocationTerminals: {
            ...hostFacts,
            recordRetirement(database, witness) {
              hostFacts.recordRetirement(database, witness);
              if (point === 'witness') throw new Error('witness write failed');
            },
          },
        },
      },
      participants: [
        {
          name: 'after dispatch',
          commit({ command: input }, db) {
            if (input.type !== 'turnBoundary.observeTerminal') return;
            expect(hostFacts.readRetirement(db, 't', 'b')).toBeDefined();
            expect(db.prepare('SELECT * FROM boundaries').all()).toEqual([]);
            throw new Error('participant after deletion');
          },
        },
      ],
    });
    cleanup.push(() => failing.close());
    f.db.exec('BEGIN');
    append(f.db, fact('eN', 'N'));
    expect(() =>
      failing.executeSync(observation(fact('eN', 'N')), context, {
        withinHostTransaction: true,
      }),
    ).toThrow(
      point === 'witness'
        ? 'witness write failed'
        : 'participant after deletion',
    );
    f.db.exec('ROLLBACK');
    expect(f.db.prepare('SELECT state FROM boundaries').get()).toEqual({
      state: 'invoking',
    });
    expect(f.db.prepare('SELECT * FROM intents').get()).toEqual(before);
    expect(f.db.prepare('SELECT * FROM events').all()).toEqual([]);
  }
});

it('missing host bundle refuses before participant writes, while a legacy operation remains usable', async () => {
  const f = fixture('json', 'executeSync', undefined);
  // Explicit undefined selects the default argument, so open the legacy binding directly.
  await f.storage.close();
  let admissions = 0;
  const { invocationTerminals: _bundle, ...legacy } = f.binding;
  const storage = openSqliteKernelStorage({
    database: f.db,
    tables: { turnBoundary: legacy },
    participants: [
      {
        name: 'instrument',
        admit(_command, db) {
          admissions++;
          db.prepare("UPDATE intents SET envelope = 'participant write'").run();
        },
      },
    ],
  });
  cleanup.push(() => storage.close());
  for (const input of [command, observation(fact('eN', 'N'))])
    expect(() => storage.executeSync(input, context)).toThrow(
      'complete host bundle',
    );
  expect(admissions).toBe(0);
  expect(f.db.prepare('SELECT envelope FROM intents').get()).toEqual({
    envelope: 'unchanged envelope',
  });
  expect(
    storage.executeSync(
      {
        type: 'turnBoundary.recordAccepted',
        boundaryId: 'legacy',
        threadId: 't',
        providerTurnId: '',
        owner,
        now: '1',
      },
      context,
    ),
  ).toEqual({ kind: 'applied' });
  expect(admissions).toBe(1);
});

it('bundle configuration has exact own functions, host mode and intent binding, copied at open', async () => {
  const db = new DatabaseSync(':memory:');
  cleanup.push(() => db.close());
  db.exec(schema);
  const base: SqliteTurnBoundaryTable = {
    table: 'boundaries',
    ownerEncoding: 'json',
    intentColumns,
    terminalFacts: 'host',
    terminalSeen: () => false,
  };
  const { readObservation: _read, ...threeMembers } = hostFacts;
  for (const invalid of [
    threeMembers,
    { ...hostFacts, constructor: () => {} },
    { ...hostFacts, toString: () => '' },
    { ...hostFacts, recordRetirement: async () => {} },
    { ...hostFacts, readObservation: async () => undefined },
    {
      ...hostFacts,
      find: function* () {
        yield undefined;
      },
    },
    { find: hostFacts.find },
    Object.create(hostFacts),
    Object.defineProperty({ ...hostFacts }, 'find', {
      get: () => hostFacts.find,
    }),
  ])
    expect(() =>
      openSqliteKernelStorage({
        database: db,
        tables: { turnBoundary: { ...base, invocationTerminals: invalid } },
      }),
    ).toThrow();
  expect(() =>
    openSqliteKernelStorage({
      database: db,
      tables: {
        turnBoundary: {
          ...base,
          terminalFacts: 'kernel',
          invocationTerminals: hostFacts,
        },
      },
    }),
  ).toThrow();
  expect(() =>
    openSqliteKernelStorage({
      database: db,
      tables: {
        turnBoundary: {
          ...base,
          intentColumns: undefined,
          invocationTerminals: hostFacts,
        },
      },
    }),
  ).toThrow();
  const bundle = { ...hostFacts };
  const storage = openSqliteKernelStorage({
    database: db,
    tables: { turnBoundary: { ...base, invocationTerminals: bundle } },
  });
  cleanup.push(() => storage.close());
  bundle.find = () => {
    throw new Error('mutated caller bundle');
  };
  await begin((input) => storage.execute(input, context));
  expect(await storage.execute(command, context)).toEqual({ kind: 'accepted' });
});

const v3Schema = `
CREATE TABLE monument_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO monument_meta VALUES('schema_version','3');
CREATE TABLE monument_turn_terminals(thread_id TEXT NOT NULL, provider_turn_id TEXT NOT NULL, PRIMARY KEY(thread_id,provider_turn_id));
INSERT INTO monument_turn_terminals VALUES('legacy',''),('legacy','N');
CREATE TABLE monument_turn_boundaries(boundary_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, state TEXT NOT NULL, purpose TEXT NOT NULL, provider_turn_id TEXT, owner_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 invocation_id TEXT, input_digest TEXT, intent_digest TEXT, body_ref TEXT, dedup_key TEXT, settlement_json TEXT);
CREATE UNIQUE INDEX monument_turn_boundaries_one_invocation ON monument_turn_boundaries(thread_id) WHERE state IN ('lifecycle','reserved','prepared','invoking','indeterminate');
CREATE TABLE unrelated(bytes BLOB); INSERT INTO unrelated VALUES(X'00ff');
`;
for (const failure of [false, true])
  it(`genuine v3 migration ${failure ? 'fails atomically' : 'preserves legacy strings, active/passive rows and unrelated records through reopen'}`, async () => {
    const location = createSqliteKernelLocation();
    cleanup.push(() => location.dispose());
    const db = new DatabaseSync(location.path);
    cleanup.push(() => db.close());
    db.exec(v3Schema);
    const settlement = {
      id: 's',
      disposition: 'cancelled',
      at: '3',
      boundaryId: 'passive',
      boundary: { owner, createdAt: '1', updatedAt: '2' },
    };
    for (const [id, state, thread, native, captured, audit] of [
      ['active', 'invoking', 'active', null, 'v3-B', null],
      ['accepted', 'accepted', 'legacy', '', null, null],
      [
        'passive',
        'settled',
        'passive',
        null,
        'old-B',
        JSON.stringify(settlement),
      ],
    ])
      db.prepare(
        'INSERT INTO monument_turn_boundaries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        id,
        thread,
        state,
        'turn',
        native,
        JSON.stringify(owner),
        '1',
        audit ? '3' : '2',
        captured,
        captured ? 'input' : null,
        captured ? 'envelope' : null,
        captured ? 'body' : null,
        id === 'active' ? 'v3-key' : null,
        audit,
      );
    db.exec(`CREATE TABLE monument_turn_dedup(dedup_key TEXT PRIMARY KEY, value TEXT, created_at INTEGER NOT NULL, owner_json TEXT, input_digest TEXT);
      CREATE TABLE monument_turn_dedup_expired(dedup_key TEXT PRIMARY KEY, expired_at INTEGER NOT NULL);`);
    const linkedBytes = JSON.stringify({
      ...owner,
      invocation: 'begun',
      preparedInvocationId: 'v3-B',
      preparedUpdatedAt: '0',
      retainedHostField: 'preserved bytes',
      inputDigest: 'station-turn-submission/v1:sha256:' + 'a'.repeat(64),
    });
    db.prepare('INSERT INTO monument_turn_dedup VALUES (?,?,?,?,?)').run(
      'v3-key',
      null,
      7,
      linkedBytes,
      'station-turn-submission/v1:sha256:' + 'a'.repeat(64),
    );
    db.prepare('INSERT INTO monument_turn_dedup VALUES (?,?,?,?,?)').run(
      'v3-legacy',
      null,
      8,
      JSON.stringify({ ...owner, invocation: 'pending' }),
      null,
    );
    const linkedBefore = db.prepare('SELECT * FROM monument_turn_dedup').all();
    const before = db
      .prepare('SELECT * FROM monument_turn_boundaries ORDER BY boundary_id')
      .all();
    if (failure) {
      db.exec(
        "CREATE TRIGGER fail_version BEFORE UPDATE ON monument_meta BEGIN SELECT RAISE(ABORT, 'migration failure'); END;",
      );
      expect(() => openSqliteKernelStorage({ database: db })).toThrow(
        'migration failure',
      );
      expect(
        db
          .prepare("SELECT value FROM monument_meta WHERE key='schema_version'")
          .get(),
      ).toEqual({ value: '3' });
      expect(
        db
          .prepare(
            'SELECT * FROM monument_turn_terminals ORDER BY provider_turn_id',
          )
          .all(),
      ).toEqual([
        { thread_id: 'legacy', provider_turn_id: '' },
        { thread_id: 'legacy', provider_turn_id: 'N' },
      ]);
      expect(
        db
          .prepare(
            'SELECT * FROM monument_turn_boundaries ORDER BY boundary_id',
          )
          .all(),
      ).toEqual(before);
      expect(db.prepare('SELECT * FROM monument_turn_dedup').all()).toEqual(
        linkedBefore,
      );
      return;
    }
    let storage = openSqliteKernelStorage({ database: db });
    expect(
      db
        .prepare("SELECT value FROM monument_meta WHERE key='schema_version'")
        .get(),
    ).toEqual({ value: '5' });
    expect(
      db
        .prepare('SELECT * FROM monument_turn_boundaries ORDER BY boundary_id')
        .all(),
    ).toEqual(before);
    expect(db.prepare('SELECT * FROM unrelated').get()).toEqual({
      bytes: new Uint8Array([0, 255]),
    });
    expect(
      db
        .prepare(
          'SELECT fact_kind, fact_id, provider_turn_id FROM monument_turn_terminals ORDER BY fact_id',
        )
        .all(),
    ).toEqual([
      { fact_kind: 'legacy', fact_id: '', provider_turn_id: '' },
      { fact_kind: 'legacy', fact_id: 'N', provider_turn_id: 'N' },
    ]);
    await storage.close();
    storage = openSqliteKernelStorage({ database: db });
    cleanup.push(() => storage.close());
    expect(db.prepare('SELECT * FROM monument_turn_dedup').all()).toEqual(
      linkedBefore,
    );
    expect(
      storage.executeSync({ type: 'turnDedup.read', key: 'v3-key' }, context),
    ).toEqual({
      kind: 'found',
      record: {
        key: 'v3-key',
        value: null,
        createdAt: 7,
        owner,
        invocation: 'begun',
        preparedInvocationId: 'v3-B',
        preparedUpdatedAt: '0',
        inputDigest: 'station-turn-submission/v1:sha256:' + 'a'.repeat(64),
      },
    });
    expect(
      storage.executeSync(
        { type: 'turnDedup.read', key: 'v3-legacy' },
        context,
      ),
    ).toMatchObject({ kind: 'found', record: { key: 'v3-legacy' } });
    const legacy = storage.executeSync(
      { type: 'turnDedup.read', key: 'v3-legacy' },
      context,
    );
    if (legacy.kind !== 'found')
      throw new Error('legacy migration prerequisite');
    expect(legacy.record).not.toHaveProperty('inputDigest');
    expect(
      storage.executeSync(
        {
          type: 'turnBoundary.create',
          boundaryId: 'blocked',
          threadId: 'active',
          purpose: 'turn',
          state: 'reserved',
          owner,
          now: '4',
        },
        context,
      ),
    ).toEqual({ kind: 'busy' });
    expect(
      storage.executeSync(
        {
          type: 'turnBoundary.create',
          boundaryId: 'legacy-new',
          threadId: 'legacy',
          purpose: 'turn',
          state: 'prepared',
          owner,
          now: '4',
        },
        context,
      ),
    ).toEqual({ kind: 'applied' });
    expect(
      storage.executeSync(
        {
          type: 'turnBoundary.transition',
          boundaryId: 'legacy-new',
          ownerId: owner.id,
          from: ['prepared'],
          to: 'accepted',
          providerTurnId: 'N',
          now: '5',
        },
        context,
      ),
    ).toEqual({ kind: 'ambiguous' });
    await begin((input) => storage.execute(input, context));
    expect(storage.executeSync(observation(fact('e', 'N')), context)).toEqual({
      kind: 'applied',
    });
    expect(storage.executeSync(command, context)).toEqual({
      kind: 'terminal',
      terminal: fact('e', 'N'),
    });
    expect(
      db
        .prepare(
          "SELECT state FROM monument_turn_boundaries WHERE boundary_id='passive'",
        )
        .get(),
    ).toEqual({ state: 'settled' });
  });

it('owned SQLite rolls newly recorded fact/aggregate/witness and deletion back after the real first writes', async () => {
  const db = new DatabaseSync(':memory:');
  cleanup.push(() => db.close());
  const storage = openSqliteKernelStorage({ database: db });
  cleanup.push(() => storage.close());
  await begin((input) => storage.execute(input, context), true);
  const rows = db.prepare('SELECT * FROM monument_turn_boundaries').all();
  const dedup = db.prepare('SELECT * FROM monument_turn_dedup').all();
  db.exec(`CREATE TRIGGER fail_owned_delete BEFORE DELETE ON monument_turn_boundaries BEGIN
    SELECT CASE WHEN (SELECT count(*) FROM monument_turn_terminals WHERE fact_kind='retirement') <> 1 THEN RAISE(ABORT,'witness not reached') END;
    SELECT RAISE(ABORT,'owned after witness'); END;`);
  await expect(
    storage.execute(observation(fact('eN', 'N')), context),
  ).rejects.toThrow('owned after witness');
  expect(db.prepare('SELECT * FROM monument_turn_terminals').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM monument_turn_boundaries').all()).toEqual(
    rows,
  );
  expect(db.prepare('SELECT * FROM monument_turn_dedup').all()).toEqual(dedup);
  db.exec('DROP TRIGGER fail_owned_delete');
  expect(await storage.execute(observation(fact('eN', 'N')), context)).toEqual({
    kind: 'applied',
  });
  const terminals = db
    .prepare('SELECT * FROM monument_turn_terminals ORDER BY fact_kind')
    .all();
  await expect(
    storage.execute(
      observation({ ...fact('eN', 'N'), retire: false }),
      context,
    ),
  ).rejects.toThrow('Conflicting invocation terminal event');
  expect(
    db
      .prepare('SELECT * FROM monument_turn_terminals ORDER BY fact_kind')
      .all(),
  ).toEqual(terminals);
});

it('linked acknowledgement compares current and witnessed complete original/resolved custody independently', async () => {
  const f = fixture('json', 'executeSync');
  await begin(f.run, true);
  const list = await f.rows();
  const boundary = list[0]!;
  const read = await f.run({ type: 'turnDedup.read', key: 'k' });
  if (read.kind !== 'found') throw new Error('dedup prerequisite');
  const original = read.record;
  const accept = { ...command, expected: boundary, expectedDedup: original };
  append(f.db, fact('eN', 'N'));
  expect(await f.run(accept)).toEqual({
    kind: 'terminal',
    terminal: fact('eN', 'N'),
  });
  const witness = hostFacts.readRetirement(f.db, 't', 'b');
  if (!witness?.dedup) throw new Error('witness prerequisite');
  const ownerJson = String(
    (
      f.db
        .prepare(
          "SELECT owner_json FROM monument_turn_dedup WHERE dedup_key='k'",
        )
        .get() as { owner_json: string }
    ).owner_json,
  );
  for (const [key, value] of [
    ['id', 'other'],
    ['pid', 92],
    ['birth', 'other'],
    ['preparedInvocationId', 'other'],
    ['preparedUpdatedAt', 'changed'],
    ['invocation', 'pending'],
    ['invocation', 'future'],
    ['invocation', 'untracked'],
  ] as const) {
    f.db
      .prepare(
        "UPDATE monument_turn_dedup SET owner_json=? WHERE dedup_key='k'",
      )
      .run(JSON.stringify({ ...JSON.parse(ownerJson), [key]: value }));
    expect(await f.run(accept)).toEqual({ kind: 'stale' });
  }
  f.db
    .prepare("UPDATE monument_turn_dedup SET owner_json=? WHERE dedup_key='k'")
    .run(ownerJson);
  for (const changed of [
    { ...original, owner: { ...owner, id: 'other' } },
    { ...original, createdAt: 9 },
    { ...original, preparedUpdatedAt: 'changed' },
    { ...original, invocation: 'pending' },
    { ...original, value: 'M' },
  ]) {
    f.db
      .prepare("UPDATE intents SET retirement=? WHERE invocation_id='B'")
      .run(JSON.stringify({ ...witness, dedup: changed }));
    expect(await f.run(accept)).toEqual({ kind: 'stale' });
  }
  f.db
    .prepare("UPDATE intents SET retirement=? WHERE invocation_id='B'")
    .run(JSON.stringify(witness));
  expect(
    await f.run({
      type: 'turnDedup.resolve',
      key: 'k',
      ownerId: owner.id,
      value: 'N',
      now: 9,
    }),
  ).toEqual({ kind: 'applied' });
  expect(await f.run(accept)).toEqual({
    kind: 'terminal',
    terminal: fact('eN', 'N'),
  });
  f.db
    .prepare("UPDATE monument_turn_dedup SET created_at=99 WHERE dedup_key='k'")
    .run();
  expect(await f.run(accept)).toEqual({ kind: 'stale' });
});

it('owned terminal codecs reject column/JSON mismatches and unknown scoped kinds without disposition writes', async () => {
  const db = new DatabaseSync(':memory:');
  cleanup.push(() => db.close());
  const storage = openSqliteKernelStorage({ database: db });
  cleanup.push(() => storage.close());
  await begin((input) => storage.execute(input, context));
  expect(await storage.execute(observation(fact('eN', 'N')), context)).toEqual({
    kind: 'applied',
  });
  const row = db
    .prepare(
      "SELECT * FROM monument_turn_terminals WHERE fact_kind='retirement'",
    )
    .get() as { retirement_json: string };
  db.prepare(
    "UPDATE monument_turn_terminals SET terminal_created_at='changed' WHERE fact_kind='retirement'",
  ).run();
  await expect(storage.execute(command, context)).rejects.toThrow(
    'columns differ',
  );
  db.prepare(
    "UPDATE monument_turn_terminals SET terminal_created_at='01' WHERE fact_kind='retirement'",
  ).run();
  const witness = JSON.parse(row.retirement_json);
  db.prepare(
    "UPDATE monument_turn_terminals SET retirement_json=? WHERE fact_kind='retirement'",
  ).run(JSON.stringify({ ...witness, schema: 'future' }));
  await expect(storage.execute(command, context)).rejects.toThrow('retirement');
  db.prepare(
    "UPDATE monument_turn_terminals SET retirement_json=? WHERE fact_kind='retirement'",
  ).run(row.retirement_json);
  db.prepare(
    "UPDATE monument_turn_terminals SET eligible=2 WHERE fact_kind='invocation'",
  ).run();
  await expect(storage.execute(command, context)).rejects.toThrow('columns');
  db.prepare(
    "UPDATE monument_turn_terminals SET eligible=1 WHERE fact_kind='invocation'",
  ).run();
  db.exec('PRAGMA ignore_check_constraints = ON');
  db.prepare(
    "UPDATE monument_turn_terminals SET fact_kind='future' WHERE fact_kind='invocation'",
  ).run();
  await expect(storage.execute(command, context)).rejects.toThrow(
    'Unknown terminal row kind',
  );
  db.prepare(
    "UPDATE monument_turn_terminals SET fact_kind='invocation' WHERE fact_kind='future'",
  ).run();
  db.exec('PRAGMA ignore_check_constraints = OFF');
  expect(await storage.execute(command, context)).toEqual({
    kind: 'terminal',
    terminal: fact('eN', 'N'),
  });
});

it('host observation checks every supplied event field even after its boundary is absent', async () => {
  const f = fixture('json', 'executeSync');
  await begin(f.run);
  append(f.db, fact('eN', 'N'));
  expect(await f.run(observation(fact('eN', 'N')))).toEqual({
    kind: 'applied',
  });
  expect(await f.rows()).toEqual([]);
  await expect(
    f.run(observation({ ...fact('eN', 'N'), terminalCreatedAt: 'changed' })),
  ).rejects.toThrow('differs');
  await expect(f.run(observation(fact('eN', 'M')))).rejects.toThrow('differs');
  await expect(f.run(observation(fact('missing', 'N')))).rejects.toThrow(
    'unavailable',
  );
  expect(await f.run(command)).toEqual({
    kind: 'terminal',
    terminal: fact('eN', 'N'),
  });
});

for (const shape of [
  'complete',
  'incomplete',
  'async',
  'unknown-field',
  'accessor',
] as const)
  it(`inherited ${shape} invocation bundle rejects at open before any callback or participant write`, () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    db.exec(schema);
    const tablesBefore = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all();
    let callbacks = 0;
    let admissions = 0;
    const own: SqliteInvocationTerminalFacts = {
      readObservation: () => {
        callbacks++;
        return undefined;
      },
      find: () => {
        callbacks++;
        return { kind: 'absent' };
      },
      readRetirement: () => {
        callbacks++;
        return undefined;
      },
      recordRetirement: () => {
        callbacks++;
      },
    };
    const candidate =
      shape === 'incomplete'
        ? { find: own.find }
        : shape === 'async'
          ? {
              ...own,
              recordRetirement: async () => {
                callbacks++;
              },
            }
          : shape === 'unknown-field'
            ? { ...own, constructor: () => {} }
            : own;
    const binding: SqliteTurnBoundaryTable = Object.setPrototypeOf(
      {
        table: 'boundaries',
        ownerEncoding: 'json' as const,
        terminalFacts: 'host' as const,
        intentColumns,
        terminalSeen: () => false,
      },
      shape === 'accessor'
        ? Object.defineProperty({}, 'invocationTerminals', {
            get() {
              callbacks++;
              return candidate;
            },
          })
        : { invocationTerminals: candidate },
    );
    expect(Object.hasOwn(binding, 'invocationTerminals')).toBe(false);
    expect(() => {
      const opened = openSqliteKernelStorage({
        database: db,
        tables: { turnBoundary: binding },
        participants: [
          {
            name: 'must not be admitted',
            admit(_command, database) {
              admissions++;
              database
                .prepare("UPDATE intents SET envelope='participant mutation'")
                .run();
            },
          },
        ],
      });
      cleanup.push(() => opened.close());
    }).toThrow(/Invocation terminal/);
    expect(callbacks).toBe(0);
    expect(admissions).toBe(0);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all(),
    ).toEqual(tablesBefore);
    expect(
      db.prepare('SELECT envelope, retirement FROM intents').get(),
    ).toEqual({ envelope: 'unchanged envelope', retirement: null });
  });

it('an own complete invocation bundle remains usable through the real write path (inherited refusal control)', async () => {
  let writes = 0;
  const f = fixture('columns', 'executeSync', {
    ...hostFacts,
    recordRetirement(db, witness) {
      writes++;
      hostFacts.recordRetirement(db, witness);
    },
  });
  await begin(f.run);
  append(f.db, fact('own-control', 'N'));
  expect(await f.run(observation(fact('own-control', 'N')))).toEqual({
    kind: 'applied',
  });
  expect(writes).toBe(1);
  expect(hostFacts.readRetirement(f.db, 't', 'b')?.boundary).toEqual(expected);
  expect(await f.run(command)).toEqual({
    kind: 'terminal',
    terminal: fact('own-control', 'N'),
  });
});

for (const layout of ['json', 'columns'] as const)
  for (const via of ['execute', 'executeSync'] as const) {
    for (const absent of [false, true])
      it(`${layout} ${via}: exact retained false observation rejects changed content with boundary ${absent ? 'absent' : 'retained'}`, async () => {
        const f = fixture(layout, via);
        await begin(f.run, true);
        if (absent)
          expect(
            await f.run({
              type: 'turnBoundary.remove',
              boundaryId: 'b',
              ownerId: owner.id,
              from: ['invoking'],
            }),
          ).toEqual({ kind: 'applied' });
        const actual = fact('false-event', 'N', false);
        append(f.db, actual);
        expect(await f.run(observation(actual))).toEqual({ kind: 'applied' });
        const before = {
          boundary: f.db.prepare('SELECT * FROM boundaries').all(),
          dedup: f.db.prepare('SELECT * FROM monument_turn_dedup').all(),
          audit: f.db.prepare('SELECT * FROM intents').all(),
          events: f.db.prepare('SELECT * FROM events').all(),
        };
        expect(
          hostFacts.find(f.db, {
            threadId: 't',
            invocationId: 'B',
            providerTurnId: 'N',
            allowMissingProviderTurnId: true,
            terminalEventId: actual.terminalEventId,
          }),
        ).toEqual({ kind: 'absent' });
        for (const changed of [
          { ...actual, terminalCreatedAt: 'changed' },
          { ...actual, providerTurnId: 'M' },
          fact('false-event', undefined, false),
          { ...actual, retire: true },
          { ...actual, invocationId: 'other' },
          { ...actual, threadId: 'other' },
        ]) {
          await expect(f.run(observation(changed))).rejects.toThrow();
          expect(f.db.prepare('SELECT * FROM boundaries').all()).toEqual(
            before.boundary,
          );
          expect(
            f.db.prepare('SELECT * FROM monument_turn_dedup').all(),
          ).toEqual(before.dedup);
          expect(f.db.prepare('SELECT * FROM intents').all()).toEqual(
            before.audit,
          );
          expect(f.db.prepare('SELECT * FROM events').all()).toEqual(
            before.events,
          );
        }
      });
    it(`${layout} ${via}: a missing false observation cannot substitute another retained event after boundary removal`, async () => {
      const f = fixture(layout, via);
      await begin(f.run);
      expect(
        await f.run({
          type: 'turnBoundary.remove',
          boundaryId: 'b',
          ownerId: owner.id,
          from: ['invoking'],
        }),
      ).toEqual({ kind: 'applied' });
      append(f.db, fact('other-false', 'N', false));
      const before = f.db.prepare('SELECT * FROM intents').all();
      await expect(
        f.run(observation(fact('missing-false', 'N', false))),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual([]);
      expect(f.db.prepare('SELECT * FROM intents').all()).toEqual(before);
    });
  }

it('exact raw response validation aborts admission writes and never runs participant commit', async () => {
  let response: unknown;
  let commits = 0;
  const f = fixture('columns', 'executeSync');
  await begin(f.run, true);
  const actual = fact('raw-event', 'N', false);
  append(f.db, actual);
  await f.storage.close();
  const storage = openSqliteKernelStorage({
    database: f.db,
    tables: {
      turnBoundary: {
        ...f.binding,
        invocationTerminals: {
          ...hostFacts,
          readObservation: () => response as InvocationTerminalFact | undefined,
        },
      },
    },
    participants: [
      {
        name: 'instrument exact raw read',
        admit(_command, db) {
          db.prepare("UPDATE intents SET envelope='admitted mutation'").run();
        },
        commit() {
          commits++;
        },
      },
    ],
  });
  cleanup.push(() => storage.close());
  const before = f.db.prepare('SELECT * FROM intents').all();
  let accessors = 0;
  for (const invalid of [
    undefined,
    null,
    {},
    Promise.resolve(actual),
    Object.create(actual),
    { ...actual, threadId: 'wrong' },
    { ...actual, invocationId: 'wrong' },
    { ...actual, terminalEventId: 'wrong' },
    { ...actual, providerTurnId: undefined },
    { ...actual, terminalCreatedAt: 'changed' },
    { ...actual, retire: true },
    { ...actual, unexpected: true },
    Object.defineProperty({ ...actual }, 'retire', {
      get() {
        accessors++;
        return false;
      },
    }),
  ]) {
    response = invalid;
    expect(() => storage.executeSync(observation(actual), context)).toThrow();
    expect(f.db.prepare('SELECT * FROM intents').all()).toEqual(before);
    expect(commits).toBe(0);
    expect(f.db.prepare('SELECT state FROM boundaries').get()).toEqual({
      state: 'invoking',
    });
  }
  expect(accessors).toBe(0);
  response = actual;
  expect(storage.executeSync(observation(actual), context)).toEqual({
    kind: 'applied',
  });
  expect(commits).toBe(1);
  expect(hostFacts.readRetirement(f.db, 't', 'b')).toBeUndefined();
});
