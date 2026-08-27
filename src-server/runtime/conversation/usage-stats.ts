import type { AppConfig } from '@kontourai/station-contracts/config';
import type { BedrockModelCatalog } from '../../providers/llm/bedrock-models.js';
import { resolveBedrockRegion } from '../../providers/llm/bedrock-region.js';
import { estimateCost } from '../../utils/pricing.js';

export interface UsageLike {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ConversationTokenBreakdown {
  systemPromptTokens?: number;
  mcpServerTokens?: number;
  userMessageTokens?: number;
  assistantMessageTokens?: number;
}

export interface ConversationStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextTokens: number;
  turns: number;
  toolCalls: number;
  estimatedCost: number | null;
  tokenBreakdown?: ConversationTokenBreakdown;
}

export interface StatsUpdateParams {
  existingStats?: ConversationStats | null;
  existingModelStats?: Record<string, ConversationStats | undefined>;
  usage: UsageLike;
  toolCallCount: number;
  modelId: string;
  latestUserMessageText?: string;
  fixedTokens?: {
    systemPromptTokens: number;
    mcpServerTokens: number;
  };
  cost: number | null;
}

export function createEmptyConversationStats(): ConversationStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    contextTokens: 0,
    turns: 0,
    toolCalls: 0,
    estimatedCost: null,
  };
}

export function getUsageInputTokens(usage: UsageLike): number {
  return usage.promptTokens ?? usage.inputTokens ?? 0;
}

export function getUsageOutputTokens(usage: UsageLike): number {
  return usage.completionTokens ?? usage.outputTokens ?? 0;
}

export function getUsageTotalTokens(usage: UsageLike): number {
  return (
    usage.totalTokens ??
    getUsageInputTokens(usage) + getUsageOutputTokens(usage)
  );
}

export function estimateMessageTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function getMessageTextContent(message: unknown): string {
  if (!message || typeof message !== 'object') {
    return '';
  }

  const candidate = message as {
    parts?: Array<{ type?: string; text?: string }>;
    content?: string | Array<{ text?: string }>;
  };

  if (Array.isArray(candidate.parts)) {
    return candidate.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text || '')
      .join('');
  }

  if (typeof candidate.content === 'string') {
    return candidate.content;
  }

  if (Array.isArray(candidate.content)) {
    return candidate.content.map((part) => part.text || '').join('');
  }

  return '';
}

/**
 * station#1299 (item 3): callers resolve the model's actual context-window
 * size from the launchable-model inventory before reaching this calculation.
 * A missing or invalid value is explicitly unknown, never a guessed 200k
 * window: a percentage participates in a user-facing capacity decision, so a
 * default would be false telemetry rather than a harmless display fallback.
 */
export function calculateContextWindowPercentage(
  /**
   * `undefined` when nothing measured context occupancy for this session
   * (station#3201) — there is then no percentage to report, exactly as
   * there is none when the window size is unresolved.
   */
  totalTokens: number | undefined,
  contextWindowTokens?: number,
): number | undefined {
  if (
    typeof totalTokens !== 'number' ||
    !Number.isFinite(totalTokens) ||
    totalTokens < 0 ||
    typeof contextWindowTokens !== 'number' ||
    !Number.isFinite(contextWindowTokens) ||
    contextWindowTokens <= 0
  ) {
    return undefined;
  }
  return Math.round((totalTokens / contextWindowTokens) * 100 * 100) / 100;
}

export async function calculateUsageCost(
  modelId: string,
  usage: UsageLike,
  modelCatalog: BedrockModelCatalog | undefined,
  appConfig: AppConfig,
  logger: { warn: (message: string, meta?: unknown) => void },
  // station#1557 review round 2 (M6). This defaulted to `appConfig.region`
  // while its callers' own enrichment lookups had been routed through the
  // resolver, so with `AWS_REGION=eu-west-1` and nothing stored, one lookup
  // priced a turn from eu-west-1 and the conversation cost stat for the SAME
  // turn priced it from us-east-1. One resolution, or the split comes back.
  region = resolveBedrockRegion({
    configRegion: appConfig.region,
    env: process.env,
  }).region,
): Promise<number | null> {
  if (!modelCatalog) {
    logger.warn('No model catalog available, cost unavailable', { modelId });
    return null;
  }

  try {
    const pricing = await modelCatalog.getModelPricing(region);
    const match = pricing.find(
      (entry) =>
        entry.modelId === modelId ||
        modelId.includes(entry.modelId.toLowerCase().replace(/\s+/g, '-')),
    );

    if (match) {
      return estimateCost(
        match,
        getUsageInputTokens(usage),
        getUsageOutputTokens(usage),
      );
    }

    logger.warn('No pricing found for model, cost unavailable', { modelId });
    return null;
  } catch (error) {
    logger.warn('Failed to fetch pricing, cost unavailable', {
      modelId,
      error,
    });
    return null;
  }
}

export function buildConversationStatsUpdate({
  existingStats,
  existingModelStats = {},
  usage,
  toolCallCount,
  modelId,
  latestUserMessageText = '',
  fixedTokens,
  cost,
}: StatsUpdateParams): {
  updatedStats: ConversationStats;
  modelStats: Record<string, ConversationStats | undefined>;
} {
  const usageValues = [
    usage.promptTokens,
    usage.completionTokens,
    usage.inputTokens,
    usage.outputTokens,
    usage.totalTokens,
  ].filter((value): value is number => value !== undefined);
  if (
    usageValues.some((value) => !Number.isFinite(value) || value < 0) ||
    !Number.isFinite(toolCallCount) ||
    toolCallCount < 0 ||
    (cost !== null && (!Number.isFinite(cost) || cost < 0))
  ) {
    throw new Error('Conversation usage update was invalid');
  }
  const stats = existingStats ?? createEmptyConversationStats();
  const currentModelStats =
    existingModelStats[modelId] ?? createEmptyConversationStats();
  const inputTokens = getUsageInputTokens(usage);
  const outputTokens = getUsageOutputTokens(usage);
  const systemPromptTokens = fixedTokens?.systemPromptTokens ?? 0;
  const mcpServerTokens = fixedTokens?.mcpServerTokens ?? 0;
  const existingUserMessageTokens =
    stats.tokenBreakdown?.userMessageTokens ?? 0;
  const userMessageTokens =
    existingUserMessageTokens +
    estimateMessageTextTokens(latestUserMessageText);
  const newInputTokens = stats.inputTokens + inputTokens;
  const newOutputTokens = stats.outputTokens + outputTokens;
  const contextTokens =
    systemPromptTokens + mcpServerTokens + userMessageTokens + newOutputTokens;

  const updatedStats: ConversationStats = {
    inputTokens: newInputTokens,
    outputTokens: newOutputTokens,
    totalTokens: newInputTokens + newOutputTokens,
    contextTokens,
    turns: stats.turns + 1,
    toolCalls: stats.toolCalls + toolCallCount,
    estimatedCost:
      cost !== null && stats.estimatedCost !== null
        ? stats.estimatedCost + cost
        : null,
    tokenBreakdown: {
      systemPromptTokens,
      mcpServerTokens,
      userMessageTokens,
      assistantMessageTokens: newOutputTokens,
    },
  };

  const updatedModelStats: ConversationStats = {
    inputTokens: currentModelStats.inputTokens + inputTokens,
    outputTokens: currentModelStats.outputTokens + outputTokens,
    totalTokens:
      currentModelStats.inputTokens +
      inputTokens +
      currentModelStats.outputTokens +
      outputTokens,
    contextTokens:
      systemPromptTokens +
      mcpServerTokens +
      userMessageTokens +
      currentModelStats.outputTokens +
      outputTokens,
    turns: currentModelStats.turns + 1,
    toolCalls: currentModelStats.toolCalls + toolCallCount,
    estimatedCost:
      cost !== null && currentModelStats.estimatedCost !== null
        ? currentModelStats.estimatedCost + cost
        : null,
    tokenBreakdown: updatedStats.tokenBreakdown,
  };

  return {
    updatedStats,
    modelStats: {
      ...existingModelStats,
      [modelId]: updatedModelStats,
    },
  };
}
