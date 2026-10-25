import type { TaskGateEvaluationReferenceInput } from './task-graph.js';
import type { TaskMemoryAuthor } from './task-memory.js';

export const TASK_REVIEW_VERSION = 'station.task-review/v1' as const;

/** Every bound is a refusal, never truncation or eviction. Text uses UTF-16 code units. */
export const TASK_REVIEW_LIMITS = Object.freeze({
  threadsPerTask: 500,
  eventsPerThread: 200,
  capturesPerTask: 200,
  captureHomeBytes: 512 * 1024 * 1024,
  captureBytes: 16 * 1024 * 1024,
  artifactIdChars: 512,
  artifactRevisionChars: 256,
  authorIdChars: 256,
  anchorJsonChars: 4096,
  quoteChars: 2000,
  bodyChars: 4000,
  reasonChars: 500,
  evidenceJsonChars: 4096,
  pageUrlChars: 2048,
  labelChars: 120,
});

export type TaskReviewArtifactKind =
  | 'plan'
  | 'summary'
  | 'output'
  | 'answer'
  | 'capture';

export interface TaskReviewArtifactRef {
  readonly kind: TaskReviewArtifactKind;
  /** Document id, 'summary', output id, sessionId/turnId, or capture id. */
  readonly id: string;
  /** Plan working-state revision, decimal summary revision, digest, or turn id. */
  readonly revision: string;
  readonly digest: `sha256:${string}`;
}

export type TaskReviewAnchor =
  | {
      readonly kind: 'text-quote';
      /** Zero-based, half-open UTF-16 offsets into the original text. */
      readonly start: number;
      readonly end: number;
      readonly exact: string;
      readonly prefix: string;
      readonly suffix: string;
    }
  | {
      readonly kind: 'block';
      readonly startLine: number;
      readonly endLine: number;
    }
  | {
      readonly kind: 'region';
      /** Normalized rectangle wholly inside the capture, with positive area. */
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
    }
  | { readonly kind: 'whole' };

export type TaskReviewAuthor = TaskMemoryAuthor;
export type TaskReviewBaseThreadState =
  | 'open'
  | 'sent'
  | 'agent-replied'
  | 'resolved';
/** Outdated is a read-time overlay; it is never an event or stored state. */
export type TaskReviewThreadState = TaskReviewBaseThreadState | 'outdated';
export type TaskReviewOutdated = boolean | 'unknown';
export type TaskReviewFilter = 'open' | 'outdated' | 'resolved';

/** Caller claims. Verification fields can only be supplied by the server. */
export interface TaskReviewEvidenceInput {
  readonly commit?: string;
  readonly gateRefs?: readonly TaskGateEvaluationReferenceInput['ref'][];
  readonly receiptRefs?: readonly string[];
  readonly captureId?: string;
}

export interface TaskReviewEvidence extends TaskReviewEvidenceInput {
  /** True only after git cat-file verifies this commit in the Task workspace. */
  readonly commitVerified: boolean;
  /**
   * True only when every supplied gate ref resolves to a passing evaluation
   * through the gate owner. Otherwise all gate chips say "claimed". Receipt
   * refs are always claims; a ref's existence is not a passing verdict.
   */
  readonly gateVerified: boolean;
}

interface TaskReviewEventIdentity {
  readonly threadId: string;
  readonly ordinal: number;
  readonly operationId: string;
  readonly createdAt: string;
}

export type TaskReviewEvent = TaskReviewEventIdentity &
  (
    | {
        readonly kind: 'comment' | 'reply';
        readonly author: TaskReviewAuthor;
        readonly body: string;
      }
    | {
        readonly kind: 'agent-reply';
        readonly author: Extract<TaskReviewAuthor, { kind: 'session' }>;
        readonly body: string;
        readonly evidence?: TaskReviewEvidence;
      }
    | {
        readonly kind: 'sent';
        readonly author: Extract<TaskReviewAuthor, { kind: 'person' }>;
        readonly deliveryKey: string;
      }
    | {
        readonly kind: 'send-failed' | 'resolved';
        readonly author: TaskReviewAuthor;
        readonly reason: string;
      }
    | {
        readonly kind: 'reopened';
        readonly author: Extract<TaskReviewAuthor, { kind: 'person' }>;
        readonly reason?: string;
      }
  );

/** Durable thread and ordered append-only events, scoped to one Task incarnation. */
export interface TaskReviewThread {
  readonly threadId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskCreatedAt: string;
  readonly ordinal: number;
  readonly artifact: TaskReviewArtifactRef;
  readonly anchor: TaskReviewAnchor;
  /** Retained text for block/whole anchors and for displaying an outdated quote. */
  readonly quote?: string;
  readonly author: TaskReviewAuthor;
  readonly operationId: string;
  readonly createdAt: string;
  readonly events: readonly TaskReviewEvent[];
}

export interface TaskReviewThreadView extends TaskReviewThread {
  readonly baseState: TaskReviewBaseThreadState;
  readonly state: TaskReviewThreadState;
  readonly outdated: TaskReviewOutdated;
  /** Revision changes are shown separately from Outdated. */
  readonly currentRevision?: string;
  readonly deliveryStatus?: 'confirmed' | 'unconfirmed';
}

export interface TaskCapture {
  readonly captureId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskCreatedAt: string;
  readonly sourceKind: 'browser' | 'device';
  readonly sourceSessionId: string;
  /** Capped, sanitized URL; never a blob path. */
  readonly pageUrl?: string;
  /** Full lowercase 40-character commit SHA from a clean workspace. */
  readonly commit: string;
  readonly mediaType: 'image/png' | 'image/jpeg';
  readonly byteLength: number;
  readonly digest: `sha256:${string}`;
  readonly width?: number;
  readonly height?: number;
  readonly label?: string;
  readonly author: TaskReviewAuthor;
  readonly operationId: string;
  readonly createdAt: string;
}

export interface TaskReviewCounts {
  /** Unresolved, non-outdated threads, including sent, agent-replied and unknown freshness. */
  readonly open: number;
  readonly outdated: number;
  readonly resolved: number;
}

export type TaskReviewItem = {
  readonly kind: TaskReviewArtifactKind;
  readonly id: string;
  readonly label: string;
  readonly counts: TaskReviewCounts;
} & (
  | {
      readonly status: 'available';
      readonly artifact: TaskReviewArtifactRef;
      readonly text?: string;
      readonly capture?: TaskCapture;
    }
  | { readonly status: 'unavailable' }
);

export interface TaskReviewView {
  readonly version: typeof TASK_REVIEW_VERSION;
  readonly taskId: string;
  readonly taskCreatedAt: string;
  readonly items: readonly TaskReviewItem[];
  readonly threads: readonly TaskReviewThreadView[];
  /** Unfiltered counts, even when the request selects one state. */
  readonly counts: TaskReviewCounts;
  readonly limits: typeof TASK_REVIEW_LIMITS;
}

export type TaskReviewRefusalCode =
  | 'invalid-request'
  | 'not-found'
  | 'forbidden'
  | 'unavailable'
  | 'no_task_binding'
  | 'no-live-agent'
  | 'anchor-mismatch'
  | 'artifact-unavailable'
  | 'operation-conflict'
  | 'thread-limit'
  | 'event-limit'
  | 'capture-limit'
  | 'capture-home-limit'
  | 'workspace-changed'
  | 'screenshot-too-large'
  | 'capture-unavailable'
  | 'capture-corrupt'
  | 'send-failed';

export interface TaskReviewFailure {
  readonly success: false;
  readonly code: TaskReviewRefusalCode;
  readonly error: string;
}
export type TaskReviewResponse<T> =
  | { readonly success: true; readonly data: T }
  | TaskReviewFailure;

/** GET /api/tasks/:taskId/review. Open includes sent/agent-replied, excludes outdated/resolved. */
export interface TaskReviewListRequest {
  readonly state?: TaskReviewFilter;
}
export type TaskReviewListResponse = TaskReviewResponse<TaskReviewView>;

/** All mutation operation ids are client-issued and stable across retries. */
export interface TaskReviewCreateThreadRequest {
  readonly artifact: TaskReviewArtifactRef;
  readonly anchor: TaskReviewAnchor;
  readonly body: string;
  readonly operationId: string;
}
export type TaskReviewCreateThreadResponse = TaskReviewResponse<{
  readonly thread: TaskReviewThreadView;
}>;

/** POST /api/tasks/:taskId/review/threads/:threadId/replies. */
export interface TaskReviewReplyRequest {
  readonly body: string;
  readonly operationId: string;
}
export type TaskReviewReplyResponse = TaskReviewResponse<{
  readonly thread: TaskReviewThreadView;
}>;

/** POST .../threads/:threadId/resolve. The server records a default reason if omitted. */
export interface TaskReviewResolveRequest {
  readonly reason?: string;
  readonly operationId: string;
}
export type TaskReviewResolveResponse = TaskReviewResponse<{
  readonly thread: TaskReviewThreadView;
}>;

/** POST .../threads/:threadId/reopen; person-only. */
export interface TaskReviewReopenRequest {
  readonly reason?: string;
  readonly operationId: string;
}
export type TaskReviewReopenResponse = TaskReviewResponse<{
  readonly thread: TaskReviewThreadView;
}>;

/** POST /api/tasks/:taskId/review/send; nonempty, unique thread ids from this incarnation. */
export interface TaskReviewSendRequest {
  readonly threadIds: readonly string[];
  readonly operationId: string;
}
export type TaskReviewSendResponse = TaskReviewResponse<{
  readonly deliveryKey: string;
  readonly status: 'queued' | 'unconfirmed' | 'failed';
  readonly threads: readonly TaskReviewThreadView[];
  readonly reason?: string;
}>;

/** POST /api/tasks/:taskId/review/captures. */
export interface TaskReviewCreateCaptureRequest {
  readonly browserSessionId: string;
  readonly label?: string;
  readonly operationId: string;
}
export type TaskReviewCreateCaptureResponse = TaskReviewResponse<{
  readonly capture: TaskCapture;
}>;

/** GET /api/tasks/:taskId/review/captures/:captureId/content. */
export interface TaskReviewCaptureContentRequest {
  readonly taskId: string;
  readonly captureId: string;
}
/** Success is raw image bytes with this Content-Type, never a JSON envelope or local path. */
export type TaskReviewCaptureContentResponse =
  | {
      readonly mediaType: TaskCapture['mediaType'];
      readonly bytes: Uint8Array;
    }
  | TaskReviewFailure;

/** GET /api/orchestration/station-control/task-threads; Task comes from caller binding. */
export interface TaskThreadListRequest {
  readonly state?: TaskReviewFilter;
}
export type TaskThreadListResponse = TaskReviewResponse<{
  readonly taskId: string;
  readonly taskCreatedAt: string;
  readonly threads: readonly TaskReviewThreadView[];
  readonly counts: TaskReviewCounts;
}>;

/** POST /api/orchestration/station-control/task-thread-reply. */
export interface TaskThreadReplyRequest extends TaskReviewEvidenceInput {
  readonly threadId: string;
  readonly text: string;
  readonly operationId: string;
}
export type TaskThreadReplyResponse = TaskReviewResponse<{
  readonly thread: TaskReviewThreadView;
}>;

/** POST /api/orchestration/station-control/task-thread-resolve; never changes Task status. */
export interface TaskThreadResolveRequest {
  readonly threadId: string;
  readonly reason: string;
  readonly operationId: string;
}
export type TaskThreadResolveResponse = TaskReviewResponse<{
  readonly thread: TaskReviewThreadView;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function onlyKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Reflect.ownKeys(record).every(
    (key) => typeof key === 'string' && keys.includes(key),
  );
}

function safeInteger(value: unknown, min: number): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min
  );
}

function finiteNumber(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min;
}

/** Strict object parser; refuses extra keys, invalid geometry and max+1, without coercion. */
export function parseTaskReviewAnchor(value: unknown): TaskReviewAnchor | null {
  if (!isRecord(value)) return null;
  let anchor: TaskReviewAnchor;
  switch (value.kind) {
    case 'text-quote': {
      if (
        !onlyKeys(value, [
          'kind',
          'start',
          'end',
          'exact',
          'prefix',
          'suffix',
        ]) ||
        !safeInteger(value.start, 0) ||
        !safeInteger(value.end, 1) ||
        typeof value.exact !== 'string' ||
        value.exact.length < 1 ||
        value.exact.length > TASK_REVIEW_LIMITS.quoteChars ||
        value.end - value.start !== value.exact.length ||
        typeof value.prefix !== 'string' ||
        value.prefix.length > TASK_REVIEW_LIMITS.anchorJsonChars ||
        typeof value.suffix !== 'string' ||
        value.suffix.length > TASK_REVIEW_LIMITS.anchorJsonChars
      )
        return null;
      anchor = {
        kind: 'text-quote',
        start: value.start,
        end: value.end,
        exact: value.exact,
        prefix: value.prefix,
        suffix: value.suffix,
      };
      break;
    }
    case 'block': {
      if (
        !onlyKeys(value, ['kind', 'startLine', 'endLine']) ||
        !safeInteger(value.startLine, 1) ||
        !safeInteger(value.endLine, value.startLine)
      )
        return null;
      anchor = {
        kind: 'block',
        startLine: value.startLine,
        endLine: value.endLine,
      };
      break;
    }
    case 'region': {
      if (
        !onlyKeys(value, ['kind', 'x', 'y', 'w', 'h']) ||
        !finiteNumber(value.x, 0) ||
        !finiteNumber(value.y, 0) ||
        !finiteNumber(value.w, 0) ||
        value.w === 0 ||
        !finiteNumber(value.h, 0) ||
        value.h === 0 ||
        value.x + value.w > 1 ||
        value.y + value.h > 1
      )
        return null;
      anchor = {
        kind: 'region',
        x: value.x,
        y: value.y,
        w: value.w,
        h: value.h,
      };
      break;
    }
    case 'whole': {
      if (!onlyKeys(value, ['kind'])) return null;
      anchor = { kind: 'whole' };
      break;
    }
    default:
      return null;
  }
  return JSON.stringify(anchor).length <= TASK_REVIEW_LIMITS.anchorJsonChars
    ? anchor
    : null;
}

/** Events arrive in ordinal order from the store; this fold never mutates or sorts them. */
export function deriveThreadState(
  events: readonly Pick<TaskReviewEvent, 'kind'>[],
): TaskReviewBaseThreadState {
  let state: TaskReviewBaseThreadState = 'open';
  for (const event of events) {
    switch (event.kind) {
      case 'comment':
      case 'reply':
      case 'reopened':
      case 'send-failed':
        state = 'open';
        break;
      case 'sent':
        state = 'sent';
        break;
      case 'agent-reply':
        state = 'agent-replied';
        break;
      case 'resolved':
        state = 'resolved';
        break;
    }
  }
  return state;
}

export type TaskReviewTextQuoteLocation =
  | {
      readonly status: 'exact' | 'moved';
      readonly start: number;
      readonly end: number;
    }
  | { readonly status: 'ambiguous' | 'missing' };

/**
 * Exact text only, with overlapping matches included. Context disambiguates
 * repeated quotes; the old offset alone never chooses between duplicates.
 * A unique quote survives changes to its surrounding context.
 */
export function relocateTextQuote(
  text: string,
  anchor: Extract<TaskReviewAnchor, { kind: 'text-quote' }>,
): TaskReviewTextQuoteLocation {
  if (anchor.exact.length === 0) return { status: 'missing' };
  let matches = 0;
  let onlyMatch = -1;
  let contextMatches = 0;
  let contextMatch = -1;
  let offset = text.indexOf(anchor.exact);
  while (offset !== -1) {
    matches++;
    onlyMatch = offset;
    if (
      text.slice(Math.max(0, offset - anchor.prefix.length), offset) ===
        anchor.prefix &&
      text.slice(
        offset + anchor.exact.length,
        offset + anchor.exact.length + anchor.suffix.length,
      ) === anchor.suffix
    ) {
      contextMatches++;
      contextMatch = offset;
    }
    offset = text.indexOf(anchor.exact, offset + 1);
  }
  if (matches === 0) return { status: 'missing' };
  const start =
    matches === 1 ? onlyMatch : contextMatches === 1 ? contextMatch : -1;
  if (start === -1) return { status: 'ambiguous' };
  return {
    status: start === anchor.start ? 'exact' : 'moved',
    start,
    end: start + anchor.exact.length,
  };
}

/** Current data is owner-resolved for this exact artifact, never supplied by the writer. */
export type TaskReviewCurrentArtifact =
  | { readonly status: 'unavailable' }
  | {
      readonly status: 'available';
      readonly kind: 'plan' | 'summary';
      readonly revision: string;
      readonly text: string;
    }
  | {
      readonly status: 'available';
      readonly kind: 'output';
      readonly revision: string;
      readonly newerOutputWithSamePath: boolean;
    }
  | {
      readonly status: 'available';
      readonly kind: 'answer' | 'capture';
      readonly revision: string;
    };

/** R2: revision changes alone never make a quote outdated. Missing reads stay unknown. */
export function deriveOutdated(
  thread: Pick<TaskReviewThread, 'artifact' | 'anchor' | 'quote'> & {
    readonly events: readonly Pick<TaskReviewEvent, 'kind'>[];
  },
  current: TaskReviewCurrentArtifact,
): TaskReviewOutdated {
  if (
    deriveThreadState(thread.events) === 'resolved' ||
    thread.artifact.kind === 'answer' ||
    thread.artifact.kind === 'capture'
  )
    return false;
  if (current.status === 'unavailable' || current.kind !== thread.artifact.kind)
    return 'unknown';
  if (current.kind === 'output') return current.newerOutputWithSamePath;
  if (current.revision === thread.artifact.revision) return false;
  if (current.kind !== 'plan' && current.kind !== 'summary') return 'unknown';
  const anchor =
    thread.anchor.kind === 'text-quote'
      ? thread.anchor
      : thread.quote
        ? {
            kind: 'text-quote' as const,
            start: 0,
            end: thread.quote.length,
            exact: thread.quote,
            prefix: '',
            suffix: '',
          }
        : undefined;
  if (!anchor) return 'unknown';
  const relocated = relocateTextQuote(current.text, anchor);
  return relocated.status === 'missing' || relocated.status === 'ambiguous';
}
