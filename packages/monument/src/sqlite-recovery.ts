import {
  decideRecoveryArm,
  decideRecoveryStorageGuard,
  type RecoveryGuardRow,
  recoveryGuardPlan,
} from './decisions/recovery-storage.js';
import { KernelStorageClosedError } from './port.js';
import type {
  RecoveryIntentInput,
  RecoveryIntentShape,
  RecoveryOwner,
  RecoveryTransition,
} from './recovery-ledger.js';
import type { SqliteKernelDatabase } from './sqlite.js';

/** Fields read by the recovery storage protocol; remaining host fields are opaque. */
export interface RecoverySqlIntent extends RecoveryIntentShape {
  threadId: string;
  sourceEventId: string;
  sourceTurnId: string;
  failureKind: string;
  scope: string;
  decision: string;
  dueAt?: string;
  attempts: number;
  maxAttempts: number;
  dispatchKind?: 'due' | 'profile';
  resumedTurnId?: string;
  outcomeReason?: string;
  usageLimit?: true;
  createdAt: string;
  updatedAt: string;
}

const RECOVERY_OPERATIONS = [
  'armRecoveryIntent',
  'findRecoveryIntent',
  'readRecoveryProjection',
  'readPendingRecoveryIntents',
  'readUsageLimitIntentsAwaitingUser',
  'readRecoveryCompensationSnapshot',
  'claimRecoveryDispatch',
  'releaseRecoveryDispatch',
  'acceptRecoveryDispatch',
  'observeRecoveryDispatchCorrelation',
  'markRecoveryDispatchIndeterminate',
  'linkRecoveryCredentialAttempt',
  'preparedRecoveryDispatches',
  'indeterminatePreparedRecoveryDispatch',
  'recordRecoveryTerminal',
  'markRecoveryCompensation',
  'resolveRecoveryCompensationRecord',
  'cancelRecovery',
  'retireWaitingRecovery',
  'cancelSourceTerminatedRecoveries',
  'cancelRecoveryIfSourceTerminated',
  'cancelShutdownRecoveries',
] as const;
type RecoveryOperation = (typeof RECOVERY_OPERATIONS)[number];

export type RecoveryStorageCommand<
  I extends RecoverySqlIntent,
  P,
  Reason extends string,
> = {
  [K in RecoveryOperation]: {
    readonly type: K;
    readonly args: Parameters<SqliteRecoveryStorage<I, P, Reason>[K]>;
  };
}[RecoveryOperation];

export type RecoveryStorageResult<
  I extends RecoverySqlIntent,
  P,
  Reason extends string,
  C extends RecoveryStorageCommand<I, P, Reason>,
> = ReturnType<SqliteRecoveryStorage<I, P, Reason>[C['type']]>;

export interface RecoveryExecuteOptions {
  /** The host owns the outer commit and must delay effects until it commits. */
  readonly withinHostTransaction?: boolean;
}

export interface RecoveryStoragePort<
  I extends RecoverySqlIntent,
  P,
  Reason extends string,
> {
  executeSync<C extends RecoveryStorageCommand<I, P, Reason>>(
    command: C,
    options?: RecoveryExecuteOptions,
  ): RecoveryStorageResult<I, P, Reason, C>;
  execute<C extends RecoveryStorageCommand<I, P, Reason>>(
    command: C,
  ): Promise<RecoveryStorageResult<I, P, Reason, C>>;
  close(): Promise<void>;
}

function recoveryTransition(result: {
  changes: number | bigint;
}): RecoveryTransition {
  return Number(result.changes) === 1 ? { kind: 'applied' } : { kind: 'stale' };
}

/** Bound to a host-owned connection and table; no schema is created here. */
class SqliteRecoveryStorage<
  I extends RecoverySqlIntent,
  P,
  Reason extends string,
> {
  private inFlight = false;
  private closed = false;
  constructor(
    private readonly options: {
      db: SqliteKernelDatabase;
      table: string;
      mapRecord: (row: unknown) => I;
      project: (intent: I) => P;
      /** Trusted host SQL over the `intent` alias, fixed at construction. */
      sourceTerminalSql: string;
      afterTerminalWrite?: () => void;
      /** Optional synchronous host participant in this transaction. */
      beforeCommit?: () => void;
    },
  ) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.table))
      throw new Error('Invalid recovery table name.');
    const pragma = (name: string): unknown => {
      const row = options.db.prepare(`PRAGMA ${name}`).get() as
        | Record<string, unknown>
        | undefined;
      return row ? Object.values(row)[0] : undefined;
    };
    if (String(pragma('journal_mode')).toLowerCase() !== 'wal')
      throw new Error('Recovery storage requires SQLite WAL mode.');
    const busyTimeout = Number(pragma('busy_timeout'));
    if (!Number.isSafeInteger(busyTimeout) || busyTimeout < 1)
      throw new Error('Recovery storage requires a positive busy timeout.');
    options.db.exec('PRAGMA synchronous = FULL');
    if (Number(pragma('synchronous')) !== 2)
      throw new Error('Recovery storage requires SQLite synchronous FULL.');
  }

  /** Execute one recovery command on the bound host connection. */
  executeSync<C extends RecoveryStorageCommand<I, P, Reason>>(
    command: C,
    options: RecoveryExecuteOptions = {},
  ): RecoveryStorageResult<I, P, Reason, C> {
    if (this.closed) throw new KernelStorageClosedError();
    if (!RECOVERY_OPERATIONS.includes(command.type))
      throw new Error('Unknown recovery storage command.');
    if (this.inFlight)
      throw new Error('Recovery storage cannot enter an existing transaction.');
    const nested = this.options.db.isTransaction === true;
    if (nested && !options.withinHostTransaction)
      throw new Error('Recovery storage cannot enter an existing transaction.');
    const readOnly = [
      'findRecoveryIntent',
      'readRecoveryProjection',
      'readPendingRecoveryIntents',
      'readUsageLimitIntentsAwaitingUser',
      'readRecoveryCompensationSnapshot',
      'preparedRecoveryDispatches',
    ].includes(command.type);
    this.options.db.exec(
      nested
        ? 'SAVEPOINT monument_recovery'
        : `BEGIN ${readOnly ? 'DEFERRED' : 'IMMEDIATE'}`,
    );
    this.inFlight = true;
    try {
      if (nested && !readOnly)
        this.options.db
          .prepare(
            `UPDATE ${this.options.table} SET fingerprint = fingerprint WHERE 0`,
          )
          .run();
      let result: unknown;
      const guard = this.guard(command);
      if (guard && !guard.allowed) {
        // The host may observe a post-write fault even on a no-op retry; its
        // exact terminal readback is the existing acknowledgement rule.
        result =
          command.type === 'recordRecoveryTerminal' &&
          this.options.afterTerminalWrite
            ? this.recordRecoveryTerminal(...command.args)
            : guard.refused === 'null'
              ? null
              : { kind: 'stale' };
      } else
        switch (command.type) {
          case 'armRecoveryIntent':
            result = this.armRecoveryIntent(...command.args);
            break;
          case 'findRecoveryIntent':
            result = this.findRecoveryIntent(...command.args);
            break;
          case 'readRecoveryProjection':
            result = this.readRecoveryProjection(...command.args);
            break;
          case 'readPendingRecoveryIntents':
            result = this.readPendingRecoveryIntents(...command.args);
            break;
          case 'readUsageLimitIntentsAwaitingUser':
            result = this.readUsageLimitIntentsAwaitingUser(...command.args);
            break;
          case 'readRecoveryCompensationSnapshot':
            result = this.readRecoveryCompensationSnapshot(...command.args);
            break;
          case 'claimRecoveryDispatch':
            result = this.claimRecoveryDispatch(...command.args);
            break;
          case 'releaseRecoveryDispatch':
            result = this.releaseRecoveryDispatch(...command.args);
            break;
          case 'acceptRecoveryDispatch':
            result = this.acceptRecoveryDispatch(...command.args);
            break;
          case 'observeRecoveryDispatchCorrelation':
            result = this.observeRecoveryDispatchCorrelation(...command.args);
            break;
          case 'markRecoveryDispatchIndeterminate':
            result = this.markRecoveryDispatchIndeterminate(...command.args);
            break;
          case 'linkRecoveryCredentialAttempt':
            result = this.linkRecoveryCredentialAttempt(...command.args);
            break;
          case 'preparedRecoveryDispatches':
            result = this.preparedRecoveryDispatches(...command.args);
            break;
          case 'indeterminatePreparedRecoveryDispatch':
            result = this.indeterminatePreparedRecoveryDispatch(
              ...command.args,
            );
            break;
          case 'recordRecoveryTerminal':
            result = this.recordRecoveryTerminal(...command.args);
            break;
          case 'markRecoveryCompensation':
            result = this.markRecoveryCompensation(...command.args);
            break;
          case 'resolveRecoveryCompensationRecord':
            result = this.resolveRecoveryCompensationRecord(...command.args);
            break;
          case 'cancelRecovery':
            result = this.cancelRecovery(...command.args);
            break;
          case 'retireWaitingRecovery':
            result = this.retireWaitingRecovery(...command.args);
            break;
          case 'cancelSourceTerminatedRecoveries':
            result = this.cancelSourceTerminatedRecoveries(...command.args);
            break;
          case 'cancelRecoveryIfSourceTerminated':
            result = this.cancelRecoveryIfSourceTerminated(...command.args);
            break;
          case 'cancelShutdownRecoveries':
            result = this.cancelShutdownRecoveries(...command.args);
            break;
        }
      if (!readOnly) this.options.beforeCommit?.();
      this.options.db.exec(
        nested ? 'RELEASE SAVEPOINT monument_recovery' : 'COMMIT',
      );
      return result as RecoveryStorageResult<I, P, Reason, C>;
    } catch (error) {
      try {
        if (nested) {
          this.options.db.exec('ROLLBACK TO SAVEPOINT monument_recovery');
          this.options.db.exec('RELEASE SAVEPOINT monument_recovery');
        } else this.options.db.exec('ROLLBACK');
      } catch {
        // The host connection may already have rolled back.
      }
      throw error;
    } finally {
      this.inFlight = false;
    }
  }

  async execute<C extends RecoveryStorageCommand<I, P, Reason>>(
    command: C,
  ): Promise<RecoveryStorageResult<I, P, Reason, C>> {
    return this.executeSync(command);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private readGuardRows(
    column?: 'fingerprint' | 'recovery_correlation_id',
    key?: string,
    source = false,
  ): RecoveryGuardRow[] {
    const terminal = source ? this.options.sourceTerminalSql : '0';
    const where = column
      ? `WHERE intent.${column} = ?`
      : "WHERE intent.outcome IN ('armed', 'resumed', 'manual')";
    const statement = this.options.db.prepare(`
      SELECT outcome, attempts, max_attempts, due_at, usage_limit, decision,
             dispatch_settlement, dispatch_kind, dispatch_attempt_id,
             recovery_correlation_id, dispatch_owner_id, dispatch_owner_pid,
             credential_attempt_id, CASE WHEN ${terminal} THEN 1 ELSE 0 END AS source_terminated
      FROM ${this.options.table} AS intent ${where}
    `);
    const rows = column ? statement.all(key ?? '') : statement.all();
    return rows.map((value) => {
      const row = value as Record<string, unknown>;
      const text = (field: string): string | null =>
        typeof row[field] === 'string' ? row[field] : null;
      return {
        outcome: text('outcome') ?? '',
        attempts: Number(row.attempts),
        maxAttempts: Number(row.max_attempts),
        dueAt: text('due_at'),
        usageLimit: Number(row.usage_limit) === 1,
        decision: text('decision') ?? '',
        settlement: text('dispatch_settlement'),
        kind: text('dispatch_kind'),
        attemptId: text('dispatch_attempt_id'),
        correlationId: text('recovery_correlation_id'),
        ownerId: text('dispatch_owner_id'),
        ownerPid:
          row.dispatch_owner_pid == null
            ? null
            : Number(row.dispatch_owner_pid),
        credentialAttemptId: text('credential_attempt_id'),
        sourceTerminated: Number(row.source_terminated) === 1,
      };
    });
  }

  private guard(
    command: RecoveryStorageCommand<I, P, Reason>,
  ): { allowed: boolean; refused: 'null' | 'stale' } | undefined {
    const plan = recoveryGuardPlan(command);
    if (!plan) return undefined;
    const rows = this.readGuardRows(
      plan.key === undefined ? undefined : plan.column,
      plan.key,
      plan.source,
    );
    return {
      allowed: rows.some((row) =>
        decideRecoveryStorageGuard(plan.decision, row),
      ),
      refused: plan.refused,
    };
  }

  armRecoveryIntent(input: RecoveryIntentInput<I>): I {
    const existing = this.findRecoveryIntent(input.fingerprint);
    if (decideRecoveryArm(existing !== null) === 'existing') {
      if (!existing) throw new Error('Recovery arm decision lost its record.');
      return existing;
    }
    this.options.db
      .prepare(
        `INSERT OR IGNORE INTO ${this.options.table}
          (fingerprint, thread_id, provider, source_event_id, source_turn_id,
           failure_kind, scope, decision, due_at, attempts, max_attempts,
           outcome, dispatch_attempt_id, recovery_correlation_id,
           dispatch_settlement, dispatch_kind, resumed_turn_id, outcome_reason, usage_limit, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        input.fingerprint,
        input.threadId,
        input.provider,
        input.sourceEventId,
        input.sourceTurnId,
        input.failureKind,
        input.scope,
        input.decision,
        input.dueAt ?? null,
        input.maxAttempts,
        input.outcome,
        input.usageLimit ? 1 : null,
        input.createdAt,
        input.updatedAt,
      );
    return this.findRecoveryIntent(input.fingerprint)!;
  }

  findRecoveryIntent(fingerprint: string): I | null {
    const row = this.options.db
      .prepare(
        `SELECT fingerprint, thread_id, provider, source_event_id, source_turn_id,
                failure_kind, scope, decision, due_at, attempts, max_attempts,
                outcome, dispatch_attempt_id, recovery_correlation_id,
                dispatch_settlement, dispatch_kind, resumed_turn_id, outcome_reason, usage_limit, created_at, updated_at
         FROM ${this.options.table} WHERE fingerprint = ?`,
      )
      .get(fingerprint) as Record<string, unknown> | undefined;
    return row ? this.options.mapRecord(row) : null;
  }

  readRecoveryProjection(threadId: string): P | undefined {
    const row = this.options.db
      .prepare(`SELECT fingerprint, thread_id, provider, source_event_id, source_turn_id,
                failure_kind, scope, decision, due_at, attempts, max_attempts,
                outcome, dispatch_attempt_id, recovery_correlation_id,
                dispatch_settlement, dispatch_kind, resumed_turn_id, outcome_reason, usage_limit, created_at, updated_at
         FROM ${this.options.table}
         WHERE thread_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1`)
      .get(threadId);
    return row ? this.options.project(this.options.mapRecord(row)) : undefined;
  }

  readPendingRecoveryIntents(): I[] {
    return this.options.db
      .prepare(
        `SELECT fingerprint, thread_id, provider, source_event_id, source_turn_id,
                failure_kind, scope, decision, due_at, attempts, max_attempts,
                outcome, dispatch_attempt_id, recovery_correlation_id,
                dispatch_settlement, dispatch_kind, resumed_turn_id, outcome_reason, usage_limit, created_at, updated_at
         FROM ${this.options.table}
         WHERE outcome IN ('armed', 'resumed') ORDER BY due_at ASC, created_at ASC`,
      )
      .all()
      .map((row: unknown) => this.options.mapRecord(row));
  }

  /** #3157: usage-limit intents left to the user (`manual`), never claimed. */
  readUsageLimitIntentsAwaitingUser(): I[] {
    return this.options.db
      .prepare(
        `SELECT fingerprint, thread_id, provider, source_event_id, source_turn_id,
                failure_kind, scope, decision, due_at, attempts, max_attempts,
                outcome, dispatch_attempt_id, recovery_correlation_id,
                dispatch_settlement, dispatch_kind, resumed_turn_id, outcome_reason, usage_limit, created_at, updated_at
         FROM ${this.options.table}
         WHERE outcome = 'manual' AND usage_limit = 1
           AND dispatch_attempt_id IS NULL AND recovery_correlation_id IS NULL
         ORDER BY updated_at ASC`,
      )
      .all()
      .map((row: unknown) => this.options.mapRecord(row));
  }

  readRecoveryCompensationSnapshot(): I[] {
    return this.options.db
      .prepare(
        `SELECT fingerprint, thread_id, provider, source_event_id, source_turn_id,
                failure_kind, scope, decision, due_at, attempts, max_attempts,
                outcome, dispatch_attempt_id, recovery_correlation_id,
                dispatch_settlement, dispatch_kind, resumed_turn_id, outcome_reason, usage_limit, created_at, updated_at
         FROM ${this.options.table}
         WHERE outcome = 'compensation-required'
         ORDER BY updated_at ASC, created_at ASC`,
      )
      .all()
      .map((row: unknown) => this.options.mapRecord(row));
  }

  claimRecoveryDispatch(input: {
    fingerprint: string;
    kind: 'due' | 'profile';
    /**
     * #3157: the user's own "Resume now" on a usage-limit stop. It claims a
     * waiting (`armed`) or left-to-the-user (`manual`) usage-limit intent
     * before its due time, and is still an ordinary `due` dispatch.
     */
    immediate?: boolean;
    dispatchAttemptId: string;
    recoveryCorrelationId: string;
    owner: RecoveryOwner;
    now: string;
  }): I | null {
    const immediate = input.kind === 'due' && input.immediate === true;
    const eligibility = immediate
      ? "outcome IN ('armed', 'manual') AND usage_limit = 1"
      : input.kind === 'due'
        ? "outcome = 'armed' AND due_at IS NOT NULL AND due_at <= ?"
        : "outcome IN ('armed', 'manual')";
    const row = this.options.db
      .prepare(
        `UPDATE ${this.options.table} AS intent
         SET outcome = 'resumed', attempts = attempts + 1, outcome_reason = NULL,
             dispatch_attempt_id = ?, recovery_correlation_id = ?,
             dispatch_settlement = 'prepared', dispatch_kind = ?,
             dispatch_owner_id = ?, dispatch_owner_pid = ?,
             dispatch_owner_birth = ?, dispatch_owner_identity_kind = ?, updated_at = ?
         WHERE fingerprint = ? AND ${eligibility} AND attempts < max_attempts
           AND dispatch_attempt_id IS NULL AND recovery_correlation_id IS NULL
           AND NOT ${this.options.sourceTerminalSql}
         RETURNING fingerprint, thread_id, provider, source_event_id, source_turn_id,
                   failure_kind, scope, decision, due_at, attempts, max_attempts,
                   outcome, dispatch_attempt_id, recovery_correlation_id,
                   dispatch_settlement, dispatch_kind, resumed_turn_id, outcome_reason, usage_limit, created_at, updated_at`,
      )
      .get(
        input.dispatchAttemptId,
        input.recoveryCorrelationId,
        input.kind,
        input.owner.id,
        input.owner.pid,
        input.owner.identityKind === 'exact' ? input.owner.birth : null,
        input.owner.identityKind,
        input.now,
        input.fingerprint,
        ...(input.kind === 'due' && !immediate ? [input.now] : []),
      ) as Record<string, unknown> | undefined;
    return row ? this.options.mapRecord(row) : null;
  }

  releaseRecoveryDispatch(input: {
    fingerprint: string;
    dispatchAttemptId: string;
    outcome: 'armed' | 'manual';
    now: string;
  }): RecoveryTransition {
    const result = this.options.db
      .prepare(
        `UPDATE ${this.options.table}
         SET outcome = ?, attempts = MAX(attempts - 1, 0),
             dispatch_attempt_id = NULL, recovery_correlation_id = NULL,
             dispatch_settlement = NULL, dispatch_kind = NULL,
             dispatch_owner_id = NULL, dispatch_owner_pid = NULL,
             dispatch_owner_birth = NULL, dispatch_owner_identity_kind = NULL,
             credential_attempt_id = NULL, updated_at = ?
         WHERE fingerprint = ? AND outcome = 'resumed' AND dispatch_attempt_id = ?
           AND dispatch_settlement = 'prepared'`,
      )
      .run(
        input.outcome,
        input.now,
        input.fingerprint,
        input.dispatchAttemptId,
      ) as {
      changes: number | bigint;
    };
    return recoveryTransition(result);
  }

  acceptRecoveryDispatch(input: {
    fingerprint: string;
    dispatchAttemptId: string;
    turnId: string;
    now: string;
  }): RecoveryTransition {
    const result = this.options.db
      .prepare(
        `UPDATE ${this.options.table}
         SET resumed_turn_id = COALESCE(resumed_turn_id, ?),
             dispatch_settlement = 'accepted', updated_at = ?
         WHERE fingerprint = ? AND outcome = 'resumed' AND dispatch_attempt_id = ?
           AND dispatch_settlement = 'prepared'`,
      )
      .run(
        input.turnId,
        input.now,
        input.fingerprint,
        input.dispatchAttemptId,
      ) as {
      changes: number | bigint;
    };
    return recoveryTransition(result);
  }

  observeRecoveryDispatchCorrelation(
    recoveryCorrelationId: string,
    turnId: string,
    now: string,
  ): I | null {
    const row = this.options.db
      .prepare(
        `UPDATE ${this.options.table}
         SET resumed_turn_id = COALESCE(resumed_turn_id, ?), updated_at = ?
         WHERE recovery_correlation_id = ? AND outcome = 'resumed'
         RETURNING fingerprint, thread_id, provider, source_event_id, source_turn_id,
                   failure_kind, scope, decision, due_at, attempts, max_attempts,
                   outcome, dispatch_attempt_id, recovery_correlation_id,
                   dispatch_settlement, dispatch_kind, resumed_turn_id, outcome_reason, usage_limit, created_at, updated_at`,
      )
      .get(turnId, now, recoveryCorrelationId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.options.mapRecord(row) : null;
  }

  markRecoveryDispatchIndeterminate(
    fingerprint: string,
    dispatchAttemptId: string,
    now: string,
  ): RecoveryTransition {
    const result = this.options.db
      .prepare(
        `UPDATE ${this.options.table}
         SET outcome = 'indeterminate', updated_at = ?
         WHERE fingerprint = ? AND outcome = 'resumed' AND dispatch_attempt_id = ?
           AND dispatch_settlement = 'prepared'`,
      )
      .run(now, fingerprint, dispatchAttemptId) as { changes: number | bigint };
    return recoveryTransition(result);
  }

  linkRecoveryCredentialAttempt(input: {
    fingerprint: string;
    dispatchAttemptId: string;
    credentialAttemptId: string;
    now: string;
  }): RecoveryTransition {
    const result = this.options.db
      .prepare(
        `UPDATE ${this.options.table}
         SET credential_attempt_id = ?, updated_at = ?
         WHERE fingerprint = ? AND outcome = 'resumed'
           AND dispatch_settlement = 'prepared' AND dispatch_kind = 'profile'
           AND dispatch_attempt_id = ?
           AND (credential_attempt_id IS NULL OR credential_attempt_id = ?)`,
      )
      .run(
        input.credentialAttemptId,
        input.now,
        input.fingerprint,
        input.dispatchAttemptId,
        input.credentialAttemptId,
      ) as { changes: number | bigint };
    return recoveryTransition(result);
  }

  preparedRecoveryDispatches(
    kind?: 'due' | 'profile',
    unlinkedOnly = false,
  ): Array<{
    intent: I;
    ownerId: string | null;
    ownerPid: number | null;
    ownerBirth: string | null;
    ownerIdentityKind: string | null;
    credentialAttemptId: string | null;
  }> {
    return this.options.db
      .prepare(
        `SELECT fingerprint, thread_id, provider, source_event_id, source_turn_id,
                failure_kind, scope, decision, due_at, attempts, max_attempts,
                outcome, dispatch_attempt_id, recovery_correlation_id,
                dispatch_settlement, dispatch_kind, resumed_turn_id, outcome_reason, usage_limit, created_at, updated_at,
                dispatch_owner_id, dispatch_owner_pid, dispatch_owner_birth,
                dispatch_owner_identity_kind, credential_attempt_id
         FROM ${this.options.table}
         WHERE ((
             outcome = 'resumed' AND dispatch_settlement IN ('prepared', 'accepted')
           ) OR (
             outcome = 'succeeded' AND credential_attempt_id IS NOT NULL
           ) OR (
             outcome = 'indeterminate' AND credential_attempt_id IS NOT NULL
           ) OR (
             ? = 1 AND outcome = 'indeterminate'
             AND credential_attempt_id IS NULL
           ))
           AND (? IS NULL OR dispatch_kind = ?)
           AND (? = 0 OR credential_attempt_id IS NULL)
           AND (
             (dispatch_attempt_id IS NOT NULL AND recovery_correlation_id IS NOT NULL)
             OR (? = 1 AND outcome = 'indeterminate' AND credential_attempt_id IS NULL)
           )
         ORDER BY updated_at ASC, created_at ASC`,
      )
      .all(
        unlinkedOnly ? 1 : 0,
        kind ?? null,
        kind ?? null,
        unlinkedOnly ? 1 : 0,
        unlinkedOnly ? 1 : 0,
      )
      .map((row: unknown) => {
        const prepared = row as Record<string, unknown> & {
          dispatch_owner_id: string | null;
          dispatch_owner_pid: number | null;
          dispatch_owner_birth: string | null;
          dispatch_owner_identity_kind: string | null;
          credential_attempt_id: string | null;
        };
        return {
          intent: this.options.mapRecord(prepared),
          ownerId: prepared.dispatch_owner_id,
          ownerPid: prepared.dispatch_owner_pid,
          ownerBirth: prepared.dispatch_owner_birth,
          ownerIdentityKind: prepared.dispatch_owner_identity_kind,
          credentialAttemptId: prepared.credential_attempt_id,
        };
      });
  }

  indeterminatePreparedRecoveryDispatch(input: {
    fingerprint: string;
    dispatchAttemptId: string;
    recoveryCorrelationId: string;
    ownerId: string | null;
    ownerPid: number | null;
    now: string;
  }): I | null {
    const row = this.options.db
      .prepare(
        `UPDATE ${this.options.table}
         SET outcome = 'indeterminate', updated_at = ?
         WHERE fingerprint = ? AND outcome = 'resumed'
           AND dispatch_settlement = 'prepared'
           AND dispatch_attempt_id = ? AND recovery_correlation_id = ?
           AND dispatch_owner_id IS ? AND dispatch_owner_pid IS ?
         RETURNING fingerprint, thread_id, provider, source_event_id, source_turn_id,
                   failure_kind, scope, decision, due_at, attempts, max_attempts,
                   outcome, dispatch_attempt_id, recovery_correlation_id,
                   dispatch_settlement, dispatch_kind, resumed_turn_id, outcome_reason, usage_limit, created_at, updated_at`,
      )
      .get(
        input.now,
        input.fingerprint,
        input.dispatchAttemptId,
        input.recoveryCorrelationId,
        input.ownerId,
        input.ownerPid,
      ) as Record<string, unknown> | undefined;
    return row ? this.options.mapRecord(row) : null;
  }

  recordRecoveryTerminal(
    fingerprint: string,
    outcome: Extract<I['outcome'], 'succeeded' | 'failed' | 'canceled'>,
    now: string,
  ): RecoveryTransition {
    try {
      const result = this.options.db
        .prepare(
          `UPDATE ${this.options.table} SET outcome = ?, updated_at = ?
         WHERE fingerprint = ? AND outcome IN ('resumed', 'indeterminate')
           AND (? != 'succeeded' OR (outcome = 'resumed' AND dispatch_settlement = 'accepted'))`,
        )
        .run(outcome, now, fingerprint, outcome) as {
        changes: number | bigint;
      };
      this.options.afterTerminalWrite?.();
      return recoveryTransition(result);
    } catch (error) {
      // A durable UPDATE can succeed before the caller observes a driver or
      // post-write fault. Re-read only this exact desired terminal fact.
      const row = this.options.db
        .prepare(
          `SELECT outcome FROM ${this.options.table} WHERE fingerprint = ?`,
        )
        .get(fingerprint) as { outcome?: string } | undefined;
      if (row?.outcome === outcome) return { kind: 'applied' };
      throw error;
    }
  }

  markRecoveryCompensation(
    fingerprint: string,
    now: string,
    expectedOutcome: 'resumed' | 'canceled' | 'indeterminate' = 'resumed',
  ): RecoveryTransition {
    const result = this.options.db
      .prepare(
        `UPDATE ${this.options.table}
         SET outcome = 'compensation-required', updated_at = ?
         WHERE fingerprint = ? AND outcome = ?`,
      )
      .run(now, fingerprint, expectedOutcome) as { changes: number | bigint };
    return recoveryTransition(result);
  }

  resolveRecoveryCompensationRecord(
    fingerprint: string,
    now: string,
  ): RecoveryTransition {
    const result = this.options.db
      .prepare(
        `UPDATE ${this.options.table}
         SET outcome = 'failed', updated_at = ?
         WHERE fingerprint = ? AND outcome = 'compensation-required'`,
      )
      .run(now, fingerprint) as { changes: number | bigint };
    return recoveryTransition(result);
  }

  cancelRecovery(
    fingerprint: string,
    now: string,
    reason?: Reason,
  ): RecoveryTransition {
    const result = this.options.db
      .prepare(
        `UPDATE ${this.options.table}
         SET outcome = 'canceled', outcome_reason = COALESCE(?, outcome_reason), updated_at = ?
         WHERE fingerprint = ? AND outcome IN ('armed', 'resumed', 'manual')`,
      )
      .run(reason ?? null, now, fingerprint) as { changes: number | bigint };
    return recoveryTransition(result);
  }

  /**
   * #3157: settles an intent that is still only waiting — armed, never
   * claimed — without a dispatch. Anything already claimed belongs to its
   * claim and is left alone (`stale`).
   */
  retireWaitingRecovery(input: {
    fingerprint: string;
    outcome: 'manual' | 'canceled';
    reason: Reason;
    now: string;
  }): RecoveryTransition {
    const result = this.options.db
      .prepare(
        `UPDATE ${this.options.table}
         SET outcome = ?, outcome_reason = ?, updated_at = ?
         WHERE fingerprint = ?
           AND (outcome = 'armed' OR (outcome = 'manual' AND usage_limit = 1))
           AND dispatch_attempt_id IS NULL AND recovery_correlation_id IS NULL`,
      )
      .run(input.outcome, input.reason, input.now, input.fingerprint) as {
      changes: number | bigint;
    };
    return recoveryTransition(result);
  }

  /**
   * A persisted source terminal is stronger than a lost in-process cancel
   * result. On restart, cancel only the exact still-pending intent whose
   * source turn has a durable terminal event; no timer or provider retry can
   * then revive it.
   */
  cancelSourceTerminatedRecoveries(now: string): RecoveryTransition {
    const result = this.options.db
      .prepare(
        `UPDATE ${this.options.table} AS intent
         SET outcome = 'canceled', updated_at = ?
         WHERE intent.outcome IN ('armed', 'resumed', 'manual')
           AND ${this.options.sourceTerminalSql}`,
      )
      .run(now) as { changes: number | bigint };
    return recoveryTransition(result);
  }

  /**
   * #3563: the same rule for one intent, when its timer fires. A startup
   * repair that answered `unavailable` cannot then replay a turn whose source
   * already ended, and it no longer has to gate every other recovery.
   * `applied` canceled the intent; `stale` means dispatch may proceed.
   */
  cancelRecoveryIfSourceTerminated(
    fingerprint: string,
    now: string,
  ): RecoveryTransition {
    const result = this.options.db
      .prepare(
        `UPDATE ${this.options.table} AS intent
         SET outcome = 'canceled', updated_at = ?
         WHERE intent.fingerprint = ?
           AND intent.outcome IN ('armed', 'resumed', 'manual')
           AND ${this.options.sourceTerminalSql}`,
      )
      .run(now, fingerprint) as { changes: number | bigint };
    return recoveryTransition(result);
  }

  /** A bounded shutdown may lose its per-intent CAS result. Persist the
   * cancel request itself so startup fences it before any timer is rebuilt.
   *
   * #3157: a usage-limit intent that is only waiting for its provider reset,
   * or that the user was left to resume (`manual`, whether the setting was off
   * or the provider gave no reset), holds no dispatch to stop. It is not
   * fenced: a restart rebuilds its timer (`reconcile`), a manual one is never
   * dispatched on its own, and the coordinator re-checks the Session before
   * any dispatch. */
  cancelShutdownRecoveries(now: string): RecoveryTransition {
    const result = this.options.db
      .prepare(
        `UPDATE ${this.options.table}
         SET shutdown_cancel_requested_at = ?, updated_at = ?
         WHERE outcome IN ('armed', 'resumed', 'manual')
           AND NOT (
             COALESCE(dispatch_attempt_id, recovery_correlation_id) IS NULL
             AND COALESCE(usage_limit, 0) = 1
             AND (
               (outcome = 'armed' AND decision = 'wait-until-reset')
               OR outcome = 'manual'
             )
           )`,
      )
      .run(now, now) as { changes: number | bigint };
    return recoveryTransition(result);
  }
}

/** Bind recovery commands to an existing host table without creating schema. */
export function createSqliteRecoveryStorage<
  I extends RecoverySqlIntent,
  P,
  Reason extends string,
>(
  options: ConstructorParameters<typeof SqliteRecoveryStorage<I, P, Reason>>[0],
): RecoveryStoragePort<I, P, Reason> {
  const storage = new SqliteRecoveryStorage<I, P, Reason>(options);
  return Object.freeze({
    executeSync: storage.executeSync.bind(storage),
    execute: storage.execute.bind(storage),
    close: storage.close.bind(storage),
  });
}
