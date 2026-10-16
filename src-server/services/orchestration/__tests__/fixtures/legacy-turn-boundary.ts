// Frozen from EventStore.composeSessionTurnBoundaries at d57abb035ac3ad638cdf5615f4edbca051ac6e99.
// Keep this pre-migration SQL independent of Monument for differential evidence.
import { isProjectTaskRoomExecutionSealed } from '../../project-task-room-source-seal.js';
import {
  SESSION_TURN_ACCEPTED_CAPACITY,
  type SessionTurnBoundaryCoordinator,
  type SessionTurnBoundaryRecord,
} from '../../session-turn-boundary.js';
import type { SqliteDatabase } from '../../sqlite-database.js';

class EventAppendTransactionLostError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('The legacy append transaction was lost', options);
  }
}
export function legacyTurnBoundaryCoordinator(
  db: SqliteDatabase & { readonly isTransaction?: boolean },
  reconcileTerminals: (threadId: string) => void,
): SessionTurnBoundaryCoordinator {
  const head = () =>
    Number(
      (
        db
          .prepare(
            'SELECT high_water FROM orchestration_stream_identity WHERE singleton = 1',
          )
          .get() as { high_water: number }
      ).high_water,
    );
  const reserveWriter = () =>
    db
      .prepare(
        'UPDATE orchestration_stream_identity SET high_water = high_water WHERE singleton = 1',
      )
      .run();
  const insertAcceptedRow = (
    record: SessionTurnBoundaryRecord & { providerTurnId: string },
  ) =>
    db
      .prepare(
        `INSERT INTO orchestration_turn_boundaries
            (boundary_id, thread_id, state, provider_turn_id, owner_id,
             owner_pid, owner_birth, owner_identity_kind, created_at, updated_at, purpose, created_sequence)
           VALUES (?, ?, 'accepted', ?, ?, ?, ?, ?, ?, ?, 'turn', ?)`,
      )
      .run(
        record.boundaryId,
        record.threadId,
        record.providerTurnId,
        record.ownerId,
        record.ownerPid,
        record.ownerBirth ?? null,
        record.ownerIdentityKind,
        record.createdAt,
        record.updatedAt,
        head(),
      );
  const exact = (input: {
    boundaryId: string;
    ownerId: string;
    state: string;
    updatedAt?: string;
    providerTurnId?: string;
  }) => {
    const row = db
      .prepare(
        `SELECT state, updated_at, provider_turn_id
             FROM orchestration_turn_boundaries
            WHERE boundary_id = ? AND owner_id = ?`,
      )
      .get(input.boundaryId, input.ownerId) as
      | {
          state: string;
          updated_at: string;
          provider_turn_id: string | null;
        }
      | undefined;
    return (
      row?.state === input.state &&
      (input.updatedAt === undefined || row.updated_at === input.updatedAt) &&
      (input.providerTurnId === undefined ||
        row.provider_turn_id === input.providerTurnId)
    );
  };
  const coordinator: SessionTurnBoundaryCoordinator = {
    create: (record) => {
      try {
        db.exec('BEGIN IMMEDIATE');
        if (
          record.state !== 'lifecycle' &&
          isProjectTaskRoomExecutionSealed(db, record.threadId)
        ) {
          db.exec('ROLLBACK');
          return { kind: 'unavailable' };
        }

        const occupied = db
          .prepare(
            record.state === 'lifecycle'
              ? `SELECT 1 AS occupied FROM orchestration_turn_boundaries
                    WHERE thread_id = ? LIMIT 1`
              : `SELECT 1 AS occupied FROM orchestration_turn_boundaries
                    WHERE thread_id = ?
                      AND (
                        state IN ('lifecycle', 'prepared', 'invoking', 'indeterminate')
                        OR (
                          state = 'accepted'
                          AND (SELECT COUNT(*) FROM orchestration_turn_boundaries
                                WHERE thread_id = ?) >= ?
                        )
                      )
                    LIMIT 1`,
          )
          .get(
            record.threadId,
            ...(record.state === 'lifecycle'
              ? []
              : [record.threadId, SESSION_TURN_ACCEPTED_CAPACITY]),
          ) as { occupied: number } | undefined;
        if (occupied) {
          db.exec('ROLLBACK');
          return { kind: 'busy' };
        }
        db.prepare(
          `INSERT INTO orchestration_turn_boundaries
                (boundary_id, thread_id, state, provider_turn_id, owner_id,
                 owner_pid, owner_birth, owner_identity_kind, created_at, updated_at, purpose, created_sequence)
               VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          record.boundaryId,
          record.threadId,
          record.state,
          record.ownerId,
          record.ownerPid,
          record.ownerBirth ?? null,
          record.ownerIdentityKind,
          record.createdAt,
          record.updatedAt,
          record.purpose ?? 'turn',
          head(),
        );
        db.exec('COMMIT');
        return { kind: 'applied' };
      } catch {
        try {
          db.exec('ROLLBACK');
        } catch {
          // The transaction may already have committed.
        }
        try {
          const exactBoundary = db
            .prepare(
              `SELECT 1 AS occupied FROM orchestration_turn_boundaries
                  WHERE boundary_id = ? AND owner_id = ?`,
            )
            .get(record.boundaryId, record.ownerId) as
            | { occupied: number }
            | undefined;
          if (exactBoundary) return { kind: 'applied' };
          const occupied = db
            .prepare(
              'SELECT 1 AS occupied FROM orchestration_turn_boundaries WHERE thread_id = ? LIMIT 1',
            )
            .get(record.threadId) as { occupied: number } | undefined;
          return occupied ? { kind: 'busy' } : { kind: 'unavailable' };
        } catch {
          return { kind: 'unavailable' };
        }
      }
    },
    transition: (input) => {
      const apply = (targetState = input.to) => {
        const placeholders = input.from.map(() => '?').join(', ');
        db.prepare(
          `UPDATE orchestration_turn_boundaries
                  SET state = ?, updated_at = ?, provider_turn_id = COALESCE(?, provider_turn_id)
                WHERE boundary_id = ? AND owner_id = ? AND state IN (${placeholders})`,
        ).run(
          targetState,
          input.now,
          input.providerTurnId ?? null,
          input.boundaryId,
          input.ownerId,
          ...input.from,
        );
      };
      let targetState = input.to;
      let ambiguousAcceptance = false;
      try {
        if (input.to === 'accepted' && input.providerTurnId) {
          db.exec('BEGIN IMMEDIATE');
          const priorOrConcurrentGeneration = db
            .prepare(
              `SELECT 1 AS observed
                   FROM orchestration_turn_boundaries AS boundary
                  WHERE boundary.boundary_id = ?
                    AND (
                      EXISTS (
                        SELECT 1 FROM orchestration_events AS event
                         WHERE event.thread_id = boundary.thread_id
                           AND event.turn_id = ?
                           AND event.method IN ('turn.completed', 'turn.aborted', 'runtime.error')
                      )
                      OR EXISTS (
                        SELECT 1 FROM orchestration_turn_boundaries AS accepted
                         WHERE accepted.thread_id = boundary.thread_id
                           AND accepted.state = 'accepted'
                           AND accepted.provider_turn_id = ?
                           AND accepted.boundary_id != boundary.boundary_id
                      )
                    )
                  LIMIT 1`,
            )
            .get(
              input.boundaryId,
              input.providerTurnId,
              input.providerTurnId,
            ) as { observed: number } | undefined;
          if (priorOrConcurrentGeneration) {
            targetState = 'indeterminate';
            ambiguousAcceptance = true;
          }
        }
        apply(targetState);
        if (input.to === 'accepted' && input.providerTurnId) {
          db.exec('COMMIT');
        }
        return exact({
          boundaryId: input.boundaryId,
          ownerId: input.ownerId,
          state: targetState,
          updatedAt: input.now,
          ...(input.providerTurnId
            ? { providerTurnId: input.providerTurnId }
            : {}),
        })
          ? { kind: ambiguousAcceptance ? 'ambiguous' : 'applied' }
          : { kind: 'stale' };
      } catch {
        if (input.to === 'accepted' && input.providerTurnId) {
          try {
            db.exec('ROLLBACK');
          } catch {
            // The transaction may already have committed.
          }
        }
        try {
          if (
            input.to === 'accepted' &&
            input.providerTurnId &&
            exact({
              boundaryId: input.boundaryId,
              ownerId: input.ownerId,
              state: 'indeterminate',
              updatedAt: input.now,
              providerTurnId: input.providerTurnId,
            })
          ) {
            return { kind: 'ambiguous' };
          }
          return exact({
            boundaryId: input.boundaryId,
            ownerId: input.ownerId,
            state: input.to,
            updatedAt: input.now,
            ...(input.providerTurnId
              ? { providerTurnId: input.providerTurnId }
              : {}),
          })
            ? { kind: 'applied' }
            : { kind: 'unavailable' };
        } catch {
          return { kind: 'unavailable' };
        }
      }
    },
    remove: (input) => {
      try {
        const placeholders = input.from.map(() => '?').join(', ');
        db.prepare(
          `DELETE FROM orchestration_turn_boundaries
                WHERE boundary_id = ? AND owner_id = ? AND state IN (${placeholders})`,
        ).run(input.boundaryId, input.ownerId, ...input.from);
        const remains = db
          .prepare(
            'SELECT 1 AS present FROM orchestration_turn_boundaries WHERE boundary_id = ?',
          )
          .get(input.boundaryId) as { present: number } | undefined;
        return remains ? { kind: 'stale' } : { kind: 'applied' };
      } catch {
        try {
          const remains = db
            .prepare(
              'SELECT 1 AS present FROM orchestration_turn_boundaries WHERE boundary_id = ?',
            )
            .get(input.boundaryId) as { present: number } | undefined;
          return remains ? { kind: 'unavailable' } : { kind: 'applied' };
        } catch {
          return { kind: 'unavailable' };
        }
      }
    },
    removeTerminal: (input) => {
      try {
        if (input.sessionTerminal) {
          // NULL fences retain timestamp ordering.
          // A missing terminal makes the subquery NULL and keeps fenced boundaries.
          db.prepare(
            `DELETE FROM orchestration_turn_boundaries
                  WHERE thread_id = ? AND state != 'lifecycle' AND purpose != 'task-dispatch'
                    AND (
                      (created_sequence IS NULL AND created_at <= ?)
                      OR created_sequence < (
                        SELECT global_sequence FROM orchestration_events WHERE id = ?
                          AND thread_id = orchestration_turn_boundaries.thread_id
                      )
                    )`,
          ).run(
            input.threadId,
            input.terminalCreatedAt,
            input.terminalEventId ?? null,
          );
        } else if (input.providerTurnId) {
          db.prepare(
            `DELETE FROM orchestration_turn_boundaries
                  WHERE thread_id = ? AND state = 'accepted' AND purpose != 'task-dispatch'
                    AND provider_turn_id = ? AND created_at <= ?`,
          ).run(input.threadId, input.providerTurnId, input.terminalCreatedAt);
        }
        return { kind: 'applied' };
      } catch {
        return { kind: 'unavailable' };
      }
    },
    recordAccepted: (record) => {
      // #3561: a provider-started turn's row is recorded inside its
      // `turn.started` append, as a co-commit participant, so it commits
      // or rolls back with that event. Inside a transaction it takes a
      // nested savepoint: a BEGIN would throw there, and a ROLLBACK would
      // discard the caller's whole transaction, event included.
      if (db.isTransaction) {
        db.exec('SAVEPOINT record_accepted_turn_boundary');
        try {
          reserveWriter();
          const { rows } = db
            .prepare(
              `SELECT COUNT(*) AS rows FROM orchestration_turn_boundaries
                  WHERE thread_id = ?`,
            )
            .get(record.threadId) as { rows: number };
          if (rows < SESSION_TURN_ACCEPTED_CAPACITY) insertAcceptedRow(record);
          db.exec(
            rows < SESSION_TURN_ACCEPTED_CAPACITY
              ? 'RELEASE SAVEPOINT record_accepted_turn_boundary'
              : 'ROLLBACK TO SAVEPOINT record_accepted_turn_boundary; RELEASE SAVEPOINT record_accepted_turn_boundary',
          );
          return rows < SESSION_TURN_ACCEPTED_CAPACITY
            ? { kind: 'applied' }
            : { kind: 'busy' };
        } catch (error) {
          // SQLite answered with a rollback of the caller's whole
          // transaction: the event cannot commit either, so this is the
          // caller's failure, not a lost row (#3561 review F1).
          if (!db.isTransaction)
            throw new EventAppendTransactionLostError({ cause: error });
          // Otherwise the row is lost and the caller's event still
          // commits: a missing crash banner is better than a lost turn.
          db.exec(
            'ROLLBACK TO SAVEPOINT record_accepted_turn_boundary; RELEASE SAVEPOINT record_accepted_turn_boundary',
          );
          return { kind: 'unavailable' };
        }
      }
      try {
        db.exec('BEGIN IMMEDIATE');
        const { rows } = db
          .prepare(
            `SELECT COUNT(*) AS rows FROM orchestration_turn_boundaries
                WHERE thread_id = ?`,
          )
          .get(record.threadId) as { rows: number };
        if (rows >= SESSION_TURN_ACCEPTED_CAPACITY) {
          db.exec('ROLLBACK');
          return { kind: 'busy' };
        }
        insertAcceptedRow(record);
        db.exec('COMMIT');
        return { kind: 'applied' };
      } catch {
        try {
          db.exec('ROLLBACK');
        } catch {
          // The transaction may already have committed.
        }
        return exact({
          boundaryId: record.boundaryId,
          ownerId: record.ownerId,
          state: 'accepted',
        })
          ? { kind: 'applied' }
          : { kind: 'unavailable' };
      }
    },
    hasPossibleEffect: (threadId) => {
      reconcileTerminals(threadId);
      return Boolean(
        db
          .prepare(
            `SELECT 1 AS active FROM orchestration_turn_boundaries
                WHERE thread_id = ? AND state != 'lifecycle'`,
          )
          .get(threadId),
      );
    },
    active: () =>
      (
        db
          .prepare(
            `SELECT boundary_id, thread_id, state, provider_turn_id, owner_id,
                      owner_pid, owner_birth, owner_identity_kind, created_at, updated_at, purpose
                 FROM orchestration_turn_boundaries`,
          )
          .all() as Array<Record<string, unknown>>
      ).map(
        (row): SessionTurnBoundaryRecord => ({
          boundaryId: row.boundary_id as string,
          ...(row.purpose === 'task-dispatch'
            ? { purpose: 'task-dispatch' as const }
            : {}),
          threadId: row.thread_id as string,
          state: row.state as SessionTurnBoundaryRecord['state'],
          ...(row.provider_turn_id
            ? { providerTurnId: row.provider_turn_id as string }
            : {}),
          ownerId: row.owner_id as string,
          ownerPid: row.owner_pid as number,
          ...(row.owner_birth ? { ownerBirth: row.owner_birth as string } : {}),
          ownerIdentityKind: row.owner_identity_kind as string,
          createdAt: row.created_at as string,
          updatedAt: row.updated_at as string,
        }),
      ),
  };
  return coordinator;
}
