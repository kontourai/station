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

export interface ConversationPullRequestLinkObservation
  extends ConversationPullRequestLink {
  observedAt: string;
  status:
    | {
        state: 'current';
        title: string;
        pullRequestState: string;
        head?: string;
      }
    | { state: 'unavailable' | 'unsupported'; reason: string };
}

export interface ConversationPullRequestLinksProjection {
  conversationId: string;
  observedAt: string;
  links: ConversationPullRequestLinkObservation[];
}
