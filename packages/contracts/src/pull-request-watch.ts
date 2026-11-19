/**
 * Task-owned pull requests (#5066): a Task that opened a pull request
 * watches it until it lands. Station wakes the Task's agent only when CI
 * fails or a reviewer writes (the pull request agent feedback loop,
 * `pull-request-feedback.ts`), counts the fix attempts it sends, and reports
 * when the pull request is ready for the person. Merging stays with the
 * person.
 *
 * Shapes and pure helpers only. The server decides and enforces
 * (`src-server/services/pull-requests/pull-request-watch*.ts`).
 */
import type { PullRequestLinkIdentity } from './conversation-pull-request-links.js';
import {
  FAILING_CHECK_CONCLUSIONS,
  type PullRequestFeedbackObservation,
} from './pull-request-feedback.js';

/** Fix attempts a watched pull request gets when the Project names none. */
export const DEFAULT_PULL_REQUEST_FIX_ATTEMPTS = 3;
/** The most fix attempts a Project may give one pull request. */
export const MAX_PULL_REQUEST_FIX_ATTEMPTS = 10;

/** A Project's setting: whether its Tasks watch the pull requests they keep. */
export interface ProjectPullRequestWatchSettings {
  enabled: boolean;
  /** Failing-check rounds sent to the agent per pull request, 1–10. */
  maxFixAttempts: number;
}

/**
 * A Task's own choice. `on` and `off` override the Project; absent follows
 * it. "Stop watching" writes `off`.
 */
export type TaskPullRequestWatchMode = 'on' | 'off';

/** What a person sends to change a Task's choice; `project` clears it. */
export type TaskPullRequestWatchModeInput =
  | TaskPullRequestWatchMode
  | 'project';

export const TASK_PULL_REQUEST_WATCH_MODE_INPUTS: readonly TaskPullRequestWatchModeInput[] =
  ['on', 'off', 'project'];

/** A Project settings body as a client sent it, or undefined. */
export function parseProjectPullRequestWatchSettings(
  value: unknown,
): ProjectPullRequestWatchSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => key !== 'enabled' && key !== 'maxFixAttempts',
    )
  )
    return undefined;
  if (typeof record.enabled !== 'boolean') return undefined;
  const attempts =
    record.maxFixAttempts === undefined
      ? DEFAULT_PULL_REQUEST_FIX_ATTEMPTS
      : record.maxFixAttempts;
  if (
    typeof attempts !== 'number' ||
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > MAX_PULL_REQUEST_FIX_ATTEMPTS
  )
    return undefined;
  return { enabled: record.enabled, maxFixAttempts: attempts };
}

export interface ResolvedTaskPullRequestWatch {
  watching: boolean;
  /** Whose choice decided it. */
  source: 'project' | 'task';
  maxFixAttempts: number;
}

/**
 * Whether a Task watches its pull requests: its own choice when it made
 * one, else its Project's. A done or canceled Task watches nothing.
 */
export function resolveTaskPullRequestWatch(
  project: { pullRequestWatch?: ProjectPullRequestWatchSettings } | undefined,
  task: { pullRequestWatch?: TaskPullRequestWatchMode; status: string },
): ResolvedTaskPullRequestWatch {
  const maxFixAttempts =
    project?.pullRequestWatch?.maxFixAttempts ??
    DEFAULT_PULL_REQUEST_FIX_ATTEMPTS;
  const ended = task.status === 'done' || task.status === 'canceled';
  if (task.pullRequestWatch)
    return {
      watching: !ended && task.pullRequestWatch === 'on',
      source: 'task',
      maxFixAttempts,
    };
  return {
    watching: !ended && project?.pullRequestWatch?.enabled === true,
    source: 'project',
    maxFixAttempts,
  };
}

/**
 * Whether one forge read shows a pull request ready for its person: open,
 * not a draft, no conflict with its base, every check finished and none
 * failing (all of them read), no unresolved current review thread, and no
 * standing change request. Unknown mergeability is not a conflict: GitHub
 * computes it lazily.
 */
export function pullRequestReadyForPerson(
  observation: PullRequestFeedbackObservation,
): boolean {
  if (observation.state !== 'OPEN' || observation.draft) return false;
  if (observation.mergeable === 'conflicting') return false;
  if (observation.checksTruncated) return false;
  if (
    observation.checks.some(
      (check) =>
        !check.completed ||
        (check.conclusion !== null &&
          FAILING_CHECK_CONCLUSIONS.has(check.conclusion)),
    )
  )
    return false;
  if (observation.threadsTotal > observation.threads.length) return false;
  if (
    observation.threads.some((thread) => !thread.resolved && !thread.outdated)
  )
    return false;
  return observation.reviewDecision?.toUpperCase() !== 'CHANGES_REQUESTED';
}

/** What a watched Task's agent may not do; Station refuses it. */
export type PullRequestWatchRefusalKind =
  | 'arm-auto-merge'
  | 'merge'
  | 'force-push'
  | 'ci-config';

/** One refused (or, for CI configuration, person-asked) agent action. */
export interface PullRequestWatchRefusal {
  id: string;
  at: string;
  kind: PullRequestWatchRefusalKind;
  /** `refused`: denied outright. `asked`: put to a person to approve. */
  outcome: 'refused' | 'asked';
  /** The engine's tool name, bounded. */
  toolName: string;
  /** What matched (a command or path), bounded to 200 characters. */
  detail: string;
}

/** Where one watched pull request stands. */
export type TaskPullRequestWatchState =
  /** Watching; nothing is owed. */
  | { state: 'watching' }
  /** Feedback went to the agent, which is working on it. */
  | { state: 'fixing' }
  | TaskPullRequestWatchReviewHold
  /** Checks pass and reviews are answered: the person's turn. */
  | { state: 'ready'; headSha: string; at: string }
  /** Every fix attempt was used; the named checks still fail. */
  | { state: 'budget-spent'; failing: string[]; headSha: string }
  /** Feedback for it goes to another chat a person chose. */
  | { state: 'elsewhere' }
  /** The forge could not be read. */
  | { state: 'unavailable' }
  | { state: 'closed' };

/** Why a watched head cannot yet be reported ready. */
export interface TaskPullRequestWatchReviewHold {
  state: 'reviewing' | 'review-needed';
  headSha: string;
  detail: string;
}

export interface TaskPullRequestWatchPullRequest {
  identity: PullRequestLinkIdentity;
  url?: string;
  watch: TaskPullRequestWatchState;
  fixAttempts: number;
  maxFixAttempts: number;
}

/** `GET /api/tasks/:taskId/pull-request-watch`. */
export interface TaskPullRequestWatchView {
  taskId: string;
  watching: boolean;
  source: 'project' | 'task';
  /** The Task's own choice; `project` when it follows its Project. */
  mode: TaskPullRequestWatchModeInput;
  projectEnabled: boolean;
  maxFixAttempts: number;
  /**
   * False while the `pull-request-agent-feedback` Feature Preview is off:
   * the choice is kept, and nothing is watched until it is on.
   */
  available: boolean;
  pullRequests: TaskPullRequestWatchPullRequest[];
  /** Newest first, at most 20. */
  refusals: PullRequestWatchRefusal[];
}

export const PULL_REQUEST_WATCH_REFUSAL_WORDS: Record<
  PullRequestWatchRefusalKind,
  string
> = {
  'arm-auto-merge': 'Arm auto-merge',
  merge: 'Merge',
  'force-push': 'Force-push',
  'ci-config': 'Change CI configuration',
};
