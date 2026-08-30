import type { AgentSpec } from '@kontourai/station-contracts/agent';
import { SpanStatusCode } from '@opentelemetry/api';
import { STATION_ENGINE_PROVIDER } from '../../../src-shared/monitoring-keys.js';
import { resolveManagedModelIdentity } from '../../runtime/plugins/runtime-provider-resolution.js';
import type { RuntimeContext } from '../../runtime/types.js';
import {
  chatDuration,
  chatRequests,
  costEstimated,
  tokensInput,
  tokensOutput,
} from '../../telemetry/metrics.js';
import { estimateCost, findModelPricing } from '../../utils/pricing.js';
import { persistUserTurnIfMissing } from './chat-persistence.js';
import {
  type ChatMessage,
  extractChatUserText,
} from './chat-request-preparation.js';
import { generateConversationTitle } from './chat-title-generation.js';

export function emitChatAgentStart({
  ctx,
  slug,
  conversationId,
  userId,
  traceId,
  input,
  model,
}: {
  ctx: RuntimeContext;
  slug: string;
  conversationId: string;
  userId: string;
  traceId: string;
  input: string | ChatMessage[];
  /** Session-configured model at dispatch, when the caller resolved one. */
  model?: string;
}): void {
  if (!ctx.monitoringEmitter) {
    return;
  }

  ctx.monitoringEmitter.emitAgentStart({
    slug,
    conversationId,
    userId,
    traceId,
    input:
      typeof input === 'string'
        ? input
        : extractChatUserText(input) || '[complex input]',
    // archive#3074 named this gap directly: the Station-engine start span carried
    // neither field, so a tool event could not even be joined back to an
    // engine. External engines already set both via the orchestration bridge.
    provider: STATION_ENGINE_PROVIDER,
    model,
  });
}

export async function ensureChatAgentStatsInitialized({
  ctx,
  slug,
}: {
  ctx: RuntimeContext;
  slug: string;
}): Promise<void> {
  if (ctx.agentStats.has(slug)) {
    return;
  }

  const adapter = ctx.memoryAdapters.get(slug);
  if (!adapter) {
    return;
  }

  const conversations = await adapter.getConversations(slug);
  let totalMessages = 0;
  for (const conversation of conversations) {
    const messages = await adapter.getMessages(
      conversation.userId,
      conversation.id,
    );
    totalMessages += messages.length;
  }

  ctx.agentStats.set(slug, {
    conversationCount: conversations.length,
    messageCount: totalMessages,
    lastUpdated: Date.now(),
  });
}

export async function finalizeChatRequest({
  ctx,
  slug,
  plugin,
  input,
  operationContext,
  completionReason,
  accumulatedText,
  reasoningText,
  artifacts,
  result,
  modelOverride,
  memoryAdapter,
  conversationStorage,
  conversationId,
  isNewConversation,
  chatStartMs,
  chatSpan,
  turnFailureText,
}: {
  ctx: RuntimeContext;
  slug: string;
  plugin: string;
  input: string | ChatMessage[];
  operationContext: {
    userId?: string;
    conversationId?: string;
    traceId?: string;
  };
  completionReason: string;
  accumulatedText: string;
  reasoningText: string;
  artifacts: Array<{ type: string; name?: string; content?: unknown }>;
  result: {
    usage?: Promise<{
      promptTokens?: number;
      completionTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    }>;
  };
  modelOverride?: string;
  memoryAdapter:
    | {
        addMessage(
          msg: any,
          userId: string,
          conversationId: string,
          metadata?: any,
        ): Promise<void>;
        getMessages?(userId: string, conversationId: string): Promise<any[]>;
      }
    | null
    | undefined;
  /**
   * The same conversation-store handle `chat-primary-stream.ts` resolved for
   * `ensureChatConversation` (archive#1566) — needed here so the auto-title
   * write below can call `updateConversation` with an updater function.
   * `getConversation` is deliberately NOT part of this narrowed shape: the
   * auto-title write reads the conversation from INSIDE the adapter's
   * serialized queue (via the updater callback) rather than through a
   * separate pre-read, closing the TOCTOU a separate read would reopen
   * (archive#1566 review HIGH — see `generateAndPersistAutoTitle`).
   * Optional/absent is simply "no auto-title write", matching every other
   * memoryAdapter-shaped param on this function.
   */
  conversationStorage?: {
    updateConversation(
      id: string,
      updater: (current: any) => Partial<any> | null,
    ): Promise<any>;
  } | null;
  conversationId?: string;
  isNewConversation: boolean;
  chatStartMs: number;
  chatSpan: {
    setAttribute: (key: string, value: string | number) => void;
    setStatus?: (status: { code: SpanStatusCode; message?: string }) => void;
    end: () => void;
  };
  /**
   * The raw failure message from `streamPrimaryAgentChat`'s outer catch,
   * when the turn errored before producing any output. Undefined on every
   * successful (or partially-successful, `accumulatedText`-bearing) turn.
   * Used only to persist a reload-safe failure marker (archive#191 R2) — never
   * translated server-side (translation stays client-side, see
   * `chatErrorTranslation.ts`).
   */
  turnFailureText?: string;
}): Promise<void> {
  ctx.logger.info('Agent stream completed', {
    conversationId: operationContext.conversationId,
    reason: completionReason,
  });

  ctx.agentStatus.set(slug, 'idle');

  // archive#914: the agent's own memory is now the same conversation store Station
  // registers for the slug, so the framework persists the turn itself. Station
  // used to duplicate it here for runtime agents — the compensating write that
  // existed only because `createTempAgent` got a throwaway store — and keeping
  // it would write every turn twice.

  // archive#797: a turn that ends with no output loses the user's own message,
  // because the agent framework persists the user turn only once the model
  // stream is consumed. Keyed on the absence of output rather than on
  // `turnFailureText`, so it also covers `chat-primary-stream.ts`'s
  // graceful-cancellation branch — an abort observed after the pipeline
  // drained, which persists only an assistant "cancelled" message and never
  // reaches the outer catch. Runs before the marker below so the two land in
  // transcript order. A read failure inside is deliberately swallowed: the
  // turn is then left exactly as it was before this recovery existed, rather
  // than risking a duplicate.
  if (
    !accumulatedText &&
    memoryAdapter &&
    conversationId &&
    operationContext.userId
  ) {
    try {
      await persistUserTurnIfMissing({
        memoryAdapter,
        conversationId,
        userId: operationContext.userId,
        input,
      });
    } catch (error) {
      ctx.logger.error('Failed to persist user turn for failed turn', {
        error,
      });
    }
  }

  // archive#191 R2 persistence-gap fix: a failed turn that produced zero output
  // otherwise persists nothing at all, so the translated error a user saw
  // live silently vanishes on reload. Persist a raw, untranslated system
  // marker using the existing `[SYSTEM_EVENT]`-prefixed user-role message
  // convention (see `conversation-manager.ts`'s `add-system-message`), plus
  // a `[CHAT_ERROR]` sub-marker so `ChatDockBody.tsx`'s `SystemEventMessage`
  // render path can distinguish this from any other `[SYSTEM_EVENT]` (e.g.
  // an `add-system-message` call) and run only this one through
  // `translateChatError` on reload, so live and reload-after-refresh show
  // the same copy. Additive: never runs when `accumulatedText` is
  // non-empty (the branch above owns that case), and applies regardless of
  // `isFileBackedAgent` since `memoryAdapter` is the same conversation
  // storage for both (see `runtime-agent-builder.ts`'s
  // `context.memoryAdapters.set(agentSlug, bundle.memoryAdapter)`).
  // Translation itself stays client-side (`chatErrorTranslation.ts`) — this
  // is intentionally the raw message.
  if (
    !accumulatedText &&
    turnFailureText &&
    memoryAdapter &&
    conversationId &&
    operationContext.userId
  ) {
    try {
      await memoryAdapter.addMessage(
        {
          id: crypto.randomUUID(),
          role: 'user',
          parts: [
            {
              type: 'text',
              text: `[SYSTEM_EVENT] [CHAT_ERROR] ${turnFailureText}`,
            },
          ],
        },
        operationContext.userId,
        conversationId,
      );
    } catch (error) {
      ctx.logger.error('Failed to persist failed-turn marker message', {
        error,
      });
    }
  }

  const finalOutput = accumulatedText.replace(reasoningText, '').trim();
  if (finalOutput) {
    artifacts.push({ type: 'text', content: finalOutput });
  }

  // archive#1566: auto-generate a short title from the first exchange of a
  // brand-new conversation. Fire-and-forget — a title is a nice-to-have, so
  // this must never delay or fail the turn the user is waiting on; any
  // failure (disabled structureModel, provider error, timeout) is swallowed
  // inside `generateConversationTitle` itself, and the write below logs
  // rather than throws. The initial truncated-prompt title
  // (`ensureChatConversation`) stands until/unless this succeeds.
  if (
    isNewConversation &&
    conversationId &&
    finalOutput &&
    operationContext.userId &&
    conversationStorage
  ) {
    const firstUserText =
      typeof input === 'string' ? input : extractChatUserText(input);
    void generateAndPersistAutoTitle({
      ctx,
      conversationStorage,
      conversationId,
      firstUserText,
      assistantText: finalOutput,
    }).catch((error) => {
      ctx.logger.debug('Auto chat title generation/write failed', { error });
    });
  }

  let usage:
    | {
        promptTokens?: number;
        completionTokens?: number;
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
      }
    | undefined;
  try {
    usage = await result.usage;
  } catch {
    usage = undefined;
  }

  if (ctx.monitoringEmitter) {
    ctx.monitoringEmitter.emitAgentComplete({
      slug,
      conversationId: operationContext.conversationId,
      userId: operationContext.userId,
      traceId: operationContext.traceId,
      reason: completionReason,
      steps: 0,
      maxSteps: ctx.agentSpecs.get(slug)?.guardrails?.maxSteps,
      inputChars:
        typeof input === 'string'
          ? input.length
          : extractChatUserText(input).length,
      outputChars: finalOutput.length,
      usage: usage
        ? {
            inputTokens: usage.promptTokens || usage.inputTokens || 0,
            outputTokens: usage.completionTokens || usage.outputTokens || 0,
          }
        : undefined,
      artifacts,
    });
  }

  const stats = ctx.agentStats.get(slug);
  if (stats) {
    stats.messageCount += 2;
    stats.lastUpdated = Date.now();
    if (isNewConversation) {
      stats.conversationCount += 1;
    }
  }

  const inputTokenCount = usage?.promptTokens || usage?.inputTokens || 0;
  const outputTokenCount = usage?.completionTokens || usage?.outputTokens || 0;
  let estimatedCost: number | undefined;

  if (usage && ctx.modelCatalog) {
    try {
      let modelId =
        modelOverride ||
        ctx.agentSpecs.get(slug)?.execution?.modelId ||
        ctx.agentSpecs.get(slug)?.model ||
        ctx.appConfig.invokeModel;
      let region = ctx.appConfig.region || 'us-east-1';
      const agentSpec = ctx.agentSpecs.get(slug);
      if (agentSpec) {
        try {
          const accountingSpec = (
            modelOverride
              ? {
                  ...agentSpec,
                  model: modelOverride,
                  execution: { ...agentSpec.execution, modelId: modelOverride },
                }
              : agentSpec
          ) as AgentSpec;
          const identity = resolveManagedModelIdentity(accountingSpec, {
            appConfig: ctx.appConfig,
            listProviderConnections: () =>
              ctx.providerService.listProviderConnections(),
          });
          modelId = identity.modelId;
          region = identity.region ?? region;
        } catch {
          // Preserve token accounting when legacy/incomplete provider state exists.
        }
      }
      if (modelId) {
        const pricing = await findModelPricing(
          ctx.modelCatalog,
          modelId,
          region,
        );
        estimatedCost = estimateCost(pricing, {
          ...(usage.promptTokens !== undefined || usage.inputTokens !== undefined
            ? { inputTokens: usage.promptTokens ?? usage.inputTokens }
            : {}),
          ...(usage.completionTokens !== undefined ||
          usage.outputTokens !== undefined
            ? {
                outputTokens:
                  usage.completionTokens ?? usage.outputTokens,
              }
            : {}),
          ...(usage.cacheReadTokens !== undefined
            ? { cacheReadTokens: usage.cacheReadTokens }
            : {}),
          ...(usage.cacheWriteTokens !== undefined
            ? { cacheWriteTokens: usage.cacheWriteTokens }
            : {}),
        });
      }
    } catch {
      estimatedCost = undefined;
    }
  }

  ctx.metricsLog.push({
    timestamp: Date.now(),
    agentSlug: slug,
    event: 'completion',
    conversationId: operationContext.conversationId,
    messageCount: 2,
    ...(estimatedCost !== undefined ? { cost: estimatedCost } : {}),
  });

  chatRequests.add(1, { agent: slug, plugin });
  chatDuration.record(Date.now() - chatStartMs, {
    agent: slug,
    plugin,
  });
  if (usage) {
    tokensInput.add(inputTokenCount, { agent: slug, plugin });
    tokensOutput.add(outputTokenCount, { agent: slug, plugin });
  }
  if (estimatedCost !== undefined && estimatedCost > 0) {
    costEstimated.add(estimatedCost, { agent: slug, plugin });
  }

  chatSpan.setAttribute(
    'station.conversation_id',
    operationContext.conversationId || '',
  );
  chatSpan.setAttribute('station.tokens.input', inputTokenCount);
  chatSpan.setAttribute('station.tokens.output', outputTokenCount);
  chatSpan.setStatus?.({ code: SpanStatusCode.OK });
  chatSpan.end();
}

/**
 * archive#1566: generates and writes the auto title.
 *
 * archive#1566 review (HIGH, TOCTOU): the original shape here did a separate
 * `getConversation` read, decided whether to skip, and only then called
 * `updateConversation` with a static object — a user-initiated rename
 * (`PATCH /:slug/conversations/:conversationId`) landing in the gap between
 * that read and the write got silently clobbered by this call's stale
 * `metadata` snapshot, contradicting the "rename always wins" guarantee.
 * `conversationStorage.updateConversation` (`FileMemoryAdapter` ->
 * `MemoryConversationStore`) now accepts an updater function that runs
 * INSIDE the adapter's serialized per-conversation read-compute-write queue
 * (the same queue `persistConversation` always used), so the
 * `titleSource === 'user'` check below executes against whatever the LATEST
 * committed record is at write time — including a rename that landed after
 * this function started (it's a network round trip to a model provider) —
 * never a pre-queue snapshot. Returning `null` skips the write entirely.
 * `titleSource: 'auto'` marks this write so a later PATCH's own metadata
 * merge doesn't need special-casing.
 */
async function generateAndPersistAutoTitle({
  ctx,
  conversationStorage,
  conversationId,
  firstUserText,
  assistantText,
}: {
  ctx: RuntimeContext;
  conversationStorage: {
    updateConversation(
      id: string,
      updater: (current: any) => Partial<any> | null,
    ): Promise<any>;
  };
  conversationId: string;
  firstUserText: string;
  assistantText: string;
}): Promise<void> {
  const title = await generateConversationTitle({
    ctx,
    firstUserText,
    assistantText,
  });
  if (!title) {
    return;
  }

  await conversationStorage.updateConversation(conversationId, (current) => {
    const currentMetadata =
      current?.metadata &&
      typeof current.metadata === 'object' &&
      !Array.isArray(current.metadata)
        ? (current.metadata as Record<string, unknown>)
        : {};
    // A user rename, provider title, and deterministic first-prompt title
    // are all durable authority. Only legacy records without a source may be
    // enhanced asynchronously; current conversations never depend on a
    // model call for their useful title.
    if (currentMetadata.titleSource) {
      return null;
    }
    return { title, metadata: { ...currentMetadata, titleSource: 'auto' } };
  });
}
