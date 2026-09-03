/**
 * `invoke` is a direct provider invocation, not an orchestration session.
 * It is additive so older clients can keep treating unknown sources as a
 * generic run while newer clients can link the raw invoke response to `/runs`.
 */
export type RunSource =
  | 'orchestration'
  | 'schedule'
  | 'invoke'
  | 'voice'
  | 'plugin';

export type RunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting_for_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type RunFailureKind =
  | 'runtime_offline'
  | 'runtime_recovery'
  | 'timeout'
  | 'cancelled'
  | 'agent_error'
  | 'tool_error'
  | 'unknown';

export interface RunOutputRef {
  source: RunSource;
  providerId: string;
  runId: string;
  artifactId: string;
  kind: 'log' | 'artifact' | 'output';
}

export interface RunSummary {
  runId: string;
  providerId: string;
  source: RunSource;
  sourceId?: string;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  failureKind?: RunFailureKind;
  failureMessage?: string;
  retryEligible: boolean;
  attempt: number;
  maxAttempts?: number;
  outputRef?: RunOutputRef;
  metadata?: Record<string, unknown>;
}
