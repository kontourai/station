export type ConversationPullRequestLinkSource =
  | 'explicit'
  | 'branch-derived'
  | 'task-declared';

export interface PullRequestLinkIdentity {
  provider: string;
  host: string;
  repository: { owner: string; name: string };
  ref: string;
}

export interface ConversationPullRequestLink extends PullRequestLinkIdentity {
  source: ConversationPullRequestLinkSource;
  linkedAt?: string;
  linkedBy?: string;
}

export interface LinkedPullRequestSnapshot {
  title: string;
  pullRequestState: string;
  head?: string;
  url?: string;
  observedAt?: string;
  isDraft?: boolean;
  checks?: 'passing' | 'failing' | 'pending' | 'awaiting-approval';
  reviewDecision?: 'approved' | 'changes_requested' | 'review_required';
  /** The forge explicitly reports that its merge requirements are satisfied. */
  reviewGateSatisfied?: true;
  mergeability?: 'mergeable' | 'conflicting' | 'unknown';
  mergedAt?: string;
  closedAt?: string;
  updatedAt?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  landing?:
    | { state: 'armed' | 'merged' | 'not-queued' | 'not-applicable' }
    | { state: 'queued'; position?: number }
    | { state: 'removed'; id: string; at: string; reason?: string };
}

export interface ConversationPullRequestLinkObservation
  extends ConversationPullRequestLink {
  observedAt: string;
  status:
    | ({ state: 'current' } & LinkedPullRequestSnapshot)
    | { state: 'unavailable' | 'unsupported'; reason: string };
}

export interface ConversationPullRequestLinksProjection {
  conversationId: string;
  observedAt: string;
  links: ConversationPullRequestLinkObservation[];
}

export type LinkedPullRequestFilter =
  | 'failing'
  | 'awaiting-review'
  | 'ready'
  | 'merged';

export function linkedPullRequestMatches(
  snapshot: LinkedPullRequestSnapshot,
  filter: LinkedPullRequestFilter,
  now = Date.now(),
): boolean {
  if (filter === 'merged') return snapshot.pullRequestState === 'MERGED';
  if (snapshot.pullRequestState !== 'OPEN') return false;
  if (filter === 'failing') {
    const removalAge =
      snapshot.landing?.state === 'removed'
        ? now - Date.parse(snapshot.landing.at)
        : Number.NaN;
    return (
      snapshot.checks === 'failing' ||
      snapshot.mergeability === 'conflicting' ||
      (snapshot.checks !== 'passing' &&
        removalAge >= 0 &&
        removalAge < 15 * 60_000)
    );
  }
  if (filter === 'awaiting-review')
    return snapshot.reviewDecision === 'review_required';
  return (
    snapshot.isDraft === false &&
    snapshot.checks === 'passing' &&
    (snapshot.reviewDecision === 'approved' ||
      (snapshot.reviewDecision === undefined &&
        snapshot.reviewGateSatisfied === true)) &&
    snapshot.mergeability === 'mergeable' &&
    (snapshot.landing?.state === 'not-queued' ||
      snapshot.landing?.state === 'not-applicable')
  );
}
