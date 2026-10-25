import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  canAppendTaskReviewEvent,
  deriveThreadState,
  TASK_REVIEW_LIMITS as LIMITS,
  parseTaskReviewAnchor,
  type TaskCapture,
  type TaskReviewAuthor,
  type TaskReviewCreateThreadRequest,
  type TaskReviewEvent,
  type TaskReviewRefusalCode,
  type TaskReviewResponse,
  type TaskReviewThread,
} from '@kontourai/station-contracts/task-review';
import type { SqliteDatabase } from './sqlite-database.js';

export interface TaskReviewIncarnation {
  readonly taskId: string;
  readonly taskCreatedAt: string;
}
export interface TaskReviewWriteContext extends TaskReviewIncarnation {
  readonly projectId: string;
  readonly author: TaskReviewAuthor;
  readonly beforeCommit: () => boolean;
}
type EventPayload = TaskReviewEvent extends infer E
  ? E extends TaskReviewEvent
    ? Omit<E, 'threadId' | 'ordinal' | 'operationId' | 'createdAt' | 'author'>
    : never
  : never;
export type TaskReviewEventWrite = EventPayload & {
  readonly operationId: string;
};
type CaptureInput = Omit<
  TaskCapture,
  | 'captureId'
  | 'projectId'
  | 'taskId'
  | 'taskCreatedAt'
  | 'author'
  | 'createdAt'
>;
export interface TaskReviewStore {
  /** Internal lookup. Writers must check caller custody inside beforeCommit. */
  readThreadById(threadId: string): TaskReviewThread | undefined;
  createThread(
    input: TaskReviewWriteContext &
      TaskReviewCreateThreadRequest & { quote?: string },
  ): TaskReviewResponse<TaskReviewThread>;
  appendEvent(
    input: TaskReviewWriteContext & {
      threadId: string;
      event: TaskReviewEventWrite;
    },
  ): TaskReviewResponse<TaskReviewThread>;
  listThreads(
    input: TaskReviewIncarnation & {
      state?: 'open' | 'sent' | 'agent-replied' | 'resolved';
    },
  ): TaskReviewThread[];
  readThread(
    input: TaskReviewIncarnation & { threadId: string },
  ): TaskReviewThread | undefined;
  recordSend(
    input: TaskReviewWriteContext & {
      threadIds: readonly string[];
      deliveryKey: string;
      operationId: string;
    },
  ): TaskReviewResponse<readonly TaskReviewThread[]>;
  recordSendFailed(
    input: TaskReviewWriteContext & {
      threadIds: readonly string[];
      reason: string;
      operationId: string;
    },
  ): TaskReviewResponse<readonly TaskReviewThread[]>;
  createCapture(
    input: TaskReviewWriteContext & CaptureInput,
  ): TaskReviewResponse<TaskCapture>;
  listCaptures(input: TaskReviewIncarnation): TaskCapture[];
}

const ok = <T>(data: T): TaskReviewResponse<T> => ({ success: true, data });
const reviewRefusal = (
  code: TaskReviewRefusalCode,
  error: string,
): TaskReviewResponse<never> => ({ success: false, code, error });
const invalid = () =>
  reviewRefusal(
    'invalid-request',
    'Invalid Task review write. Nothing was written.',
  );
const conflict = () =>
  reviewRefusal(
    'operation-conflict',
    'That operation id already names a different write.',
  );
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const digest = (value: string) => /^sha256:[a-f0-9]{64}$/.test(value);
const authorId = (author: TaskReviewAuthor) =>
  author.kind === 'person' ? author.principalId : author.sessionId;
const authorOf = (
  kind: TaskReviewAuthor['kind'],
  id: string,
): TaskReviewAuthor =>
  kind === 'person' ? { kind, principalId: id } : { kind, sessionId: id };
const validContext = (input: TaskReviewWriteContext) =>
  text(input.taskId, 256) &&
  text(input.taskCreatedAt, 256) &&
  text(input.projectId, 256) &&
  ['person', 'session'].includes(input.author.kind) &&
  text(authorId(input.author), LIMITS.authorIdChars);

interface ThreadRow {
  thread_id: string;
  project_id: string;
  task_id: string;
  task_created_at: string;
  ordinal: number;
  artifact_kind: TaskReviewThread['artifact']['kind'];
  artifact_id: string;
  artifact_revision: string;
  artifact_digest: TaskReviewThread['artifact']['digest'];
  anchor_json: string;
  quote: string | null;
  author_kind: TaskReviewAuthor['kind'];
  author_id: string;
  operation_id: string;
  created_at: string;
}
interface EventRow {
  thread_id: string;
  ordinal: number;
  kind: TaskReviewEvent['kind'];
  author_kind: TaskReviewAuthor['kind'];
  author_id: string;
  body: string | null;
  reason: string | null;
  evidence_json: string | null;
  delivery_key: string | null;
  operation_id: string;
  created_at: string;
}
interface CaptureRow {
  capture_id: string;
  project_id: string;
  task_id: string;
  task_created_at: string;
  source_kind: TaskCapture['sourceKind'];
  source_session_id: string;
  page_url: string | null;
  commit_sha: string;
  media_type: TaskCapture['mediaType'];
  byte_length: number;
  digest: TaskCapture['digest'];
  width: number | null;
  height: number | null;
  label: string | null;
  author_kind: TaskReviewAuthor['kind'];
  author_id: string;
  operation_id: string;
  created_at: string;
}
function eventFromRow(row: EventRow): TaskReviewEvent {
  const identity = {
    threadId: row.thread_id,
    ordinal: row.ordinal,
    operationId: row.operation_id,
    createdAt: row.created_at,
  };
  const author = authorOf(row.author_kind, row.author_id);
  switch (row.kind) {
    case 'comment':
    case 'reply':
      if (author.kind !== 'person')
        throw new Error('Invalid Task review person author');
      return { ...identity, kind: row.kind, author, body: row.body! };
    case 'agent-reply':
      if (author.kind !== 'session')
        throw new Error('Invalid Task review agent author');
      return {
        ...identity,
        kind: row.kind,
        author,
        body: row.body!,
        ...(row.evidence_json
          ? { evidence: JSON.parse(row.evidence_json) }
          : {}),
      };
    case 'sent':
      if (author.kind !== 'person')
        throw new Error('Invalid Task review sender');
      return {
        ...identity,
        kind: row.kind,
        author,
        deliveryKey: row.delivery_key!,
      };
    case 'reopened':
      if (author.kind !== 'person')
        throw new Error('Invalid Task review reopen author');
      return {
        ...identity,
        kind: row.kind,
        author,
        ...(row.reason !== null ? { reason: row.reason } : {}),
      };
    case 'resolved':
    case 'send-failed':
      return { ...identity, kind: row.kind, author, reason: row.reason! };
  }
}
function captureFromRow(row: CaptureRow): TaskCapture {
  return {
    captureId: row.capture_id,
    projectId: row.project_id,
    taskId: row.task_id,
    taskCreatedAt: row.task_created_at,
    sourceKind: row.source_kind,
    sourceSessionId: row.source_session_id,
    commit: row.commit_sha,
    mediaType: row.media_type,
    byteLength: row.byte_length,
    digest: row.digest,
    author: authorOf(row.author_kind, row.author_id),
    operationId: row.operation_id,
    createdAt: row.created_at,
    ...(row.page_url !== null ? { pageUrl: row.page_url } : {}),
    ...(row.width !== null ? { width: row.width } : {}),
    ...(row.height !== null ? { height: row.height } : {}),
    ...(row.label !== null ? { label: row.label } : {}),
  };
}
function validEvent(event: TaskReviewEventWrite, author: TaskReviewAuthor) {
  if (!text(event.operationId, 256)) return false;
  switch (event.kind) {
    case 'reply':
      return text(event.body, LIMITS.bodyChars);
    case 'agent-reply':
      return (
        author.kind === 'session' &&
        text(event.body, LIMITS.bodyChars) &&
        (!event.evidence ||
          JSON.stringify(event.evidence).length <= LIMITS.evidenceJsonChars)
      );
    case 'sent':
      return author.kind === 'person' && text(event.deliveryKey, 256);
    case 'reopened':
      return (
        author.kind === 'person' &&
        (event.reason === undefined || text(event.reason, LIMITS.reasonChars))
      );
    case 'resolved':
    case 'send-failed':
      return text(event.reason, LIMITS.reasonChars);
    default:
      return false;
  }
}

export function createSqliteTaskReviewStore(
  db: SqliteDatabase,
): TaskReviewStore {
  const transact = <T>(
    input: TaskReviewWriteContext,
    write: () => TaskReviewResponse<T>,
  ): TaskReviewResponse<T> => {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!input.beforeCommit()) {
        db.exec('ROLLBACK');
        return reviewRefusal(
          'not-found',
          'The Task or its authority changed. Nothing was written.',
        );
      }
      const result = validContext(input) ? write() : invalid();
      // The caller is synchronous, so this also catches a revocation observed during validation.
      if (result.success && !input.beforeCommit()) {
        db.exec('ROLLBACK');
        return reviewRefusal(
          'not-found',
          'The Task or its authority changed. Nothing was written.',
        );
      }
      db.exec(result.success ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const fromRow = (
    row: ThreadRow,
    events?: readonly TaskReviewEvent[],
  ): TaskReviewThread => ({
    threadId: row.thread_id,
    projectId: row.project_id,
    taskId: row.task_id,
    taskCreatedAt: row.task_created_at,
    ordinal: row.ordinal,
    artifact: {
      kind: row.artifact_kind,
      id: row.artifact_id,
      revision: row.artifact_revision,
      digest: row.artifact_digest,
    },
    anchor: JSON.parse(row.anchor_json),
    ...(row.quote !== null ? { quote: row.quote } : {}),
    author: authorOf(row.author_kind, row.author_id),
    operationId: row.operation_id,
    createdAt: row.created_at,
    events:
      events ??
      (
        db
          .prepare(
            'SELECT * FROM task_review_events WHERE thread_id = ? ORDER BY ordinal',
          )
          .all(row.thread_id) as EventRow[]
      ).map(eventFromRow),
  });
  const readThread: TaskReviewStore['readThread'] = (input) => {
    const row = db
      .prepare(
        'SELECT * FROM task_review_threads WHERE task_id = ? AND task_created_at = ? AND thread_id = ?',
      )
      .get(input.taskId, input.taskCreatedAt, input.threadId) as
      | ThreadRow
      | undefined;
    return row ? fromRow(row) : undefined;
  };
  const listThreads: TaskReviewStore['listThreads'] = (input) => {
    const rows = db
      .prepare(
        'SELECT * FROM task_review_threads WHERE task_id = ? AND task_created_at = ? ORDER BY ordinal',
      )
      .all(input.taskId, input.taskCreatedAt) as ThreadRow[];
    const events = db
      .prepare(`SELECT e.* FROM task_review_events e
      JOIN task_review_threads t ON t.thread_id = e.thread_id
      WHERE t.task_id = ? AND t.task_created_at = ? ORDER BY e.thread_id, e.ordinal`)
      .all(input.taskId, input.taskCreatedAt) as EventRow[];
    const grouped = new Map<string, TaskReviewEvent[]>();
    for (const row of events) {
      const group = grouped.get(row.thread_id) ?? [];
      group.push(eventFromRow(row));
      grouped.set(row.thread_id, group);
    }
    const threads = rows.map((row) =>
      fromRow(row, grouped.get(row.thread_id) ?? []),
    );
    return input.state
      ? threads.filter((t) => deriveThreadState(t.events) === input.state)
      : threads;
  };
  const listCaptures: TaskReviewStore['listCaptures'] = (input) =>
    (
      db
        .prepare(
          'SELECT * FROM task_review_captures WHERE task_id = ? AND task_created_at = ? ORDER BY created_at, capture_id',
        )
        .all(input.taskId, input.taskCreatedAt) as CaptureRow[]
    ).map(captureFromRow);
  const insertEvent = (
    threadId: string,
    ordinal: number,
    author: TaskReviewAuthor,
    event: TaskReviewEventWrite,
  ) => {
    db.prepare(`INSERT INTO task_review_events (thread_id, ordinal, kind, author_kind, author_id, body, reason, evidence_json, delivery_key, operation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      threadId,
      ordinal,
      event.kind,
      author.kind,
      authorId(author),
      'body' in event ? event.body : null,
      'reason' in event ? (event.reason ?? null) : null,
      'evidence' in event && event.evidence
        ? JSON.stringify(event.evidence)
        : null,
      'deliveryKey' in event ? event.deliveryKey : null,
      event.operationId,
      new Date().toISOString(),
    );
  };
  const append = (
    input: TaskReviewWriteContext,
    threadId: string,
    event: TaskReviewEventWrite,
  ): TaskReviewResponse<TaskReviewThread> => {
    if (!validEvent(event, input.author)) return invalid();
    const thread = readThread({ ...input, threadId });
    if (!thread || thread.projectId !== input.projectId)
      return reviewRefusal('not-found', 'Review thread not found.');
    const prior = thread.events.find(
      (e) => e.operationId === event.operationId,
    );
    if (prior) {
      const {
        threadId: _thread,
        ordinal: _ordinal,
        createdAt: _at,
        ...payload
      } = prior;
      return isDeepStrictEqual(payload, { ...event, author: input.author })
        ? ok(thread)
        : conflict();
    }
    if (thread.events.length >= LIMITS.eventsPerThread)
      return reviewRefusal(
        'event-limit',
        'This thread has reached its event limit.',
      );
    const transition = canAppendTaskReviewEvent(
      deriveThreadState(thread.events),
      {
        ...event,
        threadId,
        ordinal: thread.events.length + 1,
        author: input.author,
        createdAt: new Date().toISOString(),
      },
    );
    if (!transition.allowed)
      return reviewRefusal(
        transition.code,
        'That review event cannot follow the current thread state.',
      );
    insertEvent(threadId, thread.events.length + 1, input.author, event);
    return ok(readThread({ ...input, threadId })!);
  };
  const batch = (
    input: TaskReviewWriteContext & { threadIds: readonly string[] },
    event: TaskReviewEventWrite,
  ): TaskReviewResponse<readonly TaskReviewThread[]> =>
    transact(input, () => {
      if (
        !input.threadIds.length ||
        input.threadIds.length > LIMITS.threadsPerTask ||
        new Set(input.threadIds).size !== input.threadIds.length
      )
        return invalid();
      const threads: TaskReviewThread[] = [];
      for (const threadId of input.threadIds) {
        const result = append(input, threadId, event);
        if (!result.success) return result;
        threads.push(result.data);
      }
      return ok(threads);
    });
  return {
    readThreadById: (threadId) => {
      const row = db
        .prepare('SELECT * FROM task_review_threads WHERE thread_id = ?')
        .get(threadId) as ThreadRow | undefined;
      return row ? fromRow(row) : undefined;
    },
    readThread,
    listThreads,
    listCaptures,
    createThread: (input) =>
      transact(input, () => {
        const anchor = parseTaskReviewAnchor(input.anchor);
        if (
          !anchor ||
          !text(input.operationId, 256) ||
          !text(input.body, LIMITS.bodyChars) ||
          !['plan', 'summary', 'output', 'answer', 'capture'].includes(
            input.artifact.kind,
          ) ||
          !text(input.artifact.id, LIMITS.artifactIdChars) ||
          !text(input.artifact.revision, LIMITS.artifactRevisionChars) ||
          !digest(input.artifact.digest) ||
          (input.quote !== undefined &&
            !text(input.quote, LIMITS.quoteChars)) ||
          (anchor.kind !== 'whole' &&
            (anchor.kind === 'region') !== (input.artifact.kind === 'capture'))
        )
          return invalid();
        const prior = listThreads(input).find(
          (t) => t.operationId === input.operationId,
        );
        if (prior)
          return isDeepStrictEqual(
            {
              artifact: prior.artifact,
              anchor: prior.anchor,
              body:
                prior.events[0]?.kind === 'comment'
                  ? prior.events[0].body
                  : undefined,
              author: prior.author,
            },
            {
              artifact: input.artifact,
              anchor,
              body: input.body,
              author: input.author,
            },
          )
            ? ok(prior)
            : conflict();
        const count = Number(
          (
            db
              .prepare(
                'SELECT COUNT(*) AS n FROM task_review_threads WHERE task_id = ? AND task_created_at = ?',
              )
              .get(input.taskId, input.taskCreatedAt) as { n: number }
          ).n,
        );
        if (count >= LIMITS.threadsPerTask)
          return reviewRefusal(
            'thread-limit',
            'This Task has reached its thread limit.',
          );
        const threadId = randomUUID();
        db.prepare(`INSERT INTO task_review_threads (thread_id, project_id, task_id, task_created_at, ordinal, artifact_kind, artifact_id, artifact_revision, artifact_digest, anchor_kind, anchor_json, quote, author_kind, author_id, operation_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          threadId,
          input.projectId,
          input.taskId,
          input.taskCreatedAt,
          count + 1,
          input.artifact.kind,
          input.artifact.id,
          input.artifact.revision,
          input.artifact.digest,
          anchor.kind,
          JSON.stringify(anchor),
          anchor.kind === 'text-quote' ? anchor.exact : (input.quote ?? null),
          input.author.kind,
          authorId(input.author),
          input.operationId,
          new Date().toISOString(),
        );
        insertEvent(threadId, 1, input.author, {
          kind: 'comment',
          body: input.body,
          operationId: input.operationId,
        });
        return ok(readThread({ ...input, threadId })!);
      }),
    appendEvent: (input) =>
      transact(input, () => append(input, input.threadId, input.event)),
    recordSend: (input) =>
      batch(input, {
        kind: 'sent',
        deliveryKey: input.deliveryKey,
        operationId: input.operationId,
      }),
    recordSendFailed: (input) =>
      batch(input, {
        kind: 'send-failed',
        reason: input.reason,
        operationId: input.operationId,
      }),
    createCapture: (input) =>
      transact(input, () => {
        if (
          !text(input.operationId, 256) ||
          !['browser', 'device'].includes(input.sourceKind) ||
          !text(input.sourceSessionId, 256) ||
          !/^[a-f0-9]{40}$/.test(input.commit) ||
          !['image/png', 'image/jpeg'].includes(input.mediaType) ||
          !digest(input.digest) ||
          !Number.isSafeInteger(input.byteLength) ||
          input.byteLength < 1 ||
          input.byteLength > LIMITS.captureBytes ||
          (input.pageUrl !== undefined &&
            !text(input.pageUrl, LIMITS.pageUrlChars)) ||
          (input.label !== undefined &&
            !text(input.label, LIMITS.labelChars)) ||
          [input.width, input.height].some(
            (n) => n !== undefined && (!Number.isSafeInteger(n) || n < 1),
          )
        )
          return invalid();
        const captures = listCaptures(input);
        const prior = captures.find((c) => c.operationId === input.operationId);
        const candidate = {
          sourceKind: input.sourceKind,
          sourceSessionId: input.sourceSessionId,
          commit: input.commit,
          mediaType: input.mediaType,
          byteLength: input.byteLength,
          digest: input.digest,
          author: input.author,
          operationId: input.operationId,
          ...(input.pageUrl !== undefined ? { pageUrl: input.pageUrl } : {}),
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.width !== undefined ? { width: input.width } : {}),
          ...(input.height !== undefined ? { height: input.height } : {}),
        };
        if (prior) {
          const {
            captureId: _id,
            createdAt: _at,
            taskId: _task,
            taskCreatedAt: _inc,
            projectId: _project,
            ...payload
          } = prior;
          return isDeepStrictEqual(payload, candidate) ? ok(prior) : conflict();
        }
        if (captures.length >= LIMITS.capturesPerTask)
          return reviewRefusal(
            'capture-limit',
            'This Task has reached its capture limit.',
          );
        const home = db
          .prepare(
            'SELECT COALESCE(SUM(bytes), 0) AS n FROM (SELECT MAX(byte_length) AS bytes FROM task_review_captures GROUP BY digest)',
          )
          .get() as { n: number };
        const existing = db
          .prepare(
            'SELECT byte_length FROM task_review_captures WHERE digest = ? LIMIT 1',
          )
          .get(input.digest) as { byte_length: number } | undefined;
        if (existing && existing.byte_length !== input.byteLength)
          return invalid();
        if (
          Number(home.n) + (existing ? 0 : input.byteLength) >
          LIMITS.captureHomeBytes
        )
          return reviewRefusal(
            'capture-home-limit',
            'Capture metadata has reached the home byte limit.',
          );
        const captureId = randomUUID();
        db.prepare(`INSERT INTO task_review_captures (capture_id, project_id, task_id, task_created_at, source_kind, source_session_id, page_url, commit_sha, media_type, byte_length, digest, width, height, label, author_kind, author_id, operation_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          captureId,
          input.projectId,
          input.taskId,
          input.taskCreatedAt,
          input.sourceKind,
          input.sourceSessionId,
          input.pageUrl ?? null,
          input.commit,
          input.mediaType,
          input.byteLength,
          input.digest,
          input.width ?? null,
          input.height ?? null,
          input.label ?? null,
          input.author.kind,
          authorId(input.author),
          input.operationId,
          new Date().toISOString(),
        );
        return ok(listCaptures(input).find((c) => c.captureId === captureId)!);
      }),
  };
}
