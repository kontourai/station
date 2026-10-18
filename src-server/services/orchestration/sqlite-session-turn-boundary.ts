import { isDeepStrictEqual } from 'node:util';
import type {
  InvocationTerminalFact,
  InvocationTerminalRetirement,
  KernelCommand,
  KernelResult,
  OwnerIdentity,
  OwnerLiveness,
} from '@kontourai/monument';
import { decideTurnBoundaryObserveTerminal } from '@kontourai/monument';
import {
  assertInvocationTerminalRetirement,
  findInvocationTerminal,
} from '@kontourai/monument/adapter';
import {
  openSqliteKernelStorage,
  type SqliteInvocationTerminalFacts,
} from '@kontourai/monument/sqlite';
import { z } from 'zod';
import { readPreparedClaimCustody } from '../turn-idempotency.js';
import {
  type CapturedTurnIntent,
  decodeTurnIntent,
} from './prepared-turn-intent.js';
import { isProjectTaskRoomExecutionSealed } from './project-task-room-source-seal.js';
import {
  type InvocationAcceptanceSnapshot,
  SESSION_START_INDETERMINATE_CODE,
  SESSION_TURN_ACCEPTED_CAPACITY,
  type SessionTurnBoundaryCoordinator,
  type SessionTurnBoundaryRecord,
} from './session-turn-boundary.js';
import type { SqliteDatabase } from './sqlite-database.js';
import {
  STATION_TURN_DEDUP_KERNEL_TABLES,
  turnDedupKey,
} from './sqlite-turn-dedup-persistence.js';
import type { TurnClaim } from './turn-deduplicator.js';

/** Station's host tables and admission policy; Monument owns the boundary writes. */
export function createSqliteSessionTurnBoundaryCoordinator({
  db,
  head,
  reconcileTerminals,
  retiredBoundaryIds,
  transactionLost,
  preparedClaims,
}: {
  db: SqliteDatabase & { readonly isTransaction?: boolean };
  head(): number;
  reconcileTerminals(threadId: string): void;
  retiredBoundaryIds(threadId: string): readonly string[];
  transactionLost(cause: unknown): Error;
  preparedClaims?: {
    owner: OwnerIdentity;
    liveness: OwnerLiveness;
    adopt(key: string): TurnClaim;
  };
}): SessionTurnBoundaryCoordinator {
  let preparedCurrent: (() => boolean) | undefined;
  const invocationTerminals: SqliteInvocationTerminalFacts = {
    readObservation(database, threadId, eventId) {
      const row = database
        .prepare(
          'SELECT id, provider, thread_id, turn_id, method, created_at, payload FROM orchestration_events WHERE thread_id = ? AND id = ?',
        )
        .get(threadId, eventId);
      return row ? decodeTerminal(row) : undefined;
    },
    find(database, query) {
      // Every retained scoped assertion is decoded before the pure selector filters candidates.
      const rows = database
        .prepare(
          'SELECT id, provider, thread_id, turn_id, method, created_at, payload FROM orchestration_events WHERE thread_id = ?',
        )
        .all(query.threadId);
      const facts = rows.flatMap((row) => {
        const fact = decodeTerminal(row);
        return fact?.invocationId === query.invocationId ? [fact] : [];
      });
      return findInvocationTerminal(facts, query);
    },
    readRetirement(database, threadId, boundaryId) {
      const raw = database
        .prepare(
          'SELECT * FROM orchestration_prepared_turns WHERE thread_id = ? AND boundary_id = ?',
        )
        .get(threadId, boundaryId);
      const row = retirementRow.optional().parse(raw);
      if (!row || row.terminal_retirement === null) return undefined;
      const witness: unknown = JSON.parse(String(row.terminal_retirement));
      assertInvocationTerminalRetirement(witness);
      assertIntentAssociation(row, witness);
      return witness;
    },
    recordRetirement(database, witness) {
      assertInvocationTerminalRetirement(witness);
      const raw = database
        .prepare(
          'SELECT * FROM orchestration_prepared_turns WHERE invocation_id = ?',
        )
        .get(witness.terminal.invocationId);
      const row = retirementRow.optional().parse(raw);
      if (!row) throw new Error('Invocation retirement input is unavailable.');
      assertIntentAssociation(row, witness);
      if (row.terminal_retirement !== null) {
        const previous: unknown = JSON.parse(String(row.terminal_retirement));
        assertInvocationTerminalRetirement(previous);
        if (!isDeepStrictEqual(previous, witness))
          throw new Error(
            'Invocation retirement conflicts with retained custody.',
          );
        return;
      }
      database
        .prepare(
          'UPDATE orchestration_prepared_turns SET terminal_retirement = ? WHERE invocation_id = ?',
        )
        .run(JSON.stringify(witness), witness.terminal.invocationId);
    },
  };
  const kernel = openSqliteKernelStorage({
    database: db,
    tables: {
      turnDedup: STATION_TURN_DEDUP_KERNEL_TABLES.turnDedup,
      requestKeys: 'unused',
      // #3568: the inbox has its own storage on this connection
      // (`createSqliteThreadInboxStore`); this one owns boundaries only.
      inbox: 'unused',
      turnBoundary: {
        table: 'orchestration_turn_boundaries',
        ownerEncoding: 'columns',
        terminalFacts: 'host',
        terminalSeen: (_db, threadId, turnId) =>
          Boolean(
            db
              .prepare(
                `SELECT 1 FROM orchestration_events WHERE thread_id = ? AND turn_id = ?
           AND method IN ('turn.completed', 'turn.aborted', 'runtime.error') LIMIT 1`,
              )
              .get(threadId, turnId),
          ),
        terminalSequence: (_db, threadId, eventId) =>
          (
            db
              .prepare(
                'SELECT global_sequence FROM orchestration_events WHERE thread_id = ? AND id = ?',
              )
              .get(threadId, eventId ?? null) as
              | { global_sequence: number }
              | undefined
          )?.global_sequence,
        retiredBoundaryIds: (_db, threadId) => retiredBoundaryIds(threadId),
        creationSequence: { column: 'created_sequence', read: head },
        intentColumns: {
          invocationId: 'invocation_id',
          inputDigest: 'input_digest',
          intentDigest: 'intent_digest',
          bodyRef: 'body_ref',
          dedupKey: 'dedup_key',
        },
        settlementColumn: 'prepared_settlement',
        invocationTerminals,
      },
    },
    participants: [
      {
        name: 'station-boundary-admission',
        admit(command) {
          if (
            (command.type === 'turnBoundary.resumePrepared' ||
              command.type === 'turnBoundary.beginInvocation') &&
            preparedCurrent &&
            !preparedCurrent()
          )
            return { refuse: 'prepared-authority-changed' };
          if (
            command.type === 'turnBoundary.create' &&
            command.state !== 'lifecycle' &&
            isProjectTaskRoomExecutionSealed(db, command.threadId)
          )
            return { refuse: 'task-room-source-sealed' };
        },
      },
    ],
  });
  const context = {
    // The authority probes owners before its guarded transitions, outside the transaction.
    liveness: () => 'unknown' as const,
    limits: { turnBoundaryAcceptedCapacity: SESSION_TURN_ACCEPTED_CAPACITY },
  };
  function execute<C extends KernelCommand>(
    command: C,
    nested = false,
  ): KernelResult<C> {
    if (nested && db.isTransaction !== true)
      throw transactionLost(
        new Error('Host transaction ended before boundary command.'),
      );
    const joined = db.isTransaction === true;
    const cleanup =
      command.type === 'turnBoundary.create' ||
      command.type === 'turnBoundary.recordAccepted';
    const outer = cleanup && !db.isTransaction;
    if (outer) db.exec('BEGIN IMMEDIATE');
    try {
      // Cleanup can issue kernel commands only before dispatch, never from a participant.
      if (cleanup) reconcileTerminals(command.threadId);
      if (joined && db.isTransaction !== true)
        throw transactionLost(
          new Error('Host transaction ended during terminal cleanup.'),
        );
      const result = kernel.executeSync(command, context, {
        withinHostTransaction: nested || db.isTransaction === true,
      });
      if (outer) db.exec('COMMIT');
      return result;
    } catch (error) {
      if (outer && db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
  function withPreparedCurrent<T>(
    current: (() => boolean) | undefined,
    operation: () => T,
  ): T {
    const previous = preparedCurrent;
    preparedCurrent = current;
    try {
      return operation();
    } finally {
      preparedCurrent = previous;
    }
  }
  function owner(record: SessionTurnBoundaryRecord): OwnerIdentity {
    return record.ownerIdentityKind === 'exact' && record.ownerBirth
      ? {
          id: record.ownerId,
          pid: record.ownerPid,
          identityKind: 'exact',
          birth: record.ownerBirth,
        }
      : {
          id: record.ownerId,
          pid: record.ownerPid,
          identityKind: 'unverified',
        };
  }
  function exact(input: {
    boundaryId: string;
    ownerId: string;
    state?: string;
    updatedAt?: string;
    providerTurnId?: string;
  }) {
    const row = db
      .prepare(
        'SELECT state, updated_at, provider_turn_id FROM orchestration_turn_boundaries WHERE boundary_id = ? AND owner_id = ?',
      )
      .get(input.boundaryId, input.ownerId) as
      | { state: string; updated_at: string; provider_turn_id: string | null }
      | undefined;
    return (
      row !== undefined &&
      (input.state === undefined || row.state === input.state) &&
      (input.updatedAt === undefined || row.updated_at === input.updatedAt) &&
      (input.providerTurnId === undefined ||
        row.provider_turn_id === input.providerTurnId)
    );
  }
  function present(boundaryId: string) {
    return Boolean(
      db
        .prepare(
          'SELECT 1 FROM orchestration_turn_boundaries WHERE boundary_id = ?',
        )
        .get(boundaryId),
    );
  }
  function linked(capture: CapturedTurnIntent, claim: TurnClaim | undefined) {
    if (!capture.clientTurnId) {
      if (claim) throw new Error('Unexpected prepared turn claim.');
      return { intent: capture.intent };
    }
    const custody = claim && readPreparedClaimCustody(claim);
    if (
      !custody ||
      custody.key !== turnDedupKey(capture.threadId, capture.clientTurnId)
    )
      throw new Error('Prepared turn requires its original private claim.');
    return {
      intent: { ...capture.intent, dedupKey: custody.key },
      dedupOwnerId: custody.owner.id,
    };
  }
  return {
    ...(preparedClaims
      ? {
          resumePrepared({
            capture,
            owner: nextOwner,
            now,
            current: admission,
          }: {
            capture: CapturedTurnIntent;
            owner: OwnerIdentity;
            now: string;
            current: () => boolean;
          }) {
            try {
              const found = execute({ type: 'turnBoundary.list' });
              if (found.kind !== 'records')
                return { kind: 'unavailable' as const };
              const current = found.records.find(
                (record) =>
                  record.threadId === capture.threadId &&
                  record.intent?.invocationId === capture.intent.invocationId,
              );
              if (
                !current?.intent ||
                current.state !== 'prepared' ||
                current.intent.inputDigest !== capture.intent.inputDigest ||
                current.intent.intentDigest !== capture.intent.intentDigest ||
                current.intent.bodyRef !== capture.intent.bodyRef
              )
                return { kind: 'stale' as const };
              const verdicts = new Map<string, ReturnType<OwnerLiveness>>();
              verdicts.set(
                JSON.stringify(current.owner),
                preparedClaims.liveness(current.owner),
              );
              const key = current.intent.dedupKey;
              const dedup =
                key === undefined
                  ? undefined
                  : execute({ type: 'turnDedup.read', key });
              if (
                key !== undefined &&
                (dedup?.kind !== 'found' ||
                  !dedup.record.owner ||
                  !dedup.record.preparedUpdatedAt)
              )
                return { kind: 'stale' as const };
              const previous =
                dedup?.kind === 'found' ? dedup.record : undefined;
              if (previous?.owner)
                verdicts.set(
                  JSON.stringify(previous.owner),
                  preparedClaims.liveness(previous.owner),
                );
              const intent = current.intent;
              const result = withPreparedCurrent(admission, () =>
                kernel.executeSync(
                  {
                    type: 'turnBoundary.resumePrepared',
                    boundaryId: current.boundaryId,
                    intent,
                    observed: {
                      owner: current.owner,
                      createdAt: current.createdAt,
                      updatedAt: current.updatedAt,
                      verdict: 'dead',
                    },
                    owner: nextOwner,
                    now,
                    ...(previous?.owner && previous.preparedUpdatedAt
                      ? {
                          dedup: {
                            previousOwner: previous.owner,
                            createdAt: previous.createdAt,
                            updatedAt: previous.preparedUpdatedAt,
                            owner: preparedClaims.owner,
                          },
                        }
                      : {}),
                  },
                  {
                    ...context,
                    liveness: (owner) =>
                      verdicts.get(JSON.stringify(owner)) ?? 'unknown',
                  },
                ),
              );
              if (result.kind !== 'applied') return { kind: 'stale' as const };
              return {
                kind: 'applied' as const,
                record: {
                  boundaryId: current.boundaryId,
                  threadId: current.threadId,
                  state: 'prepared' as const,
                  intent: current.intent,
                  ownerId: nextOwner.id,
                  ownerPid: nextOwner.pid,
                  ownerIdentityKind: nextOwner.identityKind,
                  ...(nextOwner.identityKind === 'exact'
                    ? { ownerBirth: nextOwner.birth }
                    : {}),
                  createdAt: current.createdAt,
                  updatedAt: now,
                },
                ...(key === undefined
                  ? {}
                  : { turnClaim: preparedClaims.adopt(key) }),
              };
            } catch {
              return { kind: 'unavailable' as const };
            }
          },
        }
      : {}),
    prepareIntent({ boundaryId, ownerId, capture, claim, now }) {
      let inTransaction = false;
      try {
        const binding = linked(capture, claim);
        db.exec('BEGIN IMMEDIATE');
        inTransaction = true;
        // Retention is bounded by refusing new admission, never by evicting
        // uncertain input. Attachment data URLs remain exact inside the DTO.
        const used = db
          .prepare(
            'SELECT COALESCE(SUM(byte_length),0) AS bytes FROM orchestration_prepared_turns',
          )
          .get() as { bytes: number };
        if (used.bytes + capture.byteLength > 256 * 1024 * 1024)
          throw new Error('Prepared turn retention capacity is full.');
        const result = execute(
          {
            type: 'turnBoundary.prepare',
            boundaryId,
            ownerId,
            ...binding,
            now,
          },
          true,
        );
        if (result.kind !== 'applied') {
          db.exec('ROLLBACK');
          inTransaction = false;
          return { kind: 'stale' };
        }
        db.prepare(`INSERT INTO orchestration_prepared_turns
          (invocation_id,boundary_id,thread_id,client_turn_id,input_digest,intent_digest,envelope_json,byte_length,prepared_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(
          capture.intent.invocationId,
          boundaryId,
          capture.threadId,
          capture.clientTurnId ?? null,
          capture.intent.inputDigest,
          capture.intent.intentDigest,
          capture.envelopeJson,
          capture.byteLength,
          now,
        );
        db.exec('COMMIT');
        inTransaction = false;
        return { kind: 'applied' };
      } catch {
        if (inTransaction && db.isTransaction !== false) {
          try {
            db.exec('ROLLBACK');
            return { kind: 'stale' };
          } catch {
            /* Keep an ambiguous commit fenced. */
          }
        }
        return { kind: 'unavailable' };
      }
    },
    beginPrepared({ boundaryId, ownerId, capture, claim, now, current }) {
      const nested = db.isTransaction === true;
      let begun: InvocationAcceptanceSnapshot | undefined;
      let outer = false;
      try {
        if (!db.isTransaction) {
          db.exec('BEGIN IMMEDIATE');
          outer = true;
        }
        const listed = execute({ type: 'turnBoundary.list' }, true);
        const row =
          listed.kind === 'records'
            ? listed.records.find((row) => row.boundaryId === boundaryId)
            : undefined;
        if (!row) throw new Error('Begin snapshot unavailable.');
        const key = row.intent?.dedupKey;
        const dedup =
          key === undefined
            ? undefined
            : execute({ type: 'turnDedup.read', key }, true);
        if (key !== undefined && dedup?.kind !== 'found')
          throw new Error('Begin dedup snapshot unavailable.');
        begun = {
          expected: { ...row, state: 'invoking', updatedAt: now },
          ...(dedup?.kind === 'found'
            ? { expectedDedup: { ...dedup.record, invocation: 'begun' } }
            : {}),
        };
        const result = withPreparedCurrent(current, () =>
          execute(
            {
              type: 'turnBoundary.beginInvocation',
              boundaryId,
              ownerId,
              ...linked(capture, claim),
              now,
            },
            true,
          ),
        );
        if (outer) db.exec('COMMIT');
        return {
          ...(result.kind === 'applied' ? result : { kind: 'stale' as const }),
          begun,
        };
      } catch (cause) {
        if (nested && db.isTransaction !== true) throw transactionLost(cause);
        if (outer && db.isTransaction) db.exec('ROLLBACK');
        return { kind: 'unavailable', ...(begun ? { begun } : {}) };
      }
    },
    acceptInvocation({ expected, expectedDedup, providerTurnId, now }) {
      const nested = db.isTransaction === true;
      try {
        const result = execute({
          type: 'turnBoundary.acceptInvocation',
          expected,
          ...(expectedDedup ? { expectedDedup } : {}),
          providerTurnId,
          now,
        });
        return result.kind === 'accepted' || result.kind === 'terminal'
          ? { kind: 'applied' }
          : result.kind === 'refused'
            ? { kind: 'unavailable' }
            : result;
      } catch (cause) {
        if (nested && db.isTransaction !== true) throw transactionLost(cause);
        return { kind: 'unavailable' };
      }
    },
    recordDefinitiveRefusal({
      boundaryId,
      boundary,
      preparedAt,
      capture,
      claim,
      settlementId,
      now,
    }) {
      const nested = db.isTransaction === true;
      try {
        const binding = linked(capture, claim);
        const custody = claim && readPreparedClaimCustody(claim);
        if (binding.intent.dedupKey !== undefined && !custody)
          return { kind: 'stale' };
        const result = execute({
          type: 'turnBoundary.recordDefinitiveRefusal',
          boundaryId,
          intent: binding.intent,
          boundary,
          ...(custody
            ? {
                dedup: {
                  owner: custody.owner,
                  createdAt: custody.createdAt,
                  updatedAt: preparedAt,
                },
              }
            : {}),
          settlementId,
          now,
        });
        return result.kind === 'applied' ? result : { kind: 'stale' };
      } catch (cause) {
        if (nested && db.isTransaction !== true) throw transactionLost(cause);
        return { kind: 'unavailable' };
      }
    },
    create(record) {
      const nested = db.isTransaction === true;
      try {
        const result = execute({
          type: 'turnBoundary.create',
          boundaryId: record.boundaryId,
          threadId: record.threadId,
          state: record.state,
          purpose: record.purpose ?? 'turn',
          owner: owner(record),
          now: record.createdAt,
        });
        return result.kind === 'refused' ? { kind: 'unavailable' } : result;
      } catch (cause) {
        if (nested && db.isTransaction !== true) throw transactionLost(cause);
        // A lost commit acknowledgement is success only when the original owner row exists.
        try {
          if (exact({ boundaryId: record.boundaryId, ownerId: record.ownerId }))
            return { kind: 'applied' };
          return db
            .prepare(
              'SELECT 1 FROM orchestration_turn_boundaries WHERE thread_id = ? LIMIT 1',
            )
            .get(record.threadId)
            ? { kind: 'busy' }
            : { kind: 'unavailable' };
        } catch {
          return { kind: 'unavailable' };
        }
      }
    },
    transition(input) {
      const nested = db.isTransaction === true;
      try {
        const result = execute({ ...input, type: 'turnBoundary.transition' });
        return result.kind === 'refused' ? { kind: 'unavailable' } : result;
      } catch (cause) {
        if (nested && db.isTransaction !== true) throw transactionLost(cause);
        try {
          if (
            input.to === 'accepted' &&
            input.providerTurnId &&
            exact({ ...input, state: 'indeterminate', updatedAt: input.now })
          )
            return { kind: 'ambiguous' };
          return exact({ ...input, state: input.to, updatedAt: input.now })
            ? { kind: 'applied' }
            : { kind: 'unavailable' };
        } catch {
          return { kind: 'unavailable' };
        }
      }
    },
    remove(input) {
      const nested = db.isTransaction === true;
      try {
        const result = execute({ ...input, type: 'turnBoundary.remove' });
        return result.kind === 'refused' ? { kind: 'unavailable' } : result;
      } catch (cause) {
        if (nested && db.isTransaction !== true) throw transactionLost(cause);
        try {
          return present(input.boundaryId)
            ? { kind: 'unavailable' }
            : { kind: 'applied' };
        } catch {
          return { kind: 'unavailable' };
        }
      }
    },
    removeTerminal(input) {
      // Empty provider ids never identified a terminal in the host protocol.
      if (
        !input.sessionTerminal &&
        !input.providerTurnId &&
        !input.invocationId
      )
        return { kind: 'applied' };
      const nested = db.isTransaction === true;
      try {
        const result = execute(
          {
            ...input,
            type: 'turnBoundary.observeTerminal',
          },
          db.isTransaction === true,
        );
        return result.kind === 'refused' ? { kind: 'unavailable' } : result;
      } catch (cause) {
        if (nested) {
          if (!db.isTransaction) throw transactionLost(cause);
          throw cause;
        }
        return { kind: 'unavailable' };
      }
    },
    recordAccepted(record) {
      const nested = db.isTransaction === true;
      try {
        const result = execute(
          {
            type: 'turnBoundary.recordAccepted',
            boundaryId: record.boundaryId,
            threadId: record.threadId,
            providerTurnId: record.providerTurnId,
            owner: owner(record),
            now: record.createdAt,
          },
          nested,
        );
        return result.kind === 'refused' ? { kind: 'unavailable' } : result;
      } catch (cause) {
        // SQLite may roll back the host transaction on SQLITE_FULL. Never let
        // the remaining event statements autocommit after its boundary vanished.
        if (nested) {
          if (!db.isTransaction) throw transactionLost(cause);
          return { kind: 'unavailable' };
        }
        try {
          return exact({ ...record, state: 'accepted' })
            ? { kind: 'applied' }
            : { kind: 'unavailable' };
        } catch {
          return { kind: 'unavailable' };
        }
      }
    },
    readInputlessTurnDisposition(threadId) {
      const outer = db.isTransaction !== true;
      if (outer) db.exec('BEGIN');
      try {
        const listed = execute({ type: 'turnBoundary.list' }, true);
        if (
          listed.kind !== 'records' ||
          listed.records.some(
            (row) => row.threadId === threadId && row.intent !== undefined,
          )
        )
          return { kind: 'unknown' };
        if (
          db
            .prepare(
              'SELECT 1 FROM orchestration_prepared_turns WHERE thread_id = ? LIMIT 1',
            )
            .get(threadId)
        )
          return { kind: 'unknown' };
        const effect = execute(
          { type: 'turnBoundary.hasPossibleEffect', threadId },
          true,
        );
        return effect.kind === 'available' && !effect.active
          ? { kind: 'inputless' }
          : { kind: 'unknown' };
      } finally {
        if (outer && db.isTransaction) db.exec('ROLLBACK');
      }
    },
    readInvocationTerminal(threadId, invocationId, providerTurnId) {
      const outer = db.isTransaction !== true;
      if (outer) db.exec('BEGIN');
      try {
        const listed = execute({ type: 'turnBoundary.list' }, true);
        if (listed.kind !== 'records') return { kind: 'unknown' };
        const targets = listed.records.filter(
          (row) =>
            row.threadId === threadId &&
            row.intent?.invocationId === invocationId,
        );
        if (targets.length > 1) return { kind: 'unknown' };
        const audit = retirementRow
          .optional()
          .parse(
            db
              .prepare(
                'SELECT * FROM orchestration_prepared_turns WHERE thread_id = ? AND invocation_id = ?',
              )
              .get(threadId, invocationId),
          );
        const witness = audit
          ? invocationTerminals.readRetirement(db, threadId, audit.boundary_id)
          : undefined;
        const target = targets[0] ?? witness?.boundary;
        if (
          !target ||
          (target.providerTurnId !== undefined &&
            providerTurnId !== undefined &&
            target.providerTurnId !== providerTurnId)
        )
          return { kind: 'unknown' };
        const read = invocationTerminals.find(db, {
          threadId,
          invocationId,
          ...(target.providerTurnId === undefined
            ? {}
            : { providerTurnId: target.providerTurnId }),
          allowMissingProviderTurnId: target.providerTurnId === undefined,
        });
        if (read.kind !== 'found') return read;
        if (
          providerTurnId !== undefined &&
          read.fact.providerTurnId !== undefined &&
          read.fact.providerTurnId !== providerTurnId
        )
          return { kind: 'unknown' };
        const decision = decideTurnBoundaryObserveTerminal(
          [target],
          {
            type: 'turnBoundary.observeTerminal',
            threadId,
            invocationId,
            sessionTerminal: false,
            terminalEventId: read.fact.terminalEventId,
            terminalCreatedAt: read.fact.terminalCreatedAt,
            ...(read.fact.providerTurnId === undefined
              ? {}
              : { providerTurnId: read.fact.providerTurnId }),
          },
          undefined,
          [{ boundaryId: target.boundaryId, read }],
        );
        return decision.retire.includes(target.boundaryId)
          ? read
          : { kind: 'unknown' };
      } finally {
        if (outer && db.isTransaction) db.exec('ROLLBACK');
      }
    },
    hasPossibleEffect(threadId) {
      const result = execute({
        type: 'turnBoundary.hasPossibleEffect',
        threadId,
      });
      if (result.kind === 'refused') throw new Error(result.reason);
      return result.active;
    },
    active() {
      const result = execute({ type: 'turnBoundary.list' });
      if (result.kind === 'refused') throw new Error(result.reason);
      return result.records.map((record) => ({
        boundaryId: record.boundaryId,
        threadId: record.threadId,
        state: record.state,
        ...(record.purpose === 'task-dispatch'
          ? { purpose: 'task-dispatch' as const }
          : {}),
        ...(record.providerTurnId
          ? { providerTurnId: record.providerTurnId }
          : {}),
        ownerId: record.owner.id,
        ownerPid: record.owner.pid,
        ownerIdentityKind: record.owner.identityKind,
        ...(record.owner.identityKind === 'exact'
          ? { ownerBirth: record.owner.birth }
          : {}),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        ...(record.intent ? { intent: record.intent } : {}),
      }));
    },
  };
}

const terminalPayload = z
  .object({
    eventId: z.string().min(1),
    threadId: z.string().min(1),
    method: z.string().min(1),
    createdAt: z.string().min(1),
    invocationId: z.string().min(1).optional(),
    turnId: z.string().optional(),
    provider: z.string().min(1),
    recoveryTerminal: z.boolean().optional(),
    retriable: z.boolean().optional(),
    code: z.string().optional(),
  })
  .passthrough();

function decodeTerminal(raw: unknown): InvocationTerminalFact | undefined {
  const row = canonicalTerminalRow.parse(raw);
  const event = terminalPayload.parse(JSON.parse(row.payload));
  if (
    event.eventId !== row.id ||
    event.provider !== row.provider ||
    event.threadId !== row.thread_id ||
    event.method !== row.method ||
    event.createdAt !== row.created_at ||
    (event.turnId ?? null) !== row.turn_id
  )
    throw new Error('Canonical terminal columns differ from their payload.');
  if (event.invocationId === undefined) return undefined;
  return {
    threadId: event.threadId,
    invocationId: event.invocationId,
    terminalEventId: event.eventId,
    terminalCreatedAt: event.createdAt,
    ...(event.turnId === undefined ? {} : { providerTurnId: event.turnId }),
    retire:
      ['turn.completed', 'turn.aborted', 'runtime.error'].includes(
        event.method,
      ) &&
      !(event.method === 'turn.aborted' && event.recoveryTerminal === true) &&
      !(
        event.method === 'runtime.error' &&
        (event.code === SESSION_START_INDETERMINATE_CODE ||
          (event.provider === 'codex' && event.retriable === true))
      ),
  };
}
function assertIntentAssociation(
  row: z.infer<typeof retirementRow>,
  witness: InvocationTerminalRetirement,
): void {
  const intent = witness.boundary.intent;
  if (
    !intent ||
    row.invocation_id !== intent.invocationId ||
    row.boundary_id !== witness.boundary.boundaryId ||
    row.thread_id !== witness.boundary.threadId ||
    row.input_digest !== intent.inputDigest ||
    row.intent_digest !== intent.intentDigest ||
    intent.bodyRef !== intent.intentDigest
  )
    throw new Error('Invocation retirement input association changed.');
  const capture = decodeTurnIntent({
    envelopeJson: String(row.envelope_json),
    inputDigest: String(row.input_digest),
    intentDigest: String(row.intent_digest),
    invocationId: intent.invocationId,
    threadId: witness.boundary.threadId,
  });
  if (
    (row.client_turn_id ?? undefined) !== capture.clientTurnId ||
    row.byte_length !== capture.byteLength ||
    intent.dedupKey !==
      (capture.clientTurnId === undefined
        ? undefined
        : turnDedupKey(capture.threadId, capture.clientTurnId))
  )
    throw new Error('Invocation retirement input custody changed.');
}

const canonicalTerminalRow = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  thread_id: z.string().min(1),
  turn_id: z.string().nullable(),
  method: z.string().min(1),
  created_at: z.string().min(1),
  payload: z.string(),
});
const retirementRow = z.object({
  invocation_id: z.string().min(1),
  boundary_id: z.string().min(1),
  thread_id: z.string().min(1),
  client_turn_id: z.string().nullable(),
  input_digest: z.string().min(1),
  intent_digest: z.string().min(1),
  envelope_json: z.string(),
  byte_length: z.number().int().nonnegative(),
  terminal_retirement: z.string().nullable(),
});
