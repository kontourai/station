/**
 * Pull request agent feedback: what Station tells the conversation that owns
 * a pull request when its checks fail, reviewers leave unresolved threads,
 * or it conflicts with its base branch, and what a person sees about it.
 *
 * Shapes and pure helpers only. The server observes the forge, decides,
 * and delivers (`src-server/services/pull-requests/pull-request-feedback-*`);
 * see `docs/decisions/pull-request-agent-feedback.md`.
 */
import type { PullRequestLinkIdentity } from './conversation-pull-request-links.js';

/** The Feature Preview every part of this feature is behind. */
export const PULL_REQUEST_FEEDBACK_PREVIEW_ID = 'pull-request-agent-feedback';

/**
 * Station's independent review of each new head: behind this preview as
 * well as `pull-request-agent-feedback`.
 */
export const PULL_REQUEST_HEAD_REVIEW_PREVIEW_ID = 'pull-request-head-review';

/**
 * What one delivery is about. `review-findings` is the required findings of
 * Station's own independent review of a head.
 */
export type PullRequestFeedbackCategory =
  | 'failing-checks'
  | 'review-threads'
  | 'merge-conflict'
  | 'review-findings';

/**
 * A person's switches for one pull request. `fixFailingChecks` covers
 * failing checks and merge conflicts; `addressReviewComments` covers
 * unresolved review threads and change requests. `reviewEachHead` runs
 * Station's own independent review on each new head (behind the
 * `pull-request-head-review` preview); its required findings go to the agent
 * under `addressReviewComments`, or when a person sends them.
 */
export interface PullRequestFeedbackSettings {
  fixFailingChecks: boolean;
  addressReviewComments: boolean;
  reviewEachHead: boolean;
}

export const PULL_REQUEST_FEEDBACK_OFF: Readonly<PullRequestFeedbackSettings> =
  Object.freeze({
    fixFailingChecks: false,
    addressReviewComments: false,
    reviewEachHead: false,
  });

/** Whether any switch that sends to the agent is on. */
export function pullRequestFeedbackSends(
  settings: PullRequestFeedbackSettings,
): boolean {
  return settings.fixFailingChecks || settings.addressReviewComments;
}

/**
 * Whether the claim does anything at all: a switch that sends, or Station's
 * own review of each new head. A review-only claim is still read, still
 * owned and still placed (its findings go out on a person's Send to agent).
 * `headReview` is whether review of each head is offered at all (its
 * preview): while it is not, `reviewEachHead` alone does nothing.
 */
export function pullRequestFeedbackActive(
  settings: PullRequestFeedbackSettings,
  headReview: boolean,
): boolean {
  return (
    pullRequestFeedbackSends(settings) ||
    (headReview && settings.reviewEachHead)
  );
}

/** A settings body as a client sent it, or undefined when it is not one. */
export function parsePullRequestFeedbackSettings(
  value: unknown,
): PullRequestFeedbackSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    'fixFailingChecks',
    'addressReviewComments',
    'reviewEachHead',
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return undefined;
  const flag = (key: string) => {
    const field = record[key];
    return field === undefined ? false : field;
  };
  const settings = {
    fixFailingChecks: flag('fixFailingChecks'),
    addressReviewComments: flag('addressReviewComments'),
    reviewEachHead: flag('reviewEachHead'),
  };
  return Object.values(settings).every((field) => typeof field === 'boolean')
    ? (settings as PullRequestFeedbackSettings)
    : undefined;
}

/**
 * One pull request's identity as this feature keys it: provider, host,
 * owner and name lowercased (the forge treats them case-insensitively),
 * and the number.
 */
export function pullRequestFeedbackKey(
  identity: PullRequestLinkIdentity,
): string {
  return JSON.stringify([
    identity.provider.toLowerCase(),
    identity.host.toLowerCase(),
    identity.repository.owner.toLowerCase(),
    identity.repository.name.toLowerCase(),
    identity.ref,
  ]);
}

/** Check conclusions that count as failing. A cancelled check does not. */
export const FAILING_CHECK_CONCLUSIONS: ReadonlySet<string> = new Set([
  'FAILURE',
  'TIMED_OUT',
  'STARTUP_FAILURE',
  'ACTION_REQUIRED',
]);

/** One check on the head commit, as the forge reported it. */
export interface PullRequestFeedbackCheck {
  /** "workflow / job" when the forge names the workflow, else the job. */
  name: string;
  /** Upper-case conclusion; null while the check has not finished. */
  conclusion: string | null;
  completed: boolean;
  /** Whether branch protection requires it; false when the forge did not say. */
  required: boolean;
  url?: string;
  /** The check's own title or summary text, when it has one. */
  excerpt?: string;
}

export interface PullRequestReviewThreadComment {
  id: string;
  /** Forge login; empty for a deleted account. */
  author: string;
  body: string;
  url?: string;
  createdAt: string;
}

/** One review thread, with its newest comments (oldest first). */
export interface PullRequestReviewThread {
  id: string;
  resolved: boolean;
  outdated: boolean;
  path: string;
  /** The line it is on; null for a file-level thread. */
  line: number | null;
  subject: 'line' | 'file';
  totalComments: number;
  comments: PullRequestReviewThreadComment[];
}

/** A reviewer's latest review. */
export interface PullRequestFeedbackReview {
  id: string;
  author: string;
  /** Upper-case: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED. */
  state: string;
  body: string;
  submittedAt?: string;
  url?: string;
}

/** Everything one forge read observed about one pull request. */
export interface PullRequestFeedbackObservation {
  identity: PullRequestLinkIdentity;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  draft: boolean;
  headSha: string;
  baseSha: string;
  headRefName: string;
  baseRefName: string;
  /** The owner of the repository the head branch lives in. */
  headOwner?: string;
  mergeable: 'mergeable' | 'conflicting' | 'unknown';
  reviewDecision?: string;
  checks: PullRequestFeedbackCheck[];
  /** The forge had more checks than one read returns. */
  checksTruncated: boolean;
  threads: PullRequestReviewThread[];
  /** Threads the forge holds, including any one read did not return. */
  threadsTotal: number;
  reviews: PullRequestFeedbackReview[];
  /** The forge login the read ran as. */
  viewerLogin?: string;
  observedAt: string;
}

export type PullRequestFeedbackUnavailableCause =
  /** Not signed in to the forge on this Station. */
  | 'credentials'
  | 'rate-limited'
  | 'not-found'
  /** This forge has no feedback read (GitLab, for now). */
  | 'unsupported'
  /** The feedback could not fit one message, even cut down. */
  | 'too-large'
  | 'error';

export type PullRequestFeedbackObservationResult =
  | { state: 'observed'; observation: PullRequestFeedbackObservation }
  | {
      state: 'unavailable';
      cause: PullRequestFeedbackUnavailableCause;
      reason: string;
    };

/** Where a pull request's feedback stands, as a person reads it. */
export type PullRequestFeedbackStatus =
  | { state: 'off' }
  | { state: 'watching' }
  | {
      state: 'held';
      reason: /** The agent is working; it gets the message when it finishes. */
        | 'agent-busy'
        /** The agent is waiting on a person. */
        | 'agent-waiting'
        /** The conversation's agent has stopped. */
        | 'agent-stopped'
        /** The person who turned it on may no longer send to this chat. */
        | 'owner-changed'
        /** Failing checks wait for the head's other checks to finish. */
        | 'checks-running';
    }
  | {
      state: 'paused';
      /**
       * `fix-budget` (#5066): a watching Task's pull request used every fix
       * attempt its Project allows.
       */
      reason: 'round-limit' | 'repeated-failure' | 'fix-budget';
      /**
       * round-limit only: `head` after the rounds one head allows, `day`
       * after the messages a pull request allows in 24 hours. Absent on a
       * pause recorded before the distinction.
       */
      cap?: 'head' | 'day';
      headSha: string;
      /** When it paused; absent on a pause recorded before it was kept. */
      at?: string;
    }
  | { state: 'unavailable'; cause: PullRequestFeedbackUnavailableCause }
  | { state: 'closed' };

export interface PullRequestFeedbackCategoryCount {
  category: PullRequestFeedbackCategory;
  count: number;
}

/** One message Station sent, is sending, or is holding. */
export interface PullRequestFeedbackDelivery {
  id: string;
  at: string;
  headSha: string;
  categories: PullRequestFeedbackCategoryCount[];
  state: 'sent' | 'queued' | 'held' | 'refused' | 'superseded';
  /** A fixed explanation for `refused`. */
  reason?: string;
}

/**
 * The conversation that receives a pull request's feedback. Both fields are
 * absent when the reader may not read that conversation: the reader learns
 * only that another chat owns it.
 */
export interface PullRequestFeedbackOwner {
  conversationId?: string;
  title?: string;
}

/**
 * One pull request's feedback as anyone looking at the pull request sees it
 * (`GET /api/pull-request-feedback/by-pull-request`), whichever chat is open.
 * Everything past `owner` is present only when the reader may read the
 * owning chat; to anyone else the owner is `{ readable: false }` and nothing
 * else is said.
 */
export interface PullRequestFeedbackByPullRequest {
  identity: PullRequestLinkIdentity;
  /** null when no chat gets feedback for it (none claimed it, or it is off). */
  owner:
    | null
    | { readable: false }
    | { readable: true; conversationId: string; title: string };
  status?: PullRequestFeedbackStatus;
  settings?: PullRequestFeedbackSettings;
  /**
   * The newest message sent about the head Station last observed. Absent
   * when the newest send was about an earlier push.
   */
  last?: PullRequestFeedbackDelivery;
  /** Failing checks the agent was sent on the head Station last observed. */
  sentChecks?: {
    headSha: string;
    checks: Array<{ name: string; url?: string; at: string }>;
  };
  /** Station's newest head review, while the head review preview is on. */
  headReview?: PullRequestHeadReview;
  /** The observed head has no review yet, and why. */
  headReviewWaiting?: PullRequestHeadReviewWaiting;
}

/** One finding of Station's review of a head, as a person reads it. */
export interface PullRequestHeadReviewFinding {
  file: string;
  line: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  confidence: 'high' | 'medium' | 'low';
  summary: string;
  /** Goes to the agent: critical or high, with high or medium confidence. */
  required: boolean;
  /** A previous head's finding the reviewer found still present. */
  carried?: true;
}

/**
 * Station's newest review of one of the pull request's heads.
 * `unknown`: Station restarted (or the reviewer gave no answer) before it
 * knew how the review ended; it is never run again by itself.
 */
export interface PullRequestHeadReview {
  headSha: string;
  /** It is about the head Station last observed, not an earlier push. */
  current: boolean;
  state:
    | 'reviewing'
    | 'reviewed'
    | 'head-not-local'
    | 'no-reviewer'
    | 'unknown'
    | 'not-verified';
  /** When it started, or settled once it did. */
  at: string;
  /** `delta` reviewed only what changed since the previous reviewed head. */
  mode?: 'initial' | 'delta';
  /** reviewed: required first, at most 100. */
  findings?: PullRequestHeadReviewFinding[];
  required?: number;
  others?: number;
  /** not-verified: why, as the review said it. */
  failureReason?: string;
  /** The message that carried the required findings, when there was one. */
  delivery?: { state: 'sent' | 'queued' | 'held'; at: string };
}

/**
 * The head Station last observed has no review yet, and why:
 * `settling` (it may move again: read once, no turn ended since), the agent
 * `agent-busy`, `agent-waiting` on a person or `agent-stopped`,
 * `feedback-waiting` for the agent, `project-busy` (another pull request of
 * the Project is being reviewed), `daily-limit` (10 reviews in 24 hours),
 * `draft`, `closed`, or `starting` (on Station's next check).
 */
export interface PullRequestHeadReviewWaiting {
  headSha: string;
  reason:
    | 'settling'
    | 'agent-busy'
    | 'agent-waiting'
    | 'agent-stopped'
    | 'feedback-waiting'
    | 'project-busy'
    | 'daily-limit'
    | 'draft'
    | 'closed'
    | 'starting';
}

/** One pull request's feedback, as one conversation's reader sees it. */
export interface PullRequestFeedbackView {
  identity: PullRequestLinkIdentity;
  /** Whether feedback for it goes to the conversation this view is for. */
  ownedHere: boolean;
  /** Who gets it; null when nobody has turned it on. */
  owner: PullRequestFeedbackOwner | null;
  settings: PullRequestFeedbackSettings;
  status: PullRequestFeedbackStatus;
  /** The newest delivery, for the row's one meta line. */
  last?: PullRequestFeedbackDelivery;
  /** Newest first, at most 20. */
  history: PullRequestFeedbackDelivery[];
  /** Station's newest head review, for the owning chat's reader. */
  headReview?: PullRequestHeadReview;
  /** The observed head has no review yet, and why. */
  headReviewWaiting?: PullRequestHeadReviewWaiting;
}

export interface ConversationPullRequestFeedback {
  conversationId: string;
  /** The host's current person/read/continue rule; absent on older hosts. */
  viewerMayChange?: boolean;
  pullRequests: PullRequestFeedbackView[];
}

const CATEGORY_WORDS: Record<
  PullRequestFeedbackCategory,
  [singular: string, plural: string]
> = {
  'failing-checks': ['failing check', 'failing checks'],
  'review-threads': ['review comment', 'review comments'],
  'merge-conflict': ['merge conflict', 'merge conflicts'],
  'review-findings': ['review finding', 'review findings'],
};

/** "2 failing checks and 1 review comment" — the delivery's own words. */
export function describePullRequestFeedbackCategories(
  categories: readonly PullRequestFeedbackCategoryCount[],
): string {
  const parts = categories
    .filter((entry) => entry.count > 0)
    .map((entry) => {
      const [one, many] = CATEGORY_WORDS[entry.category];
      if (entry.category === 'merge-conflict') return 'a merge conflict';
      return `${entry.count} ${entry.count === 1 ? one : many}`;
    });
  if (parts.length === 0) return 'nothing';
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * An open pull request whose head branch has the asked-for name, as a forge
 * lists it. The name alone proves nothing: a fork can push a branch of the
 * same name, so `crossRepository` and `headOwner` say where it lives.
 */
export interface PullRequestByHead {
  /** The pull request's number. */
  ref: string;
  headRefName: string;
  /** The owner of the repository the head branch lives in. */
  headOwner: string;
  /** The head branch lives in another repository (a fork). */
  crossRepository: boolean;
  url: string;
}

export type PullRequestsByHeadResult =
  | { state: 'read'; pullRequests: PullRequestByHead[] }
  | {
      state: 'unavailable';
      cause: PullRequestFeedbackUnavailableCause;
      reason: string;
    };

/**
 * A Project's agent feedback defaults: the switches Station turns on for a
 * pull request one of the Project's Tasks opens from its own branch, when
 * nobody has set that pull request up yet. Never applied to a pull request
 * already set up, and changing them never changes one.
 */
export interface ProjectPullRequestFeedbackDefaults {
  projectSlug: string;
  settings: PullRequestFeedbackSettings;
  /** Whether the reader may change them: this Station's owner, in person. */
  canChange: boolean;
  /**
   * Pull requests these defaults turned feedback on for that still get it.
   * Turning the defaults off leaves them on; each is turned off from its chat.
   */
  stillOn: number;
}
