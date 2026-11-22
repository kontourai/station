import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import type { EffectiveModelSource } from '../../utils/execution';

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

/** The source turn's execution a fork may inherit. */
export interface ForkSourceExecution {
  agentSlug: string;
  model?: string;
  modelSource?: EffectiveModelSource;
  defaultModel?: string;
  defaultModelSource?: EffectiveModelSource;
  providerOptions?: Record<string, unknown>;
  providerId?: string;
  providerType?: string;
}

/** What the fork dialog chose; an absent field keeps what is inherited. */
export interface ForkExecutionChoice {
  modelOverride?: string;
  modelSource?: EffectiveModelSource;
  defaultModel?: string;
  defaultModelSource?: EffectiveModelSource;
  providerOptions?: Record<string, unknown>;
  providerId?: string;
  providerType?: string;
}

/**
 * The execution a fork opens with. The same Agent inherits the source turn's
 * model; another Agent starts from its own defaults. The source's provider
 * and runtime options belong to its model, so they carry only while the fork
 * keeps that model.
 */
export function forkOpenExecution(
  source: ForkSourceExecution,
  targetAgentSlug: string,
  choice: ForkExecutionChoice = {},
) {
  const sameAgent = targetAgentSlug === source.agentSlug;
  const keepsSourceModel =
    !choice.modelOverride || choice.modelOverride === source.model;
  const inherited = <T>(chosen: T | undefined, recorded: T | undefined) =>
    chosen ?? (sameAgent ? recorded : undefined);
  const inheritedForModel = <T>(
    chosen: T | undefined,
    recorded: T | undefined,
  ) => chosen ?? (sameAgent && keepsSourceModel ? recorded : undefined);
  const providerOptions = inheritedForModel(
    choice.providerOptions,
    source.providerOptions,
  );
  return {
    model: inherited(choice.modelOverride, source.model),
    requestedModel: inherited(choice.modelOverride, source.model),
    modelSource: inherited(choice.modelSource, source.modelSource),
    defaultModel: inherited(choice.defaultModel, source.defaultModel),
    defaultModelSource: inherited(
      choice.defaultModelSource,
      source.defaultModelSource,
    ),
    providerOptions,
    requestedProviderOptions: providerOptions,
    providerId: inheritedForModel(choice.providerId, source.providerId),
    providerType: inheritedForModel(choice.providerType, source.providerType),
  };
}
