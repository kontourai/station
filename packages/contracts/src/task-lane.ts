import type {
  ConversationPullRequestLinkObservation,
  LinkedPullRequestSnapshot,
  PullRequestLinkIdentity,
} from './conversation-pull-request-links.js';
import type { OrchestrationSessionSummary } from './orchestration.js';
import type {
  PullRequest,
  PullRequestMergeReadiness,
} from './pull-request-provider.js';
import {
  orchestrationLifecycleLabel,
  SESSION_STATUS_WORDS,
  sessionAttentionKind,
} from './session-attention.js';
import type { TaskPriority, TaskRecord } from './task-graph.js';
import { type TaskMemoryAttention, taskAwaitsAnswer } from './task-memory.js';

/**
 * WHERE A TASK STANDS (derived Task lanes). A Task's lane is never stored:
 * it is computed at read time from durable facts, so it cannot go stale the
 * way a stored "in progress" does. The stored `TaskRecord.status` stays what a
 * person or agent intended (backlog, done, canceled, "marked blocked"); the
 * facts that move a Task between lanes are its run and the pull requests kept
 * on it, as their provider reports them. The run is `TaskRecord.sessionId`'s
 * summary, or the later execution its conversation has moved on to
 * (`currentSessionId`); the caller resolves which.
 *
 * Two rules hold the derivation honest:
 *
 * - A fact that was not observed never yields a lane that claims it. A pull
 *   request whose readiness is absent or unknown is never "Ready to merge";
 *   one whose state could not be read keeps every pull request rung that
 *   needs it ("Ready to merge", "PR merged") out of reach.
 * - A run that cannot be read is "Run status unavailable", never "Stopped",
 *   and it keeps a Task out of "Ready to merge" and "PR merged": the run may
 *   still be changing the pull request.
 *
 * Session words are the status ladder's own (`SESSION_STATUS_WORDS`); this
 * module defines no synonym for them.
 */
export const TASK_LANES = [
  'needs_you',
  'running',
  'in_review',
  'ready_to_merge',
  'idle',
] as const;
export type TaskLaneId = (typeof TASK_LANES)[number];

export const TASK_SHELVES = ['backlog', 'done', 'canceled'] as const;
export type TaskShelfId = (typeof TASK_SHELVES)[number];

export const TASK_LANE_LABELS: Record<TaskLaneId, string> = {
  needs_you: 'Needs you',
  running: SESSION_STATUS_WORDS.running,
  in_review: 'In review',
  ready_to_merge: 'Ready to merge',
  idle: SESSION_STATUS_WORDS.idle,
};

export const TASK_SHELF_LABELS: Record<TaskShelfId, string> = {
  backlog: 'Backlog',
  done: SESSION_STATUS_WORDS.done,
  canceled: 'Canceled',
};

/** The Done shelf lists this many of the most recently updated Tasks. */
export const TASK_DONE_SHELF_LIMIT = 20;

/**
 * The colour discipline of the status ladder: colour means act-now
 * (`attention`), in-motion (`active`) or broken; `caution` is worth a look
 * without being owed; `positive` is the one ready-to-land state (every open
 * pull request clean); everything else is `neutral`.
 */
export type TaskLaneTone =
  | 'attention'
  | 'caution'
  | 'active'
  | 'positive'
  | 'broken'
  | 'neutral';

/** One pull request kept on a Task, as its provider reported it. */
export interface TaskPullRequestFact extends PullRequestLinkIdentity {
  url?: string;
  /** When this fact was read from the provider. */
  observedAt: string;
  status:
    | {
        state: 'current';
        /** The provider's own word: `OPEN`, `MERGED`, `CLOSED`, … */
        pullRequestState: string;
        title?: string;
        draft?: boolean;
        reviewDecision?: PullRequest['reviewDecision'];
        readiness?: PullRequestMergeReadiness;
        checks?: LinkedPullRequestSnapshot['checks'];
        mergeability: PullRequest['mergeability'];
        sourceBranch?: string;
        /** Armed or queued to merge; absent when not observed. */
        landing?: PullRequest['landing'];
        /** The head commit the provider reported, when it did. */
        headSha?: string;
      }
    | { state: 'unavailable' | 'unsupported'; reason: string };
  /**
   * Its agent feedback, only for a reader of the chat that gets it and only
   * while the `pull-request-agent-feedback` preview is on. Delivery adds a
   * note; an enabled Station review also holds Ready to merge until the
   * current head has a completed review without required findings.
   */
  feedback?: TaskPullRequestFeedbackFact;
}

/**
 * Where a pull request's agent feedback stands, for a Task card. `fixing`:
 * the feedback goes to this Task's own run, and its open turn is the one
 * Station started to send this pull request's failing checks. Computed per
 * Task, so the same pull request kept on two Tasks is fixing on at most the
 * one whose run is doing it.
 */
export interface TaskPullRequestFeedbackFact {
  state:
    | 'watching'
    | 'waiting-on-checks'
    | 'sent'
    | 'fixing'
    | 'paused'
    | 'reviewing'
    | 'reviewed'
    | 'review-needed';
  /** The head this is about. */
  headSha?: string;
  reviewEachHead?: true;
  /** `sent`: when it went. */
  at?: string;
}

export interface TaskPullRequestFactsEntry {
  taskCreatedAt: string;
  pullRequests: TaskPullRequestFact[];
  linkedPullRequests?: ConversationPullRequestLinkObservation[];
  /** Some kept pull requests were not read (a per-request bound). */
  partial?: true;
}

/** `GET /api/tasks/pull-request-facts`: one read per Project board. */
export interface TaskPullRequestFactsProjection {
  observedAt: string;
  tasks: Record<string, TaskPullRequestFactsEntry>;
}

/**
 * The session summary the derivation reads. The whole summary, because the
 * ladder's own fold (`orchestrationLifecycleLabel`) reads it whole.
 */
export type TaskSessionFact = OrchestrationSessionSummary;

export type TaskLaneRung =
  | 'canceled'
  | 'done'
  | 'approval'
  | 'answer'
  | 'interrupted'
  | 'blocked'
  | 'waiting'
  | 'taskQuestion'
  | 'failed'
  | 'running'
  | 'merged'
  | 'changesRequested'
  | 'conflict'
  | 'checksNotPassing'
  | 'draft'
  | 'awaitingReview'
  | 'stationReviewNeeded'
  | 'stationReviewPending'
  | 'repoBlocked'
  | 'behind'
  | 'readyToMerge'
  | 'prOpen'
  | 'prUnknown'
  | 'markedBlocked'
  | 'fixAttemptsUsed'
  | 'markedReview'
  | 'runUnknown'
  | 'elsewhere'
  | 'finished'
  | 'stopped'
  | 'runDraft'
  | 'backlog'
  | 'notStarted';

export type TaskNextAction =
  | {
      kind: 'open-session';
      sessionId: string;
      label: 'Approve…' | 'Answer…' | 'Resume…' | 'Open run';
    }
  | { kind: 'open-task'; label: 'Answer…' | 'Open Task' }
  | {
      kind: 'open-pull-request';
      pullRequest: PullRequestLinkIdentity;
      url?: string;
      label: 'Merge…' | 'Open PR';
    }
  | { kind: 'mark-done'; label: 'Mark done' }
  | { kind: 'dispatch'; label: 'Start' };

export type TaskStatusGlyph =
  | 'spinner'
  | 'pr-open'
  | 'pr-draft'
  | 'pr-merged'
  | 'pr-closed'
  | 'dot';

export interface TaskLaneDerivation {
  taskId: string;
  placement:
    | { kind: 'lane'; lane: TaskLaneId }
    | { kind: 'shelf'; shelf: TaskShelfId };
  rung: TaskLaneRung;
  tone: TaskLaneTone;
  word: string;
  detail?: string;
  /**
   * What agent feedback is doing for the card's pull request ("auto-fix
   * on", "sent", "fixing checks on #42"), printed after `detail`, with
   * `at` as a relative time. It never changes the lane, rung, tone or
   * certainty. Kept apart from `detail` because this derivation reads no
   * clock, and a run's own words replace `detail` on its rungs.
   */
  feedbackNote?: { text: string; at?: string };
  /** The longer form, for a tooltip; never printed on the card. */
  reason?: string;
  statusGlyph: TaskStatusGlyph;
  evidence: {
    /** Every kept pull request fact, closed ones included, worst first. */
    pullRequests: TaskPullRequestFact[];
    /** The run read: the Task's session or its conversation's current one. */
    sessionId?: string;
  };
  /** The instant of the fact the status line is about. */
  factTime?: string;
  nextAction: TaskNextAction;
  /**
   * `observed`: every fact the rung needs was read. `partial`: the rung is
   * true of what was read, and some fact was not (a pull request, the run).
   * `unknown`: the rung itself says a fact could not be read.
   */
  certainty: 'observed' | 'partial' | 'unknown';
  /** Copied from the Task: the order a lane seeds its cards in. */
  order: { priority: TaskPriority; updatedAt: string };
}

export interface TaskLaneInput {
  task: TaskRecord & Partial<TaskMemoryAttention>;
  /**
   * The summary of the Task's run: `task.sessionId`'s, or the execution its
   * conversation has since moved on to (`currentSessionId`). `unreadable`:
   * the Task names a run and its summary could not be read. `undefined`: the
   * Task names no run.
   */
  session: TaskSessionFact | 'unreadable' | undefined;
  /**
   * The Task's kept pull requests. `unavailable`: the facts read failed.
   * `undefined`: not read yet. Either way nothing about pull requests is
   * claimed.
   */
  pullRequests: readonly TaskPullRequestFact[] | 'unavailable' | undefined;
}

const MERGED = 'MERGED';
const CLOSED = 'CLOSED';

type CurrentFact = TaskPullRequestFact & {
  status: Extract<TaskPullRequestFact['status'], { state: 'current' }>;
};

const isCurrent = (fact: TaskPullRequestFact): fact is CurrentFact =>
  fact.status.state === 'current';
const OPEN = 'OPEN';
const isOpen = (fact: CurrentFact) => fact.status.pullRequestState === OPEN;
/** Read, but in a state this table does not name (GitLab `LOCKED`, …). */
const isUnnamedState = (fact: CurrentFact) =>
  fact.status.pullRequestState !== OPEN &&
  fact.status.pullRequestState !== MERGED &&
  fact.status.pullRequestState !== CLOSED;

/**
 * The review rung of one open pull request, worst first. Index order is the
 * table's order, so the worst across several pull requests is the minimum.
 */
const OPEN_PULL_REQUEST_RUNGS = [
  'changesRequested',
  'conflict',
  'checksNotPassing',
  'draft',
  'stationReviewNeeded',
  'stationReviewPending',
  'awaitingReview',
  'repoBlocked',
  'behind',
  // Unknown readiness outranks clean: one unread readiness keeps every
  // pull request out of "Ready to merge".
  'prOpen',
  'readyToMerge',
] as const;
type OpenPullRequestRung = (typeof OPEN_PULL_REQUEST_RUNGS)[number];

function openPullRequestRung(fact: CurrentFact): OpenPullRequestRung {
  const { status } = fact;
  const review = feedbackOnHead(fact)?.state;
  if (status.reviewDecision === 'changes_requested') return 'changesRequested';
  if (
    status.mergeability === 'conflicting' ||
    status.readiness === 'conflicting'
  )
    return 'conflict';
  if (status.readiness === 'checks-not-passing') return 'checksNotPassing';
  if (status.draft === true || status.readiness === 'draft') return 'draft';
  if (review === 'review-needed') return 'stationReviewNeeded';
  if (
    review === 'reviewing' ||
    (fact.feedback?.reviewEachHead &&
      (!status.headSha ||
        !fact.feedback.headSha ||
        fact.feedback.headSha !== status.headSha))
  )
    return 'stationReviewPending';
  if (status.readiness === 'blocked')
    return status.reviewDecision === 'review_required'
      ? 'awaitingReview'
      : 'repoBlocked';
  if (status.readiness === 'behind') return 'behind';
  // Only the forge's own "clean" is ready. Absent or unknown readiness says
  // nothing either way, so it stays "PR open".
  if (status.readiness === 'clean') return 'readyToMerge';
  return 'prOpen';
}

const OPEN_RUNG_WORDS: Record<OpenPullRequestRung, string> = {
  changesRequested: 'Changes requested',
  conflict: 'Conflicts with base',
  checksNotPassing: 'Checks not passing',
  draft: 'Draft PR',
  stationReviewNeeded: 'Station review needs you',
  stationReviewPending: 'Station review pending',
  awaitingReview: 'Waiting for review',
  repoBlocked: 'Blocked by repository rules',
  behind: 'Behind base',
  readyToMerge: 'Ready to merge',
  prOpen: 'PR open',
};

const OPEN_RUNG_TONES: Record<OpenPullRequestRung, TaskLaneTone> = {
  changesRequested: 'caution',
  conflict: 'caution',
  checksNotPassing: 'caution',
  draft: 'neutral',
  stationReviewNeeded: 'caution',
  stationReviewPending: 'neutral',
  awaitingReview: 'neutral',
  repoBlocked: 'neutral',
  behind: 'neutral',
  readyToMerge: 'positive',
  prOpen: 'neutral',
};

const pullRequestLabel = (fact: PullRequestLinkIdentity) => `#${fact.ref}`;

/** A pull request's feedback, only while it is about the head the provider reported. */
const feedbackOnHead = (fact: CurrentFact) =>
  fact.feedback &&
  fact.status.headSha &&
  fact.feedback.headSha === fact.status.headSha
    ? fact.feedback
    : undefined;

const IN_REVIEW_FEEDBACK_NOTES: Partial<
  Record<TaskPullRequestFeedbackFact['state'], string>
> = {
  watching: 'auto-fix on',
  'waiting-on-checks': 'waiting on checks',
  sent: 'sent',
  paused: 'auto-fix paused',
  // The run is fixing, but the card read it as not running (a run list
  // older than the facts): still say so rather than nothing.
  fixing: 'fixing checks',
};

/** An In review card's feedback note, for the pull request it names. */
function inReviewFeedbackNote(
  fact: CurrentFact,
): TaskLaneDerivation['feedbackNote'] {
  const feedback = feedbackOnHead(fact);
  const text = feedback && IN_REVIEW_FEEDBACK_NOTES[feedback.state];
  if (!feedback || !text) return undefined;
  return { text, ...(feedback.at ? { at: feedback.at } : {}) };
}

/** A Running card's note: its run is the turn fixing a pull request's checks. */
function runningFeedbackNote(
  facts: readonly TaskPullRequestFact[],
): TaskLaneDerivation['feedbackNote'] {
  const fixing = facts.find(
    (fact): fact is CurrentFact =>
      isCurrent(fact) &&
      isOpen(fact) &&
      feedbackOnHead(fact)?.state === 'fixing',
  );
  return fixing
    ? { text: `fixing checks on ${pullRequestLabel(fixing)}` }
    : undefined;
}
const identityOf = (fact: TaskPullRequestFact): PullRequestLinkIdentity => ({
  provider: fact.provider,
  host: fact.host,
  repository: { ...fact.repository },
  ref: fact.ref,
});

/** Worst first: open by rung, then merged, unavailable, closed. */
function evidenceOrder(facts: readonly TaskPullRequestFact[]) {
  const weight = (fact: TaskPullRequestFact) => {
    if (!isCurrent(fact) || isUnnamedState(fact))
      return OPEN_PULL_REQUEST_RUNGS.length + 1;
    if (isOpen(fact))
      return OPEN_PULL_REQUEST_RUNGS.indexOf(openPullRequestRung(fact));
    return fact.status.pullRequestState === MERGED
      ? OPEN_PULL_REQUEST_RUNGS.length
      : OPEN_PULL_REQUEST_RUNGS.length + 2;
  };
  return [...facts].sort((a, b) => weight(a) - weight(b));
}

function pullRequestGlyph(
  facts: readonly TaskPullRequestFact[],
): TaskStatusGlyph | undefined {
  const current = facts.filter(isCurrent);
  const open = current.filter(isOpen);
  if (open.length) {
    return open.every(
      (fact) => fact.status.draft === true || fact.status.readiness === 'draft',
    )
      ? 'pr-draft'
      : 'pr-open';
  }
  if (current.some((fact) => fact.status.pullRequestState === MERGED))
    return 'pr-merged';
  if (current.length) return 'pr-closed';
  return undefined;
}

const SESSION_NEEDS_LABEL = {
  approval: 'Approve…',
  answer: 'Answer…',
  waiting: 'Answer…',
  blocked: 'Answer…',
  interrupted: 'Resume…',
} as const;

/**
 * One Task's lane, rung, words and next action. First match wins, in the
 * numbered order below. Pure, and reads no clock: nothing here ages.
 */
export function deriveTaskLane(input: TaskLaneInput): TaskLaneDerivation {
  const { task } = input;
  const facts = Array.isArray(input.pullRequests)
    ? evidenceOrder(input.pullRequests as readonly TaskPullRequestFact[])
    : [];
  const factsKnown = Array.isArray(input.pullRequests);
  const session =
    input.session && input.session !== 'unreadable' ? input.session : undefined;
  const sessionId = task.sessionId?.trim() || undefined;
  // The run read: the Task's session, or the execution its conversation has
  // moved on to (the caller resolves which).
  const runId = session?.threadId ?? sessionId;
  const base = {
    taskId: task.id,
    evidence: { pullRequests: facts, ...(runId ? { sessionId: runId } : {}) },
    order: { priority: task.priority, updatedAt: task.updatedAt },
  };
  const glyph = pullRequestGlyph(facts) ?? 'dot';
  const openRun = (label: 'Open run' = 'Open run'): TaskNextAction =>
    runId
      ? { kind: 'open-session', sessionId: runId, label }
      : { kind: 'open-task', label: 'Open Task' };
  const openTask: TaskNextAction = { kind: 'open-task', label: 'Open Task' };
  const start: TaskNextAction = task.agentId?.trim()
    ? { kind: 'dispatch', label: 'Start' }
    : openTask;
  const sessionTime = session?.lastEventAt ?? session?.updatedAt;
  // Facts the rungs below read but could not.
  const runMissing = Boolean(sessionId) && !session;
  const lane = (id: TaskLaneId) => ({ kind: 'lane' as const, lane: id });
  const shelf = (id: TaskShelfId) => ({ kind: 'shelf' as const, shelf: id });

  // 0. Intent shelves: what a person decided outranks every observation.
  if (task.status === 'canceled')
    return {
      ...base,
      placement: shelf('canceled'),
      rung: 'canceled',
      tone: 'neutral',
      word: 'Canceled',
      statusGlyph: glyph,
      factTime: task.updatedAt,
      nextAction: openTask,
      certainty: 'observed',
    };
  if (task.status === 'done')
    return {
      ...base,
      placement: shelf('done'),
      rung: 'done',
      tone: 'neutral',
      word: SESSION_STATUS_WORDS.done,
      statusGlyph: glyph,
      factTime: task.updatedAt,
      nextAction: openTask,
      certainty: 'observed',
    };

  // A transcript attached from another app is read only here: its run
  // rungs (owed, failed, running) are not this Station's to act on.
  const ownRun =
    session && session.controlMode !== 'read-only-attached'
      ? session
      : undefined;
  const label = ownRun ? orchestrationLifecycleLabel(ownRun) : undefined;

  // 1. The run owes a decision someone here can answer.
  if (ownRun && label === 'Needs attention') {
    const kind = sessionAttentionKind(ownRun);
    return {
      ...base,
      placement: lane('needs_you'),
      rung: kind,
      tone: 'attention',
      word: SESSION_STATUS_WORDS[kind],
      statusGlyph: 'dot',
      factTime: sessionTime,
      nextAction: {
        kind: 'open-session',
        sessionId: ownRun.threadId,
        label: SESSION_NEEDS_LABEL[kind],
      },
      certainty: 'observed',
    };
  }
  // 2. The Task itself asks a question.
  if (taskAwaitsAnswer(task))
    return {
      ...base,
      placement: lane('needs_you'),
      rung: 'taskQuestion',
      tone: 'attention',
      word: SESSION_STATUS_WORDS.answer,
      detail: 'Task question',
      statusGlyph: 'dot',
      factTime: task.updatedAt,
      nextAction: { kind: 'open-task', label: 'Answer…' },
      certainty: 'observed',
    };
  // 3. The run broke.
  if (ownRun && label === 'Failed')
    return {
      ...base,
      placement: lane('needs_you'),
      rung: 'failed',
      tone: 'broken',
      word: SESSION_STATUS_WORDS.failed,
      statusGlyph: 'dot',
      factTime: sessionTime,
      nextAction: openRun(),
      certainty: 'observed',
    };
  // 4. The run is moving. It outranks every pull request state: a run in
  // flight may still push to them.
  if (ownRun && label === 'Running') {
    const feedbackNote = runningFeedbackNote(facts);
    return {
      ...base,
      placement: lane('running'),
      rung: 'running',
      tone: 'active',
      word: SESSION_STATUS_WORDS.running,
      ...(feedbackNote ? { feedbackNote } : {}),
      statusGlyph: 'spinner',
      factTime: sessionTime,
      nextAction: openRun(),
      certainty: 'observed',
    };
  }

  // 4a. Station blocked the Task (#5066): a watched pull request used every
  // fix attempt and these checks still fail.
  if (task.status === 'blocked' && task.pullRequestWatchHold)
    return {
      ...base,
      placement: lane('needs_you'),
      rung: 'fixAttemptsUsed',
      tone: 'attention',
      word: 'Fix attempts used',
      detail: task.pullRequestWatchHold.checks.join(', ') || undefined,
      reason: `${task.pullRequestWatchHold.pullRequest}: checks still fail after every fix attempt.`,
      statusGlyph: glyph,
      factTime: task.pullRequestWatchHold.at,
      nextAction: openTask,
      certainty: 'observed',
    };
  // 4b. A person or agent marked the Task blocked: a recorded decision that
  // no pull request state outranks (a clean PR does not unblock a Task).
  if (task.status === 'blocked')
    return {
      ...base,
      placement: lane('needs_you'),
      rung: 'markedBlocked',
      tone: 'attention',
      word: 'Marked blocked',
      statusGlyph: glyph,
      factTime: task.updatedAt,
      nextAction: openTask,
      certainty: 'observed',
    };

  // 5–15. Pull requests, as their provider reported them.
  const current = facts.filter(
    (fact): fact is CurrentFact => isCurrent(fact) && !isUnnamedState(fact),
  );
  const unreadPullRequests = facts.filter(
    (fact) => !isCurrent(fact) || isUnnamedState(fact),
  );
  // The run may still be changing a pull request it cannot be seen working
  // on: with the run unread, a clean or merged PR is not a next step yet.
  const runUnknownInReview = (fact: TaskPullRequestFact) => ({
    ...base,
    placement: lane('in_review'),
    rung: 'runUnknown' as const,
    tone: 'caution' as const,
    word: 'Run status unavailable',
    detail: pullRequestLabel(fact),
    statusGlyph: glyph,
    factTime: task.updatedAt,
    nextAction: {
      kind: 'open-pull-request' as const,
      pullRequest: identityOf(fact),
      ...(fact.url ? { url: fact.url } : {}),
      label: 'Open PR' as const,
    },
    certainty: 'unknown' as const,
  });
  const open = current.filter(isOpen);
  const merged = current.filter(
    (fact) => fact.status.pullRequestState === MERGED,
  );
  const pullRequestCertainty =
    unreadPullRequests.length || runMissing ? 'partial' : 'observed';
  // 5. Every kept pull request merged (closed-unmerged ones are ignored):
  // the work landed, and the Task is still open.
  if (merged.length && !open.length && !unreadPullRequests.length) {
    const first = merged[0] as CurrentFact;
    if (runMissing) return runUnknownInReview(first);
    return {
      ...base,
      placement: lane('needs_you'),
      rung: 'merged',
      tone: 'neutral',
      word: 'PR merged',
      detail:
        merged.length > 1 ? `${merged.length} PRs` : pullRequestLabel(first),
      statusGlyph: 'pr-merged',
      factTime: first.observedAt,
      nextAction: { kind: 'mark-done', label: 'Mark done' },
      certainty: 'observed',
    };
  }
  if (open.length) {
    const worst = open
      .map((fact) => ({ fact, rung: openPullRequestRung(fact) }))
      .sort(
        (a, b) =>
          OPEN_PULL_REQUEST_RUNGS.indexOf(a.rung) -
          OPEN_PULL_REQUEST_RUNGS.indexOf(b.rung),
      )[0] as { fact: CurrentFact; rung: OpenPullRequestRung };
    // 13. Ready only when every open pull request is clean and none could
    // not be read: an unread one may be open and not ready.
    const ready = worst.rung === 'readyToMerge';
    if (ready && runMissing && !unreadPullRequests.length)
      return runUnknownInReview(worst.fact);
    if (!ready || !unreadPullRequests.length) {
      const feedbackNote = ready ? undefined : inReviewFeedbackNote(worst.fact);
      return {
        ...base,
        placement: lane(ready ? 'ready_to_merge' : 'in_review'),
        rung: worst.rung,
        tone: OPEN_RUNG_TONES[worst.rung],
        word: OPEN_RUNG_WORDS[worst.rung],
        detail:
          ready && open.length > 1
            ? `${open.length} PRs`
            : pullRequestLabel(worst.fact),
        ...(feedbackNote ? { feedbackNote } : {}),
        ...(worst.fact.status.title ? { reason: worst.fact.status.title } : {}),
        statusGlyph: glyph,
        factTime: worst.fact.observedAt,
        nextAction: {
          kind: 'open-pull-request',
          pullRequest: identityOf(worst.fact),
          ...(worst.fact.url ? { url: worst.fact.url } : {}),
          label: ready ? 'Merge…' : 'Open PR',
        },
        certainty: pullRequestCertainty,
      };
    }
  }
  // 15. A kept pull request could not be read, and nothing read outranks it.
  if (unreadPullRequests.length) {
    const unread = unreadPullRequests[0] as TaskPullRequestFact;
    return {
      ...base,
      placement: lane('in_review'),
      rung: 'prUnknown',
      tone: 'caution',
      word: 'PR status unavailable',
      detail: pullRequestLabel(unread),
      reason:
        unread.status.state !== 'current'
          ? unread.status.reason
          : `The provider reports it ${unread.status.pullRequestState}.`,
      statusGlyph: glyph,
      factTime: unread.observedAt,
      nextAction: {
        kind: 'open-pull-request',
        pullRequest: identityOf(unread),
        ...(unread.url ? { url: unread.url } : {}),
        label: 'Open PR',
      },
      certainty: 'unknown',
    };
  }

  // 17. A person or agent marked the Task for review; worded by who
  // recorded it.
  if (task.status === 'review' || task.status === 'verification')
    return {
      ...base,
      placement: lane('needs_you'),
      rung: 'markedReview',
      tone: 'attention',
      word: 'Marked for review',
      statusGlyph: glyph,
      factTime: task.updatedAt,
      nextAction: openTask,
      certainty: 'observed',
    };

  // 18. The Task names a run this read could not see.
  if (runMissing)
    return {
      ...base,
      placement: lane('idle'),
      rung: 'runUnknown',
      tone: 'caution',
      word: 'Run status unavailable',
      statusGlyph: glyph,
      factTime: task.updatedAt,
      nextAction: openTask,
      certainty: 'unknown',
    };
  // 19. A run nothing here can answer or drive.
  if (
    session &&
    (session.controlMode === 'read-only-attached' || label === 'Unanswerable')
  )
    return {
      ...base,
      placement: lane('idle'),
      rung: 'elsewhere',
      tone: 'neutral',
      word: SESSION_STATUS_WORDS.elsewhere,
      statusGlyph: glyph,
      factTime: sessionTime,
      nextAction: openRun(),
      certainty: 'observed',
    };
  // 20. The run ended with nothing in review.
  if (ownRun && label) {
    if (label === 'Draft')
      return {
        ...base,
        placement: lane('idle'),
        rung: 'runDraft',
        tone: 'neutral',
        word: SESSION_STATUS_WORDS.draft,
        statusGlyph: glyph,
        factTime: sessionTime,
        nextAction: openRun(),
        certainty: 'observed',
      };
    const stopped = label === 'Stopped';
    return {
      ...base,
      placement: lane('idle'),
      rung: stopped ? 'stopped' : 'finished',
      tone: 'neutral',
      word: stopped ? SESSION_STATUS_WORDS.stopped : 'Agent finished',
      // "no PR kept" is a claim about the facts; only say it when read.
      ...(factsKnown && !facts.length ? { detail: 'no PR kept' } : {}),
      statusGlyph: glyph,
      factTime: sessionTime,
      nextAction: openRun(),
      certainty: factsKnown ? 'observed' : 'partial',
    };
  }
  // 21. Not yet picked up.
  if (
    (task.status === 'todo' || task.status === 'triage') &&
    !sessionId &&
    !facts.length
  )
    return {
      ...base,
      placement: shelf('backlog'),
      rung: 'backlog',
      tone: 'neutral',
      word: 'To do',
      statusGlyph: 'dot',
      factTime: task.updatedAt,
      nextAction: start,
      // Its pull requests were not read: nothing here says it has none.
      certainty: factsKnown ? 'observed' : 'partial',
    };
  // 22. Everything else is waiting to start.
  return {
    ...base,
    placement: lane('idle'),
    rung: 'notStarted',
    tone: 'neutral',
    word: 'Not started',
    statusGlyph: glyph,
    factTime: task.updatedAt,
    nextAction: start,
    certainty: factsKnown ? 'observed' : 'partial',
  };
}

const PRIORITY_RANK: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

function seedOrder(a: TaskLaneDerivation, b: TaskLaneDerivation) {
  return (
    PRIORITY_RANK[a.order.priority] - PRIORITY_RANK[b.order.priority] ||
    b.order.updatedAt.localeCompare(a.order.updatedAt) ||
    a.taskId.localeCompare(b.taskId)
  );
}

const byRecency = (a: TaskLaneDerivation, b: TaskLaneDerivation) =>
  b.order.updatedAt.localeCompare(a.order.updatedAt) ||
  a.taskId.localeCompare(b.taskId);

export interface TaskLanePartition {
  lanes: { id: TaskLaneId; label: string; taskIds: string[] }[];
  shelves: Record<TaskShelfId, string[]>;
  /** Every Task on each shelf, including those the Done limit leaves out. */
  shelfTotals: Record<TaskShelfId, number>;
}

/**
 * Cards in lanes, in a stable order: a card keeps its place while it stays
 * in its lane, a card entering a lane goes to its top, and a lane with no
 * previous order seeds by priority (urgent first), then most recently
 * updated, then id. Live data therefore never reorders a lane by itself;
 * only a move between lanes does. Every lane is returned, empty or not.
 */
export function partitionTaskLanes(
  derivations: readonly TaskLaneDerivation[],
  previousOrder: ReadonlyMap<TaskLaneId, readonly string[]> = new Map(),
): TaskLanePartition {
  const lanes = TASK_LANES.map((id) => {
    const members = derivations.filter(
      (item) => item.placement.kind === 'lane' && item.placement.lane === id,
    );
    const memberIds = new Set(members.map((item) => item.taskId));
    const previous = previousOrder.get(id) ?? [];
    const kept = previous.filter((taskId) => memberIds.has(taskId));
    const keptIds = new Set(kept);
    const arrivals = members
      .filter((item) => !keptIds.has(item.taskId))
      .sort(seedOrder)
      .map((item) => item.taskId);
    return {
      id,
      label: TASK_LANE_LABELS[id],
      taskIds: [...arrivals, ...kept],
    };
  });
  const onShelf = (id: TaskShelfId) =>
    derivations.filter(
      (item) => item.placement.kind === 'shelf' && item.placement.shelf === id,
    );
  const backlog = onShelf('backlog').sort(seedOrder);
  const done = onShelf('done').sort(byRecency);
  const canceled = onShelf('canceled').sort(byRecency);
  return {
    lanes,
    shelves: {
      backlog: backlog.map((item) => item.taskId),
      done: done.slice(0, TASK_DONE_SHELF_LIMIT).map((item) => item.taskId),
      canceled: canceled.map((item) => item.taskId),
    },
    shelfTotals: {
      backlog: backlog.length,
      done: done.length,
      canceled: canceled.length,
    },
  };
}
