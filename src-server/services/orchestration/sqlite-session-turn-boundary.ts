import type {
  KernelCommand,
  KernelResult,
  OwnerIdentity,
} from '@kontourai/monument';
import { openSqliteKernelStorage } from '@kontourai/monument/sqlite';
import { isProjectTaskRoomExecutionSealed } from './project-task-room-source-seal.js';
import {
  SESSION_TURN_ACCEPTED_CAPACITY,
  type SessionTurnBoundaryCoordinator,
  type SessionTurnBoundaryRecord,
} from './session-turn-boundary.js';
import type { SqliteDatabase } from './sqlite-database.js';

/** Station's host tables and admission policy; Monument owns the boundary writes. */
export function createSqliteSessionTurnBoundaryCoordinator({
  db,
  head,
  reconcileTerminals,
  retiredBoundaryIds,
  transactionLost,
}: {
  db: SqliteDatabase & { readonly isTransaction?: boolean };
  head(): number;
  reconcileTerminals(threadId: string): void;
  retiredBoundaryIds(threadId: string): readonly string[];
  transactionLost(cause: unknown): Error;
}): SessionTurnBoundaryCoordinator {
  const kernel = openSqliteKernelStorage({
    database: db,
    tables: {
      turnDedup: 'unused',
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
      },
    },
    participants: [
      {
        name: 'station-boundary-admission',
        admit(command) {
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
  return {
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
      }));
    },
  };
}
