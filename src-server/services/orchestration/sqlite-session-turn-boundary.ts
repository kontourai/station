import type {
  KernelCommand,
  KernelResult,
  OwnerIdentity,
  OwnerLiveness,
} from '@kontourai/monument';
import { openSqliteKernelStorage } from '@kontourai/monument/sqlite';
import { readPreparedClaimCustody } from '../turn-idempotency.js';
import type { CapturedTurnIntent } from './prepared-turn-intent.js';
import { isProjectTaskRoomExecutionSealed } from './project-task-room-source-seal.js';
import {
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
            command.type === 'turnBoundary.create' ||
            command.type === 'turnBoundary.recordAccepted'
          )
            reconcileTerminals(command.threadId);
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
    return kernel.executeSync(command, context, {
      withinHostTransaction: nested,
    });
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
      try {
        const result = withPreparedCurrent(current, () =>
          execute({
            type: 'turnBoundary.beginInvocation',
            boundaryId,
            ownerId,
            ...linked(capture, claim),
            now,
          }),
        );
        return result.kind === 'applied' ? result : { kind: 'stale' };
      } catch {
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
      } catch {
        return { kind: 'unavailable' };
      }
    },
    create(record) {
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
      } catch {
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
      try {
        const result = execute({ ...input, type: 'turnBoundary.transition' });
        return result.kind === 'refused' ? { kind: 'unavailable' } : result;
      } catch {
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
      try {
        const result = execute({ ...input, type: 'turnBoundary.remove' });
        return result.kind === 'refused' ? { kind: 'unavailable' } : result;
      } catch {
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
      if (!input.sessionTerminal && !input.providerTurnId)
        return { kind: 'applied' };
      try {
        const result = execute({
          ...input,
          type: 'turnBoundary.observeTerminal',
        });
        return result.kind === 'refused' ? { kind: 'unavailable' } : result;
      } catch {
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
