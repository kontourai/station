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
  mergeability?: 'mergeable' | 'conflicting' | 'unknown';
  mergedAt?: string;
  closedAt?: string;
  updatedAt?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  landing?:
    | { state: 'armed' | 'merged' | 'not-queued' }
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
