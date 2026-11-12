/**
 * Read markers: what each person has seen of each conversation, kept by the
 * server (#3075).
 *
 * A marker is one number per (person, conversation): the highest version
 * of that conversation the person has been shown. The server compares it with
 * the conversation's own current version, so every surface (dock inbox,
 * Home, phone, the channel sidebar) reads one answer and none of them derives
 * it. Three client-derived attempts failed before this: acknowledging on
 * display raced the row's render, a second device disagreed, and a reload
 * forgot everything.
 *
 * Rules the server enforces, never the client:
 *
 * - **Who.** The marker belongs to the request's person: the per-person key
 *   the conversation inventory already files "last viewed" under, derived
 *   from the request's resolved principal. The local operator and their own
 *   unbound paired devices are one person, so reading on one device clears
 *   unread on the others; a hosted Station keys by tenant. No body field
 *   names a person, and a caller that is not a person has no read state.
 * - **Monotonic.** Marking read takes the maximum of the stored and the
 *   requested version. A late, replayed or older mark is a no-op.
 * - **Bounded by the truth.** A version above the conversation's current
 *   version is refused: a client cannot pre-acknowledge what it has not been
 *   shown.
 *
 * Versions per kind:
 *
 * - `agent-conversation` — epoch milliseconds of the conversation's
 *   inventory `updatedAt`, exactly as `GET /api/conversations` reports it in
 *   `readState.version`. Nothing recorded what anyone had seen before read
 *   markers existed, so the server keeps a baseline (when it began keeping
 *   them): an agent conversation's `seenVersion` is never below it, and
 *   history from before then reads as seen until it changes.
 * - `project-room` — the room's `checkpoint.lastSeq`. Each named channel is
 *   its own room, so `roomId` names the channel (#4792).
 * - `task-room` — the Task room's `checkpoint.throughSeq` in its current
 *   epoch. A re-homed room (new epoch) starts a new marker.
 *
 * Mentions: there is deliberately no "mentions me" field yet. Structured
 * mentions do not exist (#4799), so nothing could compute one; the field will
 * be added with the code that derives it.
 */

/** `POST` a {@link ReadMarkerSummaryRequest}; answers {@link ReadMarkerSummary}. */
export const READ_MARKER_SUMMARY_PATH = '/api/read-markers/summary';
/** `POST` a {@link ReadMarkerMarkRequest}; answers {@link ReadMarkerState}. */
export const READ_MARKER_MARK_PATH = '/api/read-markers/mark';

/**
 * Most conversations one summary request may name. A request naming more is
 * refused (400), never truncated, so a caller can never mistake a partial
 * answer for a complete one.
 */
export const READ_MARKER_SUMMARY_MAX_TARGETS = 100;

/**
 * Room unread counts stop here: a count equal to the cap means "this many or
 * more". Counting further would only grow a badge nobody reads exactly.
 */
export const READ_MARKER_UNREAD_COUNT_CAP = 99;

/** Longest id segment any target may carry; longer is refused, not cut. */
export const READ_MARKER_ID_MAX_LENGTH = 512;

export type ReadMarkerTarget =
  | {
      readonly kind: 'agent-conversation';
      /** The inventory id from `GET /api/conversations`. */
      readonly conversationId: string;
    }
  | {
      readonly kind: 'project-room';
      /** Authorizes the read: the room must be this Project's room. */
      readonly projectSlug: string;
      readonly roomId: string;
    }
  | {
      readonly kind: 'task-room';
      readonly taskId: string;
    };

export type ReadMarkerTargetKind = ReadMarkerTarget['kind'];

export const READ_MARKER_TARGET_KINDS: readonly ReadMarkerTargetKind[] = [
  'agent-conversation',
  'project-room',
  'task-room',
];

/** One conversation's read state for the calling principal. */
export interface ReadMarkerState {
  readonly target: ReadMarkerTarget;
  /** The conversation's current version (see the module docs per kind). */
  readonly latestVersion: number;
  /**
   * The highest version this person has been shown, never above
   * `latestVersion`; 0 when never (agent conversations: the baseline).
   */
  readonly seenVersion: number;
  /** `latestVersion > seenVersion`. */
  readonly unread: boolean;
  /**
   * Rooms only: records after the marker, capped at
   * {@link READ_MARKER_UNREAD_COUNT_CAP}. Counts every record in the room's
   * sequence, including the caller's own, so a client that posts while the
   * room is on screen marks the new version read as it would any other.
   * Absent for agent conversations, whose version is a time and cannot be
   * counted.
   */
  readonly unreadCount?: number;
}

/**
 * A summary item the caller cannot read: unknown, not theirs, or not yet
 * opened. One shape for all three, so a summary is never an oracle for
 * whether someone else's conversation exists.
 */
export interface ReadMarkerUnavailable {
  readonly target: ReadMarkerTarget;
  readonly unavailable: true;
}

export type ReadMarkerSummaryItem = ReadMarkerState | ReadMarkerUnavailable;

export interface ReadMarkerSummaryRequest {
  readonly targets: readonly ReadMarkerTarget[];
}

export interface ReadMarkerSummary {
  /** One item per requested target, in request order. */
  readonly items: readonly ReadMarkerSummaryItem[];
}

export interface ReadMarkerMarkRequest {
  readonly target: ReadMarkerTarget;
  /** The version the person was shown. Never above the current version. */
  readonly version: number;
}

/** Wire-stable refusal codes for {@link READ_MARKER_MARK_PATH}. */
export const READ_MARKER_REFUSAL_CODES = {
  /** The requested version is above the conversation's current version. */
  futureVersion: 'read_marker_future_version',
  /** The summary named more than {@link READ_MARKER_SUMMARY_MAX_TARGETS}. */
  tooManyTargets: 'read_marker_too_many_targets',
} as const;

export function isReadMarkerUnavailable(
  item: ReadMarkerSummaryItem,
): item is ReadMarkerUnavailable {
  return 'unavailable' in item && item.unavailable === true;
}

/** A stable identity for one target, for maps and caches. */
export function readMarkerTargetKey(target: ReadMarkerTarget): string {
  switch (target.kind) {
    case 'agent-conversation':
      return `agent-conversation:${target.conversationId}`;
    case 'project-room':
      return `project-room:${target.projectSlug}:${target.roomId}`;
    case 'task-room':
      return `task-room:${target.taskId}`;
  }
}

/** Thrown by the parsers below; routes answer it as a 400. */
export class InvalidReadMarkerInputError extends TypeError {
  constructor(reason: string) {
    super(`Invalid read marker input: ${reason}`);
    this.name = 'InvalidReadMarkerInputError';
  }
}

/** Thrown by {@link parseReadMarkerSummaryRequest} past the target bound. */
export class ReadMarkerTooManyTargetsError extends RangeError {
  readonly code = READ_MARKER_REFUSAL_CODES.tooManyTargets;
  constructor(count: number) {
    super(
      `A read marker summary names at most ${READ_MARKER_SUMMARY_MAX_TARGETS} conversations; this one named ${count}`,
    );
    this.name = 'ReadMarkerTooManyTargetsError';
  }
}

function plainObject(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InvalidReadMarkerInputError(`${what} must be an object`);
  return value as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new InvalidReadMarkerInputError(`${what} has unknown field ${key}`);
}

function idSegment(value: unknown, what: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > READ_MARKER_ID_MAX_LENGTH
  )
    throw new InvalidReadMarkerInputError(`${what} is not a valid id`);
  return value;
}

export function parseReadMarkerTarget(value: unknown): ReadMarkerTarget {
  const v = plainObject(value, 'target');
  switch (v.kind) {
    case 'agent-conversation':
      onlyKeys(v, ['kind', 'conversationId'], 'target');
      return {
        kind: 'agent-conversation',
        conversationId: idSegment(v.conversationId, 'conversationId'),
      };
    case 'project-room':
      onlyKeys(v, ['kind', 'projectSlug', 'roomId'], 'target');
      return {
        kind: 'project-room',
        projectSlug: idSegment(v.projectSlug, 'projectSlug'),
        roomId: idSegment(v.roomId, 'roomId'),
      };
    case 'task-room':
      onlyKeys(v, ['kind', 'taskId'], 'target');
      return { kind: 'task-room', taskId: idSegment(v.taskId, 'taskId') };
    default:
      throw new InvalidReadMarkerInputError('target kind is unknown');
  }
}

/**
 * Refuses (throws {@link ReadMarkerTooManyTargetsError}) a request naming
 * more than {@link READ_MARKER_SUMMARY_MAX_TARGETS} targets. The count is
 * checked before any target is parsed, so an oversized body costs nothing.
 */
export function parseReadMarkerSummaryRequest(
  value: unknown,
): ReadMarkerSummaryRequest {
  const v = plainObject(value, 'summary request');
  onlyKeys(v, ['targets'], 'summary request');
  if (!Array.isArray(v.targets))
    throw new InvalidReadMarkerInputError('targets must be an array');
  if (v.targets.length > READ_MARKER_SUMMARY_MAX_TARGETS)
    throw new ReadMarkerTooManyTargetsError(v.targets.length);
  return { targets: v.targets.map(parseReadMarkerTarget) };
}

export function parseReadMarkerMarkRequest(
  value: unknown,
): ReadMarkerMarkRequest {
  const v = plainObject(value, 'mark request');
  onlyKeys(v, ['target', 'version'], 'mark request');
  if (
    typeof v.version !== 'number' ||
    !Number.isSafeInteger(v.version) ||
    v.version < 0
  )
    throw new InvalidReadMarkerInputError(
      'version must be a non-negative safe integer',
    );
  return { target: parseReadMarkerTarget(v.target), version: v.version };
}

/**
 * The one derivation of a read state from a stored marker and the
 * conversation's current version. A stored marker above the current version
 * (a room re-sequenced under the same id) reads as fully seen rather than as
 * a negative count.
 */
export function deriveReadMarkerState(input: {
  target: ReadMarkerTarget;
  latestVersion: number;
  seenVersion: number;
  countable: boolean;
}): ReadMarkerState {
  const seenVersion = Math.min(input.seenVersion, input.latestVersion);
  const unseen = input.latestVersion - seenVersion;
  return {
    target: input.target,
    latestVersion: input.latestVersion,
    seenVersion,
    unread: unseen > 0,
    ...(input.countable
      ? { unreadCount: Math.min(unseen, READ_MARKER_UNREAD_COUNT_CAP) }
      : {}),
  };
}
