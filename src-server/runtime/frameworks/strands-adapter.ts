import type { UIMessage } from 'ai';
import {
  publicAgentIdFromRuntimeKey,
  runtimeAgentKey,
} from '../../routes/agents/runtime-agent-identity.js';
/**
 * Strands Agents SDK adapter — maps Strands API to the framework-agnostic interfaces.
 *
 * This is the counterpart to voltagent-adapter.ts. When the runtime config
 * sets `runtime: 'strands'`, this adapter is used instead of VoltAgent.
 *
 * Stream event mapping (Strands → IStreamChunk / TextStreamPart-compatible):
 *   modelContentBlockDeltaEvent { delta: { type: 'textDelta', text } }       → { type: 'text-delta', text }
 *   modelContentBlockDeltaEvent { delta: { type: 'reasoningContentDelta' } } → { type: 'reasoning-delta', text }
 *   modelContentBlockStartEvent { start: { type: 'toolUseStart', name } }    → { type: 'tool-call', toolName, toolCallId }
 *   toolResultEvent                                                           → { type: 'tool-result', toolName, output }
 *   modelMessageStopEvent                                                     → { type: 'finish', finishReason }
 *   modelMetadataEvent                                                        → (usage tracking)
 */

import type { AgentSpec } from '@kontourai/station-contracts/agent';
import {
  AfterInvocationEvent,
  type AgentResult,
  type McpClient,
  type Message,
  Agent as StrandsAgent,
} from '@strands-agents/sdk';
import type { StorageAdapter } from '@voltagent/core';
import { createLogger } from '../../utils/logger.js';
import {
  currentScheduledPrincipal,
  currentScheduledRunId,
} from '../agents/scheduled-principal-context.js';
import {
  currentAuthorizedTurnCorrelation,
  currentNativeMemoryHistory,
} from '../conversation/authorized-turn-correlation.js';
import { createConfiguredDispatchModel } from '../conversation/dispatch-model-policy.js';
import type { NativeMemoryHistoryCompanion } from '../conversation/native-memory-history.js';
import { createNativeOutputDeclarationTool } from '../native-output-declaration.js';
import { resolveManagedModelBinding } from '../plugins/runtime-provider-resolution.js';
import { getLoadedMCPToolProvenance } from '../tools/mcp-tool-names.js';
import type {
  AgentBundle,
  AgentCreationConfig,
  IAgent,
  IAgentHooks,
  IGenerateResult,
  IMemory,
  InvocationContext,
  IStreamChunk,
  IStreamResult,
  ITool,
  ToolCallDenial,
} from '../types.js';
import { conformAgentHooks } from './conduit-framework-adapter.js';
import {
  createStrandsAiSdkModel,
  createStrandsManagedModel,
} from './framework-model-factory.js';
import {
  bindStrandsInvocationContext,
  resolveStrandsInvocationContext,
  wireStrandsAgentHooks,
  wireStrandsToolGate,
} from './strands-agent-hooks.js';
import {
  bindStrandsNativeHistory,
  nativeHistoryToStrands,
  syncStrandsMessagesToMemory,
} from './strands-message-sync.js';
import { mapStrandsStreamEvent } from './strands-stream-events.js';
import {
  createStrandsFunctionTools,
  destroyStrandsAgentTools,
  loadStrandsTools,
} from './strands-tool-loader.js';
import type { CreateAgentOptions } from './voltagent-adapter.js';

// ── IAgent wrapper around Strands Agent ────────────────

class StrandsAgentWrapper implements IAgent {
  private strandsAgent: StrandsAgent;
  private memory: IMemory | null;
  private tools: ITool[];
  /** Accumulated usage from the last stream — read by AfterInvocationEvent hook */
  _lastStreamUsage: {
    promptTokens?: number;
    completionTokens?: number;
  } | null = null;
  /**
   * AGENT-scoped base identity (agentSlug) — never mutated per-request.
   * Per-request fields (conversationId/userId/delegation) live in a FRESH
   * per-invocation context bound OUT-OF-BAND in a module-private WeakMap
   * keyed by this invocation's `invocationState` object identity — never
   * inside the bag itself, which the SDK lets tools mutate
   * (archive#1834 round 3): a shared mutable context let a second
   * interleaved stream overwrite the first stream's identity before its
   * lazy generator executed, so conversation A's tool call could consult
   * conversation B's approval requester; truthy-only merges also leaked
   * stale fields (e.g. delegation) into later invocations.
   */
  _invocationCtx: InvocationContext;

  constructor(
    strandsAgent: StrandsAgent,
    public readonly id: string,
    public readonly name: string,
    public readonly model: any,
    memory: IMemory | null,
    invocationCtx: InvocationContext,
    tools: ITool[] = [],
    private readonly native?: {
      agentKey?: string;
      adapter?: StorageAdapter;
      fork?: (
        history: Message[],
        companion: NativeMemoryHistoryCompanion | undefined,
        invocation: InvocationContext,
        isCurrent: () => Promise<boolean>,
      ) => StrandsAgentWrapper;
      companion?: NativeMemoryHistoryCompanion;
      isHistoryCurrent?: () => Promise<boolean>;
    },
  ) {
    this.strandsAgent = strandsAgent;
    this.memory = memory;
    this.tools = tools;
    this._invocationCtx = invocationCtx;
  }

  /** VoltAgent compat — used by server-core's handleGetAgents / handleListTools */
  getFullState() {
    return {
      id: this.id,
      name: this.name,
      status: 'idle',
      model: this.model,
      tools: this.tools,
      subAgents: [],
      memory: this.memory,
    };
  }
  getTools() {
    return this.tools;
  }
  isTelemetryConfigured() {
    return false;
  }

  /**
   * Build a fresh, isolated per-invocation context and the strands
   * InvokeOptions whose `invocationState` object IDENTIFIES it (archive#1834
   * rounds 3-4): a snapshot of agent identity plus exactly THIS request's
   * fields — a field absent on this request is absent in this invocation's
   * context (no truthy-merge retention), two interleaved streams each carry
   * their own state object, and the trusted context lives in a
   * module-private WeakMap keyed on that object, never in the tool-writable
   * bag itself.
   */
  private invocationOptions(options?: {
    conversationId?: string;
    userId?: string;
    delegation?: InvocationContext['delegation'];
    /** Forwarded by the scheduler Adapter to Strands' cancellation seam. */
    signal?: AbortSignal;
  }) {
    const correlation = currentAuthorizedTurnCorrelation();
    const exactSession =
      correlation && correlation.sessionId === options?.conversationId
        ? correlation
        : undefined;
    const ctx: InvocationContext = {
      agentSlug: this._invocationCtx.agentSlug,
      conversationId: options?.conversationId,
      ...(exactSession
        ? {
            sessionId: exactSession.sessionId,
            turnId: exactSession.turnId,
            principalId: exactSession.accountId,
          }
        : {}),
      userId: options?.userId,
      traceId: currentScheduledRunId() ?? this._invocationCtx.traceId,
      delegation: options?.delegation,
      unattendedPrincipal: currentScheduledPrincipal(),
    };
    // The bag itself stays EMPTY of trusted data: invocationState is the
    // SDK's tool-writable scratch space, so the context is bound out-of-band
    // by the bag's object identity (archive#1834 round 4) — nothing for a
    // tool implementation to mutate or spoof.
    const invocationState: Record<string, unknown> = {};
    bindStrandsInvocationContext(invocationState, ctx);
    return {
      invocationState,
      ...(options?.signal ? { cancelSignal: options.signal } : {}),
    };
  }

  private async nativeInvocation(options?: {
    conversationId?: string;
    userId?: string;
  }) {
    const conversationId = options?.conversationId;
    if (!this.native?.fork || !conversationId) return undefined;
    const companion = currentNativeMemoryHistory();
    const adapter = this.native.adapter;
    if (!adapter) {
      if (
        companion &&
        this.native.agentKey &&
        companion.ownsRuntimeAgentKey(this.native.agentKey) &&
        companion.currentSessionId === conversationId
      )
        throw new Error('Native Strands history storage is unavailable.');
      return undefined;
    }
    const agentKey = this.native.agentKey;
    if (!agentKey)
      throw new Error(
        'Memory-backed Strands conversation requires its canonical Agent identity.',
      );
    const userId = options?.userId ?? '';
    let messages: UIMessage[];
    let isCurrent: () => Promise<boolean>;
    if (companion) {
      if (
        !companion.ownsRuntimeAgentKey(agentKey) ||
        companion.currentSessionId !== conversationId
      )
        throw new Error(
          'Native Strands history does not belong to this Agent invocation.',
        );
      messages = await companion.read(adapter, userId, conversationId);
      isCurrent = () => companion.isCurrent();
    } else {
      const original = await adapter.getConversation(conversationId);
      const matches = (value: NonNullable<typeof original>) =>
        value.id === conversationId &&
        value.userId === userId &&
        publicAgentIdFromRuntimeKey(value.resourceId) ===
          publicAgentIdFromRuntimeKey(agentKey);
      if (original && !matches(original))
        throw new Error(
          'Direct Strands conversation ownership is unavailable.',
        );
      isCurrent = async () => {
        try {
          const current = await adapter.getConversation(conversationId);
          return current ? matches(current) : !original;
        } catch {
          return false;
        }
      };
      messages = original
        ? await adapter.getMessages(userId, conversationId)
        : [];
      if (!(await isCurrent()))
        throw new Error('Direct Strands conversation ownership changed.');
    }
    const invocationState = this.invocationOptions(options).invocationState;
    const invocation = Object.freeze({
      ...resolveStrandsInvocationContext(invocationState, this._invocationCtx),
    });
    return this.native.fork(
      nativeHistoryToStrands(messages),
      companion,
      invocation,
      isCurrent,
    );
  }

  async generateText(prompt: string, _options?: any): Promise<IGenerateResult> {
    const owned = await this.nativeInvocation(_options);
    if (owned) return owned.generateText(prompt, _options);
    if (
      this.native?.isHistoryCurrent &&
      !(await this.native.isHistoryCurrent())
    )
      throw new Error('Native Strands history changed before invocation.');
    // Use stream() internally to capture usage from modelMetadataEvent
    let fullText = '';
    let reasoning = '';
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    for await (const event of this.strandsAgent.stream(
      prompt,
      this.invocationOptions(_options),
    )) {
      if (event.type === 'agentResultEvent') {
        const agentResult = (event as any).result as AgentResult;
        fullText = agentResult.toString();
        const msg = agentResult.lastMessage;
        const reasoningBlocks =
          msg?.content?.filter((b: any) => b.type === 'reasoningBlock') || [];
        reasoning = reasoningBlocks
          .map((b: any) => b.reasoningText || b.text || '')
          .join('\n');
        continue;
      }
      // Capture usage from metadata events
      const mapped = mapStrandsStreamEvent(event);
      if (mapped && mapped.type === 'usage') {
        usage.promptTokens += (mapped as any).promptTokens || 0;
        usage.completionTokens += (mapped as any).completionTokens || 0;
        usage.totalTokens = usage.promptTokens + usage.completionTokens;
      }
    }

    return { text: fullText, usage, reasoning: reasoning || undefined };
  }

  async streamText(input: string, _options?: any): Promise<IStreamResult> {
    const owned = await this.nativeInvocation(_options);
    if (owned) return owned.streamText(input, _options);
    // Per-request identity is WeakMap-bound to this invocation's state object
    // identity (never stored in the tool-writable bag, never a shared mutable
    // object — archive#1834 rounds 3-4); see invocationOptions.
    const invokeOptions = this.invocationOptions(_options);
    const agent = this.strandsAgent;
    let resolveUsage: (u: any) => void;
    let resolveFinish: (r: string) => void;
    let resolveText: (t: string) => void;

    const usagePromise = new Promise<any>((r) => {
      resolveUsage = r;
    });
    const finishPromise = new Promise<string>((r) => {
      resolveFinish = r;
    });
    const textPromise = new Promise<string>((r) => {
      resolveText = r;
    });

    const self = this;

    async function* streamGenerator(): AsyncIterable<IStreamChunk> {
      let fullText = '';
      const accUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      let observedUsage = false;
      try {
        if (
          self.native?.isHistoryCurrent &&
          !(await self.native.isHistoryCurrent())
        )
          throw new Error('Native Strands history changed before invocation.');

        const _emittedStart = false;
        let emittedTextStart = false;
        const stream = agent.stream(input, invokeOptions);

        self._lastStreamUsage = null;

        // Emit synthetic start events (VoltAgent emits these, UI expects them)
        yield { type: 'start', id: '0' };
        yield { type: 'start-step', id: '0' };

        for await (const event of stream) {
          if (event.type === 'agentResultEvent') {
            const agentResult = (event as any).result as AgentResult;
            resolveText(agentResult.toString());
            resolveFinish(agentResult.stopReason || 'end_turn');
            resolveUsage(accUsage);
            continue;
          }

          const mapped = mapStrandsStreamEvent(event);
          if (mapped) {
            // Accumulate usage from metadata events
            if (mapped.type === 'usage') {
              observedUsage = true;
              accUsage.promptTokens += (mapped as any).promptTokens || 0;
              accUsage.completionTokens +=
                (mapped as any).completionTokens || 0;
              accUsage.totalTokens =
                accUsage.promptTokens + accUsage.completionTokens;
              self._lastStreamUsage = {
                promptTokens: accUsage.promptTokens,
                completionTokens: accUsage.completionTokens,
              };
            }
            // Emit synthetic text-start before first text-delta
            if (mapped.type === 'text-delta' && !emittedTextStart) {
              yield { type: 'text-start', id: '0' };
              emittedTextStart = true;
            }
            if (mapped.type === 'text-delta') fullText += mapped.text || '';
            yield mapped;
          }
        }

        // Emit synthetic boundary events
        if (emittedTextStart) yield { type: 'text-end', id: '0' };
        yield { type: 'finish-step', id: '0' };

        resolveText(fullText);
        resolveFinish('end_turn');
        resolveUsage(accUsage);
      } catch (error) {
        resolveText(fullText);
        resolveFinish('error');
        resolveUsage(observedUsage ? accUsage : undefined);
        throw error;
      }
    }

    return {
      fullStream: streamGenerator(),
      text: textPromise,
      usage: usagePromise,
      finishReason: finishPromise,
    };
  }

  async generateObject(
    prompt: string,
    _options?: any,
  ): Promise<IGenerateResult> {
    // Use structuredOutputSchema if provided for native structured output
    const schema = _options?.structuredOutputSchema;
    if (schema) {
      const tempAgent = new StrandsAgent({
        model: this.strandsAgent.model,
        systemPrompt: (this.strandsAgent as any).systemPrompt,
        tools: [],
        structuredOutputSchema: schema,
      });
      const result = await tempAgent.invoke(prompt);
      const text = result.toString();
      return {
        object: result.structuredOutput ?? JSON.parse(text),
        text,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    }

    // Fallback: invoke and parse JSON from response
    const result = await this.strandsAgent.invoke(prompt);
    const text = result.toString();
    let object: any;
    try {
      const cleaned = text
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
      object = JSON.parse(cleaned);
    } catch (e) {
      console.debug('Failed to parse JSON from agent response:', e);
      object = { raw: text };
    }
    return {
      object,
      text,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }

  getMemory(): IMemory | null {
    return this.memory;
  }
}

// ── Strands Framework Adapter ──────────────────────────

export class StrandsFramework {
  private mcpClients = new Map<string, McpClient>();
  /** Track which MCP clients belong to which agent slug */
  private agentMcpClients = new Map<string, string[]>();

  async createAgent(
    slug: string,
    spec: AgentSpec,
    config: AgentCreationConfig,
    opts: CreateAgentOptions,
  ): Promise<AgentBundle> {
    const { model, resolvedModel } = await this.buildManagedModel(spec, config);
    let tools = await this.loadTools(slug, spec, opts);
    tools = opts.guardTools?.(tools) ?? tools;

    // Calculate fixed token counts
    const systemPromptTokens = Math.ceil((spec.prompt?.length || 0) / 4);
    const toolsJson = JSON.stringify(
      tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    );
    const mcpServerTokens = Math.ceil(toolsJson.length / 4);

    // Shared denial record (toolUseId -> reason) — BeforeToolCallEvent
    // records denials, FunctionTool wrappers surface them as tool errors.
    const makeWrapper = (
      history?: Message[],
      companion?: NativeMemoryHistoryCompanion,
      ownedInvocation?: InvocationContext,
      isHistoryCurrent?: () => Promise<boolean>,
    ): StrandsAgentWrapper => {
      const deniedToolCalls = new Map<string, ToolCallDenial>();

      const resolvedPrompt =
        typeof opts.processedPrompt === 'function'
          ? opts.processedPrompt()
          : opts.processedPrompt;
      const strandsAgent = new StrandsAgent({
        model,
        messages: history,
        systemPrompt: resolvedPrompt,
        tools: createStrandsFunctionTools(tools, deniedToolCalls),
      });

      const invocationCtx: InvocationContext = ownedInvocation ?? {
        agentSlug: slug,
      };

      // Wrap in IAgent — pass memory adapter so conversations persist
      const wrapper = new StrandsAgentWrapper(
        strandsAgent,
        slug,
        slug,
        model,
        opts.memoryAdapter as unknown as IMemory,
        invocationCtx,
        tools,
        {
          agentKey: slug,
          adapter: opts.memoryAdapter,
          companion,
          isHistoryCurrent,
          fork:
            history === undefined
              ? (messages, owner, invocation, current) =>
                  makeWrapper(messages, owner, invocation, current)
              : undefined,
        },
      );
      if (history)
        bindStrandsNativeHistory(strandsAgent, strandsAgent.messages);
      wireStrandsAgentHooks({
        strandsAgent,
        hooks: conformAgentHooks('strands', config.hooks),
        deniedToolCalls,
        invocationCtx,
        memoryAdapter: opts.memoryAdapter as unknown as IMemory,
        logger: opts.logger,
        resolvedModel,
        getLastStreamUsage: () => wrapper._lastStreamUsage,
        findMCPToolProvenance: (runtimeName) =>
          tools
            .filter((tool) => tool.name === runtimeName)
            .map(getLoadedMCPToolProvenance)
            .find((provenance) => provenance !== undefined),
      });

      return wrapper;
    };
    const wrapper = makeWrapper();

    return {
      agent: wrapper,
      tools,
      memoryAdapter: opts.memoryAdapter,
      fixedTokens: { systemPromptTokens, mcpServerTokens },
    };
  }

  async loadTools(
    slug: string,
    spec: AgentSpec,
    opts: Pick<
      CreateAgentOptions,
      | 'configLoader'
      | 'mcpConfigs'
      | 'mcpCustody'
      | 'integrationSecretResolver'
      | 'mcpToolProvenanceGeneration'
      | 'mcpConnectionStatus'
      | 'integrationMetadata'
      | 'toolNameMapping'
      | 'toolNameReverseMapping'
      | 'logger'
      | 'serverPort'
    >,
  ): Promise<ITool[]> {
    const loaded = await loadStrandsTools({
      slug,
      spec,
      opts,
      state: {
        mcpClients: this.mcpClients,
        agentMcpClients: this.agentMcpClients,
      },
    });
    return [...loaded, createNativeOutputDeclarationTool() as ITool];
  }

  async destroyAgent(slug: string): Promise<void> {
    await destroyStrandsAgentTools(slug, {
      mcpClients: this.mcpClients,
      agentMcpClients: this.agentMcpClients,
    });
  }

  async createModel(
    spec: AgentSpec,
    config: AgentCreationConfig,
  ): Promise<any> {
    return (await this.buildManagedModel(spec, config)).model;
  }

  async createTempAgent(opts: {
    name: string;
    agentId?: string;
    instructions: string | (() => string);
    model: any;
    tools?: ITool[];
    maxSteps?: number;
    memoryAdapter?: StorageAdapter;
    hooks?: IAgentHooks;
  }): Promise<IAgent> {
    const resolved =
      typeof opts.instructions === 'function'
        ? opts.instructions()
        : opts.instructions;
    const makeWrapper = (
      history?: Message[],
      companion?: NativeMemoryHistoryCompanion,
      ownedInvocation?: InvocationContext,
      isHistoryCurrent?: () => Promise<boolean>,
    ): StrandsAgentWrapper => {
      const deniedToolCalls = new Map<string, ToolCallDenial>();
      const agent = new StrandsAgent({
        model: opts.model,
        messages: history,
        systemPrompt: resolved,
        tools: createStrandsFunctionTools(opts.tools || [], deniedToolCalls),
      });
      // Agent-scoped BASE identity shared by the gate and the wrapper
      // (mirrors createAgent) — agentSlug only, never mutated. Per-request
      // identity (conversationId/userId/delegation) travels per invocation:
      // the wrapper binds a fresh trusted context to each stream's
      // `invocationState` object in a module-private WeakMap, and the gate
      // resolves THIS invocation's context from the event's state-object
      // identity, falling back to this base. That is what lets a
      // conversation-scoped approval requester be found for exactly the
      // invocation that owns it — even with interleaved streams — while
      // giving tool implementations (which may write to the bag freely)
      // nothing to spoof.
      const invocationCtx: InvocationContext = ownedInvocation ?? {
        agentSlug: opts.agentId
          ? runtimeAgentKey(publicAgentIdFromRuntimeKey(opts.agentId))
          : opts.name,
      };
      // archive#1834: temp agents used to get NO tool gate at all — the
      // default agent (and every scheduler//invoke/CLI call riding it)
      // executed tools without ever evaluating beforeToolCall. Only the gate
      // is wired here (not message-sync/usage): temp-agent persistence is
      // owned by StrandsAgentWrapper below.
      wireStrandsToolGate({
        strandsAgent: agent,
        hooks: conformAgentHooks('strands', opts.hooks),
        deniedToolCalls,
        invocationCtx,
      });
      // archive#914: `createAgent` above passes the adapter into this slot "so
      // conversations persist"; passing null here gave temp agents no
      // conversation memory at all, the same gap the VoltAgent path had.
      const wrapper = new StrandsAgentWrapper(
        agent,
        opts.name,
        opts.name,
        opts.model,
        (opts.memoryAdapter as unknown as IMemory) ?? null,
        invocationCtx,
        opts.tools,
        {
          agentKey: opts.agentId,
          adapter: opts.memoryAdapter,
          companion,
          isHistoryCurrent,
          fork:
            history === undefined
              ? (messages, owner, invocation, current) =>
                  makeWrapper(messages, owner, invocation, current)
              : undefined,
        },
      );
      if (history && opts.memoryAdapter) {
        bindStrandsNativeHistory(agent, agent.messages);
        agent.addHook(AfterInvocationEvent, async (event) => {
          const invocation = resolveStrandsInvocationContext(
            event.invocationState,
            invocationCtx,
          );
          await syncStrandsMessagesToMemory({
            agent,
            agentMessages: agent.messages,
            invocation,
            memoryAdapter: opts.memoryAdapter!,
            logger: createLogger({ name: 'strands-native-memory' }),
            resolvedModel:
              typeof opts.model?.modelId === 'string' ? opts.model.modelId : '',
          });
        });
      }
      return wrapper;
    };
    return makeWrapper();
  }

  async shutdown(): Promise<void> {
    for (const [, client] of this.mcpClients) {
      await client.disconnect().catch(() => {});
    }
    this.mcpClients.clear();
  }

  private async buildManagedModel(
    spec: AgentSpec,
    config: AgentCreationConfig,
  ): Promise<{ model: any; resolvedModel: string }> {
    const binding = await resolveManagedModelBinding(spec, {
      appConfig: config.appConfig,
      listProviderConnections: config.listProviderConnections,
      modelCatalog: config.modelCatalog,
    });

    const dispatchModel = await createConfiguredDispatchModel(
      spec,
      config,
      binding,
    );

    return {
      model: dispatchModel
        ? createStrandsAiSdkModel(dispatchModel, {
            spec,
            appConfig: config.appConfig,
          })
        : createStrandsManagedModel({
            providerConnection: binding.providerConnection,
            modelId: binding.modelId,
            spec,
            appConfig: config.appConfig,
          }),
      resolvedModel: binding.modelId,
    };
  }
}
