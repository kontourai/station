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
  branch: string;
  baseRef: string;
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
      /** Branch observed from this request's recorded checkout/session worktree. */
      branch: string;
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
  commits: number;
  reviewStatus: string;
  comments: number;
  nativeId: string;
  mergeability: 'mergeable' | 'conflicting' | 'unknown';
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
export interface IPullRequestProvider {
  readonly id: string;
  readonly displayName: string;
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
  ): Promise<PullRequestResult<PullRequestMergeResult>>;
}
