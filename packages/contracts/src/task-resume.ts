/**
 * Resuming an ended Task (#4554, owner-approved option B, 2026-11-06).
 *
 * The Station operator in person may move a tracker-backed Task from `done`
 * back to `ready` within {@link TASK_RESUME_WINDOW_MS} of its `endedAt`.
 * Resume starts no work: a separate, separately authorized dispatch does.
 * `canceled` Tasks stay ended. See `docs/design/ended-task-resume.md`.
 *
 * {@link taskResumeRefusal} is the one reading of the Task-intrinsic rules,
 * shared by the server (which also checks authority, the dispatch
 * reservation, open turns and the work item's other Tasks under its store
 * lock) and the UI (which shows why Resume is unavailable).
 */
import type { ClientOrigin } from './client-origin.js';
import type { TaskRecord } from './task-graph.js';
import { canonicalGitHubWorkItemRef } from './work-item-provider.js';

/** Resume is allowed while `now - endedAt` is at most this: 14 days. */
export const TASK_RESUME_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Resumes recorded per Task incarnation; the next one is refused. */
export const TASK_RESUME_MAX_PER_INCARNATION = 20;
/** The person's reason, in characters. */
export const TASK_RESUME_REASON_MAX_CHARS = 500;
/** The client-generated idempotency key, in characters. */
export const TASK_RESUME_ID_MAX_CHARS = 128;

/** `createdBy` values whose Task lifecycle an automation owns. */
const AUTOMATION_CREATORS: ReadonlySet<string> = new Set([
  'automation-rule',
  'external-monitor',
]);

/**
 * One resume, stored with the Task in the same write as the status change.
 * Immutable once written; at most {@link TASK_RESUME_MAX_PER_INCARNATION}
 * per incarnation.
 */
export interface TaskResumeRecord {
  /** The client-generated idempotency key. */
  resumeId: string;
  taskId: string;
  /** The incarnation resumed. */
  taskCreatedAt: string;
  fromStatus: 'done';
  /** The end time this resume cleared. */
  endedAt: string;
  /** Server time. */
  resumedAt: string;
  /** The resumer's principal id. */
  resumedBy: string;
  /** The request's authenticated origin, when the server resolved one. */
  clientOrigin?: ClientOrigin;
  /** The person's own words, at most {@link TASK_RESUME_REASON_MAX_CHARS}. */
  reason: string;
  /** The earlier lead Session's recorded owner, when there was one. */
  previousLeadOwner?: string;
  /** The lead attachment this resume cleared, when there was one. */
  previousSessionId?: string;
  previousDispatchedAt?: string;
  /** The latest follow-up `recordedAt` the person was shown, if any. */
  followUpsSeenThrough?: string;
}

/** `POST /api/tasks/:taskId/resume`. */
export interface TaskResumeRequest {
  resumeId: string;
  /** The incarnation the person saw. */
  expectedCreatedAt: string;
  /** The end time the person saw. */
  expectedEndedAt: string;
  reason: string;
  followUpsSeenThrough?: string;
}

export interface TaskResumeResult {
  /** The Task as it is now, never a saved snapshot. */
  task: TaskRecord;
  resume: TaskResumeRecord;
  /** True when this answered a retry of an already committed resume. */
  replayed: boolean;
}

export const TASK_RESUME_REFUSAL_CODES = [
  'task_resume_unavailable',
  'task_resume_not_permitted',
  'task_resume_not_supported',
  'task_resume_not_ended',
  'task_resume_canceled',
  'task_resume_end_unknown',
  'task_resume_expired',
  'task_resume_conflict',
  'task_resume_work_item_taken',
  'task_resume_dispatch_reserved',
  'task_resume_turn_running',
  'task_resume_limit',
] as const;
export type TaskResumeRefusalCode = (typeof TASK_RESUME_REFUSAL_CODES)[number];

export function isTaskResumeRefusalCode(
  value: unknown,
): value is TaskResumeRefusalCode {
  return (
    typeof value === 'string' &&
    (TASK_RESUME_REFUSAL_CODES as readonly string[]).includes(value)
  );
}

/** The Task-intrinsic refusals {@link taskResumeRefusal} can answer. */
export type TaskResumeIntrinsicRefusal = Extract<
  TaskResumeRefusalCode,
  | 'task_resume_not_supported'
  | 'task_resume_not_ended'
  | 'task_resume_canceled'
  | 'task_resume_end_unknown'
  | 'task_resume_expired'
  | 'task_resume_limit'
>;

/** Whether the Task's work item is one resume supports. */
export function isTaskResumeSupported(
  task: Pick<TaskRecord, 'workItemRef' | 'workItemProvenance' | 'createdBy'>,
): boolean {
  return (
    !AUTOMATION_CREATORS.has(task.createdBy) &&
    task.workItemProvenance === 'project-board' &&
    task.workItemRef !== undefined &&
    canonicalGitHubWorkItemRef(task.workItemRef) !== null
  );
}

/** When resume stops being allowed, or undefined without a known end. */
export function taskResumeDeadline(
  task: Pick<TaskRecord, 'endedAt'>,
): string | undefined {
  if (task.endedAt === undefined) return undefined;
  const ended = Date.parse(task.endedAt);
  return Number.isNaN(ended)
    ? undefined
    : new Date(ended + TASK_RESUME_WINDOW_MS).toISOString();
}

/**
 * Why this Task cannot be resumed at `now`, from the Task alone, or
 * undefined when nothing on the Task refuses it. An unknown or unparsable
 * end time refuses; the window is never inferred from `updatedAt`.
 */
export function taskResumeRefusal(
  task: Pick<
    TaskRecord,
    | 'status'
    | 'endedAt'
    | 'resumes'
    | 'workItemRef'
    | 'workItemProvenance'
    | 'createdBy'
  >,
  now: number = Date.now(),
): TaskResumeIntrinsicRefusal | undefined {
  if (!isTaskResumeSupported(task)) return 'task_resume_not_supported';
  if (task.status === 'canceled') return 'task_resume_canceled';
  if (task.status !== 'done') return 'task_resume_not_ended';
  if (task.endedAt === undefined) return 'task_resume_end_unknown';
  const ended = Date.parse(task.endedAt);
  if (Number.isNaN(ended)) return 'task_resume_end_unknown';
  if (now - ended > TASK_RESUME_WINDOW_MS) return 'task_resume_expired';
  if ((task.resumes?.length ?? 0) >= TASK_RESUME_MAX_PER_INCARNATION)
    return 'task_resume_limit';
  return undefined;
}

/** What a person reads for each refusal code. */
export function taskResumeRefusalText(code: TaskResumeRefusalCode): string {
  switch (code) {
    case 'task_resume_unavailable':
      return 'Resume is not available on this Station.';
    case 'task_resume_not_permitted':
      return 'Only the Station operator, in person and with access to this Task, can resume it.';
    case 'task_resume_not_supported':
      return 'Only Tasks on a GitHub item from the Project board, not created by an automation, can be resumed.';
    case 'task_resume_not_ended':
      return 'This Task is not done.';
    case 'task_resume_canceled':
      return 'A canceled Task stays ended. Start a new Task on the work item instead.';
    case 'task_resume_end_unknown':
      return 'This Task ended before Station recorded end times, so it cannot be resumed.';
    case 'task_resume_expired':
      return 'More than 14 days have passed since this Task ended.';
    case 'task_resume_conflict':
      return 'This Task changed since you opened it. Review it again.';
    case 'task_resume_work_item_taken':
      return 'Another open Task holds this work item.';
    case 'task_resume_dispatch_reserved':
      return 'A dispatch of this Task is being established.';
    case 'task_resume_turn_running':
      return 'A Session of this Task is still running a turn, or its worktree is in use.';
    case 'task_resume_limit':
      return 'This Task has been resumed 20 times. Start a new Task instead.';
  }
}

/**
 * The request body's shape, checked without trimming or rewriting: a value
 * the person did not send is never stored.
 */
export function validateTaskResumeRequest(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return ['body must be an object'];
  const body = value as Record<string, unknown>;
  const allowed = new Set([
    'resumeId',
    'expectedCreatedAt',
    'expectedEndedAt',
    'reason',
    'followUpsSeenThrough',
  ]);
  for (const key of Object.keys(body))
    if (!allowed.has(key)) problems.push(`${key}: unknown field`);
  const id = body.resumeId;
  if (
    typeof id !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(id) ||
    id.length > TASK_RESUME_ID_MAX_CHARS
  )
    problems.push(
      `resumeId: 1-${TASK_RESUME_ID_MAX_CHARS} letters, digits, '-' or '_'`,
    );
  for (const key of ['expectedCreatedAt', 'expectedEndedAt'] as const)
    if (!isCanonicalInstant(body[key]))
      problems.push(`${key}: must be a canonical ISO timestamp`);
  if (
    body.followUpsSeenThrough !== undefined &&
    !isCanonicalInstant(body.followUpsSeenThrough)
  )
    problems.push('followUpsSeenThrough: must be a canonical ISO timestamp');
  const reason = body.reason;
  if (
    typeof reason !== 'string' ||
    reason.trim().length === 0 ||
    reason.length > TASK_RESUME_REASON_MAX_CHARS
  )
    problems.push(
      `reason: 1-${TASK_RESUME_REASON_MAX_CHARS} characters, not only spaces`,
    );
  return problems;
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}
