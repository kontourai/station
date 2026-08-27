/**
 * External monitors are deterministic, bounded observations which may decide
 * to request a normal Station task. They are deliberately not a second
 * workflow engine: the resulting task/turn remains owned by orchestration.
 */
export const EXTERNAL_MONITOR_KIND = 'github-pull-request' as const;
export const EXTERNAL_MONITOR_OBJECTIVE = 'review-ready' as const;

export type GitHubPullRequestMonitor = Readonly<{
  kind: typeof EXTERNAL_MONITOR_KIND;
  objective: typeof EXTERNAL_MONITOR_OBJECTIVE;
  /** Canonical browser target: https://github.com/<owner>/<repo>/pull/<n>. */
  target: string;
  /** Project that owns the deterministic Task created for an actionable revision. */
  projectId: string;
  /** Agent that owns the deterministic monitor Task; never inferred from a job name. */
  agentId: string;
  /** Exact existing secret-binding id; the value is never persisted here. */
  credentialSecretBinding?: string;
  budget?: Readonly<{
    maxTurns?: number;
    maxTokens?: number;
    maxRuntimeMs?: number;
    /** Hard reservation lifetime; expiry becomes unknown usage, never a retry. */
    maxWallRuntimeMs?: number;
    maxActive?: number;
    maxConcurrency?: number;
  }>;
}>;

export type ExternalMonitorConfig = GitHubPullRequestMonitor;

export type ExternalMonitorOutcome =
  | 'baseline'
  | 'unchanged'
  | 'actionable'
  | 'pending'
  | 'terminal'
  | 'unauthorized'
  | 'unavailable'
  | 'budget-exhausted';

/** Bounded public projection. Source bodies and secret values never appear. */
export type ExternalMonitorObservation = Readonly<{
  outcome: Exclude<
    ExternalMonitorOutcome,
    'baseline' | 'unchanged' | 'actionable' | 'budget-exhausted'
  >;
  observedAt: string;
  sourceTime?: string;
  fingerprint?: string;
  detail?: string;
}>;

export type ExternalMonitorState = Readonly<{
  lastSuccessfulFingerprint?: string;
  /** Fingerprint whose deterministic task has been durably adopted. */
  lastTriggeredFingerprint?: string;
  lastObservedAt?: string;
  lastOutcome?: ExternalMonitorOutcome;
  nextAction?: string;
  triggeredTaskId?: string;
  /** Bounded exact receipt identity for an explicit monitor resolution. */
  triggerId?: string;
  completedTurns?: number;
  consumedTokens?: number;
  consumedRuntimeMs?: number;
  /** Unknown accounting is a fence, never silently treated as zero. */
  usageKnown?: boolean;
}>;

export type ExternalMonitorDecision = Readonly<{
  outcome: ExternalMonitorOutcome;
  fingerprint?: string;
  shouldDispatch: boolean;
  nextAction: string;
}>;
