/**
 * Task memory (#4003, docs/design/tracker-backed-tasks.md "Task memory"):
 * the judgment layer of a Task. Agents decide what matters and people can
 * edit it. It sits above the facts Station derives itself (session digests,
 * Project activity, kept outputs, the observed work item), which nobody
 * writes.
 *
 * Two parts, both kept per Task incarnation with every revision:
 *
 * - **Task summary**: one bounded text that agents and people REWRITE, never
 *   append to: what is true now, what works, what is next, what is risky.
 *   A write names the revision it was based on and is refused when that is
 *   no longer the current one.
 * - **Task records**: keyed decisions, questions and dead ends. Setting an
 *   existing key supersedes it; a question stays open until answered; any
 *   record can be retired with a reason. Every version is kept.
 *
 * Every bound here is a refusal. Nothing is ever cut or evicted.
 */

export const TASK_MEMORY_VERSION = 'station.task-memory/v1' as const;

export const TASK_RECORD_KINDS = ['decision', 'question', 'dead_end'] as const;
export type TaskRecordKind = (typeof TASK_RECORD_KINDS)[number];

/**
 * `standing` records are shown in every Task brief; `on_topic` records are
 * only counted there, and listed in full on request.
 */
export const TASK_RECORD_IMPORTANCES = ['standing', 'on_topic'] as const;
export type TaskRecordImportance = (typeof TASK_RECORD_IMPORTANCES)[number];

export const TASK_RECORD_ACTIONS = ['set', 'answer', 'retire'] as const;
export type TaskRecordAction = (typeof TASK_RECORD_ACTIONS)[number];

/**
 * A record's state after its newest version. Decisions and dead ends are
 * `active` until retired. Questions are `open` until answered (or retired).
 */
export const TASK_RECORD_STATES = [
  'active',
  'open',
  'answered',
  'retired',
] as const;
export type TaskRecordState = (typeof TASK_RECORD_STATES)[number];

/**
 * The default importance when a `set` names none and the key has no earlier
 * version. Every kind defaults to `standing`: a decision constrains all later
 * work, an open question needs a person whatever its topic, and a dead end
 * exists so the next Session does not repeat it, which only works when the
 * brief shows it. `on_topic` is the writer's explicit choice for a record
 * that matters only to one narrow part of the Task.
 */
export const TASK_RECORD_DEFAULT_IMPORTANCE = Object.freeze({
  decision: 'standing',
  question: 'standing',
  dead_end: 'standing',
} as const satisfies Record<TaskRecordKind, TaskRecordImportance>);

export const TASK_MEMORY_LIMITS = Object.freeze({
  /** The summary, in UTF-16 code units. Longer text is refused, never cut. */
  summaryChars: 4000,
  /** One record's text, and an answer's. */
  recordTextChars: 1000,
  /** A retirement's reason. */
  recordReasonChars: 500,
  /** A record key: a lowercase slug. */
  recordKeyChars: 64,
  /**
   * Records that may be live at once per kind: active decisions, OPEN
   * questions and active dead ends. Past it a new key is refused until one is
   * superseded, answered or retired.
   */
  liveRecords: Object.freeze({
    decision: 40,
    question: 20,
    dead_end: 30,
  } as const satisfies Record<TaskRecordKind, number>),
});

/** A short lowercase slug: `storage-engine`, `retry-policy-2`. */
export const TASK_RECORD_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type TaskMemoryAuthor =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'person'; readonly principalId: string };

export interface TaskSummaryRevision {
  readonly taskId: string;
  /** 1 for the first summary; each accepted write adds one. */
  readonly revision: number;
  readonly text: string;
  readonly author: TaskMemoryAuthor;
  /** ISO-8601, the server's clock when the revision was written. */
  readonly createdAt: string;
}

/** One version of a keyed record. The newest version is the record. */
export interface TaskMemoryRecord {
  readonly taskId: string;
  readonly kind: TaskRecordKind;
  readonly key: string;
  /** 1 for the key's first `set`; each later action adds one. */
  readonly version: number;
  readonly action: TaskRecordAction;
  readonly state: TaskRecordState;
  readonly importance: TaskRecordImportance;
  /** The decision, question or dead end. An answer keeps the question's text. */
  readonly text: string;
  /** The answer, present exactly when `state` is `answered`. */
  readonly answer?: string;
  /** Why it was retired, present exactly when `action` is `retire`. */
  readonly reason?: string;
  /** Who wrote THIS version: for an open question, who asked it. */
  readonly author: TaskMemoryAuthor;
  readonly createdAt: string;
}

/** A write to a keyed record, as an agent's `task_record` or a person sends it. */
export interface TaskRecordWrite {
  readonly kind: TaskRecordKind;
  readonly key: string;
  /** Defaults to `set`. */
  readonly action?: TaskRecordAction;
  /** Required for `set` (the record) and `answer` (the answer). */
  readonly text?: string;
  /** Only with `set`; defaults to the key's previous importance, else the kind's default. */
  readonly importance?: TaskRecordImportance;
  /** Required for `retire`. */
  readonly reason?: string;
}

/** Live records are the ones that count against `TASK_MEMORY_LIMITS.liveRecords`. */
export function isLiveTaskRecord(record: Pick<TaskMemoryRecord, 'state'>) {
  return record.state === 'active' || record.state === 'open';
}

/** What a person's Task workspace reads. */
export interface TaskMemoryView {
  readonly version: typeof TASK_MEMORY_VERSION;
  readonly taskId: string;
  /** Absent until the first summary is written; then base revision is 0. */
  readonly summary?: TaskSummaryRevision;
  /** The newest version of every key, oldest key first, every state. */
  readonly records: readonly TaskMemoryRecord[];
  readonly limits: typeof TASK_MEMORY_LIMITS;
}

/** A page of earlier summary revisions, newest first. */
export interface TaskSummaryHistoryView {
  readonly version: typeof TASK_MEMORY_VERSION;
  readonly taskId: string;
  readonly revisions: readonly TaskSummaryRevision[];
  /** Every revision the Task incarnation has, shown or not. */
  readonly total: number;
}

/**
 * A Task's open-question count, carried beside a Task in the Tasks list so
 * Home and the inbox derive "Needs you" from it with the Task's status.
 */
export interface TaskMemoryAttention {
  readonly openQuestionCount: number;
}

/**
 * Whether a Task waits on a person's answer: it has an open question and is
 * still live. A done or canceled Task's leftover questions ask nobody.
 */
export function taskAwaitsAnswer(
  task: { readonly status: string } & Partial<TaskMemoryAttention>,
): boolean {
  return (
    (task.openQuestionCount ?? 0) > 0 &&
    task.status !== 'done' &&
    task.status !== 'canceled'
  );
}

export type TaskMemoryRefusal =
  | { readonly kind: 'summary-empty' }
  | {
      readonly kind: 'summary-too-long';
      readonly length: number;
      readonly limit: number;
    }
  | { readonly kind: 'base-revision-invalid' }
  | { readonly kind: 'kind-invalid' }
  | { readonly kind: 'action-invalid' }
  | { readonly kind: 'importance-invalid' }
  | { readonly kind: 'key-invalid'; readonly limit: number }
  | { readonly kind: 'text-required'; readonly action: 'set' | 'answer' }
  | {
      readonly kind: 'text-too-long';
      readonly length: number;
      readonly limit: number;
    }
  | { readonly kind: 'reason-required' }
  | {
      readonly kind: 'reason-too-long';
      readonly length: number;
      readonly limit: number;
    }
  /** A field the action does not take was sent; nothing is ignored silently. */
  | {
      readonly kind: 'field-not-allowed';
      readonly field: 'text' | 'importance' | 'reason';
      readonly action: TaskRecordAction;
    }
  | { readonly kind: 'answer-not-a-question' }
  | { readonly kind: 'record-missing' }
  | { readonly kind: 'question-not-open'; readonly state: TaskRecordState }
  | { readonly kind: 'record-retired' }
  | {
      readonly kind: 'live-cap';
      readonly recordKind: TaskRecordKind;
      readonly limit: number;
    };

function isOneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === 'string' && (values as readonly string[]).includes(value)
  );
}

export const isTaskRecordKind = (value: unknown): value is TaskRecordKind =>
  isOneOf(TASK_RECORD_KINDS, value);

/** The refusal for a summary's text, or undefined when it can be stored as given. */
export function taskSummaryRefusal(
  text: string,
): TaskMemoryRefusal | undefined {
  if (text.trim().length === 0) return { kind: 'summary-empty' };
  if (text.length > TASK_MEMORY_LIMITS.summaryChars)
    return {
      kind: 'summary-too-long',
      length: text.length,
      limit: TASK_MEMORY_LIMITS.summaryChars,
    };
  return undefined;
}

export function isValidTaskRecordKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    key.length <= TASK_MEMORY_LIMITS.recordKeyChars &&
    TASK_RECORD_KEY_PATTERN.test(key)
  );
}

/**
 * The stateless refusal for a record write, or the write with its action
 * resolved. Whether the key exists, is open, or fits under its cap is the
 * store's to decide inside its transaction.
 */
export function checkTaskRecordWrite(write: TaskRecordWrite):
  | {
      readonly ok: true;
      readonly write: TaskRecordWrite & { action: TaskRecordAction };
    }
  | { readonly ok: false; readonly refusal: TaskMemoryRefusal } {
  const refuse = (refusal: TaskMemoryRefusal) => ({
    ok: false as const,
    refusal,
  });
  if (!isTaskRecordKind(write.kind)) return refuse({ kind: 'kind-invalid' });
  const action = write.action ?? 'set';
  if (!isOneOf(TASK_RECORD_ACTIONS, action))
    return refuse({ kind: 'action-invalid' });
  if (!isValidTaskRecordKey(write.key))
    return refuse({
      kind: 'key-invalid',
      limit: TASK_MEMORY_LIMITS.recordKeyChars,
    });
  if (
    write.importance !== undefined &&
    !isOneOf(TASK_RECORD_IMPORTANCES, write.importance)
  )
    return refuse({ kind: 'importance-invalid' });
  if (action !== 'set' && write.importance !== undefined)
    return refuse({ kind: 'field-not-allowed', field: 'importance', action });
  if (action !== 'retire' && write.reason !== undefined)
    return refuse({ kind: 'field-not-allowed', field: 'reason', action });
  if (action === 'retire') {
    if (write.text !== undefined)
      return refuse({ kind: 'field-not-allowed', field: 'text', action });
    if (typeof write.reason !== 'string' || !write.reason.trim())
      return refuse({ kind: 'reason-required' });
    if (write.reason.length > TASK_MEMORY_LIMITS.recordReasonChars)
      return refuse({
        kind: 'reason-too-long',
        length: write.reason.length,
        limit: TASK_MEMORY_LIMITS.recordReasonChars,
      });
  } else {
    if (typeof write.text !== 'string' || !write.text.trim())
      return refuse({ kind: 'text-required', action });
    if (write.text.length > TASK_MEMORY_LIMITS.recordTextChars)
      return refuse({
        kind: 'text-too-long',
        length: write.text.length,
        limit: TASK_MEMORY_LIMITS.recordTextChars,
      });
    if (action === 'answer' && write.kind !== 'question')
      return refuse({ kind: 'answer-not-a-question' });
  }
  return { ok: true, write: { ...write, action } };
}

const KIND_NOUNS: Record<TaskRecordKind, string> = {
  decision: 'decision',
  question: 'open question',
  dead_end: 'dead end',
};

/** The sentence a refusal shows to the agent or person who made the write. */
export function taskMemoryRefusalMessage(refusal: TaskMemoryRefusal): string {
  switch (refusal.kind) {
    case 'summary-empty':
      return 'The summary is empty. Nothing was written.';
    case 'summary-too-long':
      return `The summary is ${refusal.length} characters; the limit is ${refusal.limit}. Nothing was written: prune it to what is true now (drop finished detail, merge repeated points) and write it again.`;
    case 'base-revision-invalid':
      return 'baseRevision must be the whole-number revision you read (0 when the Task has no summary yet).';
    case 'kind-invalid':
      return 'kind must be "decision", "question" or "dead_end".';
    case 'action-invalid':
      return 'action must be "set", "answer" or "retire".';
    case 'importance-invalid':
      return 'importance must be "standing" or "on_topic".';
    case 'key-invalid':
      return `key must be a short lowercase slug of letters, digits and single hyphens (for example "storage-engine"), at most ${refusal.limit} characters. Nothing was written.`;
    case 'text-required':
      return refusal.action === 'answer'
        ? 'answer needs text: the answer to the question.'
        : 'set needs text: the decision, question or dead end.';
    case 'text-too-long':
      return `The text is ${refusal.length} characters; the limit is ${refusal.limit}. Nothing was written: shorten it.`;
    case 'reason-required':
      return 'retire needs a reason: why the record no longer holds.';
    case 'reason-too-long':
      return `The reason is ${refusal.length} characters; the limit is ${refusal.limit}. Nothing was written: shorten it.`;
    case 'field-not-allowed':
      return `${refusal.action} does not take ${refusal.field}. Nothing was written.`;
    case 'answer-not-a-question':
      return 'Only a question can be answered.';
    case 'record-missing':
      return 'No record has that kind and key. Nothing was written.';
    case 'question-not-open':
      return `That question is ${refusal.state}, not open, so it cannot be answered. Set it again to reopen it.`;
    case 'record-retired':
      return 'That record is already retired. Set it again to bring it back.';
    case 'live-cap':
      return `This Task already holds ${refusal.limit} ${refusal.recordKind === 'question' ? 'open questions' : `active ${KIND_NOUNS[refusal.recordKind]}s`}, the limit. Nothing was written: supersede or retire one (set an existing key, or retire one that no longer holds)${refusal.recordKind === 'question' ? ', or answer one' : ''}.`;
  }
}

// ── Learning: promoting a done Task's lessons (#4003, layer 4) ──────────────
//
// When a Task is done, its active standing decisions and dead ends are
// CANDIDATES for the Project's knowledge store. Candidates are derived on
// read from Task memory; nothing is copied until a person promotes one.
// Promotion writes one knowledge record through the store's own create path,
// under an id derived from the record version, so the same version is never
// written twice. A dismissal is the only state Station keeps of its own.

export const TASK_LEARNING_VERSION = 'station.task-learning/v1' as const;

/** The record kinds a done Task offers for promotion. */
export const TASK_LEARNING_KINDS = ['decision', 'dead_end'] as const;
export type TaskLearningKind = (typeof TASK_LEARNING_KINDS)[number];

export const TASK_LEARNING_LIMITS = Object.freeze({
  /** The promoted knowledge record's title. */
  titleChars: 200,
  /** The promoted knowledge record's body: the person's edited text. */
  bodyChars: 4000,
});

/**
 * Where a candidate stands. `promoted` is read back from the Project's
 * knowledge stores (the record under the candidate's knowledge record id);
 * `dismissed` is the person's persisted decision not to promote it.
 */
export type TaskLearningReview =
  | { readonly state: 'open' }
  /**
   * A promotion is recorded for this version and its store is still one of
   * the Project's, but the knowledge record is not in it: finishing the
   * promotion writes it there, and only there.
   */
  | {
      readonly state: 'pending';
      readonly rootId: string;
    }
  /**
   * A promotion is recorded for this version, into a store that is no
   * longer one of the Project's (removed, or its root id now names another
   * store). A closed review: never offered again, and nothing is claimed
   * about whether the record was written. `rootId` is as recorded.
   */
  | {
      readonly state: 'promotion-store-gone';
      readonly rootId: string;
    }
  | {
      readonly state: 'promoted';
      readonly rootId: string;
      readonly knowledgeRecordId: string;
    }
  | {
      readonly state: 'dismissed';
      readonly dismissedAt: string;
      readonly dismissedBy: string;
    };

export interface TaskLearningCandidate {
  /** The record version on offer: an active, standing decision or dead end. */
  readonly record: TaskMemoryRecord & { readonly kind: TaskLearningKind };
  /** The id a promotion of this version writes, in whichever store. */
  readonly knowledgeRecordId: string;
  readonly review: TaskLearningReview;
}

/** A Project knowledge store a candidate can be promoted into. */
export interface TaskLearningStore {
  readonly rootId: string;
  readonly displayName: string;
}

/** What the Task workspace reads to review a Task's lessons. */
export interface TaskLearningView {
  readonly version: typeof TASK_LEARNING_VERSION;
  readonly taskId: string;
  /** Only a done Task offers candidates; otherwise `candidates` is empty. */
  readonly offered: boolean;
  /** The Task's Project slug: Project knowledge stores are keyed by it. */
  readonly projectSlug: string;
  readonly workItemRef?: string;
  /** Writable Project knowledge stores; empty when the Project has none. */
  readonly stores: readonly TaskLearningStore[];
  /** Oldest first: decisions, then dead ends. */
  readonly candidates: readonly TaskLearningCandidate[];
  readonly limits: typeof TASK_LEARNING_LIMITS;
}

/** A person's promotion of one candidate version into one Project store. */
export interface TaskLearningPromotion {
  readonly kind: TaskLearningKind;
  readonly key: string;
  /** The version the person reviewed; a newer version is refused. */
  readonly version: number;
  readonly rootId: string;
  readonly title: string;
  /** The person's edited text: the knowledge record's body. */
  readonly text: string;
}

/** A person's dismissal of one candidate version. */
export interface TaskLearningDismissal {
  readonly kind: TaskLearningKind;
  readonly key: string;
  readonly version: number;
}
