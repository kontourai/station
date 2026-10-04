/** Provider-neutral pull-request contract. Native ids and URLs stay opaque. */
export type PullRequestCapability =
  | 'list'
  | 'detail'
  | 'open'
  | 'comment'
  | 'approve'
  | 'merge'
  | 'autoMerge';
export type PullRequestMergeMethod = 'merge' | 'squash' | 'rebase';
export type PullRequestMergeMethodsSource = 'provider-default' | 'repository';
export interface PullRequestCapabilities {
  list: boolean;
  detail: boolean;
  open: boolean;
  comment: boolean;
  approve: boolean;
  merge: boolean;
  autoMerge: boolean;
}
export function narrowToOffered(
  offered: PullRequestCapabilities,
  effective: PullRequestCapabilities,
): PullRequestCapabilities {
  return {
    list: offered.list && effective.list,
    detail: offered.detail && effective.detail,
    open: offered.open && effective.open,
    comment: offered.comment && effective.comment,
    approve: offered.approve && effective.approve,
    merge: offered.merge && effective.merge,
    autoMerge: offered.autoMerge && effective.autoMerge,
  };
}
export function narrowMergeMethods(
  offered: PullRequestMergeMethod[],
  effective: PullRequestMergeMethod[],
): PullRequestMergeMethod[] {
  return effective.filter((method) => offered.includes(method));
}
export interface PullRequestRepositoryContext {
  repository: { owner: string; name: string; remote: string };
  workingDirectory: string;
  /**
   * The checkout's branch and the base a new pull request targets. Present
   * only when the checkout is on a branch pushed to its upstream — what
   * opening a pull request from it requires. A read of an existing pull
   * request resolves without them (#2474).
   */
  branch?: string;
  baseRef?: string;
  /** Owner of the current branch's configured push target, when known. */
  pushTargetOwner?: string;
  /**
   * Where a new pull request opens FROM, as the forge names it: the
   * branch the checkout's branch is pushed to (its upstream, which may be
   * named differently from the local branch), and, when that upstream lives
   * in another repository (a fork), that repository's owner and name.
   * Absent: the local branch, on the context's own repository.
   */
  head?: { branch: string; owner?: string; repository?: string };
}
/**
 * Portable exact repository identity for a point detail read. It deliberately
 * carries no checkout path, branch, or base: those are server-private runtime
 * details, not durable/provider identity.
 */
export interface PullRequestRepositoryIdentityContext {
  host: string;
  repository: { owner: string; name: string };
}
export interface PullRequestAvailability {
  available: boolean;
  reason?: string;
  effectiveCapabilities: PullRequestCapabilities;
  effectiveMergeMethods: PullRequestMergeMethod[];
  mergeMethodsSource: PullRequestMergeMethodsSource;
}
/**
 * Machine-readable cause behind an unavailable pull-request context (#1536 G5).
 *
 * `reason` is a sentence for a reader; a surface deciding HOW to present the
 * state cannot classify by prose. `no-remote` is the ordinary local repository
 * — nothing is broken and nothing is missing that the operator asked for — and
 * the panel rendered it as a warning-triangle error card, indistinguishable
 * from a forge that refused. Absent means "no cause was reported", never
 * "some other cause".
 */
export type PullRequestUnavailableCause = 'no-remote';

export type PullRequestClientContext =
  | {
      available: true;
      provider: string;
      host: string;
      repository: { owner: string; name: string };
      /**
       * Branch observed from this request's recorded checkout/session
       * worktree; absent when it is detached or not pushed to its upstream.
       */
      branch?: string;
      /** Owner of the local branch's configured push target, when known. */
      pushTargetOwner?: string;
    }
  | {
      available: false;
      reason: string;
      cause?: PullRequestUnavailableCause;
    };
export interface PullRequest {
  provider: string;
  /**
   * Literal authority token from the repository remote. SSH aliases are
   * distinct host identities; v1 deliberately does not resolve ssh config.
   */
  host: string;
  ref: string;
  url: string;
  repository: { owner: string; name: string };
  title: string;
  body: string | null;
  state: string;
  author: { login: string; url?: string };
  sourceBranch: string;
  targetBranch: string;
  /** Exact provider-observed revisions when the forge reports them. */
  headSha?: string;
  baseSha?: string;
  commits: number;
  reviewStatus: string;
  comments: number;
  nativeId: string;
  mergeability: 'mergeable' | 'conflicting' | 'unknown';
}
/**
 * One open pull request's source branch and whether it merges cleanly: what
 * a conflict indicator needs, and nothing a review needs (#2937). A provider
 * answers it with a narrow forge read, never the full pull-request list.
 */
export interface PullRequestBranchMergeability {
  ref: string;
  sourceBranch: string;
  /** Forge-observed head repository owner; absent when not reported. */
  sourceOwner?: string;
  mergeability: PullRequest['mergeability'];
}
export interface PullRequestListQuery {
  state?: string;
  limit?: number;
}
export interface PullRequestOpenInput {
  title: string;
  body?: string;
  base?: string;
  head?: string;
}
export interface PullRequestCommentInput {
  body: string;
}
export interface PullRequestApproveInput {
  body?: string;
}
export interface PullRequestMergeInput {
  method: PullRequestMergeMethod;
  autoMerge?: boolean;
  expectedHeadSha?: string;
}
export type PullRequestMergeResult =
  | { status: 'merged' }
  | { status: 'queued-auto-merge' }
  | { status: 'indeterminate'; reason: string; observed: unknown }
  | { status: 'refused'; reason: string };
export interface PullRequestResult<T> {
  available: boolean;
  data?: T;
  reason?: string;
  effectiveCapabilities: PullRequestCapabilities;
  effectiveMergeMethods: PullRequestMergeMethod[];
  mergeMethodsSource: PullRequestMergeMethodsSource;
}
/** A bounded provider observation, not a local checkout diff or gate verdict. */
export interface PullRequestReviewSnapshot {
  pullRequest: PullRequest;
  headSha: string;
  baseSha: string;
  observedAt: string;
  diff:
    | { state: 'available'; patch: string; completeness: 'provider-output' }
    | { state: 'unavailable'; reason: string };
  discussion: Array<{
    id: string;
    author: string;
    body: string;
    createdAt: string;
    kind: 'comment' | 'review';
    state?: string;
    headSha?: string;
  }>;
  discussionPartial: boolean;
  /**
   * The provider's CI checks for the observed head. Absent: this server did
   * not observe checks (an older server), which is not "no checks".
   */
  checks?: PullRequestChecksObservation;
  /**
   * Inline review comments anchored to lines of the provider diff. Absent:
   * not observed, which is not "no comments".
   */
  reviewComments?: PullRequestReviewCommentsObservation;
}
export type PullRequestCheckState =
  | 'success'
  | 'failure'
  | 'pending'
  | 'neutral'
  | 'skipped'
  | 'cancelled';
export interface PullRequestCheck {
  name: string;
  state: PullRequestCheckState;
  /** The provider's own label for the run (workflow, pipeline). */
  group?: string;
  url?: string;
}
export type PullRequestChecksObservation =
  | { state: 'available'; checks: PullRequestCheck[]; partial: boolean }
  | { state: 'unavailable'; reason: string };
/** One inline comment; `line` is null when it no longer maps onto the diff. */
export interface PullRequestReviewComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  path: string;
  /** `additions`: a line of the new file; `deletions`: of the old file. */
  side: 'additions' | 'deletions';
  /**
   * `line`: made on a line, `line` null once the forge no longer maps it
   * onto the diff. `file`: made on the file as a whole; `line` is null and
   * that is not "outdated".
   */
  subject: 'line' | 'file';
  line: number | null;
  inReplyTo?: string;
  url?: string;
}
export type PullRequestReviewCommentsObservation =
  | {
      state: 'available';
      comments: PullRequestReviewComment[];
      partial: boolean;
    }
  | { state: 'unavailable'; reason: string };
export interface PullRequestReviewInput {
  action: 'comment' | 'approve';
  expectedHeadSha: string;
  body?: string;
}
export type PullRequestReviewOutcome =
  | { status: 'confirmed'; nativeId: string; actor: string; headSha?: string }
  | { status: 'refused' | 'indeterminate'; reason: string };
/** Server-owned current authority check; never supplied in an HTTP input. */
export interface PullRequestWriteAdmission {
  isCurrent: () => boolean;
}
export interface IPullRequestProvider {
  readonly id: string;
  readonly displayName: string;
  getReviewSnapshot?(
    context: PullRequestRepositoryContext,
    ref: string,
  ): Promise<PullRequestResult<PullRequestReviewSnapshot>>;
  submitReview?(
    context: PullRequestRepositoryContext,
    ref: string,
    input: PullRequestReviewInput,
    admission?: PullRequestWriteAdmission,
  ): Promise<PullRequestResult<PullRequestReviewOutcome>>;
  readonly offeredCapabilities: PullRequestCapabilities;
  readonly offeredMergeMethods: PullRequestMergeMethod[];
  canServeHost(host: string): boolean;
  getHost(context: PullRequestRepositoryContext): string;
  getAvailability(
    context: PullRequestRepositoryContext,
  ): Promise<PullRequestAvailability>;
  listPullRequests(
    context: PullRequestRepositoryContext,
    query: PullRequestListQuery,
  ): Promise<PullRequestResult<PullRequest[]>>;
  getPullRequest(
    context: PullRequestRepositoryContext,
    ref: string,
  ): Promise<PullRequestResult<PullRequest>>;
  /** The repository's open pull requests, narrowed to branch mergeability. */
  listOpenPullRequestMergeability?(
    context: PullRequestRepositoryContext,
  ): Promise<PullRequestResult<PullRequestBranchMergeability[]>>;
  /** Exact owner read for declared outputs; avoids branch/base derivation. */
  getPullRequestByIdentity?(
    context: PullRequestRepositoryIdentityContext,
    ref: string,
  ): Promise<PullRequestResult<PullRequest>>;
  openPullRequest(
    context: PullRequestRepositoryContext,
    input: PullRequestOpenInput,
  ): Promise<PullRequestResult<PullRequest>>;
  createComment(
    context: PullRequestRepositoryContext,
    ref: string,
    input: PullRequestCommentInput,
  ): Promise<PullRequestResult<PullRequest>>;
  approvePullRequest(
    context: PullRequestRepositoryContext,
    ref: string,
    input?: PullRequestApproveInput,
  ): Promise<PullRequestResult<PullRequest>>;
  mergePullRequest(
    context: PullRequestRepositoryContext,
    ref: string,
    input: PullRequestMergeInput,
    admission?: PullRequestWriteAdmission,
  ): Promise<PullRequestResult<PullRequestMergeResult>>;
}
