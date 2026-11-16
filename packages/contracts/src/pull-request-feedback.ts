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
 * What one delivery is about. `review-findings` is reserved for Station's
 * own independent review of each new head; nothing produces it yet.
 */
export type PullRequestFeedbackCategory =
  | 'failing-checks'
  | 'review-threads'
  | 'merge-conflict'
  | 'review-findings';

/**
 * A person's switches for one pull request. `fixFailingChecks` covers
 * failing checks and merge conflicts; `addressReviewComments` covers
 * unresolved review threads and change requests. `reviewEachHead` is
 * accepted and stored for the later head review; nothing reads it yet.
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
        | 'owner-changed';
    }
  | {
      state: 'paused';
      reason: 'round-limit' | 'repeated-failure';
      headSha: string;
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

/** The conversation that receives a pull request's feedback. */
export interface PullRequestFeedbackOwner {
  conversationId: string;
  /** Absent when the reader may not read that conversation. */
  title?: string;
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
}

export interface ConversationPullRequestFeedback {
  conversationId: string;
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
