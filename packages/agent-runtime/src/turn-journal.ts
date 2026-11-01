import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { OwnerIdentity, OwnerLiveness } from '@kontourai/monument';
import type {
  AtomicCommand,
  AtomicParticipant,
  AtomicPort,
} from '@kontourai/monument/testing';
import { z } from 'zod';
import { canonical, fence, hash, owner, runKey, text } from './encoding.js';
import {
  type ApprovalCommand,
  type ApprovalResult,
  approvalCommands,
  approvalsDefinition,
  decideAgentApproval,
  readAgentApproval,
  validateAgentApprovals,
} from './turn-approvals.js';
import {
  decideAgentEffect,
  type EffectCommand,
  type EffectResult,
  effectCommands,
  effectsDefinition,
  readAgentEffect,
  takeOverAgentEffects,
  validateAgentEffects,
} from './turn-effects.js';
import type { Fence, RunKey } from './types.js';

export interface AgentTurnSpec {
  readonly key: RunKey;
  /** Immutable host input, without credentials or process-local capabilities. */
  readonly input: string;
  readonly implementation: string;
}
const spec = z
  .object({
    key: runKey,
    input: text.max(32 * 1024 * 1024),
    implementation: text,
  })
  .strict();
const turnSchema = z
  .object({
    version: z.literal(1),
    spec,
    inputDigest: text,
    fence,
    state: z.enum(['running', 'completed', 'cancelled', 'blocked']),
  })
  .strict();
export type AgentTurnRecord = z.infer<typeof turnSchema>;
export type AgentJournalResult =
  | ApprovalResult
  | EffectResult
  | {
      readonly kind: 'owned';
      readonly turn: AgentTurnRecord;
      readonly providerSessionId: string;
    }
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'refused';
      readonly reason:
        | 'busy'
        | 'stale'
        | 'unknown-owner'
        | 'conflict'
        | 'settled';
    };
type Owned = { readonly key: RunKey; readonly expected: Fence };
type StepCommand = EffectCommand | ApprovalCommand;
type EffectProtocol = {
  [K in StepCommand['type']]: {
    command: Extract<StepCommand, { type: K }>;
    result: AgentJournalResult;
  };
};
export type AgentJournalProtocol = EffectProtocol & {
  open: {
    command: {
      readonly type: 'open';
      readonly spec: AgentTurnSpec;
      readonly owner: OwnerIdentity;
    };
    result: AgentJournalResult;
  };
  read: {
    command: { readonly type: 'read'; readonly key: RunKey };
    result: AgentJournalResult;
  };
  claim: {
    command: Owned & { readonly type: 'claim'; readonly owner: OwnerIdentity };
    result: AgentJournalResult;
  };
  settle: {
    command: Owned & {
      readonly type: 'settle';
      readonly state: 'completed' | 'cancelled' | 'blocked';
    };
    result: AgentJournalResult;
  };
};
export type AgentJournalContext = {
  readonly liveness: OwnerLiveness;
  readonly now?: () => number;
};
export type AgentJournal = AtomicPort<
  AgentJournalProtocol,
  AgentJournalContext
>;
export type AgentJournalParticipant = AtomicParticipant<
  AgentJournalProtocol,
  DatabaseSync
>;
const ownedFields = { key: runKey, expected: fence };
const commandSchema = z.discriminatedUnion('type', [
  ...effectCommands,
  ...approvalCommands,
  z.object({ type: z.literal('open'), spec, owner }).strict(),
  z.object({ type: z.literal('read'), key: runKey }).strict(),
  z.object({ type: z.literal('claim'), ...ownedFields, owner }).strict(),
  z
    .object({
      type: z.literal('settle'),
      ...ownedFields,
      state: z.enum(['completed', 'cancelled', 'blocked']),
    })
    .strict(),
]);
const unresolved =
  "active=1 OR CASE WHEN json_valid(record)=0 THEN 1 WHEN json_extract(record,'$.state') NOT IN ('completed','cancelled','blocked') THEN 1 WHEN json_type(record,'$.state') IS NOT 'text' THEN 1 ELSE 0 END=1";
const affinityDefinition =
  'CREATE TABLE agent_steps_affinity(scope TEXT NOT NULL, conversation TEXT NOT NULL, provider_session_id TEXT NOT NULL UNIQUE, PRIMARY KEY(scope,conversation)) STRICT';
const unresolvedDefinition = `CREATE INDEX agent_steps_unresolved ON agent_steps_turns(id) WHERE ${unresolved}`;
const definitions = [
  "CREATE TABLE agent_steps_meta(id INTEGER PRIMARY KEY CHECK(id=1), writer_format TEXT NOT NULL CHECK(writer_format='agent-steps/4')) STRICT",
  'CREATE TABLE agent_steps_turns(id TEXT PRIMARY KEY, scope TEXT NOT NULL, conversation TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)), record TEXT NOT NULL) STRICT',
  'CREATE UNIQUE INDEX agent_steps_active_conversation ON agent_steps_turns(scope,conversation) WHERE active=1',
  effectsDefinition,
  approvalsDefinition,
  affinityDefinition,
  unresolvedDefinition,
  "CREATE TRIGGER agent_steps_affinity_no_update BEFORE UPDATE ON agent_steps_affinity BEGIN SELECT RAISE(ABORT,'immutable provider session'); END",
  "CREATE TRIGGER agent_steps_affinity_no_delete BEFORE DELETE ON agent_steps_affinity BEGIN SELECT RAISE(ABORT,'immutable provider session'); END",
] as const;
const idOf = (key: RunKey) => canonical(key);
function validateRow(row: Record<string, unknown>): AgentTurnRecord {
  const turn = turnSchema.parse(JSON.parse(String(row.record)));
  if (
    row.id !== idOf(turn.spec.key) ||
    row.scope !== turn.spec.key.scopeId ||
    row.conversation !== turn.spec.key.conversationId ||
    row.active !== Number(turn.state === 'running') ||
    turn.inputDigest !== hash(turn.spec.input)
  )
    throw new Error('DURABLE_AGENT_JOURNAL_DAMAGED');
  return turn;
}

function validateAgentJournalSchema(
  database: DatabaseSync,
  inTransaction = false,
) {
  if (
    database.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal' ||
    database.prepare('PRAGMA synchronous').get()?.synchronous !== 2 ||
    database.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1 ||
    (database.isTransaction && !inTransaction)
  )
    throw new Error('DURABLE_AGENT_STORAGE_POLICY');
  const rows = database
    .prepare(
      "SELECT sql FROM main.sqlite_schema WHERE (lower(name) GLOB 'agent_steps_*' OR lower(tbl_name) GLOB 'agent_steps_*') AND sql IS NOT NULL ORDER BY sql",
    )
    .all();
  if (
    canonical(rows.map((r) => r.sql).sort()) !==
      canonical([...definitions].sort()) ||
    database
      .prepare(
        "SELECT 1 FROM temp.sqlite_schema WHERE lower(name) GLOB 'agent_steps_*' OR lower(tbl_name) GLOB 'agent_steps_*'",
      )
      .get() ||
    database.prepare('SELECT count(*) AS n FROM main.agent_steps_meta').get()
      ?.n !== 1 ||
    database
      .prepare('SELECT writer_format FROM agent_steps_meta WHERE id=1')
      .get()?.writer_format !== 'agent-steps/4'
  )
    throw new Error('DURABLE_AGENT_WRITER_UNSUPPORTED');
}

function readAffinity(
  database: DatabaseSync,
  key: Pick<RunKey, 'scopeId' | 'conversationId'>,
) {
  const id = database
    .prepare(
      'SELECT provider_session_id FROM agent_steps_affinity WHERE scope=? AND conversation=?',
    )
    .get(key.scopeId, key.conversationId)?.provider_session_id;
  if (
    typeof id !== 'string' ||
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)
  )
    throw new Error('DURABLE_AGENT_AFFINITY_DAMAGED');
  return id;
}

/** Quiescent, read-only integrity diagnosis; never initializes or migrates. */
export function auditSqliteAgentJournal({
  database,
}: {
  readonly database: DatabaseSync;
}) {
  validateAgentJournalSchema(database);
  database.exec('BEGIN');
  try {
    const turns = database
      .prepare('SELECT * FROM agent_steps_turns')
      .all()
      .map(validateRow);
    let effects = 0;
    let approvals = 0;
    for (const turn of turns) {
      effects += validateAgentEffects(database, idOf(turn.spec.key)).length;
      approvals += validateAgentApprovals(database, idOf(turn.spec.key)).length;
      readAffinity(database, turn.spec.key);
    }
    for (const row of database
      .prepare('SELECT * FROM agent_steps_affinity')
      .all()) {
      const key = runKey.parse({
        scopeId: row.scope,
        conversationId: row.conversation,
        invocationId: 'audit',
      });
      readAffinity(database, key);
    }
    if (
      database.prepare('PRAGMA foreign_key_check(agent_steps_effects)').all()
        .length ||
      database.prepare('PRAGMA foreign_key_check(agent_steps_approvals)').all()
        .length
    )
      throw new Error('DURABLE_AGENT_JOURNAL_DAMAGED');
    return { turns: turns.length, effects, approvals };
  } finally {
    database.exec('ROLLBACK');
  }
}

/** A new namespace and writer format; the runtime-model/1 tables are untouched. */
export function openSqliteAgentJournal(options: {
  readonly database: DatabaseSync;
  readonly participants?: readonly AgentJournalParticipant[];
}): AgentJournal {
  const { database } = options;
  let closed = false;
  const participants = [...(options.participants ?? [])];
  const affinity = (key: RunKey) => readAffinity(database, key);
  const seedAffinity = (key: RunKey) => {
    database
      .prepare(
        'INSERT INTO agent_steps_affinity VALUES(?,?,?) ON CONFLICT(scope,conversation) DO NOTHING',
      )
      .run(key.scopeId, key.conversationId, randomUUID());
  };
  const owned = (turn: AgentTurnRecord): AgentJournalResult => ({
    kind: 'owned',
    turn,
    providerSessionId: affinity(turn.spec.key),
  });
  const validateSchema = (inTransaction = false) =>
    validateAgentJournalSchema(database, inTransaction);
  if (
    database.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal' ||
    database.prepare('PRAGMA synchronous').get()?.synchronous !== 2 ||
    database.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1 ||
    database.isTransaction
  )
    throw new Error('DURABLE_AGENT_STORAGE_POLICY');
  if (
    !database
      .prepare(
        "SELECT 1 FROM main.sqlite_schema WHERE lower(name) GLOB 'agent_steps_*' OR lower(tbl_name) GLOB 'agent_steps_*'",
      )
      .get()
  ) {
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const sql of definitions) database.exec(sql);
      database.exec("INSERT INTO agent_steps_meta VALUES(1,'agent-steps/4')");
      database.exec('COMMIT');
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    }
  }
  const priorWriter = database
    .prepare('SELECT writer_format FROM main.agent_steps_meta WHERE id=1')
    .get()?.writer_format;
  if (
    priorWriter === 'agent-steps/1' ||
    priorWriter === 'agent-steps/2' ||
    priorWriter === 'agent-steps/3'
  ) {
    const actual = database
      .prepare(
        "SELECT sql FROM main.sqlite_schema WHERE (lower(name) GLOB 'agent_steps_*' OR lower(tbl_name) GLOB 'agent_steps_*') AND sql IS NOT NULL",
      )
      .all()
      .map((r) => r.sql)
      .sort();
    const expected = definitions
      .slice(
        0,
        priorWriter === 'agent-steps/1'
          ? 3
          : priorWriter === 'agent-steps/2'
            ? 4
            : 5,
      )
      .map((sql) => sql.replace('agent-steps/4', priorWriter))
      .sort();
    if (
      canonical(actual) !== canonical(expected) ||
      database
        .prepare(
          "SELECT 1 FROM temp.sqlite_schema WHERE lower(name) GLOB 'agent_steps_*' OR lower(tbl_name) GLOB 'agent_steps_*'",
        )
        .get()
    )
      throw new Error('DURABLE_AGENT_MIGRATION_REFUSED');
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const row of database
        .prepare('SELECT * FROM main.agent_steps_turns')
        .all())
        validateRow(row);
      database.exec('DROP TABLE agent_steps_meta');
      database.exec(definitions[0]);
      database.exec("INSERT INTO agent_steps_meta VALUES(1,'agent-steps/4')");
      if (priorWriter === 'agent-steps/1') database.exec(effectsDefinition);
      else
        for (const row of database
          .prepare('SELECT id FROM main.agent_steps_turns')
          .all())
          validateAgentEffects(database, String(row.id));
      if (priorWriter !== 'agent-steps/3') database.exec(approvalsDefinition);
      else
        for (const row of database
          .prepare('SELECT id FROM agent_steps_turns')
          .all())
          validateAgentApprovals(database, String(row.id));
      database.exec(affinityDefinition);
      database.exec(unresolvedDefinition);
      for (const sql of definitions.slice(7)) database.exec(sql);
      for (const row of database
        .prepare('SELECT * FROM agent_steps_turns')
        .all())
        seedAffinity(validateRow(row).spec.key);
      database.exec('COMMIT');
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    }
  }
  validateSchema();
  for (const row of database
    .prepare(`SELECT * FROM agent_steps_turns WHERE ${unresolved}`)
    .all()) {
    const id = idOf(validateRow(row).spec.key);
    validateAgentEffects(database, id);
    validateAgentApprovals(database, id);
    affinity(validateRow(row).spec.key);
  }
  const read = (key: RunKey) => {
    const row = database
      .prepare('SELECT * FROM agent_steps_turns WHERE id=?')
      .get(idOf(key));
    if (!row) return undefined;
    const turn = validateRow(row);
    validateAgentEffects(database, idOf(key));
    validateAgentApprovals(database, idOf(key));
    affinity(key);
    return turn;
  };
  const write = (turn: AgentTurnRecord) => {
    turnSchema.parse(turn);
    database
      .prepare(
        'INSERT INTO agent_steps_turns VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET active=excluded.active,record=excluded.record',
      )
      .run(
        idOf(turn.spec.key),
        turn.spec.key.scopeId,
        turn.spec.key.conversationId,
        Number(turn.state === 'running'),
        canonical(turn),
      );
  };
  return {
    async execute(
      raw: AtomicCommand<AgentJournalProtocol>,
      context: AgentJournalContext,
    ): Promise<AgentJournalResult> {
      if (closed) throw new Error('DURABLE_AGENT_STORAGE_CLOSED');
      const command = commandSchema.parse(raw);
      validateSchema();
      database.exec(command.type === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE');
      try {
        const key = command.type === 'open' ? command.spec.key : command.key;
        const beforeIds = database
          .prepare(
            `SELECT id FROM agent_steps_turns WHERE ${unresolved} ORDER BY id`,
          )
          .all()
          .map((row) => String(row.id));
        const probe = (candidate: OwnerIdentity) => {
          const changes = database
            .prepare('SELECT total_changes() AS n')
            .get()?.n;
          const verdict = context.liveness(structuredClone(candidate));
          if (
            database.prepare('SELECT total_changes() AS n').get()?.n !== changes
          )
            throw new Error('DURABLE_AGENT_LIVENESS_CHANGED_STATE');
          return verdict;
        };
        const decide = (): AgentJournalResult => {
          const turn = read(key);
          if (command.type === 'read')
            return turn ? owned(turn) : { kind: 'absent' };
          if (command.type === 'open') {
            if (turn) return { kind: 'refused', reason: 'conflict' };
            const active = database
              .prepare(`SELECT * FROM agent_steps_turns WHERE ${unresolved}`)
              .all()
              .map(validateRow);
            if (
              active.length >= 128 ||
              active.some(
                (r) =>
                  r.spec.key.scopeId === key.scopeId &&
                  r.spec.key.conversationId === key.conversationId,
              )
            )
              return { kind: 'refused', reason: 'busy' };
            if (probe(command.owner) !== 'live')
              return { kind: 'refused', reason: 'unknown-owner' };
            const created: AgentTurnRecord = {
              version: 1,
              spec: command.spec,
              inputDigest: hash(command.spec.input),
              fence: { owner: command.owner, revision: '0' },
              state: 'running',
            };
            write(created);
            seedAffinity(key);
            return owned(created);
          }
          if (!turn || canonical(turn.fence) !== canonical(command.expected))
            return { kind: 'refused', reason: 'stale' };
          if (turn.state !== 'running')
            return { kind: 'refused', reason: 'settled' };
          if (command.type === 'claim') {
            const live = probe(turn.fence.owner);
            if (live !== 'dead')
              return {
                kind: 'refused',
                reason: live === 'live' ? 'busy' : 'unknown-owner',
              };
            if (
              command.owner.id === turn.fence.owner.id ||
              probe(command.owner) !== 'live'
            )
              return { kind: 'refused', reason: 'conflict' };
            turn.fence.owner = command.owner;
            takeOverAgentEffects(database, idOf(key));
          } else if (
            command.type === 'effectPlan' ||
            command.type === 'effectBegin' ||
            command.type === 'effectPartial' ||
            command.type === 'effectComplete'
          ) {
            if (probe(turn.fence.owner) !== 'live')
              return { kind: 'refused', reason: 'unknown-owner' };
            return decideAgentEffect(
              database,
              idOf(key),
              command,
              context.now?.() ?? Date.now(),
            );
          } else if (
            command.type === 'approvalPlan' ||
            command.type === 'approvalResolve'
          ) {
            if (probe(turn.fence.owner) !== 'live')
              return { kind: 'refused', reason: 'unknown-owner' };
            return decideAgentApproval(
              database,
              idOf(key),
              command,
              context.now?.() ?? Date.now(),
            );
          } else {
            if (probe(turn.fence.owner) !== 'live')
              return { kind: 'refused', reason: 'unknown-owner' };
            if (
              command.state === 'completed' &&
              (validateAgentEffects(database, idOf(key)).some((effect) =>
                effect.intent.kind === 'model'
                  ? effect.state !== 'completed'
                  : effect.state === 'running',
              ) ||
                validateAgentApprovals(database, idOf(key)).some(
                  (approval) => approval.state === 'pending',
                ))
            )
              return { kind: 'refused', reason: 'busy' };
            turn.state = command.state;
          }
          turn.fence.revision = String(BigInt(turn.fence.revision) + 1n);
          write(turn);
          return owned(turn);
        };
        const answer = decide();
        if (
          command.type !== 'read' &&
          (answer.kind === 'owned' ||
            answer.kind === 'effect' ||
            answer.kind === 'approval')
        ) {
          for (const participant of participants) {
            const returned: unknown = participant.commit?.(
              {
                command: structuredClone(command),
                result: structuredClone(answer),
              },
              database,
            );
            if (returned !== undefined)
              throw new Error('DURABLE_ASYNC_PARTICIPANT');
          }
        }
        validateSchema(true);
        const expectedIds = new Set(beforeIds);
        if (answer.kind === 'owned') {
          if (answer.turn.state === 'running') expectedIds.add(idOf(key));
          else expectedIds.delete(idOf(key));
        }
        const afterIds = database
          .prepare(
            `SELECT id FROM agent_steps_turns WHERE ${unresolved} ORDER BY id`,
          )
          .all()
          .map((row) => String(row.id))
          .sort();
        if (canonical(afterIds) !== canonical([...expectedIds].sort()))
          throw new Error('DURABLE_AGENT_PARTICIPANT_CHANGED_MEMBERSHIP');
        if (
          answer.kind === 'owned' &&
          canonical(read(answer.turn.spec.key)) !== canonical(answer.turn)
        )
          throw new Error('DURABLE_AGENT_PARTICIPANT_CHANGED_STATE');
        if (
          answer.kind === 'owned' &&
          affinity(key) !== answer.providerSessionId
        )
          throw new Error('DURABLE_AGENT_AFFINITY_CHANGED');
        if (
          answer.kind === 'approval' &&
          canonical(
            readAgentApproval(
              database,
              idOf(command.type === 'open' ? command.spec.key : command.key),
              answer.approval.id,
            ),
          ) !== canonical(answer.approval)
        )
          throw new Error('DURABLE_AGENT_PARTICIPANT_CHANGED_STATE');
        if (
          answer.kind === 'effect' &&
          canonical(
            readAgentEffect(
              database,
              idOf(command.type === 'open' ? command.spec.key : command.key),
              answer.effect.intent.id,
            ),
          ) !== canonical(answer.effect)
        )
          throw new Error('DURABLE_AGENT_PARTICIPANT_CHANGED_STATE');
        database.exec('COMMIT');
        return structuredClone(answer);
      } catch (error) {
        if (database.isTransaction) database.exec('ROLLBACK');
        throw error;
      }
    },
    async close() {
      closed = true;
    },
  };
}
