/**
 * #4003 Task memory's store: `task_summary_revisions` and
 * `task_record_versions` in the orchestration database (migration 020).
 * Authority is the caller's (`ProjectTaskRoomRuntime`); this module owns the
 * bounds, the base-revision rule, the live-record caps, supersede, answer and
 * retire, and the append-only shape.
 *
 * Every write runs in one `BEGIN IMMEDIATE` transaction: the caller's
 * `beforeCommit` re-check, the base-revision or record-state read, the cap
 * count and the insert see one state, so two concurrent writes can neither
 * both win the same base revision nor both take a cap's last slot.
 *
 * The read API at the bottom (`listStandingRecords`, `listOpenQuestions`,
 * `countOpenQuestions`) is what other server code reads Task memory through.
 * It also keeps a person's dismissals of a done Task's promotion candidates
 * (`task_learning_dismissals`, migration 021; see
 * `services/projects/task-learning.ts`).
 */
import {
  checkTaskRecordWrite,
  isLiveTaskRecord,
  TASK_MEMORY_LIMITS,
  TASK_RECORD_DEFAULT_IMPORTANCE,
  type TaskLearningDismissal,
  type TaskLearningKind,
  type TaskMemoryAuthor,
  type TaskMemoryRecord,
  type TaskMemoryRefusal,
  type TaskRecordImportance,
  type TaskRecordKind,
  type TaskRecordWrite,
  type TaskSummaryRevision,
  taskSummaryRefusal,
} from '@kontourai/station-contracts/task-memory';
import type { SqliteDatabase } from './sqlite-database.js';

export interface TaskMemoryIncarnation {
  readonly taskId: string;
  /** `TaskRecord.createdAt`: a re-created Task starts with no memory. */
  readonly taskCreatedAt: string;
}

interface WriteContext extends TaskMemoryIncarnation {
  readonly projectId: string;
  readonly author: TaskMemoryAuthor;
  /** The caller's authority, re-checked inside the write transaction. */
  readonly beforeCommit?: () => boolean;
}

export type TaskSummaryUpdateResult =
  | {
      readonly kind: 'updated';
      readonly summary: TaskSummaryRevision;
      /** The text equals the current revision's: nothing new was written. */
      readonly unchanged?: true;
    }
  /** `baseRevision` is not the current revision; nothing was written. */
  | {
      readonly kind: 'stale-base';
      readonly current: TaskSummaryRevision | undefined;
    }
  | { readonly kind: 'refused'; readonly refusal: TaskMemoryRefusal }
  /** `beforeCommit` answered false inside the transaction; nothing written. */
  | { readonly kind: 'stale' };

export type TaskRecordWriteResult =
  | { readonly kind: 'recorded'; readonly record: TaskMemoryRecord }
  | { readonly kind: 'refused'; readonly refusal: TaskMemoryRefusal }
  | { readonly kind: 'stale' };

/** Why a Task-memory write did not reach the Task. */
export type TaskMemoryAccessRefusal =
  /** The Session has no bound Task, or is not this Task's lead or request. */
  | { readonly kind: 'no-task' }
  /** A person's request is not authorized for this Task's room. */
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unavailable' };

export type TaskSummaryUpdateOutcome =
  | {
      readonly kind: 'updated';
      readonly taskId: string;
      readonly summary: TaskSummaryRevision;
      readonly unchanged?: true;
    }
  /** The base revision is not current; the current summary, to merge with. */
  | {
      readonly kind: 'stale-base';
      readonly current: TaskSummaryRevision | undefined;
    }
  | { readonly kind: 'refused'; readonly refusal: TaskMemoryRefusal }
  | TaskMemoryAccessRefusal;

export type TaskRecordWriteOutcome =
  | {
      readonly kind: 'recorded';
      readonly taskId: string;
      readonly record: TaskMemoryRecord;
    }
  | { readonly kind: 'refused'; readonly refusal: TaskMemoryRefusal }
  | TaskMemoryAccessRefusal;

/** A person's persisted dismissal of one promotion candidate version. */
export interface TaskLearningDismissalRecord extends TaskLearningDismissal {
  readonly principalId: string;
  readonly dismissedAt: string;
}

export type TaskLearningDismissResult =
  | {
      readonly kind: 'dismissed';
      readonly dismissal: TaskLearningDismissalRecord;
    }
  /** Already dismissed: the first dismissal stands and nothing is written. */
  | {
      readonly kind: 'already-dismissed';
      readonly dismissal: TaskLearningDismissalRecord;
    }
  /** The version is not the key's current active, standing version. */
  | { readonly kind: 'not-a-candidate' }
  | { readonly kind: 'stale' };

export interface TaskOpenQuestion {
  readonly record: TaskMemoryRecord;
  /** The Session that asked it; absent when a person asked. */
  readonly askedBySessionId?: string;
}

export interface TaskMemoryStore {
  updateSummary(
    input: WriteContext & {
      readonly text: string;
      /** The revision the writer read; 0 when there was no summary. */
      readonly baseRevision: number;
    },
  ): TaskSummaryUpdateResult;
  readSummary(input: TaskMemoryIncarnation): TaskSummaryRevision | undefined;
  /** Newest first, at most `limit`, with the incarnation's total. */
  listSummaryRevisions(
    input: TaskMemoryIncarnation & { readonly limit: number },
  ): { revisions: TaskSummaryRevision[]; total: number };
  writeRecord(
    input: WriteContext & { readonly write: TaskRecordWrite },
  ): TaskRecordWriteResult;
  /** The newest version of every key, in the order keys were first set. */
  listRecords(input: TaskMemoryIncarnation): TaskMemoryRecord[];
  /** Every version of one record, oldest first. */
  listRecordVersions(
    input: TaskMemoryIncarnation & {
      readonly kind: TaskRecordKind;
      readonly key: string;
    },
  ): TaskMemoryRecord[];
  /**
   * Active, standing decisions and dead ends: what holds for the whole Task.
   * Oldest first, by when each record's current version was written.
   */
  listStandingRecords(input: TaskMemoryIncarnation): {
    decisions: TaskMemoryRecord[];
    deadEnds: TaskMemoryRecord[];
  };
  /**
   * #4003 layer 4: persist a person's dismissal of one standing decision or
   * dead end version, so a done Task stops offering it for promotion. Only
   * the key's current active, standing version can be dismissed.
   */
  dismissLearningCandidate(
    input: TaskMemoryIncarnation &
      TaskLearningDismissal & {
        readonly projectId: string;
        readonly principalId: string;
        readonly beforeCommit?: () => boolean;
      },
  ): TaskLearningDismissResult;
  /** Every dismissal of the incarnation, oldest first. */
  listLearningDismissals(
    input: TaskMemoryIncarnation,
  ): TaskLearningDismissalRecord[];
  /** Open questions, oldest first, with the Session that asked each. */
  listOpenQuestions(input: TaskMemoryIncarnation): TaskOpenQuestion[];
  /** Open-question counts per Task incarnation; Tasks with none are absent. */
  countOpenQuestions(
    incarnations: readonly TaskMemoryIncarnation[],
  ): Map<string, number>;
}

interface SummaryRow {
  task_id: string;
  revision: number;
  text: string;
  author_kind: 'session' | 'person';
  author_id: string;
  created_at: string;
}

interface RecordRow {
  task_id: string;
  kind: TaskRecordKind;
  record_key: string;
  version: number;
  action: TaskMemoryRecord['action'];
  state: TaskMemoryRecord['state'];
  importance: TaskRecordImportance;
  text: string;
  answer: string | null;
  reason: string | null;
  author_kind: 'session' | 'person';
  author_id: string;
  created_at: string;
}

interface DismissalRow {
  kind: TaskLearningKind;
  record_key: string;
  version: number;
  principal_id: string;
  dismissed_at: string;
}

const DISMISSAL_COLUMNS =
  'kind, record_key, version, principal_id, dismissed_at';

function dismissalFromRow(row: DismissalRow): TaskLearningDismissalRecord {
  return {
    kind: row.kind,
    key: row.record_key,
    version: row.version,
    principalId: row.principal_id,
    dismissedAt: row.dismissed_at,
  };
}

function authorOf(kind: 'session' | 'person', id: string): TaskMemoryAuthor {
  return kind === 'session'
    ? { kind: 'session', sessionId: id }
    : { kind: 'person', principalId: id };
}

function authorId(author: TaskMemoryAuthor): string {
  return author.kind === 'session' ? author.sessionId : author.principalId;
}

function summaryFromRow(row: SummaryRow): TaskSummaryRevision {
  return {
    taskId: row.task_id,
    revision: row.revision,
    text: row.text,
    author: authorOf(row.author_kind, row.author_id),
    createdAt: row.created_at,
  };
}

function recordFromRow(row: RecordRow): TaskMemoryRecord {
  return {
    taskId: row.task_id,
    kind: row.kind,
    key: row.record_key,
    version: row.version,
    action: row.action,
    state: row.state,
    importance: row.importance,
    text: row.text,
    ...(row.answer !== null ? { answer: row.answer } : {}),
    ...(row.reason !== null ? { reason: row.reason } : {}),
    author: authorOf(row.author_kind, row.author_id),
    createdAt: row.created_at,
  };
}

const SUMMARY_COLUMNS =
  'task_id, revision, text, author_kind, author_id, created_at';
const RECORD_COLUMNS = `v.task_id, v.kind, v.record_key, v.version, v.action,
  v.state, v.importance, v.text, v.answer, v.reason, v.author_kind,
  v.author_id, v.created_at`;
/** The newest version of each key: the record itself. */
const IS_CURRENT_VERSION = `v.version = (SELECT MAX(w.version)
    FROM task_record_versions w
   WHERE w.task_id = v.task_id AND w.task_created_at = v.task_created_at
     AND w.kind = v.kind AND w.record_key = v.record_key)`;
/** SQLite's default bound on host parameters is 999; leave room for one more. */
const COUNT_CHUNK = 400;

export function createSqliteTaskMemoryStore(
  db: SqliteDatabase,
  options: { now?: () => Date } = {},
): TaskMemoryStore {
  const now = options.now ?? (() => new Date());
  const caps = TASK_MEMORY_LIMITS.liveRecords;

  /** Runs `body` in one IMMEDIATE transaction after the authority re-check. */
  const transact = <T>(
    beforeCommit: (() => boolean) | undefined,
    body: () => { commit: boolean; value: T },
  ): T | { kind: 'stale' } => {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (beforeCommit && !beforeCommit()) {
        db.exec('ROLLBACK');
        return { kind: 'stale' };
      }
      const { commit, value } = body();
      db.exec(commit ? 'COMMIT' : 'ROLLBACK');
      return value;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The failed statement may already have ended the transaction.
      }
      throw error;
    }
  };

  const readSummary = (input: TaskMemoryIncarnation) => {
    const row = db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS} FROM task_summary_revisions
          WHERE task_id = ? AND task_created_at = ?
          ORDER BY revision DESC LIMIT 1`,
      )
      .get(input.taskId, input.taskCreatedAt) as SummaryRow | undefined;
    return row ? summaryFromRow(row) : undefined;
  };

  const currentRecord = (
    input: TaskMemoryIncarnation,
    kind: TaskRecordKind,
    key: string,
  ) => {
    const row = db
      .prepare(
        `SELECT ${RECORD_COLUMNS} FROM task_record_versions v
          WHERE v.task_id = ? AND v.task_created_at = ? AND v.kind = ?
            AND v.record_key = ?
          ORDER BY v.version DESC LIMIT 1`,
      )
      .get(input.taskId, input.taskCreatedAt, kind, key) as
      | RecordRow
      | undefined;
    return row ? recordFromRow(row) : undefined;
  };

  const liveCount = (input: TaskMemoryIncarnation, kind: TaskRecordKind) =>
    Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM task_record_versions v
              WHERE v.task_id = ? AND v.task_created_at = ? AND v.kind = ?
                AND v.state IN ('active', 'open') AND ${IS_CURRENT_VERSION}`,
          )
          .get(input.taskId, input.taskCreatedAt, kind) as { count: number }
      ).count,
    );

  const listRecords = (input: TaskMemoryIncarnation) =>
    (
      db
        .prepare(
          `SELECT ${RECORD_COLUMNS} FROM task_record_versions v
            WHERE v.task_id = ? AND v.task_created_at = ? AND ${IS_CURRENT_VERSION}
            ORDER BY (SELECT MIN(f.ordinal) FROM task_record_versions f
                       WHERE f.task_id = v.task_id
                         AND f.task_created_at = v.task_created_at
                         AND f.kind = v.kind AND f.record_key = v.record_key)`,
        )
        .all(input.taskId, input.taskCreatedAt) as RecordRow[]
    ).map(recordFromRow);

  /** Live records ordered by when their current version was written. */
  const liveByRecency = (input: TaskMemoryIncarnation) =>
    (
      db
        .prepare(
          `SELECT ${RECORD_COLUMNS} FROM task_record_versions v
            WHERE v.task_id = ? AND v.task_created_at = ?
              AND v.state IN ('active', 'open') AND ${IS_CURRENT_VERSION}
            ORDER BY v.ordinal`,
        )
        .all(input.taskId, input.taskCreatedAt) as RecordRow[]
    ).map(recordFromRow);

  const readDismissal = (
    input: TaskMemoryIncarnation & TaskLearningDismissal,
  ) => {
    const row = db
      .prepare(
        `SELECT ${DISMISSAL_COLUMNS} FROM task_learning_dismissals
          WHERE task_id = ? AND task_created_at = ? AND kind = ?
            AND record_key = ? AND version = ?`,
      )
      .get(
        input.taskId,
        input.taskCreatedAt,
        input.kind,
        input.key,
        input.version,
      ) as DismissalRow | undefined;
    return row ? dismissalFromRow(row) : undefined;
  };

  return {
    updateSummary(input) {
      if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0)
        return {
          kind: 'refused',
          refusal: { kind: 'base-revision-invalid' },
        };
      const refusal = taskSummaryRefusal(input.text);
      if (refusal) return { kind: 'refused', refusal };
      return transact<TaskSummaryUpdateResult>(input.beforeCommit, () => {
        const current = readSummary(input);
        if ((current?.revision ?? 0) !== input.baseRevision)
          return { commit: false, value: { kind: 'stale-base', current } };
        if (current && current.text === input.text)
          return {
            commit: false,
            value: { kind: 'updated', summary: current, unchanged: true },
          };
        const summary: TaskSummaryRevision = {
          taskId: input.taskId,
          revision: input.baseRevision + 1,
          text: input.text,
          author: input.author,
          createdAt: now().toISOString(),
        };
        db.prepare(
          `INSERT INTO task_summary_revisions (project_id, task_id,
             task_created_at, revision, text, author_kind, author_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.projectId,
          input.taskId,
          input.taskCreatedAt,
          summary.revision,
          summary.text,
          input.author.kind,
          authorId(input.author),
          summary.createdAt,
        );
        return { commit: true, value: { kind: 'updated', summary } };
      });
    },

    readSummary,

    listSummaryRevisions(input) {
      const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
      const rows = db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS} FROM task_summary_revisions
            WHERE task_id = ? AND task_created_at = ?
            ORDER BY revision DESC LIMIT ?`,
        )
        .all(input.taskId, input.taskCreatedAt, limit) as SummaryRow[];
      const total = Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM task_summary_revisions
                WHERE task_id = ? AND task_created_at = ?`,
            )
            .get(input.taskId, input.taskCreatedAt) as { count: number }
        ).count,
      );
      return { revisions: rows.map(summaryFromRow), total };
    },

    writeRecord(input) {
      const checked = checkTaskRecordWrite(input.write);
      if (!checked.ok) return { kind: 'refused', refusal: checked.refusal };
      const write = checked.write;
      return transact<TaskRecordWriteResult>(input.beforeCommit, () => {
        const refuse = (refusal: TaskMemoryRefusal) => ({
          commit: false,
          value: { kind: 'refused' as const, refusal },
        });
        const previous = currentRecord(input, write.kind, write.key);
        let next: Omit<TaskMemoryRecord, 'taskId' | 'author' | 'createdAt'>;
        if (write.action === 'set') {
          // A key that is not live takes a slot; superseding a live key does not.
          if (!previous || !isLiveTaskRecord(previous)) {
            const limit = caps[write.kind];
            if (liveCount(input, write.kind) >= limit)
              return refuse({
                kind: 'live-cap',
                recordKind: write.kind,
                limit,
              });
          }
          next = {
            kind: write.kind,
            key: write.key,
            version: (previous?.version ?? 0) + 1,
            action: 'set',
            state: write.kind === 'question' ? 'open' : 'active',
            importance:
              write.importance ??
              previous?.importance ??
              TASK_RECORD_DEFAULT_IMPORTANCE[write.kind],
            text: write.text!,
          };
        } else if (!previous) {
          return refuse({ kind: 'record-missing' });
        } else if (write.action === 'answer') {
          if (previous.state !== 'open')
            return refuse({ kind: 'question-not-open', state: previous.state });
          next = {
            kind: write.kind,
            key: write.key,
            version: previous.version + 1,
            action: 'answer',
            state: 'answered',
            importance: previous.importance,
            text: previous.text,
            answer: write.text!,
          };
        } else {
          if (previous.state === 'retired')
            return refuse({ kind: 'record-retired' });
          next = {
            kind: write.kind,
            key: write.key,
            version: previous.version + 1,
            action: 'retire',
            state: 'retired',
            importance: previous.importance,
            text: previous.text,
            reason: write.reason!,
          };
        }
        const record: TaskMemoryRecord = {
          taskId: input.taskId,
          ...next,
          author: input.author,
          createdAt: now().toISOString(),
        };
        const ordinal =
          Number(
            (
              db
                .prepare(
                  `SELECT COALESCE(MAX(ordinal), 0) AS last
                     FROM task_record_versions
                    WHERE task_id = ? AND task_created_at = ?`,
                )
                .get(input.taskId, input.taskCreatedAt) as { last: number }
            ).last,
          ) + 1;
        db.prepare(
          `INSERT INTO task_record_versions (project_id, task_id,
             task_created_at, ordinal, kind, record_key, version, action, state,
             importance, text, answer, reason, author_kind, author_id,
             created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.projectId,
          input.taskId,
          input.taskCreatedAt,
          ordinal,
          record.kind,
          record.key,
          record.version,
          record.action,
          record.state,
          record.importance,
          record.text,
          record.answer ?? null,
          record.reason ?? null,
          input.author.kind,
          authorId(input.author),
          record.createdAt,
        );
        return { commit: true, value: { kind: 'recorded', record } };
      });
    },

    listRecords,

    listRecordVersions(input) {
      return (
        db
          .prepare(
            `SELECT ${RECORD_COLUMNS} FROM task_record_versions v
              WHERE v.task_id = ? AND v.task_created_at = ? AND v.kind = ?
                AND v.record_key = ?
              ORDER BY v.version`,
          )
          .all(
            input.taskId,
            input.taskCreatedAt,
            input.kind,
            input.key,
          ) as RecordRow[]
      ).map(recordFromRow);
    },

    listStandingRecords(input) {
      const live = liveByRecency(input).filter(
        (record) => record.importance === 'standing',
      );
      return {
        decisions: live.filter((record) => record.kind === 'decision'),
        deadEnds: live.filter((record) => record.kind === 'dead_end'),
      };
    },

    dismissLearningCandidate(input) {
      const result = transact<TaskLearningDismissResult>(
        input.beforeCommit,
        () => {
          const existing = readDismissal(input);
          if (existing)
            return {
              commit: false,
              value: { kind: 'already-dismissed', dismissal: existing },
            };
          const current = currentRecord(input, input.kind, input.key);
          if (
            !current ||
            current.version !== input.version ||
            current.state !== 'active' ||
            current.importance !== 'standing'
          )
            return { commit: false, value: { kind: 'not-a-candidate' } };
          const dismissal: TaskLearningDismissalRecord = {
            kind: input.kind,
            key: input.key,
            version: input.version,
            principalId: input.principalId,
            dismissedAt: now().toISOString(),
          };
          db.prepare(
            `INSERT INTO task_learning_dismissals (project_id, task_id,
               task_created_at, kind, record_key, version, principal_id,
               dismissed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            input.projectId,
            input.taskId,
            input.taskCreatedAt,
            dismissal.kind,
            dismissal.key,
            dismissal.version,
            dismissal.principalId,
            dismissal.dismissedAt,
          );
          return { commit: true, value: { kind: 'dismissed', dismissal } };
        },
      );
      return result;
    },

    listLearningDismissals(input) {
      return (
        db
          .prepare(
            `SELECT ${DISMISSAL_COLUMNS} FROM task_learning_dismissals
              WHERE task_id = ? AND task_created_at = ?
              ORDER BY dismissed_at, kind, record_key, version`,
          )
          .all(input.taskId, input.taskCreatedAt) as DismissalRow[]
      ).map(dismissalFromRow);
    },

    listOpenQuestions(input) {
      return liveByRecency(input)
        .filter((record) => record.state === 'open')
        .map((record) => ({
          record,
          ...(record.author.kind === 'session'
            ? { askedBySessionId: record.author.sessionId }
            : {}),
        }));
    },

    countOpenQuestions(incarnations) {
      const counts = new Map<string, number>();
      const wanted = new Map(
        incarnations.map((entry) => [entry.taskId, entry.taskCreatedAt]),
      );
      const ids = [...wanted.keys()];
      for (let start = 0; start < ids.length; start += COUNT_CHUNK) {
        const chunk = ids.slice(start, start + COUNT_CHUNK);
        const rows = db
          .prepare(
            `SELECT v.task_id, v.task_created_at, COUNT(*) AS count
               FROM task_record_versions v
              WHERE v.task_id IN (${chunk.map(() => '?').join(', ')})
                AND v.kind = 'question' AND v.state = 'open'
                AND ${IS_CURRENT_VERSION}
              GROUP BY v.task_id, v.task_created_at`,
          )
          .all(...chunk) as Array<{
          task_id: string;
          task_created_at: string;
          count: number;
        }>;
        // Only the incarnation asked about: an earlier one's questions
        // belong to a Task that no longer exists.
        for (const row of rows)
          if (wanted.get(row.task_id) === row.task_created_at)
            counts.set(row.task_id, Number(row.count));
      }
      return counts;
    },
  };
}
