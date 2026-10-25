import {
  isWellFormedUnicode,
  type TaskGateEvaluationReferenceInput,
} from './task-graph.js';
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
  documentChars: 1024 * 1024,
});

export type TaskReviewArtifactKind =
  | 'plan'
  | 'summary'
  | 'output'
  | 'answer'
  | 'capture';

export type TaskReviewRevision = string | number;

export type TaskReviewArtifactRef = { readonly digest: `sha256:${string}` } & (
  | {
      readonly kind: 'plan' | 'output' | 'capture';
      readonly id: string;
      readonly revision: string;
    }
  | {
      readonly kind: 'summary';
      readonly id: 'summary';
      readonly revision: number;
    }
  | {
      readonly kind: 'answer';
      readonly sessionId: string;
      readonly turnId: string;
      readonly revision: string;
    }
);

export type TaskReviewAnchor =
  | {
      readonly kind: 'text-quote';
      /** Zero-based, half-open UTF-16 offsets after CRLF and CR are normalized to LF. */
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
        readonly author: Extract<TaskReviewAuthor, { kind: 'person' }>;
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
  readonly currentRevision?: TaskReviewRevision;
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
  | 'invalid-event'
  | 'invalid-transition'
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
  readonly quote?: string;
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
  readonly sourceKind: TaskCapture['sourceKind'];
  readonly sourceSessionId: string;
  readonly label?: string;
  readonly operationId: string;
}
export type TaskReviewCreateCaptureResponse = TaskReviewResponse<{
  readonly capture: TaskCapture;
}>;

/** GET /api/tasks/:taskId/review/captures/:captureId/content. */
export interface TaskReviewCaptureContentRequest {
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
export interface TaskThreadReplyRequest {
  readonly threadId: string;
  readonly body: string;
  readonly evidence?: TaskReviewEvidenceInput;
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
        !boundedText(value.exact, TASK_REVIEW_LIMITS.quoteChars) ||
        value.end - value.start !== value.exact.length ||
        !boundedText(value.prefix, TASK_REVIEW_LIMITS.anchorJsonChars, 0) ||
        !boundedText(value.suffix, TASK_REVIEW_LIMITS.anchorJsonChars, 0) ||
        /\r/.test(value.exact + value.prefix + value.suffix)
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

function boundedText(value: unknown, max: number, min = 1): value is string {
  return (
    typeof value === 'string' &&
    value.length >= min &&
    value.length <= max &&
    isWellFormedUnicode(value)
  );
}

function identity(value: unknown): value is string {
  return boundedText(value, TASK_REVIEW_LIMITS.artifactIdChars);
}

function parseAuthor(value: unknown): TaskReviewAuthor | null {
  if (!isRecord(value)) return null;
  if (
    value.kind === 'person' &&
    onlyKeys(value, ['kind', 'principalId']) &&
    boundedText(value.principalId, TASK_REVIEW_LIMITS.authorIdChars)
  )
    return { kind: 'person', principalId: value.principalId };
  if (
    value.kind === 'session' &&
    onlyKeys(value, ['kind', 'sessionId']) &&
    boundedText(value.sessionId, TASK_REVIEW_LIMITS.authorIdChars)
  )
    return { kind: 'session', sessionId: value.sessionId };
  return null;
}

/** Retained block/whole quote. Absence is optional at the owning DTO. */
export function parseTaskReviewQuote(value: unknown): string | null {
  return boundedText(value, TASK_REVIEW_LIMITS.quoteChars) &&
    !value.includes('\r')
    ? value
    : null;
}

export function parseTaskReviewArtifactRef(
  value: unknown,
): TaskReviewArtifactRef | null {
  if (
    !isRecord(value) ||
    typeof value.digest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.digest)
  )
    return null;
  const digest: `sha256:${string}` = `sha256:${value.digest.slice(7)}`;
  if (value.kind === 'answer') {
    if (
      !onlyKeys(value, ['kind', 'sessionId', 'turnId', 'revision', 'digest']) ||
      !identity(value.sessionId) ||
      !identity(value.turnId) ||
      !boundedText(value.revision, TASK_REVIEW_LIMITS.artifactRevisionChars)
    )
      return null;
    return {
      kind: 'answer',
      sessionId: value.sessionId,
      turnId: value.turnId,
      revision: value.revision,
      digest,
    };
  }
  if (
    !onlyKeys(value, ['kind', 'id', 'revision', 'digest']) ||
    !identity(value.id)
  )
    return null;
  if (value.kind === 'summary')
    return value.id === 'summary' && safeInteger(value.revision, 1)
      ? { kind: 'summary', id: 'summary', revision: value.revision, digest }
      : null;
  if (
    (value.kind === 'plan' ||
      value.kind === 'output' ||
      value.kind === 'capture') &&
    boundedText(value.revision, TASK_REVIEW_LIMITS.artifactRevisionChars)
  )
    return { kind: value.kind, id: value.id, revision: value.revision, digest };
  return null;
}

/** Captures accept whole or region anchors; text artifacts accept whole, block or text-quote. */
export function checkAnchorForArtifact(
  kind: TaskReviewArtifactKind,
  anchor: TaskReviewAnchor,
): boolean {
  if (!parseTaskReviewAnchor(anchor)) return false;
  return kind === 'capture'
    ? anchor.kind === 'region' || anchor.kind === 'whole'
    : anchor.kind !== 'region';
}

export function parseTaskReviewEvidenceInput(
  value: unknown,
): TaskReviewEvidenceInput | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ['commit', 'gateRefs', 'receiptRefs', 'captureId'])
  )
    return null;
  if (
    value.commit !== undefined &&
    !boundedText(value.commit, TASK_REVIEW_LIMITS.artifactRevisionChars)
  )
    return null;
  if (value.captureId !== undefined && !identity(value.captureId)) return null;
  const gateRefs: TaskGateEvaluationReferenceInput['ref'][] = [];
  if (value.gateRefs !== undefined) {
    if (
      !Array.isArray(value.gateRefs) ||
      value.gateRefs.length > TASK_REVIEW_LIMITS.eventsPerThread
    )
      return null;
    for (const ref of value.gateRefs) {
      if (
        !isRecord(ref) ||
        !onlyKeys(ref, ['runId', 'gateId', 'evaluationId']) ||
        !identity(ref.runId) ||
        !identity(ref.gateId) ||
        !identity(ref.evaluationId)
      )
        return null;
      gateRefs.push({
        runId: ref.runId,
        gateId: ref.gateId,
        evaluationId: ref.evaluationId,
      });
    }
  }
  const receiptRefs: string[] = [];
  if (value.receiptRefs !== undefined) {
    if (
      !Array.isArray(value.receiptRefs) ||
      value.receiptRefs.length > TASK_REVIEW_LIMITS.eventsPerThread
    )
      return null;
    for (const ref of value.receiptRefs) {
      if (!identity(ref)) return null;
      receiptRefs.push(ref);
    }
  }
  const evidence = {
    ...(value.commit !== undefined ? { commit: value.commit } : {}),
    ...(value.captureId !== undefined ? { captureId: value.captureId } : {}),
    ...(value.gateRefs !== undefined ? { gateRefs } : {}),
    ...(value.receiptRefs !== undefined ? { receiptRefs } : {}),
  };
  return JSON.stringify(evidence).length <= TASK_REVIEW_LIMITS.evidenceJsonChars
    ? evidence
    : null;
}

function parseEvidence(value: unknown): TaskReviewEvidence | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      'commit',
      'gateRefs',
      'receiptRefs',
      'captureId',
      'commitVerified',
      'gateVerified',
    ]) ||
    typeof value.commitVerified !== 'boolean' ||
    typeof value.gateVerified !== 'boolean'
  )
    return null;
  const { commitVerified, gateVerified, ...claims } = value;
  const input = parseTaskReviewEvidenceInput(claims);
  if (!input) return null;
  const evidence = { ...input, commitVerified, gateVerified };
  return JSON.stringify(evidence).length <= TASK_REVIEW_LIMITS.evidenceJsonChars
    ? evidence
    : null;
}

/** Validates stored event shape and its expected one-based position, without granting authority. */
export function parseTaskReviewEvent(
  value: unknown,
  ordinal: number,
): TaskReviewEvent | null {
  if (
    !isRecord(value) ||
    !safeInteger(ordinal, 1) ||
    ordinal > TASK_REVIEW_LIMITS.eventsPerThread ||
    value.ordinal !== ordinal ||
    !identity(value.threadId) ||
    !identity(value.operationId) ||
    !boundedText(value.createdAt, TASK_REVIEW_LIMITS.artifactRevisionChars)
  )
    return null;
  const author = parseAuthor(value.author);
  if (!author) return null;
  const base = {
    threadId: value.threadId,
    ordinal,
    operationId: value.operationId,
    createdAt: value.createdAt,
  };
  const keys = [
    'kind',
    'threadId',
    'ordinal',
    'operationId',
    'createdAt',
    'author',
  ];
  switch (value.kind) {
    case 'comment':
    case 'reply':
      if (
        !onlyKeys(value, [...keys, 'body']) ||
        author.kind !== 'person' ||
        (value.kind === 'comment' ? ordinal !== 1 : ordinal === 1) ||
        !boundedText(value.body, TASK_REVIEW_LIMITS.bodyChars)
      )
        return null;
      return { ...base, kind: value.kind, author, body: value.body };
    case 'agent-reply': {
      if (
        !onlyKeys(value, [...keys, 'body', 'evidence']) ||
        ordinal === 1 ||
        author.kind !== 'session' ||
        !boundedText(value.body, TASK_REVIEW_LIMITS.bodyChars)
      )
        return null;
      const evidence =
        value.evidence === undefined
          ? undefined
          : parseEvidence(value.evidence);
      return evidence === null
        ? null
        : {
            ...base,
            kind: 'agent-reply',
            author,
            body: value.body,
            ...(evidence ? { evidence } : {}),
          };
    }
    case 'sent':
      return onlyKeys(value, [...keys, 'deliveryKey']) &&
        ordinal > 1 &&
        author.kind === 'person' &&
        identity(value.deliveryKey)
        ? { ...base, kind: 'sent', author, deliveryKey: value.deliveryKey }
        : null;
    case 'send-failed':
    case 'resolved':
      return onlyKeys(value, [...keys, 'reason']) &&
        ordinal > 1 &&
        boundedText(value.reason, TASK_REVIEW_LIMITS.reasonChars)
        ? { ...base, kind: value.kind, author, reason: value.reason }
        : null;
    case 'reopened':
      if (
        !onlyKeys(value, [...keys, 'reason']) ||
        ordinal === 1 ||
        author.kind !== 'person' ||
        (value.reason !== undefined &&
          !boundedText(value.reason, TASK_REVIEW_LIMITS.reasonChars))
      )
        return null;
      return {
        ...base,
        kind: 'reopened',
        author,
        ...(value.reason !== undefined ? { reason: value.reason } : {}),
      };
    default:
      return null;
  }
}

export function parseTaskReviewListRequest(
  value: unknown,
): TaskReviewListRequest | null {
  if (!isRecord(value) || !onlyKeys(value, ['state'])) return null;
  return value.state === undefined
    ? {}
    : value.state === 'open' ||
        value.state === 'outdated' ||
        value.state === 'resolved'
      ? { state: value.state }
      : null;
}
export function parseTaskThreadListRequest(
  value: unknown,
): TaskThreadListRequest | null {
  return parseTaskReviewListRequest(value);
}
export function parseTaskReviewCreateThreadRequest(
  value: unknown,
): TaskReviewCreateThreadRequest | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ['artifact', 'anchor', 'quote', 'body', 'operationId']) ||
    !boundedText(value.body, TASK_REVIEW_LIMITS.bodyChars) ||
    !identity(value.operationId)
  )
    return null;
  const artifact = parseTaskReviewArtifactRef(value.artifact);
  const anchor = parseTaskReviewAnchor(value.anchor);
  const quote =
    value.quote === undefined ? undefined : parseTaskReviewQuote(value.quote);
  if (
    !artifact ||
    !anchor ||
    !checkAnchorForArtifact(artifact.kind, anchor) ||
    quote === null
  )
    return null;
  return {
    artifact,
    anchor,
    body: value.body,
    operationId: value.operationId,
    ...(quote !== undefined ? { quote } : {}),
  };
}
export function parseTaskReviewReplyRequest(
  value: unknown,
): TaskReviewReplyRequest | null {
  return isRecord(value) &&
    onlyKeys(value, ['body', 'operationId']) &&
    boundedText(value.body, TASK_REVIEW_LIMITS.bodyChars) &&
    identity(value.operationId)
    ? { body: value.body, operationId: value.operationId }
    : null;
}
export function parseTaskReviewResolveRequest(
  value: unknown,
): TaskReviewResolveRequest | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ['reason', 'operationId']) ||
    !identity(value.operationId) ||
    (value.reason !== undefined &&
      !boundedText(value.reason, TASK_REVIEW_LIMITS.reasonChars))
  )
    return null;
  return {
    operationId: value.operationId,
    ...(value.reason !== undefined ? { reason: value.reason } : {}),
  };
}
export function parseTaskReviewReopenRequest(
  value: unknown,
): TaskReviewReopenRequest | null {
  return parseTaskReviewResolveRequest(value);
}
export function parseTaskReviewSendRequest(
  value: unknown,
): TaskReviewSendRequest | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ['threadIds', 'operationId']) ||
    !identity(value.operationId) ||
    !Array.isArray(value.threadIds) ||
    value.threadIds.length < 1 ||
    value.threadIds.length > TASK_REVIEW_LIMITS.threadsPerTask
  )
    return null;
  const threadIds: string[] = [];
  for (const id of value.threadIds) {
    if (!identity(id)) return null;
    threadIds.push(id);
  }
  return new Set(threadIds).size === threadIds.length
    ? { threadIds, operationId: value.operationId }
    : null;
}
export function parseTaskReviewCreateCaptureRequest(
  value: unknown,
): TaskReviewCreateCaptureRequest | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      'sourceKind',
      'sourceSessionId',
      'label',
      'operationId',
    ]) ||
    (value.sourceKind !== 'browser' && value.sourceKind !== 'device') ||
    !identity(value.sourceSessionId) ||
    !identity(value.operationId) ||
    (value.label !== undefined &&
      !boundedText(value.label, TASK_REVIEW_LIMITS.labelChars))
  )
    return null;
  return {
    sourceKind: value.sourceKind,
    sourceSessionId: value.sourceSessionId,
    operationId: value.operationId,
    ...(value.label !== undefined ? { label: value.label } : {}),
  };
}
export function parseTaskReviewCaptureContentRequest(
  value: unknown,
): TaskReviewCaptureContentRequest | null {
  return isRecord(value) &&
    onlyKeys(value, ['captureId']) &&
    identity(value.captureId)
    ? { captureId: value.captureId }
    : null;
}
export function parseTaskThreadReplyRequest(
  value: unknown,
): TaskThreadReplyRequest | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ['threadId', 'body', 'evidence', 'operationId']) ||
    !identity(value.threadId) ||
    !identity(value.operationId) ||
    !boundedText(value.body, TASK_REVIEW_LIMITS.bodyChars)
  )
    return null;
  const evidence =
    value.evidence === undefined
      ? undefined
      : parseTaskReviewEvidenceInput(value.evidence);
  return evidence === null
    ? null
    : {
        threadId: value.threadId,
        body: value.body,
        operationId: value.operationId,
        ...(evidence ? { evidence } : {}),
      };
}
export function parseTaskThreadResolveRequest(
  value: unknown,
): TaskThreadResolveRequest | null {
  return isRecord(value) &&
    onlyKeys(value, ['threadId', 'reason', 'operationId']) &&
    identity(value.threadId) &&
    identity(value.operationId) &&
    boundedText(value.reason, TASK_REVIEW_LIMITS.reasonChars)
    ? {
        threadId: value.threadId,
        reason: value.reason,
        operationId: value.operationId,
      }
    : null;
}

/** Metadata validation does not sanitize URLs, verify commits, or verify image bytes. */
export function parseTaskCapture(value: unknown): TaskCapture | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      'captureId',
      'projectId',
      'taskId',
      'taskCreatedAt',
      'sourceKind',
      'sourceSessionId',
      'pageUrl',
      'commit',
      'mediaType',
      'byteLength',
      'digest',
      'width',
      'height',
      'label',
      'author',
      'operationId',
      'createdAt',
    ])
  )
    return null;
  const request = parseTaskReviewCreateCaptureRequest({
    sourceKind: value.sourceKind,
    sourceSessionId: value.sourceSessionId,
    label: value.label,
    operationId: value.operationId,
  });
  const author = parseAuthor(value.author);
  const artifact = parseTaskReviewArtifactRef({
    kind: 'capture',
    id: value.captureId,
    revision: value.commit,
    digest: value.digest,
  });
  if (
    !request ||
    !author ||
    !artifact ||
    !identity(value.captureId) ||
    !identity(value.projectId) ||
    !identity(value.taskId) ||
    !boundedText(
      value.taskCreatedAt,
      TASK_REVIEW_LIMITS.artifactRevisionChars,
    ) ||
    !boundedText(value.createdAt, TASK_REVIEW_LIMITS.artifactRevisionChars) ||
    typeof value.commit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(value.commit) ||
    (value.mediaType !== 'image/png' && value.mediaType !== 'image/jpeg') ||
    !safeInteger(value.byteLength, 1) ||
    value.byteLength > TASK_REVIEW_LIMITS.captureBytes ||
    (value.pageUrl !== undefined &&
      !boundedText(value.pageUrl, TASK_REVIEW_LIMITS.pageUrlChars)) ||
    (value.width !== undefined && !safeInteger(value.width, 1)) ||
    (value.height !== undefined && !safeInteger(value.height, 1))
  )
    return null;
  return {
    ...request,
    captureId: value.captureId,
    projectId: value.projectId,
    taskId: value.taskId,
    taskCreatedAt: value.taskCreatedAt,
    author,
    commit: value.commit,
    mediaType: value.mediaType,
    byteLength: value.byteLength,
    digest: artifact.digest,
    createdAt: value.createdAt,
    ...(value.pageUrl !== undefined ? { pageUrl: value.pageUrl } : {}),
    ...(value.width !== undefined ? { width: value.width } : {}),
    ...(value.height !== undefined ? { height: value.height } : {}),
  };
}

/** Check projected totals inside the store transaction, before writing. */
export function checkTaskReviewCapacity(counts: {
  readonly threads: number;
  readonly events: number;
  readonly captures: number;
  readonly captureHomeBytes: number;
}): TaskReviewRefusalCode | null {
  if (Object.values(counts).some((value) => !safeInteger(value, 0)))
    return 'invalid-request';
  if (counts.threads > TASK_REVIEW_LIMITS.threadsPerTask) return 'thread-limit';
  if (counts.events > TASK_REVIEW_LIMITS.eventsPerThread) return 'event-limit';
  if (counts.captures > TASK_REVIEW_LIMITS.capturesPerTask)
    return 'capture-limit';
  if (counts.captureHomeBytes > TASK_REVIEW_LIMITS.captureHomeBytes)
    return 'capture-home-limit';
  return null;
}

export type TaskReviewAppendResult =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: 'invalid-event' | 'event-limit' | 'invalid-transition';
    };

/** Null is the empty history. The store separately owns ordinal continuity and authority. */
export function canAppendTaskReviewEvent(
  state: TaskReviewBaseThreadState | null,
  value: unknown,
): TaskReviewAppendResult {
  if (
    isRecord(value) &&
    safeInteger(value.ordinal, 1) &&
    value.ordinal > TASK_REVIEW_LIMITS.eventsPerThread
  )
    return { allowed: false, code: 'event-limit' };
  const event =
    isRecord(value) && typeof value.ordinal === 'number'
      ? parseTaskReviewEvent(value, value.ordinal)
      : null;
  if (!event) return { allowed: false, code: 'invalid-event' };
  const allowed =
    event.kind === 'comment'
      ? state === null
      : state === null
        ? false
        : event.kind === 'reopened'
          ? state === 'resolved'
          : event.kind === 'agent-reply' || event.kind === 'send-failed'
            ? state === 'sent'
            : event.kind === 'sent'
              ? state === 'open' || state === 'agent-replied'
              : event.kind === 'resolved'
                ? state !== 'resolved'
                : true;
  return allowed
    ? { allowed: true }
    : { allowed: false, code: 'invalid-transition' };
}

/** Invalid shapes/transitions cannot change state; the write boundary must refuse them. */
export function deriveThreadState(
  events: readonly unknown[],
): TaskReviewBaseThreadState {
  let state: TaskReviewBaseThreadState | null = null;
  for (let index = 0; index < events.length; index++) {
    const event = parseTaskReviewEvent(events[index], index + 1);
    if (!event || !canAppendTaskReviewEvent(state, event).allowed) continue;
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
  return state ?? 'open';
}

export type TaskReviewTextQuoteLocation =
  | {
      readonly status: 'exact' | 'moved';
      readonly start: number;
      readonly end: number;
      readonly confidence: 'high' | 'low';
    }
  | { readonly status: 'ambiguous' | 'missing' | 'unknown' };

/** Normalize before creating offsets, selecting block lines, or relocating. Quotes must already use LF. */
export function normalizeTaskReviewText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function splitsSurrogate(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return (
    before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
  );
}

/** Overlapping exact matches; both contexts disambiguate duplicates. Unique context-free matches are low confidence. */
export function relocateTextQuote(
  text: string,
  anchor: Extract<TaskReviewAnchor, { kind: 'text-quote' }>,
): TaskReviewTextQuoteLocation {
  if (
    text.length > TASK_REVIEW_LIMITS.documentChars ||
    !isWellFormedUnicode(text) ||
    !parseTaskReviewAnchor(anchor)
  )
    return { status: 'unknown' };
  text = normalizeTaskReviewText(text);
  if (splitsSurrogate(text, anchor.start) || splitsSurrogate(text, anchor.end))
    return { status: 'unknown' };
  let matches = 0,
    onlyMatch = -1,
    contextMatches = 0,
    contextMatch = -1;
  let offset = text.indexOf(anchor.exact);
  while (offset !== -1) {
    matches++;
    onlyMatch = offset;
    if (
      offset >= anchor.prefix.length &&
      text.startsWith(anchor.prefix, offset - anchor.prefix.length) &&
      text.startsWith(anchor.suffix, offset + anchor.exact.length)
    ) {
      contextMatches++;
      contextMatch = offset;
    }
    if (contextMatches > 1) return { status: 'ambiguous' };
    offset = text.indexOf(anchor.exact, offset + 1);
  }
  if (matches === 0) return { status: 'missing' };
  const start =
    matches === 1 ? onlyMatch : contextMatches === 1 ? contextMatch : -1;
  if (start === -1) return { status: 'ambiguous' };
  const context =
    (anchor.prefix.length > 0 &&
      start >= anchor.prefix.length &&
      text.startsWith(anchor.prefix, start - anchor.prefix.length)) ||
    (anchor.suffix.length > 0 &&
      text.startsWith(anchor.suffix, start + anchor.exact.length));
  return {
    status: start === anchor.start ? 'exact' : 'moved',
    start,
    end: start + anchor.exact.length,
    confidence: context ? 'high' : 'low',
  };
}

/** Current data is owner-resolved for this exact artifact, never supplied by the writer. */
export type TaskReviewCurrentArtifact = (
  | { readonly status: 'unavailable' }
  | {
      readonly status: 'available';
      readonly kind: 'plan';
      readonly revision: string;
      readonly text: string;
    }
  | {
      readonly status: 'available';
      readonly kind: 'summary';
      readonly revision: number;
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
    }
) & { readonly deliveryStatus?: 'confirmed' | 'unconfirmed' };

type FreshnessThread = Pick<
  TaskReviewThread,
  'artifact' | 'anchor' | 'quote' | 'events'
>;

export function deriveOutdated(
  thread: FreshnessThread,
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
  if (current.revision === thread.artifact.revision) return false;
  if (current.kind === 'output') return current.newerOutputWithSamePath;
  if (current.kind !== 'plan' && current.kind !== 'summary') return 'unknown';
  if (thread.anchor.kind === 'whole') return 'unknown';
  if (
    current.text.length > TASK_REVIEW_LIMITS.documentChars ||
    !isWellFormedUnicode(current.text)
  )
    return 'unknown';
  const text = normalizeTaskReviewText(current.text);
  let anchor: Extract<TaskReviewAnchor, { kind: 'text-quote' }>;
  if (thread.anchor.kind === 'text-quote') anchor = thread.anchor;
  else if (thread.anchor.kind === 'block') {
    const quote = parseTaskReviewQuote(thread.quote);
    if (quote === null) return 'unknown';
    const lines = text.split('\n');
    if (
      lines
        .slice(thread.anchor.startLine - 1, thread.anchor.endLine)
        .join('\n') === quote
    )
      return false;
    const start = lines
      .slice(0, thread.anchor.startLine - 1)
      .reduce((offset, line) => offset + line.length + 1, 0);
    anchor = {
      kind: 'text-quote',
      start,
      end: start + quote.length,
      exact: quote,
      prefix: '',
      suffix: '',
    };
  } else return 'unknown';
  const result = relocateTextQuote(text, anchor);
  return result.status === 'unknown'
    ? 'unknown'
    : result.status === 'missing' || result.status === 'ambiguous';
}

/** Unknown freshness stays in Open. Only confirmed outdated threads enter Outdated. */
export function matchesTaskReviewFilter(
  view: TaskReviewThreadView,
  filter: TaskReviewFilter,
): boolean {
  return filter === 'resolved'
    ? view.baseState === 'resolved'
    : filter === 'outdated'
      ? view.state === 'outdated'
      : view.baseState !== 'resolved' && view.state !== 'outdated';
}

export function deriveThreadView(
  thread: TaskReviewThread,
  current: TaskReviewCurrentArtifact,
): TaskReviewThreadView {
  const baseState = deriveThreadState(thread.events);
  const outdated = deriveOutdated(thread, current);
  return {
    ...thread,
    baseState,
    outdated,
    state: outdated === true ? 'outdated' : baseState,
    ...(current.status === 'available' && current.kind === thread.artifact.kind
      ? { currentRevision: current.revision }
      : {}),
    ...(baseState === 'sent'
      ? { deliveryStatus: current.deliveryStatus ?? 'unconfirmed' }
      : {}),
  };
}

export function countThreads(
  views: readonly TaskReviewThreadView[],
): TaskReviewCounts {
  const counts = { open: 0, outdated: 0, resolved: 0 };
  for (const view of views) {
    if (matchesTaskReviewFilter(view, 'resolved')) counts.resolved++;
    else if (matchesTaskReviewFilter(view, 'outdated')) counts.outdated++;
    else counts.open++;
  }
  return counts;
}
