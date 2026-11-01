/** Isolated repairs are separate durable executions attached to a canonical Task. */
export interface IsolatedRepairBudget {
  maxProviderRequests: number;
  maxWallRuntimeMs: number;
}
export type IsolatedRepairPhase =
  | 'planned'
  | 'executing'
  | 'proposed'
  | 'rejected'
  | 'reviewed'
  | 'granted'
  | 'publishing'
  | 'published'
  | 'indeterminate'
  | 'canceled';
export interface IsolatedRepairProjection {
  runId: string;
  taskId: string;
  taskIncarnation: string;
  intentId: string;
  repository: string;
  failedSha: string;
  workflowRun: string;
  workflowAttempt: string;
  phase: IsolatedRepairPhase;
  bindingDigest?: string;
  resultDigest?: string;
  reasonCode?: string;
  /** A published draft is not merge or deployment evidence. */
  pullRequestUrl?: string;
}
