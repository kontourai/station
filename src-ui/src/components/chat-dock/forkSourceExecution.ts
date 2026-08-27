import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';

export interface HistoricalForkExecution {
  providerType?: string;
  providerId?: string;
  providerOptions?: Record<string, string | number | boolean>;
}

/** Exact persisted Session execution; never consults the Agent's live binding. */
export function resolveHistoricalForkExecution(
  sourceSessionId: string | undefined,
  sessions: readonly OrchestrationSessionSummary[],
): HistoricalForkExecution {
  if (!sourceSessionId) return {};
  const session = sessions.find(
    (candidate) => candidate.threadId === sourceSessionId,
  );
  if (!session) return {};
  return {
    providerType: session.provider,
    providerId:
      session.modelLaunchPlan?.kind === 'station-resolved'
        ? session.modelLaunchPlan.modelConnectionId
        : undefined,
    providerOptions: session.effectiveModelOptions,
  };
}
