import { createHash } from 'node:crypto';
import type {
  CommittedRevision,
  RevisionEvidencePersistence,
  RevisionEvidencePersistenceBounds,
} from '../../domain/revision-bound-evidence.js';
import { MAX_REVISION_EVIDENCE_IDENTIFIER_BYTES } from '../../domain/revision-bound-evidence.js';

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...values: unknown[]): unknown;
    get(...values: unknown[]): unknown;
    all(...values: unknown[]): unknown[];
  };
}

const RESTORE_PAGE_SIZE = 32;
const PORTABLE_PREFIX_BYTES = Buffer.byteLength(
  '{"schemaVersion":1,"revisions":[',
  'utf8',
);
const PORTABLE_SUFFIX_BYTES = Buffer.byteLength(']}', 'utf8');
const REVISION_ID_BYTES =
  Buffer.byteLength('revision-evidence-v1:', 'utf8') + 64;
const DIGEST_BYTES = 64;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function portableBytes(recordBytes: number, count: number): number {
  return (
    PORTABLE_PREFIX_BYTES +
    recordBytes +
    Math.max(0, count - 1) +
    PORTABLE_SUFFIX_BYTES
  );
}

function storedRecord(
  row: Record<string, unknown>,
  maxRecordBytes: number,
): unknown | undefined {
  if (
    typeof row.record_json !== 'string' ||
    typeof row.record_bytes !== 'number' ||
    !Number.isSafeInteger(row.record_bytes) ||
    row.record_bytes < 1 ||
    row.record_bytes > maxRecordBytes ||
    typeof row.record_digest !== 'string' ||
    Buffer.byteLength(row.record_json, 'utf8') !== row.record_bytes ||
    digest(row.record_json) !== row.record_digest
  )
    return undefined;
  try {
    const record = JSON.parse(row.record_json) as Record<string, unknown>;
    const recordScope = record.scope as Record<string, unknown> | undefined;
    const snapshot = record.snapshot as Record<string, unknown> | undefined;
    const snapshotScope = snapshot?.scope as
      | Record<string, unknown>
      | undefined;
    return record.revisionId === row.revision_id &&
      recordScope?.projectId === row.project_id &&
      recordScope?.taskId === row.task_id &&
      recordScope?.documentId === row.document_id &&
      snapshotScope?.projectId === row.project_id &&
      snapshotScope?.taskId === row.task_id &&
      snapshotScope?.documentId === row.document_id
      ? record
      : undefined;
  } catch {
    return undefined;
  }
}

function metadata(
  database: SqliteDatabase,
  bounds: RevisionEvidencePersistenceBounds,
):
  | { outcome: 'available'; count: number; recordBytes: number }
  | { outcome: 'corrupt' | 'capacity' } {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS record_count,
              COALESCE(SUM(record_bytes), 0) AS record_bytes,
              COALESCE(MAX(record_bytes), 0) AS largest_record,
              COALESCE(SUM(
                CASE WHEN typeof(revision_id) != 'text'
                       OR length(CAST(revision_id AS BLOB)) != ${REVISION_ID_BYTES}
                       OR typeof(project_id) != 'text'
                       OR length(CAST(project_id AS BLOB)) NOT BETWEEN 1 AND ${MAX_REVISION_EVIDENCE_IDENTIFIER_BYTES}
                       OR typeof(task_id) != 'text'
                       OR length(CAST(task_id AS BLOB)) NOT BETWEEN 1 AND ${MAX_REVISION_EVIDENCE_IDENTIFIER_BYTES}
                       OR typeof(document_id) != 'text'
                       OR length(CAST(document_id AS BLOB)) NOT BETWEEN 1 AND ${MAX_REVISION_EVIDENCE_IDENTIFIER_BYTES}
                       OR typeof(record_digest) != 'text'
                       OR length(CAST(record_digest AS BLOB)) != ${DIGEST_BYTES}
                       OR typeof(record_json) != 'text'
                       OR record_bytes != length(CAST(record_json AS BLOB))
                     THEN 1 ELSE 0 END
              ), 0) AS invalid_storage
         FROM revision_evidence_receipts`,
    )
    .get() as Record<string, unknown> | undefined;
  if (
    !row ||
    typeof row.record_count !== 'number' ||
    typeof row.record_bytes !== 'number' ||
    typeof row.largest_record !== 'number' ||
    typeof row.invalid_storage !== 'number' ||
    !Number.isSafeInteger(row.record_count) ||
    !Number.isSafeInteger(row.record_bytes) ||
    !Number.isSafeInteger(row.largest_record) ||
    !Number.isSafeInteger(row.invalid_storage) ||
    row.record_count < 0 ||
    row.record_bytes < 0 ||
    row.largest_record < 0 ||
    row.invalid_storage < 0 ||
    row.invalid_storage !== 0
  )
    return { outcome: 'corrupt' };
  if (
    row.record_count > bounds.maxRevisions ||
    row.largest_record > bounds.maxRecordBytes ||
    portableBytes(row.record_bytes, row.record_count) > bounds.maxPortableBytes
  )
    return { outcome: 'capacity' };
  return {
    outcome: 'available',
    count: row.record_count,
    recordBytes: row.record_bytes,
  };
}

type LedgerSnapshot =
  | {
      outcome: 'available';
      revisions: unknown[];
      witness: string;
      count: number;
      recordBytes: number;
    }
  | { outcome: 'corrupt' | 'capacity' };

/** Caller owns the surrounding SQLite snapshot/IMMEDIATE transaction. */
function readLedgerSnapshot(
  database: SqliteDatabase,
  bounds: RevisionEvidencePersistenceBounds,
): LedgerSnapshot {
  const ledger = metadata(database, bounds);
  if (ledger.outcome !== 'available') return ledger;
  const revisions: unknown[] = [];
  const witness = createHash('sha256');
  witness.update(
    JSON.stringify({ count: ledger.count, recordBytes: ledger.recordBytes }),
  );
  let afterRevisionId = '';
  let loadedBytes = 0;
  while (revisions.length < ledger.count) {
    const rows = database
      .prepare(
        `SELECT revision_id, project_id, task_id, document_id, record_json,
                record_bytes, record_digest
           FROM revision_evidence_receipts
          WHERE revision_id > ?
          ORDER BY revision_id ASC LIMIT ?`,
      )
      .all(afterRevisionId, RESTORE_PAGE_SIZE) as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0 || rows.length > RESTORE_PAGE_SIZE)
      return { outcome: 'corrupt' };
    for (const row of rows) {
      const record = storedRecord(row, bounds.maxRecordBytes);
      if (!record) return { outcome: 'corrupt' };
      loadedBytes += row.record_bytes as number;
      if (
        revisions.length >= bounds.maxRevisions ||
        portableBytes(loadedBytes, revisions.length + 1) >
          bounds.maxPortableBytes
      )
        return { outcome: 'capacity' };
      witness.update(
        JSON.stringify([
          row.revision_id,
          row.project_id,
          row.task_id,
          row.document_id,
          row.record_bytes,
          row.record_digest,
        ]),
      );
      revisions.push(record);
      afterRevisionId = row.revision_id as string;
    }
  }
  if (revisions.length !== ledger.count || loadedBytes !== ledger.recordBytes)
    return { outcome: 'corrupt' };
  return {
    outcome: 'available',
    revisions,
    count: ledger.count,
    recordBytes: ledger.recordBytes,
    witness: `revision-evidence-ledger-v1:${witness.digest('hex')}`,
  };
}

/**
 * Private SQLite receipt adapter. Restore is page-bounded and checks count,
 * row lengths, and aggregate portable bytes before materializing record JSON.
 * Writes validate the resulting ledger inside one IMMEDIATE transaction.
 */
export function createSqliteRevisionEvidencePersistence(
  database: SqliteDatabase,
  options: {
    unavailableAfterCommitOnce?: () => boolean;
    beforePersistOnce?: () => void;
    afterPersistCommitOnce?: () => void;
  } = {},
): RevisionEvidencePersistence {
  let beforePersistConsumed = false;
  let afterPersistConsumed = false;
  const read = (revisionId: string) =>
    database
      .prepare(
        `SELECT revision_id, project_id, task_id, document_id, record_json,
                record_bytes, record_digest
           FROM revision_evidence_receipts WHERE revision_id = ?`,
      )
      .get(revisionId) as Record<string, unknown> | undefined;

  return Object.freeze({
    restore(bounds: RevisionEvidencePersistenceBounds) {
      let transactionOpen = false;
      try {
        database.exec('BEGIN');
        transactionOpen = true;
        const result = readLedgerSnapshot(database, bounds);
        database.exec('COMMIT');
        transactionOpen = false;
        return result;
      } catch {
        if (transactionOpen)
          try {
            database.exec('ROLLBACK');
          } catch {
            // The unavailable result remains authoritative.
          }
        return { outcome: 'unavailable' } as const;
      }
    },

    persist({
      records,
      bounds,
      expectedWitness,
    }: Parameters<RevisionEvidencePersistence['persist']>[0]) {
      const incoming = new Map<
        string,
        { record: CommittedRevision; payload: string; payloadBytes: number }
      >();
      try {
        for (const record of records) {
          const payload = JSON.stringify(record);
          if (payload === undefined) return { outcome: 'corrupt' } as const;
          const payloadBytes = Buffer.byteLength(payload, 'utf8');
          if (payloadBytes > bounds.maxRecordBytes)
            return {
              outcome: 'rejected',
              reason: 'capacity_exceeded',
            } as const;
          const prior = incoming.get(record.revisionId);
          if (prior && prior.payload !== payload)
            return {
              outcome: 'rejected',
              reason: 'identity_collision',
            } as const;
          incoming.set(record.revisionId, { record, payload, payloadBytes });
        }
      } catch {
        return { outcome: 'corrupt' } as const;
      }

      try {
        if (!beforePersistConsumed && options.beforePersistOnce) {
          beforePersistConsumed = true;
          options.beforePersistOnce();
        }
        database.exec('BEGIN IMMEDIATE');
        const ledger = readLedgerSnapshot(database, bounds);
        if (ledger.outcome !== 'available') {
          database.exec('ROLLBACK');
          return ledger.outcome === 'capacity'
            ? ({ outcome: 'rejected', reason: 'capacity_exceeded' } as const)
            : ({ outcome: 'corrupt' } as const);
        }
        if (ledger.witness !== expectedWitness) {
          database.exec('ROLLBACK');
          return {
            outcome: 'unavailable',
            reason: 'stale_witness',
          } as const;
        }
        const durable = new Map<string, unknown>();
        const additions: Array<{
          record: CommittedRevision;
          payload: string;
          payloadBytes: number;
        }> = [];
        for (const value of incoming.values()) {
          const existing = read(value.record.revisionId);
          if (existing) {
            const restored = storedRecord(existing, bounds.maxRecordBytes);
            if (!restored) {
              database.exec('ROLLBACK');
              return { outcome: 'corrupt' } as const;
            }
            durable.set(value.record.revisionId, restored);
          } else additions.push(value);
        }

        const incomingScopes = new Map(
          [...incoming.values()].map(({ record }) => [
            record.revisionId,
            record.scope,
          ]),
        );
        for (const { record } of additions) {
          for (const parent of record.parents) {
            const incomingParent = incomingScopes.get(parent);
            if (incomingParent) {
              if (
                incomingParent.projectId !== record.scope.projectId ||
                incomingParent.taskId !== record.scope.taskId ||
                incomingParent.documentId !== record.scope.documentId
              ) {
                database.exec('ROLLBACK');
                return { outcome: 'rejected', reason: 'wrong_scope' } as const;
              }
              continue;
            }
            const parentRow = read(parent);
            if (!parentRow) {
              database.exec('ROLLBACK');
              return { outcome: 'rejected', reason: 'missing_parent' } as const;
            }
            if (!storedRecord(parentRow, bounds.maxRecordBytes)) {
              database.exec('ROLLBACK');
              return { outcome: 'corrupt' } as const;
            }
            if (
              parentRow.project_id !== record.scope.projectId ||
              parentRow.task_id !== record.scope.taskId ||
              parentRow.document_id !== record.scope.documentId
            ) {
              database.exec('ROLLBACK');
              return { outcome: 'rejected', reason: 'wrong_scope' } as const;
            }
          }
        }

        const resultingCount = ledger.count + additions.length;
        const resultingRecordBytes =
          ledger.recordBytes +
          additions.reduce((total, value) => total + value.payloadBytes, 0);
        if (
          resultingCount > bounds.maxRevisions ||
          portableBytes(resultingRecordBytes, resultingCount) >
            bounds.maxPortableBytes
        ) {
          database.exec('ROLLBACK');
          return { outcome: 'rejected', reason: 'capacity_exceeded' } as const;
        }

        for (const { record, payload, payloadBytes } of additions) {
          database
            .prepare(
              `INSERT INTO revision_evidence_receipts (
                revision_id, project_id, task_id, document_id, record_json,
                record_bytes, record_digest, persisted_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              record.revisionId,
              record.scope.projectId,
              record.scope.taskId,
              record.scope.documentId,
              payload,
              payloadBytes,
              digest(payload),
              new Date().toISOString(),
            );
        }
        for (const { record } of incoming.values()) {
          const row = read(record.revisionId);
          const restored = row
            ? storedRecord(row, bounds.maxRecordBytes)
            : undefined;
          if (!restored) {
            database.exec('ROLLBACK');
            return { outcome: 'corrupt' } as const;
          }
          durable.set(record.revisionId, restored);
        }
        database.exec('COMMIT');
        if (!afterPersistConsumed && options.afterPersistCommitOnce) {
          afterPersistConsumed = true;
          options.afterPersistCommitOnce();
        }
        if (options.unavailableAfterCommitOnce?.())
          return { outcome: 'unavailable' } as const;
        return {
          outcome: additions.length === 0 ? 'duplicate' : 'committed',
          inserted: additions.length,
          records: [...incoming.keys()].map((id) => durable.get(id)!),
        } as const;
      } catch {
        try {
          database.exec('ROLLBACK');
        } catch {
          // The caller gets a typed unavailable outcome either way.
        }
        return { outcome: 'unavailable' } as const;
      }
    },
  });
}
