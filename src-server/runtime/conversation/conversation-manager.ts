/**
 * Conversation management functions
 * Handles conversation CRUD, stats, and message history
 */

import type { AppConfig } from '@kontourai/station-contracts/config';
import {
  isValidContextObservation,
  type SessionUsageAggregate,
} from '@kontourai/station-shared/usage-fold';
import type { FileMemoryAdapter } from '../../adapters/file/memory-adapter.js';
import type { ConfigLoader } from '../../domain/config-loader.js';
import type { BedrockModelCatalog } from '../../providers/llm/bedrock-models.js';
import {
  buildConversationStatsView,
  buildEmptyConversationStatsView,
  type ConversationStats,
  resolveConversationUserMessageTokens,
} from './conversation-stats-view.js';

// Type extensions for conversation manager
interface ConversationMetadata {
  stats?: ConversationStats;
  modelStats?: Record<string, any>;
}

interface ConversationWithMetadata {
  metadata?: ConversationMetadata;
  userId: string;
}

interface UserMessage {
  id: string;
  role: 'user';
  parts: Array<{ type: 'text'; text: string }>;
}

/**
 * Fold an orchestration `SessionUsageAggregate` (archive#1299) into the
 * shape `buildConversationStatsView` expects.
 *
 * Field-for-field pass-through, deliberately: whatever the engine did not
 * report arrives here as `undefined` and leaves as `undefined`
 * (archive#3201). Two figures this function used to invent are gone —
 * `estimatedCost: 0`, which rendered as `$0.0000` for engines that report
 * no cost at all, and `contextTokens: … ?? totalTokens`, which presented a
 * cumulative across-turns token sum as context occupancy. Cost now carries
 * the provider's own `reportedCostUsd` verbatim when there is one.
 */
function usageAggregateToConversationStats(
  aggregate: SessionUsageAggregate,
): ConversationStats {
  return {
    inputTokens: aggregate.inputTokens,
    outputTokens: aggregate.outputTokens,
    totalTokens: aggregate.totalTokens,
    // archive#4196: the fold has carried these since the birth-site fix;
    // dropping them here is exactly what made every stats surface
    // cache-blind while the context bar beside it was cache-inclusive.
    cacheReadTokens: aggregate.cacheReadTokens,
    cacheWriteTokens: aggregate.cacheWriteTokens,
    contextTokens: aggregate.contextTokens,
    turns: aggregate.turns,
    toolCalls: aggregate.toolCalls,
    estimatedCost: aggregate.reportedCostUsd,
  };
}

/** True when a folded aggregate carries any real signal worth surfacing. */
function hasUsageSignal(aggregate: SessionUsageAggregate): boolean {
  return (
    aggregate.turns > 0 ||
    aggregate.toolCalls > 0 ||
    (aggregate.totalTokens ?? 0) > 0 ||
    // A context observation counts whether or not the engine also reported
    // the window size — the window can be resolved from the model
    // inventory, so occupancy alone is still a real measurement.
    aggregate.contextTokens !== undefined
  );
}

/**
 * Get conversation statistics for an agent and conversation
 */
export async function getConversationStats(
  slug: string,
  conversationId: string | undefined,
  memoryAdapters: Map<string, FileMemoryAdapter>,
  _agentFixedTokens: Map<
    string,
    { systemPromptTokens: number; mcpServerTokens: number }
  >,
  agentTools: Map<string, any[]>,
  configLoader: ConfigLoader,
  appConfig: AppConfig,
  _modelCatalog: BedrockModelCatalog | undefined,
  _logger: any,
  /**
   * archive#1299: reads a native-SDK (Claude/Codex) session's
   * persisted runtime events (threadId === conversationId) and folds them
   * into usage totals — the stats-route counterpart to how the messages
   * route already falls back to `sessionMessageReader.readSessionMessages`
   * on a memory-store miss. Returns `undefined` when there is nothing to
   * fold (no reader wired, or the session has no events at all).
   */
  readSessionUsage?: (threadId: string) => SessionUsageAggregate | undefined,
  /**
   * archive#1299 item 3a: resolves a model's real context-window size (e.g.
   * from the launchable-model-inventory's cached `effectiveContextTokens`)
   * so `calculateContextWindowPercentage` can report a real percentage.
   * Optional — absence, or an unresolved model, leaves the percentage
   * unresolved.
   */
  resolveContextWindowTokens?: (
    modelId: string,
  ) => number | undefined | Promise<number | undefined>,
) {
  if (!slug || slug === 'undefined') {
    throw new Error('Invalid agent slug');
  }

  let spec: any;
  try {
    spec = await configLoader.loadAgent(slug);
  } catch (e) {
    console.debug('Failed to load agent spec, using defaults:', e);
    // Default/temp agents don't have agent.json on disk — use minimal defaults
    spec = { prompt: '', model: appConfig.defaultModel };
  }
  const modelId = spec.model || appConfig.defaultModel;

  // Calculate base stats from system prompt and tools
  const systemPromptTokens = Math.ceil((spec.prompt?.length || 0) / 4);
  const agentToolsList = agentTools.get(slug) || [];
  const toolsJson = JSON.stringify(
    agentToolsList.map((t: any) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  );
  const mcpServerTokens = Math.ceil(toolsJson.length / 4);

  // If no conversationId or conversation doesn't exist, return agent-level stats
  if (!conversationId) {
    return buildEmptyConversationStatsView({
      modelId,
      systemPromptTokens,
      mcpServerTokens,
      contextWindowTokens: await resolveContextWindowTokens?.(modelId),
    });
  }

  /**
   * Native-SDK (Claude/Codex) turns persist as runtime events, not in the
   * memory store, so a conversationId that the memory store has never heard
   * of (or has heard of but never recorded stats for) may still be a real,
   * usage-bearing orchestration session under the same id (threadId ===
   * conversationId). Additive: only returns a view when the fold actually
   * finds turn/tool/token signal, so a conversation that is genuinely empty
   * (or genuinely unknown to both stores) keeps the existing empty/notFound
   * response.
   */
  const tryOrchestrationFallback = async () => {
    const aggregate = readSessionUsage?.(conversationId);
    if (!aggregate) return undefined;
    const reportedTokenFigureIsBroken = (value: number | undefined) =>
      value !== undefined && (!Number.isFinite(value) || value < 0);
    if (
      reportedTokenFigureIsBroken(aggregate.totalTokens) ||
      reportedTokenFigureIsBroken(aggregate.inputTokens) ||
      reportedTokenFigureIsBroken(aggregate.outputTokens) ||
      reportedTokenFigureIsBroken(aggregate.cacheReadTokens) ||
      reportedTokenFigureIsBroken(aggregate.cacheWriteTokens)
    ) {
      throw new Error('Conversation usage aggregate was invalid');
    }
    if (!hasUsageSignal(aggregate)) return undefined;
    const effectiveModelId = aggregate.lastModelId || modelId;
    const reportedContextWindowTokens = isValidContextObservation(
      aggregate.contextTokens,
      aggregate.contextWindowTokens,
    )
      ? aggregate.contextWindowTokens
      : undefined;
    return buildConversationStatsView({
      stats: usageAggregateToConversationStats(aggregate),
      conversationId,
      modelId: effectiveModelId,
      // `systemPromptTokens`/`mcpServerTokens`/`userMessageTokens` are
      // Station's estimates of ITS OWN prompt and tool schema for this
      // agent. An external engine composed its own context, so passing
      // them here would describe a prompt the engine never sent — that is
      // where archive#3201's `MCP Tools: 1` (`Math.ceil(len('[]') / 4)`)
      // came from. The context breakdown is a Station-engine measurement;
      // for an engine-events view it is honestly absent.
      contextWindowTokens:
        reportedContextWindowTokens ??
        (await resolveContextWindowTokens?.(effectiveModelId)),
      measurement: {
        source: 'engine-events',
        ...(aggregate.provider ? { provider: aggregate.provider } : {}),
      },
    });
  };

  const adapter = memoryAdapters.get(slug);

  if (!adapter) {
    const orchestrationFallback = await tryOrchestrationFallback();
    return (
      orchestrationFallback ??
      buildEmptyConversationStatsView({
        modelId,
        systemPromptTokens,
        mcpServerTokens,
        contextWindowTokens: await resolveContextWindowTokens?.(modelId),
      })
    );
  }

  const conversation = await adapter.getConversation(conversationId);

  if (!conversation) {
    const orchestrationFallback = await tryOrchestrationFallback();
    return (
      orchestrationFallback ??
      buildEmptyConversationStatsView({
        modelId,
        systemPromptTokens,
        mcpServerTokens,
        notFound: true,
        contextWindowTokens: await resolveContextWindowTokens?.(modelId),
      })
    );
  }

  const stats: ConversationStats = (conversation as ConversationWithMetadata)
    .metadata?.stats || {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    turns: 0,
    toolCalls: 0,
    estimatedCost: 0,
  };

  const modelStats =
    (conversation as ConversationWithMetadata).metadata?.modelStats || {};

  // Get token breakdown from stats or calculate on-the-fly
  const breakdown = stats.tokenBreakdown || {};
  let userMessageTokens = breakdown.userMessageTokens;
  const assistantMessageTokens = breakdown.assistantMessageTokens;

  // If breakdown doesn't exist, calculate user message tokens from conversation
  // Note: messages are stored separately, not on conversation object
  if (userMessageTokens === undefined) {
    const messages = await adapter.getMessages(
      conversation.userId,
      conversationId,
    );
    userMessageTokens = resolveConversationUserMessageTokens(messages);
  }

  return buildConversationStatsView({
    stats,
    conversationId,
    modelId,
    modelStats,
    systemPromptTokens,
    mcpServerTokens,
    userMessageTokens,
    assistantMessageTokens,
    contextWindowTokens: await resolveContextWindowTokens?.(modelId),
  });
}

/**
 * Manage conversation context (add system messages, clear history)
 */
export async function manageConversationContext(
  slug: string,
  conversationId: string,
  action: string,
  content: string | undefined,
  memoryAdapters: Map<string, FileMemoryAdapter>,
) {
  const adapter = memoryAdapters.get(slug);

  if (!adapter) {
    throw new Error('Agent not found');
  }

  switch (action) {
    case 'add-system-message':
      if (!content) {
        throw new Error('content is required for add-system-message');
      }

      // Inject as user message with special prefix for UI treatment
      await adapter.addMessage(
        {
          id: crypto.randomUUID(),
          role: 'user',
          parts: [{ type: 'text', text: `[SYSTEM_EVENT] ${content}` }],
        } as UserMessage,
        `agent:${slug}`,
        conversationId,
      );

      return { success: true, message: 'System event added' };

    case 'clear-history':
      await adapter.clearMessages(`agent:${slug}`, conversationId);
      return { success: true, message: 'Conversation history cleared' };

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
