import { DatabaseSync } from 'node:sqlite';
import {
  createSqliteRecoveryStorage,
  MemoryRecoveryVolume,
  openMemoryRecoveryStorage,
  type RecoveryStorageCommand,
} from '../recovery-ledger.js';
import type {
  RecoveryConformanceHarness,
  RecoveryConformanceIntent,
  RecoveryConformanceSession,
  RecoveryConformanceStorage,
} from './recovery-conformance.js';
import { createSqliteKernelLocation } from './sqlite-harness.js';

const schema = `
CREATE TABLE recovery_intents (
  fingerprint TEXT PRIMARY KEY, thread_id TEXT NOT NULL, provider TEXT NOT NULL,
  source_event_id TEXT NOT NULL, source_turn_id TEXT NOT NULL, failure_kind TEXT NOT NULL,
  scope TEXT NOT NULL, decision TEXT NOT NULL, due_at TEXT, attempts INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL, outcome TEXT NOT NULL, dispatch_attempt_id TEXT,
  recovery_correlation_id TEXT, dispatch_settlement TEXT, dispatch_kind TEXT,
  resumed_turn_id TEXT, outcome_reason TEXT, usage_limit INTEGER, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, dispatch_owner_id TEXT, dispatch_owner_pid INTEGER,
  dispatch_owner_birth TEXT, dispatch_owner_identity_kind TEXT, credential_attempt_id TEXT,
  shutdown_cancel_requested_at TEXT
);
`;

type SqlRow = {
  fingerprint: string;
  thread_id: string;
  provider: string;
  source_event_id: string;
  source_turn_id: string;
  failure_kind: string;
  scope: string;
  decision: string;
  due_at: string | null;
  attempts: number;
  max_attempts: number;
  outcome: RecoveryConformanceIntent['outcome'];
  dispatch_attempt_id: string | null;
  recovery_correlation_id: string | null;
  dispatch_settlement: RecoveryConformanceIntent['dispatchSettlement'] | null;
  dispatch_kind: RecoveryConformanceIntent['dispatchKind'] | null;
  resumed_turn_id: string | null;
  outcome_reason: string | null;
  usage_limit: number | null;
  created_at: string;
  updated_at: string;
};
const mapRecord = (value: unknown): RecoveryConformanceIntent => {
  const row = value as SqlRow;
  return {
    fingerprint: row.fingerprint,
    threadId: row.thread_id,
    provider: row.provider,
    sourceEventId: row.source_event_id,
    sourceTurnId: row.source_turn_id,
    failureKind: row.failure_kind,
    scope: row.scope,
    decision: row.decision,
    ...(row.due_at ? { dueAt: row.due_at } : {}),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    outcome: row.outcome,
    ...(row.dispatch_attempt_id
      ? { dispatchAttemptId: row.dispatch_attempt_id }
      : {}),
    ...(row.recovery_correlation_id
      ? { recoveryCorrelationId: row.recovery_correlation_id }
      : {}),
    ...(row.dispatch_settlement
      ? { dispatchSettlement: row.dispatch_settlement }
      : {}),
    ...(row.dispatch_kind ? { dispatchKind: row.dispatch_kind } : {}),
    ...(row.resumed_turn_id ? { resumedTurnId: row.resumed_turn_id } : {}),
    ...(row.outcome_reason ? { outcomeReason: row.outcome_reason } : {}),
    ...(row.usage_limit === 1 ? { usageLimit: true as const } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

function normalizeIntent(
  value: RecoveryConformanceIntent,
): RecoveryConformanceIntent {
  const { dueAt, resumedTurnId, outcomeReason, ...rest } = value;
  return {
    ...rest,
    ...(dueAt ? { dueAt } : {}),
    ...(resumedTurnId ? { resumedTurnId } : {}),
    ...(outcomeReason ? { outcomeReason } : {}),
  };
}

export function createRecoveryHarness(
  kind: 'memory' | 'sqlite',
  via: 'sync' | 'async',
  options: { table?: string; prepare?: (db: DatabaseSync) => void } = {},
): RecoveryConformanceHarness {
  if (options.table && !options.prepare)
    throw new Error('A host table requires a schema fixture.');
  return {
    name: `${kind} (${via})`,
    async create(): Promise<RecoveryConformanceSession> {
      let failCommit = false;
      let loseAck = false;
      let commitCallback: (() => void) | undefined;
      const terminated = new Set<string>();
      const volume = new MemoryRecoveryVolume<RecoveryConformanceIntent>();
      const location =
        kind === 'sqlite'
          ? createSqliteKernelLocation({
              prepare: (db) => {
                if (options.prepare) options.prepare(db);
                else db.exec(schema);
                db.exec(
                  'CREATE TABLE source_terminals (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL)',
                );
              },
            })
          : undefined;
      let database: DatabaseSync | undefined;
      const beforeCommit = () => {
        if (failCommit) {
          failCommit = false;
          throw new Error('commit fault');
        }
        const callback = commitCallback;
        commitCallback = undefined;
        callback?.();
      };
      const open = (): RecoveryConformanceStorage => {
        if (kind === 'memory') {
          return openMemoryRecoveryStorage<
            RecoveryConformanceIntent,
            RecoveryConformanceIntent,
            string
          >({
            volume,
            makeIntent: (input) => normalizeIntent({ ...input, attempts: 0 }),
            updateIntent: (old, patch) =>
              normalizeIntent({
                ...old,
                ...patch,
                fingerprint: patch.fingerprint ?? old.fingerprint,
                threadId: patch.threadId ?? old.threadId,
                provider: patch.provider ?? old.provider,
                sourceEventId: patch.sourceEventId ?? old.sourceEventId,
                sourceTurnId: patch.sourceTurnId ?? old.sourceTurnId,
                failureKind: patch.failureKind ?? old.failureKind,
                scope: patch.scope ?? old.scope,
                decision: patch.decision ?? old.decision,
                attempts: patch.attempts ?? old.attempts,
                maxAttempts: patch.maxAttempts ?? old.maxAttempts,
                outcome: patch.outcome ?? old.outcome,
                createdAt: patch.createdAt ?? old.createdAt,
                updatedAt: patch.updatedAt ?? old.updatedAt,
              }),
            project: (value) => value,
            sourceTerminated: (value) =>
              terminated.has(`${value.threadId}:${value.sourceTurnId}`),
            beforeCommit,
          });
        } else {
          if (!location) throw new Error('missing SQLite location');
          database = new DatabaseSync(location.path);
          database.exec(
            'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000',
          );
          return createSqliteRecoveryStorage<
            RecoveryConformanceIntent,
            RecoveryConformanceIntent,
            string
          >({
            db: database,
            table: options.table ?? 'recovery_intents',
            mapRecord,
            project: (value) => value,
            sourceTerminalSql: `(intent.shutdown_cancel_requested_at IS NOT NULL OR EXISTS (SELECT 1 FROM source_terminals AS event WHERE event.thread_id = intent.thread_id AND event.turn_id = intent.source_turn_id))`,
            beforeCommit,
          });
        }
      };
      let raw = open();
      const makeWrap = (
        current: RecoveryConformanceStorage,
      ): RecoveryConformanceStorage => ({
        executeSync: <
          C extends RecoveryStorageCommand<
            RecoveryConformanceIntent,
            RecoveryConformanceIntent,
            string
          >,
        >(
          command: C,
        ) => {
          const result = current.executeSync(command);
          if (loseAck) {
            loseAck = false;
            throw new Error('acknowledgement fault');
          }
          return result;
        },
        execute: async <
          C extends RecoveryStorageCommand<
            RecoveryConformanceIntent,
            RecoveryConformanceIntent,
            string
          >,
        >(
          command: C,
        ) => {
          const result =
            via === 'sync'
              ? current.executeSync(command)
              : await current.execute(command);
          if (loseAck) {
            loseAck = false;
            throw new Error('acknowledgement fault');
          }
          return result;
        },
        close: () => current.close(),
      });
      let wrap = makeWrap(raw);
      return {
        get storage() {
          return wrap;
        },
        async reopen() {
          await wrap.close();
          database?.close();
          database = undefined;
          raw = open();
          wrap = makeWrap(raw);
        },
        markSourceTerminated(threadId, turnId) {
          terminated.add(`${threadId}:${turnId}`);
          database
            ?.prepare(
              'INSERT INTO source_terminals (thread_id, turn_id) VALUES (?, ?)',
            )
            .run(threadId, turnId);
        },
        failNextCommit() {
          failCommit = true;
        },
        loseNextAcknowledgement() {
          loseAck = true;
        },
        onNextCommit(callback) {
          commitCallback = callback;
        },
        async dispose() {
          await wrap.close();
          database?.close();
          await location?.dispose();
        },
      };
    },
  };
}
