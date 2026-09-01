import type { AppConfig } from '@kontourai/station-contracts/config';
import type { ProviderConnectionConfig } from '@kontourai/station-contracts/tool';
import type { FileMemoryAdapter } from '../../adapters/file/memory-adapter.js';
import type { ConfigLoader } from '../../domain/config-loader.js';
import type { BedrockModelCatalog } from '../../providers/llm/bedrock-models.js';
import { resolveBedrockRegion } from '../../providers/llm/bedrock-region.js';
import {
  contextTokens as otelContextTokens,
  costEstimated as otelCost,
} from '../../telemetry/metrics.js';
import { findModelPricing } from '../../utils/pricing.js';
import {
  buildConversationStatsUpdate,
  type ConversationStats,
  calculateUsageCost,
  estimateMessageTextTokens,
  getMessageTextContent,
  getUsageInputTokens,
  getUsageOutputTokens,
  getUsageTotalTokens,
} from '../conversation/usage-stats.js';
import { resolveManagedModelIdentity } from '../plugins/runtime-provider-resolution.js';

interface UIMessagePart {
  type: string;
  text?: string;
}

interface UIMessage {
  role: string;
  parts?: UIMessagePart[];
}

export async function recordToolExecutionUsage(input: {
  context: {
    conversationId?: string;
    userId?: string;
    context: Map<string | symbol, unknown>;
  };
  output: unknown;
  agent: { getMemory(): any };
  appConfig: AppConfig;
  configLoader: ConfigLoader;
  modelCatalog: BedrockModelCatalog | undefined;
  listProviderConnections?: () => ProviderConnectionConfig[];
  agentFixedTokens: Map<
    string,
    { systemPromptTokens: number; mcpServerTokens: number }
  >;
  memoryAdapters: Map<string, FileMemoryAdapter>;
  logger: any;
}): Promise<void> {
  const {
    context,
    output,
    agent,
    appConfig,
    configLoader,
    modelCatalog,
    listProviderConnections,
    agentFixedTokens,
    memoryAdapters,
    logger,
  } = input;

  if (!context.conversationId || !output) {
    return;
  }

  try {
    const memory = agent.getMemory();
    if (!memory) return;

    const conversation = await memory.getConversation(context.conversationId);
    if (!conversation) return;

    const usage =
      'usage' in (output as Record<string, unknown>)
        ? (output as { usage?: any }).usage
        : undefined;
    const toolCallCount = (context.context.get('toolCallCount') as number) || 0;
    const messages = await memory.getMessages(
      context.userId || '',
      context.conversationId,
    );

    logger.info('[Usage Stats]', {
      conversationId: context.conversationId,
      ...(usage?.promptTokens !== undefined
        ? { promptTokens: usage.promptTokens }
        : {}),
      ...(usage?.completionTokens !== undefined
        ? { completionTokens: usage.completionTokens }
        : {}),
      ...(usage?.totalTokens !== undefined
        ? { totalTokens: usage.totalTokens }
        : {}),
      messageCount: messages.length,
      toolCallCount,
      aborted: !usage,
    });

    if (!usage) return;

    const existingStats = conversation.metadata?.stats as
      | ConversationStats
      | undefined;
    const agentSlug = conversation.resourceId;
    const agentSpec = await configLoader.loadAgent(agentSlug);
    let modelId =
      agentSpec.execution?.modelId || agentSpec.model || appConfig.defaultModel;
    let region = appConfig.region;
    let providerType: string | undefined;
    if (listProviderConnections) {
      try {
        const identity = resolveManagedModelIdentity(agentSpec, {
          appConfig,
          listProviderConnections,
        });
        modelId = identity.modelId;
        region = identity.region ?? region;
        providerType = identity.providerType;
      } catch {
        // Usage persistence remains available for legacy provider state.
      }
    }
    const cost = await calculateUsageCost(
      modelId,
      usage,
      modelCatalog,
      providerType,
      appConfig,
      logger,
      region,
    );

    const fixedTokens = agentFixedTokens.get(agentSlug);
    const userMessages = messages.filter(
      (message: any) => message.role === 'user',
    );

    logger.info('[Token Calculation Debug]', {
      conversationId: context.conversationId,
      totalMessages: messages.length,
      userMessageCount: userMessages.length,
      existingUserMessageTokens:
        existingStats?.tokenBreakdown?.userMessageTokens || 0,
      turn: (existingStats?.turns || 0) + 1,
    });

    const latestUserMessage = userMessages[userMessages.length - 1];
    const latestUserMessageText = latestUserMessage
      ? getMessageTextContent(latestUserMessage as UIMessage)
      : '';

    if (!latestUserMessage) {
      logger.warn('[No User Message Found]', {
        conversationId: context.conversationId,
        userMessageCount: userMessages.length,
      });
    } else {
      logger.info('[New User Message]', {
        conversationId: context.conversationId,
        contentLength: latestUserMessageText.length,
        tokens: estimateMessageTextTokens(latestUserMessageText),
      });
    }

    const { updatedStats, modelStats } = buildConversationStatsUpdate({
      existingStats,
      existingModelStats: (conversation.metadata?.modelStats || {}) as Record<
        string,
        ConversationStats | undefined
      >,
      usage,
      toolCallCount,
      modelId,
      latestUserMessageText,
      fixedTokens,
      cost,
    });

    logger.info('[Token Breakdown]', {
      conversationId: context.conversationId,
      turn: (existingStats?.turns || 0) + 1,
      newUserMessageTokens: estimateMessageTextTokens(latestUserMessageText),
      totalUserMessageTokens:
        updatedStats.tokenBreakdown?.userMessageTokens || 0,
      systemPromptTokens: updatedStats.tokenBreakdown?.systemPromptTokens || 0,
      mcpServerTokens: updatedStats.tokenBreakdown?.mcpServerTokens || 0,
      assistantMessageTokens:
        updatedStats.tokenBreakdown?.assistantMessageTokens || 0,
    });

    await memory.updateConversation(context.conversationId, {
      metadata: {
        ...conversation.metadata,
        stats: updatedStats,
        modelStats,
      },
    });

    otelContextTokens.add(
      (updatedStats.tokenBreakdown?.systemPromptTokens || 0) +
        (updatedStats.tokenBreakdown?.mcpServerTokens || 0),
      {
        agent: agentSlug,
      },
    );
    otelCost.add(cost ?? 0, { agent: agentSlug });

    try {
      const adapter = memoryAdapters.get(agentSlug);
      if (!adapter) {
        logger.warn('No adapter found for agent', { agent: agentSlug });
        return;
      }

      const adapterMessages = await adapter.getMessages(
        `agent:${agentSlug}`,
        context.conversationId,
      );
      const lastMessage = adapterMessages[adapterMessages.length - 1];

      if (lastMessage && lastMessage.role === 'assistant') {
        const models = await modelCatalog?.listModels();
        const modelInfo = models?.find((model) => model.modelId === modelId);
        const pricingInfo = await findModelPricing(
          modelCatalog,
          modelId,
          resolveBedrockRegion({
            configRegion: appConfig.region,
            env: process.env,
          }).region,
          providerType,
        );

        await adapter.removeLastMessage(
          `agent:${agentSlug}`,
          context.conversationId,
        );
        const inputTokens = getUsageInputTokens(usage);
        const outputTokens = getUsageOutputTokens(usage);
        const totalTokens = getUsageTotalTokens(usage);
        await adapter.addMessage(
          lastMessage,
          `agent:${agentSlug}`,
          context.conversationId,
          {
            model: modelId,
            modelMetadata: modelInfo
              ? {
                  capabilities: {
                    inputModalities: modelInfo.inputModalities,
                    outputModalities: modelInfo.outputModalities,
                    supportsStreaming: modelInfo.responseStreamingSupported,
                  },
                  pricing: pricingInfo
                    ? {
                        inputTokenPrice: pricingInfo.inputTokenPrice,
                        outputTokenPrice: pricingInfo.outputTokenPrice,
                        currency: 'USD',
                        region: appConfig.region,
                      }
                    : undefined,
                }
              : undefined,
            usage: {
              ...(inputTokens !== undefined ? { inputTokens } : {}),
              ...(outputTokens !== undefined ? { outputTokens } : {}),
              ...(totalTokens !== undefined ? { totalTokens } : {}),
              estimatedCost: cost,
            },
          },
        );
      }
    } catch (error) {
      logger.error('Failed to enrich message with model metadata', {
        error,
      });
    }
  } catch (error) {
    input.logger.error('Failed to update conversation stats', { error });
  }
}
