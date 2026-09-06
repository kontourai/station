import type { AgentDelegationContext } from '@kontourai/station-contracts/agent';
import type { TurnProvenanceContextInjection } from '@kontourai/station-contracts/turn-provenance-context';
import { SpanStatusCode } from '@opentelemetry/api';
import type { Context } from 'hono';
import { stream } from 'hono/streaming';
import { STATION_ENGINE_PROVIDER } from '../../../src-shared/monitoring-keys.js';
import {
  type AuthorizedTurnCorrelation,
  runWithAuthorizedTurnCorrelation,
} from '../../runtime/conversation/authorized-turn-correlation.js';
import type { NativeMemoryHistoryCompanion } from '../../runtime/conversation/native-memory-history.js';
import * as StreamOrchestrator from '../../runtime/conversation/stream-orchestrator.js';
import { stripOutputDeclarationHandles } from '../../runtime/native-output-declaration.js';
import {
  closeNativeOutputTurnContext,
  type NativeOutputTurnContext,
  runWithNativeOutputTurnContext,
} from '../../runtime/native-output-turn-grant.js';
import {
  type RuntimeConfigurationLease,
  requireCurrentRuntimeConfiguration,
  requireStableRuntimeConfigurationAcross,
} from '../../runtime/plugins/runtime-configuration-lease.js';
import { InjectableStream } from '../../runtime/streaming/InjectableStream.js';
import type { RuntimeContext } from '../../runtime/types.js';
import {
  chatContextInjectionBlocks,
  chatContextInjectionTokens,
  chatTurnDedup,
  tracer,
} from '../../telemetry/metrics.js';
import { errorMessage } from '../schemas/schemas.js';
import { getCachedUser } from '../system/auth.js';
import {
  applyAmbientContextToInput,
  applyCombinedContextToInput,
  injectConversationFeedbackContext,
} from './chat-context.js';
import {
  approxAppliedTokenDelta,
  CHAT_CONTEXT_INJECTION_EVENT,
  totalApproxInjectedTokens,
} from './chat-context-injection.js';
import {
  emitChatAgentStart,
  ensureChatAgentStatsInitialized,
  finalizeChatRequest,
} from './chat-lifecycle.js';
import {
  createChatConversationId,
  createChatTraceId,
  ensureChatConversation,
} from './chat-persistence.js';
import type { ChatMessage } from './chat-request-preparation.js';
import type { ChatTurnDedupStore } from './chat-turn-dedup.js';

type ChatOperationContext = Record<string, unknown> & {
  userId?: string;
  conversationId?: string;
  title?: string;
  traceId?: string;
  abortSignal?: AbortSignal;
  delegation?: AgentDelegationContext;
  /**
   * archive#1207 minted this per-turn idempotency key; archive#1224 (offline
   * slice 2) is the first server code to read it. Rides in via `restOptions`
   * (the chat schema's `.passthrough()`'d `options` bag) — see
   * `chat-turn-dedup.ts` for the dedup this drives.
   */
  clientTurnId?: string;
};

interface StreamPrimaryAgentChatArgs {
  c: Context;
  ctx: RuntimeContext;
  slug: string;
  plugin: string;
  input: string | ChatMessage[];
  /**
   * Ambient, model-facing context (timezone, geolocation, …) sent
   * out-of-band by the UI (archive#685). Composed into the model input only; the
   * persistence seams below keep receiving the typed `input`.
   */
  ambientContext?: string;
  restOptions: Record<string, unknown>;
  injectContext: string | null;
  ragContext: string | null;
  /**
   * archive#2649: the dispatch-time record `prepareChatRequest` built of the
   * blocks behind `injectContext`/`ragContext`. Optional so callers/tests
   * that predate the receipt stay valid — when ABSENT, no `context-injection`
   * frame is emitted at all (an honest non-claim), never an empty record
   * fabricated for strings this layer cannot itemize.
   */
  contextInjection?: TurnProvenanceContextInjection;
  modelOverride?: string;
  agent: any;
  configurationLease: RuntimeConfigurationLease;
  /** S1 of archive#1302: stamped onto a newly-created file-backed conversation's metadata — see `ensureChatConversation`. */
  projectSlug?: string;
  /** archive#1224 (offline): absent in callers/tests that predate this — dedup is then simply inert (byte-identical to before). */
  dedupStore?: ChatTurnDedupStore;
  /** Exact authorized orchestration coordinate from Station's internal relay only. */
  turnCorrelation?: AuthorizedTurnCorrelation;
  /** Private native-output capability from the authenticated internal relay. */
  nativeOutputGrant?: NativeOutputTurnContext;
  nativeMemory?: NativeMemoryHistoryCompanion;
}

export function logDebugChatImages(
  logger: RuntimeContext['logger'],
  input: string | ChatMessage[],
): void {
  if (!Array.isArray(input)) {
    return;
  }
  for (const msg of input) {
    if (!msg.parts) {
      continue;
    }
    for (const part of msg.parts) {
      if (part.type !== 'file') {
        continue;
      }
      const filePart = part as Record<string, unknown>;
      const dataUrl =
        typeof filePart.url === 'string' ? filePart.url : undefined;
      if (!dataUrl) {
        continue;
      }
      logger.info('[DEBUG Image] Received file part', {
        mediaType:
          typeof filePart.mediaType === 'string'
            ? filePart.mediaType
            : undefined,
        urlLength: dataUrl.length,
        urlStart: dataUrl.substring(0, 50),
        urlEnd: dataUrl.substring(dataUrl.length - 50),
      });
    }
  }
}

export function streamPrimaryAgentChat({
  c,
  ctx,
  slug,
  plugin,
  input,
  ambientContext,
  restOptions,
  injectContext,
  ragContext,
  contextInjection,
  modelOverride,
  agent,
  configurationLease,
  dedupStore,
  projectSlug,
  turnCorrelation,
  nativeOutputGrant,
  nativeMemory,
}: StreamPrimaryAgentChatArgs): Response {
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');

  const writeStream = async (
    streamWriter: Parameters<Parameters<typeof stream>[1]>[0],
  ) => {
    // archive#1207: started immediately — before any of the pre-stream
    // setup below (conversation creation, `agent.streamText` invocation) —
    // so a slow setup step can't itself be mistaken for a stalled
    // connection by the client's own watchdog, which starts counting the
    // moment the response headers (sent by `stream()` starting this
    // callback) arrive.
    const stopKeepalive = StreamOrchestrator.startSSEKeepalive(streamWriter);
    let conversationId: string | undefined;
    let operationContext: ChatOperationContext = {};
    let completionReason = 'completed';
    let hasOutput = false;
    let accumulatedText = '';
    let reasoningText = '';
    // Undefined until a trace is minted: a turn that fails before then (the
    // dedup claim, conversation setup) genuinely has no trace id, and the
    // emitter omits the key rather than writing one that is not an id.
    let requestTraceId: string | undefined;
    let isNewConversation = false;
    let releaseApprovalRequester = () => {};
    // archive#1224 (offline) — see chat-turn-dedup.ts.
    let clientTurnId: string | undefined;
    let ownsClientTurnClaim = false;
    let dedupShortCircuited = false;
    // Populated only when the outer catch below fires — used to persist a
    // reload-safe failure marker when the turn produced zero output (archive#191
    // R2's persistence-gap fix). Left undefined on every non-error path, so
    // a successful turn never persists a marker.
    let turnFailureText: string | undefined;
    // biome-ignore lint: agent framework types inferred from Map
    let result;
    let memory = null;
    let memoryAdapter = null;
    // archive#1566: hoisted so the `finally` block (where
    // `finalizeChatRequest` runs) can pass the same handle through for the
    // auto-title write. Declared here rather than as a `const` inside the
    // `try` block below because `finally` needs it too.
    let conversationStorage: {
      getConversation(id: string): Promise<any>;
      createConversation(payload: {
        id: string;
        resourceId: string;
        userId: string;
        title?: string;
        metadata?: any;
      }): Promise<any>;
      updateConversation(id: string, updates: any): Promise<any>;
    } | null = null;
    let effectiveRagContext: string | null = ragContext;
    const chatStartMs = Date.now();
    const chatSpan = tracer.startSpan('station.chat', {
      attributes: { 'station.agent': slug },
    });
    const artifacts: Array<{
      type: string;
      name?: string;
      content?: unknown;
    }> = [];

    try {
      const injectableStream = new InjectableStream();
      const agentSpec = ctx.agentSpecs.get(slug);
      const elicitation = StreamOrchestrator.createElicitationCallback(
        agentSpec!,
        ctx.toolNameMapping,
        ctx.approvalRegistry,
        injectableStream,
        ctx.logger,
        () => operationContext.conversationId,
      );

      operationContext = { ...restOptions, elicitation };

      if (!operationContext.userId) {
        operationContext.userId = getCachedUser().alias;
      }

      // archive#1224 (offline): the crux of server-side turn
      // idempotency for the direct /chat path. Must run BEFORE the
      // isNewConversation/createChatConversationId step below — a replayed
      // turn (retry, or a flushed offline-queue turn after a disconnect)
      // may never have learned the conversationId its original attempt was
      // assigned (its `fetch` could have failed locally before that SSE
      // frame arrived), so a duplicate request would otherwise mint a
      // SECOND, unrelated conversation instead of recognizing the original.
      clientTurnId =
        typeof operationContext.clientTurnId === 'string' &&
        operationContext.clientTurnId.length > 0
          ? operationContext.clientTurnId
          : undefined;
      if (clientTurnId) {
        const claim = dedupStore?.claim(clientTurnId);
        if (claim) {
          if (claim.claimed) {
            ownsClientTurnClaim = true;
          } else {
            chatTurnDedup.add(1, {
              outcome: claim.conversationId ? 'hit' : 'hit_inflight',
            });
            const resolvedConversationId =
              claim.conversationId ??
              (await dedupStore!.awaitResolution(clientTurnId));
            if (!resolvedConversationId) {
              throw new Error(
                `Turn ${clientTurnId} is already being processed.`,
              );
            }
            dedupShortCircuited = true;
            // Tell the client the conversation its original attempt already
            // landed in, so its normal post-send flow (assign conversationId,
            // fetch messages) reconciles against the real, already-persisted
            // response instead of the agent running a second time.
            const conversationStartedFrame = {
              type: 'conversation-started',
              conversationId: resolvedConversationId,
            };
            const finishFrame = {
              type: 'finish',
              finishReason: 'completed',
            };
            await streamWriter.write(
              `data: ${JSON.stringify(conversationStartedFrame)}\n\n`,
            );
            await streamWriter.write(
              `data: ${JSON.stringify(finishFrame)}\n\n`,
            );
            await streamWriter.write('data: [DONE]\n\n');
            return;
          }
        }
      }

      isNewConversation = !operationContext.conversationId;
      if (isNewConversation && operationContext.userId) {
        operationContext.conversationId = createChatConversationId(
          operationContext.userId,
        );
      }

      const agentHooks = ctx.agentHooksMap.get(slug);
      if (agentHooks && operationContext.conversationId) {
        releaseApprovalRequester = agentHooks.registerApprovalRequester(
          operationContext.conversationId,
          async (tool) => {
            const result = await elicitation({
              type: 'tool-approval',
              toolName: tool.toolName,
              toolDescription: tool.toolDescription || '',
              toolArgs: tool.toolArgs,
            });
            return !!result;
          },
        );
      }

      const abortController = new AbortController();
      conversationId = operationContext.conversationId;

      c.req.raw.signal?.addEventListener('abort', () => {
        ctx.logger.debug('Client disconnected, aborting operation', {
          conversationId,
        });
        abortController.abort('Client disconnected');
      });

      operationContext.abortSignal = abortController.signal;
      ctx.logger.debug('Abort signal configured', { conversationId });

      memory = agent.getMemory();
      memoryAdapter = ctx.memoryAdapters.get(slug);
      // archive#914: one conversation store, not a choice between two. This used to
      // pick the agent's own memory for file-backed agents and Station's
      // adapter for runtime ones — which were different objects, so the title
      // written here was invisible to the frame below that read the other one.
      conversationStorage = memoryAdapter ?? memory;
      const requestedDelegation =
        operationContext.delegation &&
        typeof operationContext.delegation === 'object'
          ? operationContext.delegation
          : undefined;
      await ensureChatConversation({
        conversationStorage,
        conversationId: operationContext.conversationId,
        userId: operationContext.userId,
        slug,
        input,
        title: operationContext.title,
        projectSlug,
        metadata: requestedDelegation
          ? { delegation: requestedDelegation }
          : undefined,
      });
      const persistedConversation =
        conversationStorage && operationContext.conversationId
          ? await conversationStorage.getConversation(
              operationContext.conversationId,
            )
          : null;
      const persistedDelegation = persistedConversation?.metadata?.delegation;
      if (persistedDelegation && typeof persistedDelegation === 'object') {
        operationContext.delegation =
          persistedDelegation as AgentDelegationContext;
      }

      const traceId = createChatTraceId(operationContext.conversationId!);
      operationContext.traceId = traceId;
      // Bind the finally-block's copy HERE, not after the stream is built
      // (archive#3115). Everything between this line and the stream can
      // throw — a model auth failure, a client disconnect — and the catch
      // below swallows it, so `finalizeChatRequest` still emits the
      // agent-complete span. Assigned late, that span carried the initial
      // `''`, which insights counts as no trace at all: the failed turns of
      // a named agent were recorded as zero conversations.
      requestTraceId = traceId;

      const feedbackInjection = injectConversationFeedbackContext(
        ctx.feedbackService.getRatings(),
        operationContext.conversationId,
        effectiveRagContext,
      );
      effectiveRagContext = feedbackInjection.ragContext;
      // archive#2649: the blocks this dispatch COMPOSED. Composition is not
      // yet a claim — the receipt below is built only from what the
      // composers report actually reaching the model input.
      const composedContext: TurnProvenanceContextInjection | undefined =
        contextInjection
          ? {
              ...contextInjection,
              ...(feedbackInjection.feedback
                ? { conversationFeedback: feedbackInjection.feedback }
                : {}),
            }
          : undefined;

      // Model-facing choke point (archive#685): ambient context joins the model
      // input here only — every persistence seam above/below keeps `input`.
      const ambientApplication = applyAmbientContextToInput(
        input,
        ambientContext,
      );
      const combinedApplication = applyCombinedContextToInput(
        ambientApplication.input,
        injectContext,
        effectiveRagContext,
      );
      const finalInput = combinedApplication.input;

      // archive#2649 (review fix): the composers are the AUTHORITY for this
      // receipt, not the composition above. Both drop their whole block when
      // the user message is array-shaped with no text part — an uncaptioned
      // attachment — and recording intent there would state that the model
      // read project rules and guidelines it never received. When the
      // combined block did not land, its blocks are omitted; what remains is
      // an honest empty record ("no Station-composed context reached the
      // model"), which is exactly what the card renders.
      const contextInjectionRecord: TurnProvenanceContextInjection | undefined =
        composedContext
          ? {
              ...(combinedApplication.applied ? composedContext : {}),
              ...(ambientApplication.applied
                ? {
                    ambient: {
                      approxTokens: approxAppliedTokenDelta(
                        input,
                        ambientApplication.input,
                      ),
                    },
                  }
                : {}),
            }
          : undefined;
      if (composedContext && !combinedApplication.applied) {
        // The drop itself is a product defect (archive#2743), not a
        // provenance one: the receipt now tells the truth about it, and this
        // line is what makes the silent discard observable.
        ctx.logger.debug('Composed chat context was not applied to the input', {
          conversationId: operationContext.conversationId,
          blocks: Object.keys(composedContext),
        });
      }

      requireCurrentRuntimeConfiguration(ctx, configurationLease);
      result = await agent.streamText(finalInput, operationContext);
      requireCurrentRuntimeConfiguration(ctx, configurationLease);
      ctx.agentStatus.set(slug, 'running');

      emitChatAgentStart({
        ctx,
        slug,
        conversationId: operationContext.conversationId || '',
        userId: operationContext.userId || '',
        traceId,
        input,
        model: (agent.model as { modelId?: string } | undefined)?.modelId,
      });
      await ensureChatAgentStatsInitialized({ ctx, slug });

      // archive#3179: these three handles exist only so a rejection on them
      // is not left unhandled — nothing awaits what `.catch()` returns. The
      // old body re-rejected (`abortController.signal.aborted ? undefined :
      // Promise.reject(err)`) whenever the abort was not STATION's own,
      // which put the rejection straight back into the void it was being
      // rescued from. A policy denial aborts `@voltagent/core`'s internal
      // controller and never Station's, so every denial produced three
      // unhandled rejections (observed: `text`, `usage`, and `finishReason`
      // all reject with the denial), logged by `crash-handlers.ts` at error
      // with no conversation to attribute them to.
      //
      // Nothing is swallowed that is not already reported: a transport or
      // model failure throws out of the `for await` below into the outer
      // catch, which logs at error and writes an SSE error frame; a denial
      // now arrives as a real tool-result plus a `tool-denied` finish. This
      // records the duplicate WITH the turn's identity instead, once —
      // all three reject together on the same underlying failure.
      let auxiliaryRejectionRecorded = false;
      const recordAuxiliaryRejection = (err: unknown) => {
        if (abortController.signal.aborted) return;
        if (auxiliaryRejectionRecorded) return;
        auxiliaryRejectionRecorded = true;
        ctx.logger.warn('Agent result promise rejected outside the stream', {
          agentId: slug,
          conversationId: operationContext.conversationId,
          error: err,
        });
      };
      result.text?.catch(recordAuxiliaryRejection);
      result.usage?.catch(recordAuxiliaryRejection);
      result.finishReason?.catch(recordAuxiliaryRejection);

      const saveCancellationMessage = async () => {
        await StreamOrchestrator.saveCancellationMessage(
          agent,
          operationContext,
        );
      };

      ctx.logger.info('Agent stream started', {
        conversationId: operationContext.conversationId,
        isNewConversation,
      });

      if (isNewConversation && operationContext.conversationId) {
        const conversation = conversationStorage
          ? await conversationStorage.getConversation(
              operationContext.conversationId,
            )
          : null;
        await streamWriter.write(
          `data: ${JSON.stringify({
            type: 'conversation-started',
            conversationId: operationContext.conversationId,
            title: conversation?.title || 'New Conversation',
          })}\n\n`,
        );
      }

      // archive#2649: the per-turn context receipt, emitted AFTER
      // `agent.streamText` accepted the composed input (so it records a
      // dispatch that actually happened — the dedup short-circuit above
      // returns before ever reaching here) and before any model output.
      // The station-agent adapter relays this frame onto the turn's
      // terminal event metadata for the provenance envelope.
      if (contextInjectionRecord) {
        await streamWriter.write(
          `data: ${JSON.stringify({
            type: CHAT_CONTEXT_INJECTION_EVENT,
            contextInjection: contextInjectionRecord,
          })}\n\n`,
        );
        for (const block of Object.keys(contextInjectionRecord)) {
          chatContextInjectionBlocks.add(1, { agent: slug, block });
        }
        chatContextInjectionTokens.record(
          totalApproxInjectedTokens(contextInjectionRecord),
          { agent: slug },
        );
      }

      completionReason = 'completed';
      hasOutput = false;
      accumulatedText = '';
      reasoningText = '';

      const debugStreaming = process.env.DEBUG_STREAMING === 'true';
      // Read the model BEFORE the pipeline is built: the tool events emitted
      // inside it carry the engine and model (archive#3074), and this is the only
      // construction path, so a value resolved afterwards never reaches them.
      const configuredModelId = (
        agent.model as { modelId?: string } | undefined
      )?.modelId;
      const pipeline = StreamOrchestrator.createStreamingPipeline(
        abortController.signal,
        ctx.monitoringEvents,
        {
          slug,
          conversationId: operationContext.conversationId,
          userId: operationContext.userId,
          traceId,
          plugin,
          // This IS the Station engine; the external engines report their own
          // provider through the orchestration bridge.
          provider: STATION_ENGINE_PROVIDER,
          model: configuredModelId,
        },
        ctx.monitoringEmitter,
      );

      const agentTools = ctx.agentTools.get(slug) || [];
      const agentModel = agent.model as
        | {
            modelId?: string;
            settings?: { maxTokens?: number; temperature?: number };
          }
        | undefined;
      ctx.logger.debug('Stream starting', {
        conversationId,
        model: agentModel?.modelId,
        toolCount: agentTools.length,
        toolNames: agentTools.map((tool) => tool.name).slice(0, 5),
        maxTokens: agentModel?.settings?.maxTokens,
        temperature: agentModel?.settings?.temperature,
        debugStreaming,
      });

      const wrappedStream = stripOutputDeclarationHandles(
        injectableStream.wrap(result.fullStream),
      );
      for await (const chunk of pipeline.run(wrappedStream)) {
        requireCurrentRuntimeConfiguration(ctx, configurationLease);
        await StreamOrchestrator.writeSSEChunk(streamWriter, chunk);
      }

      const results = await pipeline.finalize();
      await requireStableRuntimeConfigurationAcross(
        ctx,
        configurationLease,
        () => StreamOrchestrator.writeSSEDone(streamWriter),
      );

      if (results.completion) {
        hasOutput = results.completion.hasOutput;
        completionReason = results.completion.completionReason;
        accumulatedText = results.completion.accumulatedText;
      }

      if (abortController.signal.aborted) {
        completionReason = 'aborted';
        if (!hasOutput) {
          await saveCancellationMessage();
        }
      }
    } catch (error: unknown) {
      chatSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMessage(error),
      });
      chatSpan.recordException(
        error instanceof Error ? error : new Error(errorMessage(error)),
      );
      const agentModelForError = agent.model as
        | { modelId?: string }
        | undefined;
      ctx.logger.error('Stream error occurred', {
        agentId: slug,
        modelName: agentModelForError?.modelId,
        conversationId,
        agentName: slug,
        error,
      });
      turnFailureText = errorMessage(error);
      await StreamOrchestrator.writeSSEError(streamWriter, error);
      await StreamOrchestrator.writeSSEDone(streamWriter);
    } finally {
      stopKeepalive();
      releaseApprovalRequester();
      // archive#1224 (offline): the dedup short-circuit above
      // already wrote its own terminal SSE frames and `return`ed — none of
      // this turn's own bookkeeping (stats, cost, and critically
      // `persistUserTurnIfMissing`, which would otherwise see the empty
      // `accumulatedText` this short-circuit leaves behind and persist a
      // SECOND copy of the user's message) applies to it, since nothing
      // here executed a turn at all.
      if (dedupShortCircuited) {
        // finalizeChatRequest() (which ends the span for every other path)
        // never runs here — end it directly so it isn't left open.
        chatSpan.end();
      } else {
        if (clientTurnId && ownsClientTurnClaim) {
          if (
            !turnFailureText &&
            completionReason === 'completed' &&
            conversationId
          ) {
            // Only a genuine success is remembered permanently — an
            // aborted/failed attempt releases the claim so a retry with the
            // same clientTurnId can actually re-execute rather than being
            // deduped against nothing.
            dedupStore?.resolve(clientTurnId, conversationId);
          } else {
            dedupStore?.release(clientTurnId);
          }
        }
        await finalizeChatRequest({
          ctx,
          slug,
          plugin,
          input,
          operationContext: {
            userId: operationContext.userId,
            conversationId: operationContext.conversationId,
            traceId: requestTraceId,
          },
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
        });
      }
    }
  };

  return stream(c, (streamWriter) => {
    const write = () => writeStream(streamWriter);
    const correlated = () =>
      turnCorrelation
        ? runWithAuthorizedTurnCorrelation(turnCorrelation, write, nativeMemory)
        : write();
    return nativeOutputGrant
      ? runWithNativeOutputTurnContext(nativeOutputGrant, async () => {
          try {
            return await correlated();
          } finally {
            // Completion ends issuance only. A bound native scope drains until
            // the orchestration event-store commits its terminal event.
            closeNativeOutputTurnContext(nativeOutputGrant);
          }
        })
      : correlated();
  });
}
