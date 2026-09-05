import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import { PROJECT_TASK_ROOM_RUNTIME_MIGRATION } from '../../domain/migrations/006-project-task-room-runtime.js';
import { PROJECT_TASK_ROOM_REVISION_PUBLICATION_MIGRATION } from '../../domain/migrations/008-project-task-room-revision-publication.js';
import { ensureProjectTaskRoomRevisionAttributionColumn } from '../../domain/migrations/009-project-task-room-revision-attribution.js';
import {
  DEFAULT_RETAINED_WORKING_STATE_OPERATIONS,
  SharedWorkingState,
  type TextDocumentOperation,
  type WorkingStateSnapshot,
} from '../../domain/shared-working-state.js';
import { applyWalJournalMode } from '../../utils/sqlite-wal.js';
import {
  initializeProjectTaskRoomSourceSeals,
  readProjectTaskRoomSourceSeal,
} from './project-task-room-source-seal.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { timeout?: number }) => any;
};
const db = new DatabaseSync(workerData.databasePath, { timeout: 5_000 });
// archive#3661: unguarded before, so a first-open race with another instance
// killed this worker at startup on `database is locked`. Review MEDIUM-1: the
// race no longer kills it, and every other failure still does — this worker
// serialises shared-document edits, and coming up silently without WAL is not
// a state it should serve from.
applyWalJournalMode(db, {
  store: 'project task room working state',
  onUnavailable: 'throw',
});
db.exec(PROJECT_TASK_ROOM_RUNTIME_MIGRATION);
initializeProjectTaskRoomSourceSeals(db);
db.exec(PROJECT_TASK_ROOM_REVISION_PUBLICATION_MIGRATION);
ensureProjectTaskRoomRevisionAttributionColumn(db);
const maxRetainedOperations = Number.isSafeInteger(
  workerData.maxRetainedOperations,
)
  ? workerData.maxRetainedOperations
  : DEFAULT_RETAINED_WORKING_STATE_OPERATIONS;
const MAX_REVISION_PUBLICATION_SNAPSHOT_BYTES = 512 * 1024;
const maxWorkingSnapshotBytes = Number.isSafeInteger(
  workerData.maxWorkingSnapshotBytes,
)
  ? Math.min(16 * 1024 * 1024, workerData.maxWorkingSnapshotBytes)
  : MAX_REVISION_PUBLICATION_SNAPSHOT_BYTES;
const MAX_REVISION_PUBLICATION_CORRELATION_BYTES = 2 * 1024;
const MAX_REVISION_PUBLICATION_TEXT_BYTES = 512;
const send = (id: number, result: unknown) =>
  parentPort?.postMessage({ id, result });
let watchCount = 0;
let dataVersion = Number(
  db.prepare('PRAGMA data_version').get()?.data_version ?? 0,
);
let watchTimer: ReturnType<typeof setInterval> | undefined;
const beforeCommit = new Map<number, (allowed: boolean) => void>();
function requestBeforeCommit(id: number): Promise<boolean> {
  return new Promise((resolve) => {
    beforeCommit.set(id, resolve);
    parentPort?.postMessage({ type: 'before-commit', id });
  });
}
function updateWatch() {
  if (watchCount > 0 && !watchTimer) {
    watchTimer = setInterval(() => {
      try {
        const next = Number(
          db.prepare('PRAGMA data_version').get()?.data_version ?? 0,
        );
        if (next !== dataVersion) {
          dataVersion = next;
          parentPort?.postMessage({ type: 'changed' });
        }
      } catch {}
    }, 250);
  } else if (watchCount === 0 && watchTimer) {
    clearInterval(watchTimer);
    watchTimer = undefined;
  }
}
const key = (scope: any) => [scope.projectId, scope.taskId, scope.documentId];
const boundedText = (
  value: unknown,
  max = MAX_REVISION_PUBLICATION_TEXT_BYTES,
) =>
  typeof value === 'string' &&
  value.length > 0 &&
  Buffer.byteLength(value, 'utf8') <= max;
const evidenceRevision = (value: unknown) =>
  typeof value === 'string' &&
  /^revision-evidence-v1:[0-9a-f]{64}$/.test(value);

function readRevisionPublication(scope: any) {
  const lengths = db
    .prepare(
      `SELECT
        length(CAST(snapshot_json AS BLOB)) AS snapshot_bytes_actual,
        length(CAST(correlation_json AS BLOB)) AS correlation_bytes,
        length(CAST(intent_id AS BLOB)) AS intent_bytes,
        length(CAST(base_working_revision AS BLOB)) AS base_bytes,
        length(CAST(working_revision AS BLOB)) AS working_bytes,
        length(CAST(actor_id AS BLOB)) AS actor_bytes,
        length(CAST(actor_kind AS BLOB)) AS actor_kind_bytes,
        COALESCE(length(CAST(actor_label AS BLOB)), 0) AS actor_label_bytes,
        length(CAST(operator_id AS BLOB)) AS operator_bytes,
        length(CAST(device_id AS BLOB)) AS device_bytes,
        length(CAST(policy_revision AS BLOB)) AS policy_bytes,
        COALESCE(length(CAST(parent_evidence_revision AS BLOB)), 0) AS parent_bytes,
        COALESCE(length(CAST(evidence_revision AS BLOB)), 0) AS evidence_bytes,
        length(CAST(created_at AS BLOB)) AS created_at_bytes,
        snapshot_bytes
       FROM project_task_room_revision_publication_outbox
       WHERE project_id=? AND task_id=? AND document_id=? LIMIT 1`,
    )
    .get(...key(scope)) as Record<string, unknown> | undefined;
  if (!lengths) return { kind: 'missing' } as const;
  const measured = (name: string, max: number) => {
    const value = lengths[name];
    return (
      Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max
    );
  };
  if (
    !measured(
      'snapshot_bytes_actual',
      MAX_REVISION_PUBLICATION_SNAPSHOT_BYTES,
    ) ||
    Number(lengths.snapshot_bytes_actual) !== Number(lengths.snapshot_bytes) ||
    !measured(
      'correlation_bytes',
      MAX_REVISION_PUBLICATION_CORRELATION_BYTES,
    ) ||
    !measured('intent_bytes', MAX_REVISION_PUBLICATION_TEXT_BYTES) ||
    !measured('base_bytes', MAX_REVISION_PUBLICATION_TEXT_BYTES) ||
    !measured('working_bytes', MAX_REVISION_PUBLICATION_TEXT_BYTES) ||
    !measured('actor_bytes', MAX_REVISION_PUBLICATION_TEXT_BYTES) ||
    !measured('actor_kind_bytes', 8) ||
    !measured('actor_label_bytes', MAX_REVISION_PUBLICATION_TEXT_BYTES) ||
    !measured('operator_bytes', MAX_REVISION_PUBLICATION_TEXT_BYTES) ||
    !measured('device_bytes', MAX_REVISION_PUBLICATION_TEXT_BYTES) ||
    !measured('policy_bytes', MAX_REVISION_PUBLICATION_TEXT_BYTES) ||
    !measured('parent_bytes', MAX_REVISION_PUBLICATION_TEXT_BYTES) ||
    !measured('evidence_bytes', MAX_REVISION_PUBLICATION_TEXT_BYTES) ||
    !measured('created_at_bytes', MAX_REVISION_PUBLICATION_TEXT_BYTES)
  )
    return { kind: 'unavailable' } as const;
  const row = db
    .prepare(
      `SELECT intent_id,base_working_revision,working_revision,snapshot_json,
        actor_id,actor_label,actor_kind,operator_id,device_id,policy_revision,
        correlation_json,parent_evidence_revision,evidence_revision,created_at
       FROM project_task_room_revision_publication_outbox
       WHERE project_id=? AND task_id=? AND document_id=? LIMIT 1`,
    )
    .get(...key(scope)) as Record<string, unknown> | undefined;
  if (!row) return { kind: 'unavailable' } as const;
  try {
    if (
      !boundedText(row.intent_id) ||
      !boundedText(row.base_working_revision) ||
      !boundedText(row.working_revision) ||
      !boundedText(row.actor_id) ||
      (row.actor_kind !== 'human' && row.actor_kind !== 'agent') ||
      !boundedText(row.operator_id) ||
      !boundedText(row.device_id) ||
      !boundedText(row.policy_revision) ||
      (row.actor_label !== null &&
        row.actor_label !== undefined &&
        !boundedText(row.actor_label)) ||
      (row.parent_evidence_revision !== null &&
        row.parent_evidence_revision !== undefined &&
        !evidenceRevision(row.parent_evidence_revision)) ||
      (row.evidence_revision !== null &&
        row.evidence_revision !== undefined &&
        !evidenceRevision(row.evidence_revision)) ||
      typeof row.snapshot_json !== 'string' ||
      typeof row.correlation_json !== 'string' ||
      !boundedText(row.created_at)
    )
      return { kind: 'unavailable' } as const;
    const restored = new SharedWorkingState({
      scope,
      snapshot: JSON.parse(row.snapshot_json) as WorkingStateSnapshot,
    });
    const snapshot = restored.snapshot();
    const correlation = JSON.parse(row.correlation_json) as Record<
      string,
      unknown
    >;
    if (
      snapshot.revision !== row.working_revision ||
      snapshot.deferred.length > 0 ||
      correlation?.projectId !== scope.projectId ||
      correlation?.taskId !== scope.taskId ||
      (row.actor_kind === 'human'
        ? Object.keys(correlation).length !== 2
        : Object.keys(correlation).length !== 4 ||
          !boundedText(correlation.agentSessionId) ||
          !boundedText(correlation.runId))
    )
      return { kind: 'unavailable' } as const;
    return {
      kind: 'available',
      publication: {
        intentId: row.intent_id,
        scope,
        baseWorkingRevision: row.base_working_revision,
        workingRevision: row.working_revision,
        snapshot,
        actorId: row.actor_id,
        actorKind: row.actor_kind,
        ...(typeof row.actor_label === 'string'
          ? { actorLabel: row.actor_label }
          : {}),
        principal: {
          operatorId: row.operator_id,
          deviceId: row.device_id,
          policyRevision: row.policy_revision,
        },
        correlation: {
          projectId: scope.projectId,
          taskId: scope.taskId,
          ...(row.actor_kind === 'agent'
            ? {
                agentSessionId: correlation.agentSessionId as string,
                runId: correlation.runId as string,
              }
            : {}),
        },
        ...(typeof row.parent_evidence_revision === 'string'
          ? { parentEvidenceRevision: row.parent_evidence_revision }
          : {}),
        ...(typeof row.evidence_revision === 'string'
          ? { evidenceRevision: row.evidence_revision }
          : {}),
        createdAt: row.created_at,
      },
    } as const;
  } catch {
    return { kind: 'unavailable' } as const;
  }
}
function readRevisionHead(scope: any) {
  const lengths = db
    .prepare(
      `SELECT length(CAST(working_revision AS BLOB)) AS working_bytes,
        length(CAST(evidence_revision AS BLOB)) AS evidence_bytes
       FROM project_task_room_revision_evidence_heads
       WHERE project_id=? AND task_id=? AND document_id=? LIMIT 1`,
    )
    .get(...key(scope)) as
    | { working_bytes?: unknown; evidence_bytes?: unknown }
    | undefined;
  if (!lengths) return { kind: 'missing' } as const;
  if (
    !Number.isSafeInteger(lengths.working_bytes) ||
    Number(lengths.working_bytes) < 1 ||
    Number(lengths.working_bytes) > MAX_REVISION_PUBLICATION_TEXT_BYTES ||
    !Number.isSafeInteger(lengths.evidence_bytes) ||
    Number(lengths.evidence_bytes) < 1 ||
    Number(lengths.evidence_bytes) > MAX_REVISION_PUBLICATION_TEXT_BYTES
  )
    return { kind: 'unavailable' } as const;
  const row = db
    .prepare(
      `SELECT working_revision,evidence_revision
       FROM project_task_room_revision_evidence_heads
       WHERE project_id=? AND task_id=? AND document_id=? LIMIT 1`,
    )
    .get(...key(scope)) as
    | { working_revision?: unknown; evidence_revision?: unknown }
    | undefined;
  return row &&
    boundedText(row.working_revision) &&
    evidenceRevision(row.evidence_revision)
    ? {
        kind: 'available' as const,
        workingRevision: row.working_revision,
        evidenceRevision: row.evidence_revision,
      }
    : ({ kind: 'unavailable' } as const);
}
function load(scope: any) {
  const row = db
    .prepare(
      'SELECT snapshot_json FROM project_task_room_working_states WHERE project_id=? AND task_id=? AND document_id=?',
    )
    .get(...key(scope)) as { snapshot_json?: string } | undefined;
  try {
    return new SharedWorkingState({
      scope,
      ...(row?.snapshot_json
        ? { snapshot: JSON.parse(row.snapshot_json) as WorkingStateSnapshot }
        : {}),
    });
  } catch {
    return undefined;
  }
}
function retainedFloor(scope: any, fallback: string) {
  const row = db
    .prepare(
      'SELECT prior_revision FROM project_task_room_working_revisions WHERE project_id=? AND task_id=? AND document_id=? ORDER BY ordinal ASC LIMIT 1',
    )
    .get(...key(scope)) as { prior_revision?: string } | undefined;
  return row?.prior_revision ?? fallback;
}
function canResume(scope: any, after: string, revision: string) {
  if (after === revision) return true;
  let cursor = after;
  for (let count = 0; count <= maxRetainedOperations; count += 1) {
    const row = db
      .prepare(
        'SELECT revision FROM project_task_room_working_revisions WHERE project_id=? AND task_id=? AND document_id=? AND prior_revision=? LIMIT 1',
      )
      .get(...key(scope), cursor) as { revision?: string } | undefined;
    if (!row?.revision) return false;
    cursor = row.revision;
    if (cursor === revision) return true;
  }
  return false;
}
async function handle(message: any) {
  const { id, value } = message ?? {};
  if (message?.type === 'before-commit-result' && Number.isSafeInteger(id)) {
    const resolve = beforeCommit.get(id);
    beforeCommit.delete(id);
    resolve?.(message.allowed === true);
    return;
  }
  if (!value || typeof value.type !== 'string') return;
  if (value.type === 'watch') {
    watchCount += 1;
    updateWatch();
    // A subscriber must take an initial projection even when another worker
    // committed between the parent posting `watch` and this worker installing
    // its first data_version sample. This closes that lost-wakeup window.
    parentPort?.postMessage({ type: 'changed' });
    return;
  }
  if (value.type === 'unwatch') {
    watchCount = Math.max(0, watchCount - 1);
    updateWatch();
    return;
  }
  if (!Number.isSafeInteger(id)) return;
  try {
    if (value.type === 'read') {
      const state = load(value.scope);
      if (!state) return send(id, { kind: 'unavailable' });
      const snapshot = state.snapshot();
      const resync =
        value.after && canResume(value.scope, value.after, snapshot.revision)
          ? { outcome: 'delta' as const }
          : { outcome: 'snapshot' as const };
      return send(
        id,
        resync.outcome === 'snapshot'
          ? {
              kind: value.after ? 'gap' : 'snapshot',
              revision: snapshot.revision,
              text: state.text(),
              floor: retainedFloor(value.scope, snapshot.revision),
            }
          : {
              kind: 'delta',
              revision: snapshot.revision,
              text: state.text(),
              floor: snapshot.checkpointRevision,
            },
      );
    }
    if (value.type === 'private-snapshot') {
      const state = load(value.scope);
      return send(id, state?.snapshot());
    }
    if (value.type === 'receipt') {
      const existing = db
        .prepare(
          'SELECT intent_digest,receipt_json FROM project_task_room_working_batches WHERE project_id=? AND task_id=? AND document_id=? AND intent_id=?',
        )
        .get(...key(value.scope), value.intentId) as any;
      if (!existing) return send(id, { kind: 'missing' });
      return send(
        id,
        existing.intent_digest === value.intentDigest
          ? { kind: 'duplicate', ...JSON.parse(existing.receipt_json) }
          : { kind: 'conflict' },
      );
    }
    if (value.type === 'read-revision-publication') {
      return send(id, readRevisionPublication(value.scope));
    }
    if (value.type === 'mark-revision-publication') {
      if (
        !boundedText(value.intentId) ||
        !evidenceRevision(value.evidenceRevision)
      )
        return send(id, { kind: 'unavailable' });
      db.exec('BEGIN IMMEDIATE');
      try {
        const read = readRevisionPublication(value.scope);
        if (read.kind !== 'available') {
          db.exec('ROLLBACK');
          return send(id, { kind: 'unavailable' });
        }
        if (read.publication.intentId !== value.intentId) {
          db.exec('ROLLBACK');
          return send(id, { kind: 'conflict' });
        }
        if (read.publication.evidenceRevision) {
          const head = readRevisionHead(value.scope);
          db.exec('ROLLBACK');
          return send(id, {
            kind:
              read.publication.evidenceRevision !== value.evidenceRevision
                ? 'conflict'
                : head.kind === 'available' &&
                    head.evidenceRevision === value.evidenceRevision &&
                    head.workingRevision === read.publication.workingRevision
                  ? 'duplicate'
                  : 'unavailable',
          });
        }
        const head = readRevisionHead(value.scope);
        const expectedParent = read.publication.parentEvidenceRevision;
        if (
          (expectedParent === undefined && head.kind !== 'missing') ||
          (expectedParent !== undefined &&
            (head.kind !== 'available' ||
              head.evidenceRevision !== expectedParent ||
              head.workingRevision !== read.publication.baseWorkingRevision))
        ) {
          db.exec('ROLLBACK');
          return send(id, { kind: 'unavailable' });
        }
        db.prepare(
          'UPDATE project_task_room_revision_publication_outbox SET evidence_revision=? WHERE project_id=? AND task_id=? AND document_id=? AND intent_id=? AND evidence_revision IS NULL',
        ).run(value.evidenceRevision, ...key(value.scope), value.intentId);
        db.prepare(
          `INSERT INTO project_task_room_revision_evidence_heads(project_id,task_id,document_id,working_revision,evidence_revision,updated_at)
           VALUES(?,?,?,?,?,?)
           ON CONFLICT(project_id,task_id,document_id) DO UPDATE SET
             working_revision=excluded.working_revision,
             evidence_revision=excluded.evidence_revision,
             updated_at=excluded.updated_at`,
        ).run(
          ...key(value.scope),
          read.publication.workingRevision,
          value.evidenceRevision,
          new Date().toISOString(),
        );
        db.exec('COMMIT');
        return send(id, { kind: 'marked' });
      } catch {
        try {
          db.exec('ROLLBACK');
        } catch {}
        return send(id, { kind: 'unavailable' });
      }
    }
    if (value.type === 'remove-revision-publication') {
      if (
        !boundedText(value.intentId) ||
        !evidenceRevision(value.evidenceRevision)
      )
        return send(id, { kind: 'unavailable' });
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = readRevisionPublication(value.scope);
        if (current.kind === 'missing') {
          db.exec('ROLLBACK');
          return send(id, { kind: 'missing' });
        }
        if (
          current.kind !== 'available' ||
          current.publication.intentId !== value.intentId ||
          current.publication.evidenceRevision !== value.evidenceRevision
        ) {
          db.exec('ROLLBACK');
          return send(id, {
            kind: current.kind === 'unavailable' ? 'unavailable' : 'conflict',
          });
        }
        const head = readRevisionHead(value.scope);
        if (
          head.kind !== 'available' ||
          head.evidenceRevision !== value.evidenceRevision ||
          head.workingRevision !== current.publication.workingRevision
        ) {
          db.exec('ROLLBACK');
          return send(id, { kind: 'unavailable' });
        }
        const removed = db
          .prepare(
            'DELETE FROM project_task_room_revision_publication_outbox WHERE project_id=? AND task_id=? AND document_id=? AND intent_id=? AND evidence_revision=?',
          )
          .run(...key(value.scope), value.intentId, value.evidenceRevision);
        db.exec('COMMIT');
        return send(id, {
          kind: Number(removed.changes) === 1 ? 'removed' : 'missing',
        });
      } catch {
        try {
          db.exec('ROLLBACK');
        } catch {}
        return send(id, { kind: 'unavailable' });
      }
    }
    if (value.type === 'recovery') {
      db.prepare(
        'INSERT INTO project_task_room_live_recovery(project_id,task_id,document_id,generation,recovery_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,task_id,document_id) DO UPDATE SET generation=excluded.generation,recovery_json=excluded.recovery_json,updated_at=excluded.updated_at',
      ).run(
        ...key(value.scope),
        value.generation,
        JSON.stringify(value.value),
        new Date().toISOString(),
      );
      return send(id, { kind: 'stored' });
    }
    if (value.type === 'read-recovery') {
      const row = db
        .prepare(
          'SELECT generation,recovery_json FROM project_task_room_live_recovery WHERE project_id=? AND task_id=? AND document_id=?',
        )
        .get(...key(value.scope)) as
        | { generation?: string; recovery_json?: string }
        | undefined;
      if (!row?.generation || !row.recovery_json)
        return send(id, { kind: 'unavailable' });
      try {
        return send(id, {
          kind: 'available',
          generation: row.generation,
          value: JSON.parse(row.recovery_json),
        });
      } catch {
        return send(id, { kind: 'unavailable' });
      }
    }
    if (value.type === 'agent-lifecycle') {
      try {
        db.prepare(
          'INSERT INTO project_task_room_agent_lifecycle_outbox(project_id,task_id,document_id,intent_id,lifecycle_json,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,task_id,document_id,intent_id) DO NOTHING',
        ).run(
          ...key(value.scope),
          value.intentId,
          JSON.stringify(value.value),
          new Date().toISOString(),
        );
        return send(id, { kind: 'stored' });
      } catch {
        return send(id, { kind: 'unavailable' });
      }
    }
    if (value.type === 'read-agent-lifecycles') {
      try {
        const rows = db
          .prepare(
            'SELECT intent_id,lifecycle_json FROM project_task_room_agent_lifecycle_outbox WHERE project_id=? AND task_id=? AND document_id=? ORDER BY created_at ASC',
          )
          .all(...key(value.scope)) as Array<{
          intent_id?: string;
          lifecycle_json?: string;
        }>;
        const values = rows.flatMap((row) => {
          if (!row.intent_id || !row.lifecycle_json) return [];
          try {
            return [
              {
                intentId: row.intent_id,
                value: JSON.parse(row.lifecycle_json),
              },
            ];
          } catch {
            return [];
          }
        });
        return send(id, { kind: 'available', values });
      } catch {
        return send(id, { kind: 'unavailable' });
      }
    }
    if (value.type === 'remove-agent-lifecycle') {
      try {
        db.prepare(
          'DELETE FROM project_task_room_agent_lifecycle_outbox WHERE project_id=? AND task_id=? AND document_id=? AND intent_id=?',
        ).run(...key(value.scope), value.intentId);
        return send(id, { kind: 'removed' });
      } catch {
        return send(id, { kind: 'unavailable' });
      }
    }
    if (value.type === 'settle') {
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = db
          .prepare(
            'SELECT intent_digest,receipt_json FROM project_task_room_working_batches WHERE project_id=? AND task_id=? AND document_id=? AND intent_id=?',
          )
          .get(...key(value.scope), value.intentId) as any;
        if (existing) {
          db.exec('COMMIT');
          return send(
            id,
            existing.intent_digest === value.intentDigest
              ? { kind: 'duplicate', ...JSON.parse(existing.receipt_json) }
              : { kind: 'conflict' },
          );
        }
        if (readProjectTaskRoomSourceSeal(db, value.scope)) {
          db.exec('ROLLBACK');
          return send(id, { kind: 'unavailable' });
        }
        const pending = db
          .prepare(
            'SELECT 1 AS pending FROM project_task_room_revision_publication_outbox WHERE project_id=? AND task_id=? AND document_id=? LIMIT 1',
          )
          .get(...key(value.scope));
        if (pending) {
          db.exec('ROLLBACK');
          return send(id, {
            kind: 'rejected',
            reason: 'revision-publication-pending',
          });
        }
        const state = load(value.scope);
        if (!state) throw new Error('unavailable');
        const baseWorkingRevision = state.snapshot().revision;
        const revisions: Array<{ prior: string; revision: string }> = [];
        for (const operation of value.operations as TextDocumentOperation[]) {
          const prior = state.snapshot().revision;
          const result = state.apply(operation, {
            scope: value.scope,
            epoch: value.epoch,
            allowedActorIds: new Set([value.actorId]),
          });
          if (result.outcome === 'rejected' || result.outcome === 'deferred') {
            db.exec('ROLLBACK');
            return send(id, { kind: 'rejected' });
          }
          const revision = state.snapshot().revision;
          if (revision !== prior) revisions.push({ prior, revision });
        }
        // Persist the converged snapshot for recovery, but retain the bounded
        // revision chain separately. Compacting here erased every delta after
        // each successful batch.
        const snapshot = state.snapshot();
        const snapshotJson = JSON.stringify(snapshot);
        const snapshotBytes = Buffer.byteLength(snapshotJson, 'utf8');
        if (
          snapshotBytes < 1 ||
          snapshotBytes > maxWorkingSnapshotBytes ||
          !boundedText(value.intentId) ||
          !boundedText(value.actorId) ||
          (value.actorLabel !== undefined && !boundedText(value.actorLabel))
        ) {
          db.exec('ROLLBACK');
          return send(id, { kind: 'unavailable' });
        }
        const projection = { revision: snapshot.revision, text: state.text() };
        let nextOrdinal = Number(
          (
            db
              .prepare(
                'SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM project_task_room_working_revisions WHERE project_id=? AND task_id=? AND document_id=?',
              )
              .get(...key(value.scope)) as { ordinal?: number }
          ).ordinal ?? 0,
        );
        for (const entry of revisions) {
          nextOrdinal += 1;
          db.prepare(
            'INSERT INTO project_task_room_working_revisions(project_id,task_id,document_id,ordinal,prior_revision,revision) VALUES(?,?,?,?,?,?)',
          ).run(...key(value.scope), nextOrdinal, entry.prior, entry.revision);
        }
        db.prepare(
          'DELETE FROM project_task_room_working_revisions WHERE project_id=? AND task_id=? AND document_id=? AND ordinal <= ?',
        ).run(
          ...key(value.scope),
          Math.max(0, nextOrdinal - maxRetainedOperations),
        );
        const floor = retainedFloor(value.scope, snapshot.revision);
        db.prepare(
          'INSERT INTO project_task_room_working_states(project_id,task_id,document_id,snapshot_json,revision,compaction_floor,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,task_id,document_id) DO UPDATE SET snapshot_json=excluded.snapshot_json,revision=excluded.revision,compaction_floor=excluded.compaction_floor,updated_at=excluded.updated_at',
        ).run(
          ...key(value.scope),
          snapshotJson,
          snapshot.revision,
          floor,
          new Date().toISOString(),
        );
        db.prepare(
          'INSERT INTO project_task_room_working_batches(project_id,task_id,document_id,intent_id,intent_digest,receipt_json,committed_at) VALUES(?,?,?,?,?,?,?)',
        ).run(
          ...key(value.scope),
          value.intentId,
          value.intentDigest,
          JSON.stringify(projection),
          new Date().toISOString(),
        );
        if (value.suppressRevisionPublicationForDiagnostic === true) {
          if (!(await requestBeforeCommit(id))) {
            db.exec('ROLLBACK');
            return send(id, { kind: 'rejected' });
          }
          db.exec('COMMIT');
          dataVersion = Number(
            db.prepare('PRAGMA data_version').get()?.data_version ??
              dataVersion,
          );
          return send(id, { kind: 'committed', ...projection });
        }
        const parent = db
          .prepare(
            'SELECT working_revision,evidence_revision FROM project_task_room_revision_evidence_heads WHERE project_id=? AND task_id=? AND document_id=? LIMIT 1',
          )
          .get(...key(value.scope)) as
          | { working_revision?: string; evidence_revision?: string }
          | undefined;
        if (
          parent &&
          (parent.working_revision !== baseWorkingRevision ||
            !evidenceRevision(parent.evidence_revision))
        )
          throw new Error('corrupt revision evidence head');
        const publicationIntentId = `revision-publication:${value.intentId}`;
        if (!boundedText(publicationIntentId))
          throw new Error('publication intent too large');
        const actorKind = value.actorKind ?? 'human';
        const publicationCorrelation = value.publicationCorrelation;
        if (
          (actorKind !== 'human' && actorKind !== 'agent') ||
          (actorKind === 'human' && publicationCorrelation !== undefined) ||
          (actorKind === 'agent' &&
            (!publicationCorrelation ||
              Object.keys(publicationCorrelation).length !== 2 ||
              !boundedText(publicationCorrelation.agentSessionId) ||
              !boundedText(publicationCorrelation.runId)))
        )
          throw new Error('publication attribution is malformed');
        const correlationJson = JSON.stringify({
          projectId: value.scope.projectId,
          taskId: value.scope.taskId,
          ...(actorKind === 'agent' ? publicationCorrelation : {}),
        });
        const publicationPrincipal = value.publicationPrincipal ?? {
          operatorId: value.actorLabel ?? value.actorId,
          deviceId: 'working-state',
          policyRevision: 'working-state',
        };
        if (
          !boundedText(publicationPrincipal.operatorId) ||
          !boundedText(publicationPrincipal.deviceId) ||
          !boundedText(publicationPrincipal.policyRevision)
        )
          throw new Error('publication principal is malformed');
        db.prepare(
          `INSERT INTO project_task_room_revision_publication_outbox(
            project_id,task_id,document_id,intent_id,base_working_revision,
            working_revision,snapshot_json,snapshot_bytes,actor_id,actor_label,actor_kind,
            operator_id,device_id,policy_revision,
            correlation_json,parent_evidence_revision,evidence_revision,created_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)`,
        ).run(
          ...key(value.scope),
          publicationIntentId,
          baseWorkingRevision,
          snapshot.revision,
          snapshotJson,
          snapshotBytes,
          value.actorId,
          value.actorLabel ?? null,
          actorKind,
          publicationPrincipal.operatorId,
          publicationPrincipal.deviceId,
          publicationPrincipal.policyRevision,
          correlationJson,
          parent?.evidence_revision ?? null,
          new Date().toISOString(),
        );
        // The transaction is intentionally still open while the runtime
        // revalidates the immutable request/device/policy grant. A revoked
        // caller can therefore never turn an already-planned batch into a
        // committed write.
        if (!(await requestBeforeCommit(id))) {
          db.exec('ROLLBACK');
          return send(id, { kind: 'rejected' });
        }
        db.exec('COMMIT');
        dataVersion = Number(
          db.prepare('PRAGMA data_version').get()?.data_version ?? dataVersion,
        );
        return send(id, { kind: 'committed', ...projection });
      } catch {
        try {
          db.exec('ROLLBACK');
        } catch {}
        return send(id, { kind: 'unavailable' });
      }
    }
  } catch {
    send(id, { kind: 'unavailable' });
  }
}

// SQLite permits an async function to yield while a transaction is open.  A
// worker-thread message handler is not implicitly serialized, so without this
// rail a read/second settlement could run in that yield (while the parent is
// deciding the pre-commit fence).  The fence reply itself deliberately bypasses
// the rail: it is the one message the active settlement is waiting for.
let ordinaryRequests = Promise.resolve();
parentPort?.on('message', (message: any) => {
  const id = message?.id;
  if (message?.type === 'before-commit-result' && Number.isSafeInteger(id)) {
    const resolve = beforeCommit.get(id);
    beforeCommit.delete(id);
    resolve?.(message.allowed === true);
    return;
  }
  ordinaryRequests = ordinaryRequests
    .then(() => handle(message))
    .catch(() => undefined);
});
