import type { OrchestrationCommandReceipt } from '@kontourai/station-contracts/orchestration';
import type { ProviderSession } from '@kontourai/station-contracts/provider';
import {
  AdoptionCommitFailure,
  type AdoptionLedgerCoordinator,
  type AdoptionReservation,
} from './adoption-ledger.js';
import type { SqliteDatabase } from './sqlite-database.js';

/**
 * `commitOwnedAdoption` writes the child session and its command receipt
 * inside its own `BEGIN IMMEDIATE`, so both cross-group writes are injected
 * rather than reimplemented: they must run on the same connection, in that
 * transaction. `EventStore.upsertSession` opens a `SAVEPOINT`, which nests
 * legally inside it — that nesting is what makes one atomic commit possible.
 */
export function createSqliteAdoptionCoordinator({
  db,
  upsertSession,
  appendCommandReceipt,
}: {
  db: SqliteDatabase;
  upsertSession: (child: ProviderSession) => void;
  appendCommandReceipt: (receipt: OrchestrationCommandReceipt) => void;
}): AdoptionLedgerCoordinator {
  function reserveAdoptionRecord(reservation: AdoptionReservation): boolean {
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO provider_session_adoptions
          (source_thread_id, target_thread_id, owner_id, owner_pid, owner_token, provider, source_session_id, source_kind, cwd, project_root, status, provider_resume_cursor, provider_cleanup_complete, flow_run_id, flow_run_resumed, flow_cleanup_complete, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reservation.sourceThreadId,
        reservation.targetThreadId,
        reservation.ownerId,
        reservation.ownerPid,
        reservation.ownerToken,
        reservation.provider,
        reservation.sourceSessionId,
        reservation.sourceKind,
        reservation.cwd,
        reservation.projectRoot,
        reservation.status,
        reservation.providerResumeCursor === undefined
          ? null
          : JSON.stringify(reservation.providerResumeCursor),
        reservation.providerCleanupComplete ? 1 : 0,
        reservation.flowRunId ?? null,
        reservation.flowRunResumed === undefined
          ? null
          : reservation.flowRunResumed
            ? 1
            : 0,
        reservation.flowCleanupComplete ? 1 : 0,
        reservation.createdAt,
        reservation.updatedAt,
      ) as { changes: number };
    return result.changes === 1;
  }

  function replaceAdoptionOwner(input: {
    expected: {
      sourceThreadId: string;
      ownerId: string;
      ownerPid: number;
      ownerToken: string;
    };
    next: {
      sourceThreadId: string;
      ownerId: string;
      ownerPid: number;
      ownerToken: string;
    };
  }): AdoptionReservation | undefined {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = db
        .prepare(
          `UPDATE provider_session_adoptions
           SET owner_id = ?, owner_pid = ?, owner_token = ?, updated_at = ?
           WHERE source_thread_id = ? AND owner_id = ? AND owner_pid = ? AND owner_token = ?`,
        )
        .run(
          input.next.ownerId,
          input.next.ownerPid,
          input.next.ownerToken,
          new Date().toISOString(),
          input.expected.sourceThreadId,
          input.expected.ownerId,
          input.expected.ownerPid,
          input.expected.ownerToken,
        ) as { changes: number };
      if (result.changes !== 1) {
        db.exec('COMMIT');
        return undefined;
      }
      const claimed = readAdoptionReservationRecord(
        input.next.sourceThreadId,
        input.next.ownerId,
        input.next.ownerPid,
        input.next.ownerToken,
      );
      db.exec('COMMIT');
      return claimed;
    } catch (error) {
      rollbackAdoptionTransaction();
      throw error;
    }
  }

  function updateOwnedAdoption(input: {
    claim: {
      sourceThreadId: string;
      ownerId: string;
      ownerPid: number;
      ownerToken: string;
    };
    next: AdoptionReservation;
  }): AdoptionReservation | undefined {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = db
        .prepare(
          `UPDATE provider_session_adoptions
           SET status = ?, provider_resume_cursor = ?, provider_cleanup_complete = ?,
               flow_run_id = ?, flow_run_resumed = ?, flow_cleanup_complete = ?, updated_at = ?
           WHERE source_thread_id = ? AND owner_id = ? AND owner_pid = ? AND owner_token = ?`,
        )
        .run(
          input.next.status,
          input.next.providerResumeCursor === undefined
            ? null
            : JSON.stringify(input.next.providerResumeCursor),
          input.next.providerCleanupComplete ? 1 : 0,
          input.next.flowRunId ?? null,
          input.next.flowRunResumed === undefined
            ? null
            : input.next.flowRunResumed
              ? 1
              : 0,
          input.next.flowCleanupComplete ? 1 : 0,
          new Date().toISOString(),
          input.claim.sourceThreadId,
          input.claim.ownerId,
          input.claim.ownerPid,
          input.claim.ownerToken,
        ) as { changes: number };
      if (result.changes !== 1) {
        db.exec('COMMIT');
        return undefined;
      }
      const updated = readAdoptionReservationRecord(
        input.claim.sourceThreadId,
        input.claim.ownerId,
        input.claim.ownerPid,
        input.claim.ownerToken,
      );
      db.exec('COMMIT');
      return updated;
    } catch (error) {
      rollbackAdoptionTransaction();
      throw error;
    }
  }

  function rollbackAdoptionTransaction(): void {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the durable/read failure that triggered cleanup.
    }
  }

  function readAdoptionReservationRecords(): AdoptionReservation[] {
    return db
      .prepare(
        `SELECT source_thread_id, target_thread_id, owner_id, owner_pid, owner_token, provider, source_session_id,
                source_kind, cwd, project_root, status, provider_resume_cursor,
                provider_cleanup_complete, flow_run_id, flow_run_resumed,
                flow_cleanup_complete, created_at, updated_at
         FROM provider_session_adoptions
         ORDER BY created_at ASC`,
      )
      .all()
      .map(mapAdoptionReservationRow);
  }

  function readAdoptionReservationRecord(
    sourceThreadId: string,
    ownerId: string,
    ownerPid: number,
    ownerToken: string,
  ): AdoptionReservation | undefined {
    const row = db
      .prepare(
        `SELECT source_thread_id, target_thread_id, owner_id, owner_pid, owner_token, provider, source_session_id,
                source_kind, cwd, project_root, status, provider_resume_cursor,
                provider_cleanup_complete, flow_run_id, flow_run_resumed,
                flow_cleanup_complete, created_at, updated_at
         FROM provider_session_adoptions
         WHERE source_thread_id = ? AND owner_id = ? AND owner_pid = ? AND owner_token = ?`,
      )
      .get(sourceThreadId, ownerId, ownerPid, ownerToken);
    return row ? mapAdoptionReservationRow(row as any) : undefined;
  }

  function adoptionReservesProviderCursor(
    provider: ProviderSession['provider'],
    providerResumeCursor: unknown,
  ): boolean {
    if (providerResumeCursor === undefined) return false;
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM provider_session_adoptions
           WHERE provider = ? AND provider_resume_cursor = ?
           LIMIT 1`,
        )
        .get(provider, JSON.stringify(providerResumeCursor)),
    );
  }

  function commitOwnedAdoption(input: {
    claim: {
      sourceThreadId: string;
      ownerId: string;
      ownerPid: number;
      ownerToken: string;
    };
    child: ProviderSession;
    receipt?: OrchestrationCommandReceipt;
  }): boolean {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (
        !readAdoptionReservationRecord(
          input.claim.sourceThreadId,
          input.claim.ownerId,
          input.claim.ownerPid,
          input.claim.ownerToken,
        )
      ) {
        db.exec('COMMIT');
        return false;
      }
      upsertSession(input.child);
      if (input.receipt) appendCommandReceipt(input.receipt);
      const deleted = db
        .prepare(
          `DELETE FROM provider_session_adoptions
           WHERE source_thread_id = ? AND owner_id = ? AND owner_pid = ? AND owner_token = ?`,
        )
        .run(
          input.claim.sourceThreadId,
          input.claim.ownerId,
          input.claim.ownerPid,
          input.claim.ownerToken,
        ) as {
        changes: number;
      };
      if (deleted.changes !== 1) {
        throw new Error('Adoption ownership changed inside its transaction.');
      }
      db.exec('COMMIT');
      return true;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        throw new AdoptionCommitFailure('unknown', error);
      }
      throw new AdoptionCommitFailure('rolled-back', error);
    }
  }

  function completeOwnedAdoptionCleanup(input: {
    claim: {
      sourceThreadId: string;
      ownerId: string;
      ownerPid: number;
      ownerToken: string;
    };
  }): boolean {
    const deleted = db
      .prepare(
        `DELETE FROM provider_session_adoptions
         WHERE source_thread_id = ? AND owner_id = ? AND owner_pid = ? AND owner_token = ?
           AND flow_cleanup_complete = 1 AND provider_cleanup_complete = 1`,
      )
      .run(
        input.claim.sourceThreadId,
        input.claim.ownerId,
        input.claim.ownerPid,
        input.claim.ownerToken,
      ) as {
      changes: number;
    };
    return deleted.changes === 1;
  }

  return {
    reserve: (reservation) => reserveAdoptionRecord(reservation),
    replaceOwner: (input) => replaceAdoptionOwner(input),
    updateOwned: (input) => updateOwnedAdoption(input),
    commitOwned: (input) => commitOwnedAdoption(input),
    completeCleanupOwned: (input) => completeOwnedAdoptionCleanup(input),
    reservations: () => readAdoptionReservationRecords(),
    reservesProviderCursor: (provider, providerResumeCursor) =>
      adoptionReservesProviderCursor(provider, providerResumeCursor),
  };
}

function mapAdoptionReservationRow(row: any): AdoptionReservation {
  return {
    sourceThreadId: row.source_thread_id,
    targetThreadId: row.target_thread_id,
    ownerId: row.owner_id,
    ownerPid: row.owner_pid,
    ownerToken: row.owner_token,
    provider: row.provider,
    sourceSessionId: row.source_session_id,
    sourceKind: row.source_kind,
    cwd: row.cwd,
    projectRoot: row.project_root,
    status: row.status,
    ...(row.provider_resume_cursor
      ? { providerResumeCursor: JSON.parse(row.provider_resume_cursor) }
      : {}),
    providerCleanupComplete: row.provider_cleanup_complete === 1,
    ...(row.flow_run_id ? { flowRunId: row.flow_run_id } : {}),
    ...(row.flow_run_resumed === null
      ? {}
      : { flowRunResumed: row.flow_run_resumed === 1 }),
    flowCleanupComplete: row.flow_cleanup_complete === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
