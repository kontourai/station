import {
  AfterInvocationEvent,
  AfterToolCallEvent,
  BeforeToolCallEvent,
  Agent as StrandsAgent,
} from '@strands-agents/sdk';
import { stationDenial } from '../agents/denial-message.js';
import type {
  IAgentHooks,
  IMemory,
  InvocationContext,
  TokenUsage,
  ToolCallDenial,
} from '../types.js';
import { syncStrandsMessagesToMemory } from './strands-message-sync.js';

/**
 * Trusted per-invocation contexts, keyed by the IDENTITY of the strands
 * SDK's per-invocation `invocationState` object (archive#1834 rounds 3-4).
 *
 * The wrapper binds a fresh context per stream/invoke call, and every hook
 * event (BeforeToolCall/AfterToolCall/AfterInvocation) carries the same
 * state object back — the only channel that stays correct when two streams
 * on the same agent interleave. The context deliberately does NOT live
 * inside the bag itself: `invocationState` is the SDK's tool-writable
 * scratch space ("Mutable — read and write freely" for hooks AND tools), so
 * an in-bag key would let a tool implementation replace the context and
 * change a sibling tool's approval identity or redirect memory sync to
 * another conversation/user. A module-private WeakMap keyed on the bag's
 * object identity gives tools nothing to spoof — planting a
 * look-alike key in the bag is simply never read.
 */
const trustedInvocationContexts = new WeakMap<object, InvocationContext>();

/** Bind the trusted context for one invocation's `invocationState` object. */
export function bindStrandsInvocationContext(
  invocationState: object,
  ctx: InvocationContext,
): void {
  trustedInvocationContexts.set(invocationState, ctx);
}

/**
 * Resolve the CURRENT invocation's trusted context from a hook event's
 * `invocationState` object identity, falling back to the agent-scoped base
 * identity (agentSlug only — never per-request fields) when the object was
 * never bound. Anything a tool wrote INTO the bag is ignored by design.
 */
export function resolveStrandsInvocationContext(
  invocationState: Record<string, unknown> | undefined,
  baseCtx: InvocationContext,
): InvocationContext {
  if (invocationState) {
    const ctx = trustedInvocationContexts.get(invocationState);
    if (ctx) return ctx;
  }
  return baseCtx;
}

/**
 * Wire ONLY the beforeToolCall gate onto a Strands agent (archive#1834).
 *
 * Split out of `wireStrandsAgentHooks` so temp agents (default agent,
 * /invoke, CLI) get the tool gate without the message-sync/usage wiring —
 * their persistence is owned by `StrandsAgentWrapper`.
 *
 * Denials are recorded as toolUseId -> the structured `ToolCallDenial` (not
 * just its reason string, archive#3091) so a downstream consumer can tell a
 * policy-authored denial apart from a human's own decline. The FunctionTool
 * wrappers built by `createStrandsFunctionTools` look the id up and surface
 * the reason as a real tool ERROR result.
 */
export function wireStrandsToolGate(options: {
  strandsAgent: StrandsAgent;
  hooks?: IAgentHooks;
  deniedToolCalls: Map<string, ToolCallDenial>;
  invocationCtx: InvocationContext;
}): void {
  const { strandsAgent, hooks, deniedToolCalls, invocationCtx } = options;
  if (!hooks?.beforeToolCall) return;
  strandsAgent.addHook(BeforeToolCallEvent, async (event) => {
    // Resolve THIS invocation's context from the event's own state — the
    // fallback base carries agent identity only, never another stream's
    // conversation/user/delegation (archive#1834 round 3).
    const invocation = resolveStrandsInvocationContext(
      (event as { invocationState?: Record<string, unknown> }).invocationState,
      invocationCtx,
    );
    const approved = await hooks.beforeToolCall!(
      {
        toolName: event.toolUse.name,
        toolCallId: event.toolUse.toolUseId,
        toolArgs: event.toolUse.input,
      },
      invocation,
    );
    // Any non-`true` result is a denial (archive#1834): a ToolCallDenial
    // object is truthy, so a bare `!approved` would execute denied tools.
    if (approved !== true) {
      deniedToolCalls.set(
        event.toolUse.toolUseId,
        typeof approved === 'object' && approved !== null && approved.reason
          ? approved
          : stationDenial({
              toolName: event.toolUse.name,
              predicate: "was denied by Station's tool gate.",
            }),
      );
    }
  });
}

export function wireStrandsAgentHooks(options: {
  strandsAgent: StrandsAgent;
  hooks?: IAgentHooks;
  deniedToolCalls: Map<string, ToolCallDenial>;
  invocationCtx: InvocationContext;
  memoryAdapter: IMemory;
  logger: any;
  resolvedModel: string;
  getLastStreamUsage: () => TokenUsage | null | undefined;
}): void {
  const {
    strandsAgent,
    hooks,
    deniedToolCalls,
    invocationCtx,
    memoryAdapter,
    logger,
    resolvedModel,
    getLastStreamUsage,
  } = options;

  let toolCallCount = 0;

  wireStrandsToolGate({ strandsAgent, hooks, deniedToolCalls, invocationCtx });

  if (hooks?.afterToolCall) {
    strandsAgent.addHook(AfterToolCallEvent, (event) => {
      toolCallCount++;
      hooks.afterToolCall!(
        {
          toolName: event.toolUse.name,
          toolCallId: event.toolUse.toolUseId,
          toolArgs: event.toolUse.input,
        },
        {
          output: event.result?.content,
          error: event.error,
        },
        resolveStrandsInvocationContext(
          (event as { invocationState?: Record<string, unknown> })
            .invocationState,
          invocationCtx,
        ),
      );
    });
  }

  strandsAgent.addHook(AfterInvocationEvent, async (event) => {
    const resolved = resolveStrandsInvocationContext(
      (event as { invocationState?: Record<string, unknown> }).invocationState,
      invocationCtx,
    );
    logger.info('[Strands] AfterInvocationEvent fired', {
      hasMessages: !!(event as any).agent?.messages?.length,
      messageCount: (event as any).agent?.messages?.length || 0,
      lastStreamUsage: getLastStreamUsage(),
      conversationId: resolved.conversationId,
      userId: resolved.userId,
      agentSlug: resolved.agentSlug,
    });

    const agentMessages = (event as any).agent?.messages || [];
    const ctx: InvocationContext = { ...resolved };

    await syncStrandsMessagesToMemory({
      agentMessages,
      invocation: ctx,
      logger,
      memoryAdapter,
      resolvedModel,
    });

    if (hooks?.afterInvocation) {
      await hooks.afterInvocation({
        invocation: ctx,
        usage: getLastStreamUsage() || (event as any).metrics?.usage,
        toolCallCount,
      });
    }

    toolCallCount = 0;
  });
}
