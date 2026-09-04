/**
 * VoltAgent adapter — confines all @voltagent/* and @ai-sdk/* imports to this file.
 *
 * Implements IAgentFramework so the runtime and routes only depend on the
 * framework-agnostic interfaces in runtime/types.ts.
 */

import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type {
  MCPConnection,
  MCPLocalConnectionCustody,
} from '@kontourai/station-shared/mcp';
import {
  Agent,
  type AgentHooks,
  createHooks,
  createTool,
  Memory,
  type StorageAdapter,
  type Tool,
  ToolDeniedError,
} from '@voltagent/core';
import { jsonSchema } from 'ai';
import type { FileMemoryAdapter } from '../../adapters/file/memory-adapter.js';
import { createPromptOnlyMemoryView } from '../../adapters/file/memory-adapter-prompt-view.js';
import { resolveMaxSteps } from '../../constants.js';
import type { ConfigLoader } from '../../domain/config-loader.js';
import type { ApprovalRegistry } from '../../services/approvals/approval-registry.js';
import type { MCPToolProvenanceGeneration } from '../../services/orchestration/mcp-tool-provenance.js';
import type { IntegrationSecretResolver } from '../../services/secrets/secret-binding-administration.js';
import { stationDenial } from '../agents/denial-message.js';
import {
  currentScheduledPrincipal,
  currentScheduledRunId,
} from '../agents/scheduled-principal-context.js';
import { currentAuthorizedTurnCorrelation } from '../conversation/authorized-turn-correlation.js';
import { createConfiguredDispatchModel } from '../conversation/dispatch-model-policy.js';
import * as MCPManager from '../mcp/mcp-manager.js';
import {
  createNativeOutputDeclarationTool,
  invalidNativeOutputDeclarationInput,
  NATIVE_OUTPUT_DECLARATION_TOOL,
  parseNativeOutputDeclarationInput,
  publicNativeOutputDeclarationResult,
} from '../native-output-declaration.js';
import { runWithCurrentNativeOutputCall } from '../native-output-turn-grant.js';
import { resolveManagedModelBinding } from '../plugins/runtime-provider-resolution.js';
import {
  copyLoadedMCPToolProvenance,
  getLoadedMCPToolProvenance,
} from '../tools/mcp-tool-names.js';
import type {
  AgentCreationConfig,
  IAgent,
  IAgentHooks,
  IGenerateResult,
  IMemory,
  InvocationContext,
  IStreamChunk,
  IStreamResult,
  ITool,
  ToolCallContext,
  ToolCallDenial,
} from '../types.js';
import {
  GENERIC_TOOL_FAILURE_MESSAGE,
  TOOL_DENIED_FINISH_REASON,
} from '../types.js';
import { conformAgentHooks } from './conduit-framework-adapter.js';
import { createVoltAgentManagedModel } from './framework-model-factory.js';

// ── Result bundle from agent creation ──────────────────

export interface AgentBundle {
  agent: IAgent;
  tools: ITool[];
  memoryAdapter: FileMemoryAdapter;
  fixedTokens: { systemPromptTokens: number; mcpServerTokens: number };
}

// ── Extended creation options (runtime passes these in) ─

export interface CreateAgentOptions {
  processedPrompt: string | (() => string);
  memoryAdapter: FileMemoryAdapter;
  configLoader: ConfigLoader;
  mcpConfigs: Map<string, MCPConnection>;
  mcpCustody: MCPLocalConnectionCustody;
  mcpConnectionStatus: Map<string, { connected: boolean; error?: string }>;
  integrationMetadata: Map<
    string,
    { type: string; transport?: string; toolCount?: number }
  >;
  toolNameMapping: Map<
    string,
    {
      original: string;
      normalized: string;
      server: string | null;
      tool: string;
    }
  >;
  toolNameReverseMapping: Map<string, string>;
  mcpToolProvenanceGeneration?: MCPToolProvenanceGeneration;
  approvalRegistry: ApprovalRegistry;
  agentFixedTokens: Map<
    string,
    { systemPromptTokens: number; mcpServerTokens: number }
  >;
  memoryAdapters: Map<string, FileMemoryAdapter>;
  logger: any;
  /** Actually-bound Station listener port used in OAuth redirect registration. */
  serverPort: number;
  guardTools?: (tools: ITool[]) => ITool[];
  /** Runtime-composed only; never exposed through ToolDef/configuration. */
  integrationSecretResolver?: IntegrationSecretResolver;
}

// ── IAgent wrapper around VoltAgent Agent ──────────────

/**
 * archive#3091/#3113: lift a VoltAgent tool failure's real outcome onto the
 * `IStreamChunk` the rest of Station's pipeline (MetadataHandler, SSE, the
 * live orchestration path) reads — for BOTH a policy denial and an ordinary
 * tool error.
 *
 * For an ORDINARY tool error (the tool's own `execute` throws something that
 * is not a `ToolDeniedError`), `@voltagent/core`'s internal `handleToolError`
 * catches it and RESOLVES the tool call normally with
 * `buildToolErrorResult(error, toolCallId, toolName)` as the output —
 * `{ error: true, name, message, stack, toolCallId, toolName, ...<every
 * other own-enumerable property of the thrown error> }` (verified by
 * reading the installed package's compiled source, not guessed — see the
 * tripwire test in voltagent-adapter.test.ts, which exercises this REAL
 * shape end to end through a real Agent + a real thrown error, and reddens
 * if a `@voltagent/core` upgrade changes it). That own-property copy is why
 * `onToolStart` below sets `.policyDenied` directly on the thrown
 * `ToolDeniedError` instance for the policy-denial case: it survives into
 * this exact shape, arriving here as a completely ordinary `type:
 * 'tool-result'` chunk whose `output` looks like success unless this
 * function lifts the real outcome back out.
 *
 * DISCLOSED GAP (found investigating archive#3171, not yet filed as its own
 * issue): for a GENUINE `ToolDeniedError` specifically — thrown from
 * `onToolStart` below OR from a tool's own `execute` — `handleToolError`
 * takes a DIFFERENT branch first: `if (isToolDeniedError(errorValue))
 * oc.abortController.abort(errorValue)`. Verified empirically (a real Agent,
 * a real thrown `ToolDeniedError`, consumed via `agent.streamText()`):
 * `result.fullStream` stops emitting chunks right after `'tool-call'` — no
 * `'tool-result'` chunk is ever yielded for that call — while
 * `result.finishReason` and `result.text` both REJECT with the denial's
 * message. This function's `policyDenied` branch below is therefore
 * unreached for a real, live policy denial delivered through
 * `VoltAgentWrapper.streamText()`; it only fires today for a hand-shaped
 * `'tool-result'` chunk (which is what this file's own unit tests, and
 * apparently nothing in the live request path, actually construct). Fixing
 * the propagation gap (deciding whether to prevent the abort, or synthesize
 * a `'tool-result'` chunk before it, or surface the rejection to the caller
 * some other way) is a separate, larger change than archive#3171's marker-
 * authenticity hardening and is left here as a found-but-not-fixed risk.
 *
 * Before archive#3091 nothing recognized this shape at all: MetadataHandler's
 * outcome derivation and the client's `ToolCallDisplay` both read only the
 * chunk's OWN top-level `error`/`state`, so ANY VoltAgent tool failure —
 * policy-denied or ordinary — rendered with `result` set and no `error`: a
 * false SUCCESS checkmark. archive#3091 fixed only the policy-denied case
 * (deliberately, as the smallest defensible change — generalizing to
 * ordinary failures needed its own redaction decision). This function now
 * covers both: a denial whose reason `denial-message.ts` composed carries its
 * real reason (`output.message`), and independently the `policyDenied` badge
 * marker when the policy evaluator produced it (archive#3210 separated those
 * two questions); everything else — including an ordinary failure — carries
 * only `GENERIC_TOOL_FAILURE_MESSAGE`, never
 * `output.message`, which is untrusted for that branch. `output` itself is
 * left untouched in both branches (matching the prior tested contract for
 * the policy-denial case).
 *
 * Where that distinction actually lands, stated precisely because the two
 * paths differ (archive#3210 review, corrected here):
 *
 * - On the canonical orchestration relay, `mapStationAgentStreamEvent` drops
 *   `output` whenever `error` is set, so the redacted-vs-real decision made
 *   here is the whole of what a client sees.
 * - On the `/api/agents/:slug/chat` SSE path — which is what the chat UI and
 *   every test in `chat-primary-stream.denial.test.ts` drive —
 *   `writeSSEChunk` serialises the WHOLE chunk, so the raw `output` (remote
 *   `message`, and a `stack` carrying absolute host paths) is delivered
 *   alongside the redacted `error` and rendered under "Response:" while
 *   "Error:" shows the redaction. The decision made here is therefore not the
 *   only thing that reaches the chat UI on that path, and saying so would be
 *   a claim this code does not support.
 *
 * That leak predates archive#3210 and is neither widened nor narrowed by it;
 * it is filed as **archive#3263**, whose fix is to project `output` here the
 * way the Strands adapter already constructs a fresh chunk, with a test that
 * asserts the whole stringified frame rather than a `toMatchObject` subset.
 */
export function normalizeVoltAgentToolErrors(
  source: AsyncIterable<IStreamChunk>,
): AsyncIterable<IStreamChunk> {
  return (async function* () {
    for await (const chunk of source) {
      const output = (chunk as { output?: unknown })?.output as
        | {
            error?: unknown;
            policyDenied?: unknown;
            stationComposedReason?: unknown;
            message?: unknown;
          }
        | undefined;
      if (chunk?.type === 'tool-result' && output?.error === true) {
        // Reviewed suggestion to also require `output.name === 'ToolDeniedError'`
        // as forgery-proofing was tried and REVERTED: it would never match.
        // `__name(this, 'ToolDeniedError')` in the class's `static {}` block is
        // esbuild preserving the CONSTRUCTOR's name; instances get `.name` from
        // `ClientHTTPError`'s constructor, which assigns `this.name = name` from
        // its FIRST argument — and `ToolDeniedError` passes `toolName` there.
        // An instance therefore reports the tool's name. Verified empirically:
        // `new ToolDeniedError({toolName:'t',...}).name === 't'`. Adding that
        // clause would have routed every policy denial to the generic message.
        //
        // archive#3171: by the time `output` reaches this function,
        // `.policyDenied` is no longer a bare convention — the `onToolError`
        // hook above already strips it from anything that was not a genuine
        // `ToolDeniedError` instance, before `buildToolErrorResult` ever
        // copies it onto `output`. So this check trusts CONSTRUCTED
        // evidence, not a self-reported flag; it does not need to re-verify
        // authenticity itself.
        //
        // archive#3210: the two markers decide two DIFFERENT things and are
        // read independently. `stationComposedReason` says the text was
        // composed by `denial-message.ts` (Station prose, sanitized tool
        // name, any foreign fragment bounded/quoted/attributed) and is the
        // only thing that licenses carrying it verbatim; `policyDenied` says
        // the policy evaluator produced the denial and drives archive#3091's badge.
        // A denial marked policy-denied but NOT composed here is still
        // badged and still redacted — fail-closed on authorship.
        const badge =
          output.policyDenied === true ? { policyDenied: true } : {};
        if (
          output.stationComposedReason === true &&
          typeof output.message === 'string'
        ) {
          yield { ...chunk, error: output.message, ...badge };
          continue;
        }
        yield { ...chunk, error: GENERIC_TOOL_FAILURE_MESSAGE, ...badge };
        continue;
      }
      yield chunk;
    }
  })();
}

/**
 * archive#3179: the per-operation channel a REAL observed tool denial
 * travels on, from the lifecycle hook that saw it to the stream that
 * caused it.
 *
 * `normalizeVoltAgentToolErrors` above translates a tool-result chunk that
 * `@voltagent/core` actually emitted. For a DENIAL it never gets one:
 * `handleToolError` awaits `hooks.onToolEnd` and then calls
 * `oc.abortController.abort(errorValue)` for a `ToolDeniedError`, which
 * tears the operation down before `buildToolErrorResult`'s return value can
 * reach `fullStream`. Reproduced end to end through the real package: the
 * `/chat` SSE response for a denied tool carried `conversation-started`,
 * `start`, `[DONE]` — no `tool-call`, no `tool-result`, no `finish`, no
 * `error` — while the turn was reported as `completed`.
 *
 * The hook call that precedes the abort is therefore the only place a
 * denial is observable, and it observes the genuine error object, not a
 * reconstruction. A symbol key keeps this off `Object.keys(oc.context)`,
 * which `@voltagent/core` serializes onto its root span.
 */
const TOOL_DENIAL_OBSERVATIONS = Symbol.for(
  'station.voltagent.tool-denial-observations',
);

/** One denial, exactly as the lifecycle hook observed it. */
export interface ObservedToolDenial {
  toolName: string;
  toolCallId: string;
  /**
   * The real `ToolDeniedError`'s own message.
   *
   * archive#3210: whether this reaches the user verbatim is decided by
   * `stationComposedReason`, NOT by `policyDenied`. `policyDenied` derives
   * from one thing only — the denial was produced by the pre-tool policy
   * evaluator — which answers "which code produced this?", not "who wrote
   * this text?". Two evaluator sites embed genuinely foreign prose (the
   * approval guardian's LLM-authored verdict, and the config-protection
   * policy's external hook output), so the two questions came apart:
   * `denial-message.ts` is what bounds and attributes that prose, and its
   * marker is what licenses carrying the result.
   */
  reason: string;
  /** True only when the thrown error carried archive#3091's own-property marker. */
  policyDenied: boolean;
  /**
   * True only when the thrown error carried archive#3210's authorship
   * marker — i.e. `denial-message.ts` composed `reason`.
   */
  stationComposedReason: boolean;
}

/**
 * Recognize a genuine denial in what `onToolEnd` was handed.
 *
 * The hook receives `@voltagent/core`'s `VoltAgentError` wrapper, whose
 * `originalError` is the exact object `onToolStart` threw. Both positions
 * are accepted, but an `instanceof ToolDeniedError` check is required:
 * a duck-typed shape test would let an ORDINARY tool failure — whose
 * message may be remote-controlled (archive#3113) — mint a denial and carry
 * its text. Same single-copy assumption `@voltagent/core`'s own
 * `isToolDeniedError` makes.
 */
function observedToolDenial(
  error: unknown,
  toolName: string,
  toolCallId: string,
): ObservedToolDenial | undefined {
  const original = (error as { originalError?: unknown } | undefined)
    ?.originalError;
  const denied = [error, original].find(
    (
      candidate,
    ): candidate is ToolDeniedError & {
      policyDenied?: true;
      stationComposedReason?: true;
    } => candidate instanceof ToolDeniedError,
  );
  if (!denied) return undefined;
  return {
    toolName,
    toolCallId,
    reason: denied.message,
    policyDenied: denied.policyDenied === true,
    stationComposedReason: denied.stationComposedReason === true,
  };
}

/**
 * The operation `context` map handed to `Agent.streamText` for one call,
 * carrying this call's denial sink. `@voltagent/core` uses a supplied `Map`
 * by identity and merges the agent's own context into it, so a copy (rather
 * than the caller's own map) keeps that merge out of the caller's object.
 *
 * Exported for the archive#3211 gap-3 test: the caller's own entries must
 * survive the copy. `operationContext` is `{ ...restOptions, elicitation }`
 * and `restOptions` comes from the chat schema's `.passthrough()`'d
 * client-supplied `options`, so a client CAN put `options.context` on the
 * wire — dropping the copy would silently discard it, and nothing else in
 * the tree reads it back to notice.
 */
export function contextWithToolDenialObservations(
  callerContext: unknown,
  sink: ObservedToolDenial[],
): Map<string | symbol, unknown> {
  const context = new Map<string | symbol, unknown>();
  if (callerContext instanceof Map) {
    for (const [key, value] of callerContext) context.set(key, value);
  } else if (callerContext && typeof callerContext === 'object') {
    for (const [key, value] of Object.entries(callerContext)) {
      context.set(key, value);
    }
  }
  context.set(TOOL_DENIAL_OBSERVATIONS, sink);
  return context;
}

/**
 * archive#3179: after the engine's own stream has ended, emit what the
 * engine could not — one tool-result per denial it observed but aborted
 * before reporting, and a `finish` naming the denial as the reason the turn
 * stopped.
 *
 * Nothing here is synthesized from a gap in the stream: `observed` is
 * appended to only by `onToolEnd`, only from a real `ToolDeniedError`
 * instance. A denial whose tool-call the engine DID resolve is skipped, so
 * a future `@voltagent/core` that stops aborting cannot produce two
 * results for one call. The redaction rule matches
 * `normalizeVoltAgentToolErrors` and the Strands adapter exactly — the real
 * reason rides only with archive#3210's `stationComposedReason` authorship
 * marker, everything else gets the one shared generic message, and the
 * `policyDenied` badge marker is carried independently of both.
 *
 * What is identical across engines is that REDACTION RULE, and the denial
 * text it selects. The frame is not: this adapter spreads `...chunk` (see
 * `normalizeVoltAgentToolErrors`) while `mapStrandsStreamEvent` builds a
 * fresh chunk, so on the `/chat` SSE path VoltAgent additionally ships the
 * raw `output` and Strands does not — the Strands suite asserts the canary is
 * absent from the whole stringified chunk, and no VoltAgent test makes that
 * assertion because it would fail. Tracked as archive#3263.
 */
export function appendObservedToolDenials(
  source: AsyncIterable<IStreamChunk>,
  observed: ObservedToolDenial[],
): AsyncIterable<IStreamChunk> {
  return (async function* () {
    const resolvedToolCallIds = new Set<string>();
    let engineReportedFinish = false;
    for await (const chunk of source) {
      if (chunk?.type === 'tool-result' && chunk.toolCallId) {
        resolvedToolCallIds.add(String(chunk.toolCallId));
      }
      if (chunk?.type === 'finish') engineReportedFinish = true;
      yield chunk;
    }
    let emittedDenial = false;
    for (const denial of observed) {
      if (resolvedToolCallIds.has(denial.toolCallId)) continue;
      emittedDenial = true;
      yield {
        type: 'tool-result',
        toolCallId: denial.toolCallId,
        toolName: denial.toolName,
        error: denial.stationComposedReason
          ? denial.reason
          : GENERIC_TOOL_FAILURE_MESSAGE,
        ...(denial.policyDenied ? { policyDenied: true } : {}),
      };
    }
    if (emittedDenial && !engineReportedFinish) {
      yield { type: 'finish', finishReason: TOOL_DENIED_FINISH_REASON };
    }
  })();
}

class VoltAgentWrapper implements IAgent {
  constructor(private inner: Agent) {}

  get id() {
    return this.inner.name;
  }
  get name() {
    return this.inner.name;
  }
  get model() {
    return this.inner.model;
  }

  /** VoltAgent compat — server-core routes call these on registered agents */
  getFullState() {
    return (this.inner as any).getFullState();
  }
  getTools() {
    return (this.inner as any).getTools?.() ?? [];
  }
  isTelemetryConfigured() {
    return (this.inner as any).isTelemetryConfigured?.() ?? false;
  }
  getToolsForApi() {
    return (this.inner as any).getToolsForApi?.() ?? this.getTools();
  }

  async generateText(prompt: string, options?: any): Promise<IGenerateResult> {
    const { signal, ...invokeOptions } = options ?? {};
    const result = await this.inner.generateText(prompt, {
      ...invokeOptions,
      ...(signal ? { abortSignal: signal } : {}),
    });
    return result as unknown as IGenerateResult;
  }

  async streamText(input: string, options?: any): Promise<IStreamResult> {
    // archive#3179: one sink per call, reachable from the lifecycle hooks
    // (which are per-AGENT and shared by concurrent turns) only through
    // this call's own operation context.
    const observedDenials: ObservedToolDenial[] = [];
    const result = await this.inner.streamText(input, {
      ...options,
      context: contextWithToolDenialObservations(
        options?.context,
        observedDenials,
      ),
    });
    return {
      fullStream: appendObservedToolDenials(
        normalizeVoltAgentToolErrors(
          result.fullStream as AsyncIterable<IStreamChunk>,
        ),
        observedDenials,
      ),
      text: Promise.resolve(result.text),
      usage: Promise.resolve(result.usage as any),
      finishReason: Promise.resolve(result.finishReason as any),
    };
  }

  async generateObject(
    prompt: string,
    options?: any,
  ): Promise<IGenerateResult> {
    return this.inner.generateObject(prompt, options);
  }

  getMemory(): IMemory | null {
    const mem = this.inner.getMemory();
    return mem as unknown as IMemory | null;
  }

  /** Access the underlying VoltAgent Agent (for framework-specific operations) */
  get raw(): Agent {
    return this.inner;
  }
}

// ── IAgentFramework implementation ─────────────────────

const nativeVoltExecuteWrappers = new WeakMap<
  object,
  { original: unknown; wrapped: unknown }
>();

/**
 * VoltAgent-specific framework adapter.
 *
 * Does NOT formally implement IAgentFramework because VoltAgent needs
 * extra options (MCP maps, etc.) that are framework-specific. The runtime
 * wraps calls to this class and satisfies the interface contract.
 */
/**
 * Normalize a loaded tool into a real VoltAgent `Tool` before it reaches the
 * `Agent`. VoltAgent only forwards tools to the model when they register as
 * base tools — and `ToolManager` requires `tool.type === 'user-defined'`
 * (set only on `Tool` instances) AND calls `Tool` methods like `isClientSide()`
 * during request prep. Tools that already are VoltAgent/MCP tools (they carry a
 * `type`) pass through untouched; Station's hand-rolled builtin tools are plain
 * objects with a raw JSON-schema `parameters`, so they get wrapped via
 * `createTool` with the schema marked through AI SDK's `jsonSchema()` (VoltAgent
 * hands `parameters` straight to the model as `inputSchema`, which must be a
 * zod/`jsonSchema()` schema, not a bare object). Without this, builtin tools
 * (e.g. `render_component`) were silently dropped from the model request.
 */
export function toVoltAgentTool(tool: ITool): Tool<any> {
  const t = tool as ITool & { type?: string };
  if (t.type === 'user-defined' || t.type === 'provider') {
    // Provider/MCP tools are already real VoltAgent Tools and must retain
    // their instance identity and metadata. Their actual execute seam still
    // crosses Station, however, so decorate that seam in place rather than
    // returning an unobserved native callback.
    const original = t.execute;
    if (typeof original === 'function') {
      const existing = nativeVoltExecuteWrappers.get(t);
      if (!existing || existing.wrapped !== original) {
        const wrapped = async (
          input: unknown,
          options: { toolContext?: { callId?: unknown } },
        ) => {
          if (t.name === NATIVE_OUTPUT_DECLARATION_TOOL) {
            const declarationInput = parseNativeOutputDeclarationInput(input);
            if (!declarationInput) return invalidNativeOutputDeclarationInput();
            const result = await runWithCurrentNativeOutputCall(
              options?.toolContext?.callId,
              () => Reflect.apply(original, t, [declarationInput, options]),
            );
            return publicNativeOutputDeclarationResult(
              declarationInput,
              result,
            );
          }
          const result = await runWithCurrentNativeOutputCall(
            options?.toolContext?.callId,
            () => Reflect.apply(original, t, [input, options]),
          );
          return result;
        };
        try {
          Object.defineProperty(t, 'execute', {
            ...Object.getOwnPropertyDescriptor(t, 'execute'),
            value: wrapped,
          });
          nativeVoltExecuteWrappers.set(t, { original, wrapped });
        } catch {
          // An immutable third-party Tool remains usable, but cannot become a
          // provenance source. No alternate id source may compensate.
        }
      }
    }
    return tool as unknown as Tool<any>;
  }
  // `createTool`'s *type* requires a zod schema, but the runtime `Tool`
  // constructor stores `parameters` verbatim and AI SDK accepts a `jsonSchema()`
  // schema as `inputSchema` — so cast past the zod-only signature.
  const parameters = jsonSchema(
    (tool.parameters as Record<string, unknown>) ?? {
      type: 'object',
      properties: {},
    },
  ) as never;
  const execute =
    typeof tool.execute === 'function'
      ? async (
          input: unknown,
          options: { toolContext?: { callId?: unknown } },
        ) => {
          // VoltAgent's execute options are the sole trusted source here.
          // No argument, MCP, or SSE fallback may mint native provenance.
          if (tool.name === NATIVE_OUTPUT_DECLARATION_TOOL) {
            const declarationInput = parseNativeOutputDeclarationInput(input);
            if (!declarationInput) return invalidNativeOutputDeclarationInput();
            const result = await runWithCurrentNativeOutputCall(
              options?.toolContext?.callId,
              () => tool.execute!(declarationInput, options),
            );
            return publicNativeOutputDeclarationResult(
              declarationInput,
              result,
            );
          }
          const result = await runWithCurrentNativeOutputCall(
            options?.toolContext?.callId,
            () => tool.execute!(input, options),
          );
          return result;
        }
      : undefined;
  return copyLoadedMCPToolProvenance(
    tool,
    createTool({
      id: tool.id,
      name: tool.name,
      description: tool.description ?? '',
      parameters,
      ...(execute ? { execute: execute as never } : {}),
    }) as unknown as Tool<any>,
  );
}

type PendingVoltAgentToolCall = {
  tool: ToolCallContext;
  invocation: InvocationContext;
};

function voltAgentInvocationContext(
  slug: string,
  context: {
    conversationId?: string;
    userId?: string;
    traceId?: string;
    delegation?: InvocationContext['delegation'];
  },
  options?: Record<string, unknown>,
): InvocationContext {
  const correlation = currentAuthorizedTurnCorrelation();
  const exactSession =
    correlation && correlation.sessionId === context.conversationId
      ? correlation
      : undefined;
  return {
    agentSlug: slug,
    conversationId: context.conversationId,
    ...(exactSession
      ? {
          sessionId: exactSession.sessionId,
          turnId: exactSession.turnId,
          principalId: exactSession.accountId,
        }
      : {}),
    userId: context.userId,
    traceId: currentScheduledRunId() ?? context.traceId,
    delegation: (options?.delegation ??
      context.delegation) as InvocationContext['delegation'],
    unattendedPrincipal: currentScheduledPrincipal(),
  };
}

/**
 * Adapt Station's framework-neutral hooks to VoltAgent's real lifecycle.
 * Tool arguments are available only at start, while the result/error is
 * available only at end, so retain the start record by VoltAgent call id until
 * the matching completion arrives.
 */
export function createVoltAgentLifecycleHooks(
  slug: string,
  sharedHooks?: IAgentHooks,
): AgentHooks {
  const pendingToolCalls = new WeakMap<
    object,
    Map<string, PendingVoltAgentToolCall>
  >();

  return createHooks({
    onToolStart: async ({ tool, context, args, options }) => {
      const currentCount =
        (context.context.get('toolCallCount') as number) || 0;
      context.context.set('toolCallCount', currentCount + 1);
      const toolCallId = options?.toolContext?.callId || '';
      const toolCall: ToolCallContext = {
        toolName: tool.name,
        toolCallId,
        toolArgs: args,
        ...(getLoadedMCPToolProvenance(tool)
          ? {
              mcp: Object.freeze({
                provenance: getLoadedMCPToolProvenance(tool)!,
                trustedArguments: args,
              }),
            }
          : {}),
      };
      const invocation = voltAgentInvocationContext(
        slug,
        context as typeof context & { traceId?: string },
        options,
      );
      // archive#1834: hook-absent (no beforeToolCall wired at all) keeps the
      // legacy allow path; an INVOKED hook allows only on literal `true` —
      // `undefined`, `false`, or any other value denies. A `ToolCallDenial`
      // carries the real reason — surface it instead of the old hardcoded
      // delegated-child wording, which mislabelled every other denial.
      if (sharedHooks?.beforeToolCall) {
        const approved = await sharedHooks.beforeToolCall(toolCall, invocation);
        if (approved !== true) {
          const denial: ToolCallDenial =
            typeof approved === 'object' && approved !== null && approved.reason
              ? (approved as ToolCallDenial)
              : stationDenial({
                  toolName: tool.name,
                  predicate: "was denied by Station's tool gate.",
                });
          const deniedError: ToolDeniedError & {
            policyDenied?: true;
            stationComposedReason?: true;
          } = new ToolDeniedError({
            toolName: tool.name,
            message: denial.reason,
            code: 'TOOL_FORBIDDEN',
            httpStatus: 403,
          });
          // archive#3091: own-property set BEFORE throwing — VoltAgent's
          // internal error handling copies every own-enumerable property of
          // a thrown error into the tool's resolved output (see
          // `normalizeVoltAgentToolErrors` above), which is how this
          // marker survives to become the UI's policy-denied badge.
          if (denial.policyDenied) deniedError.policyDenied = true;
          // archive#3210: the authorship marker rides the same own-property
          // channel, and is what decides verbatim vs. redacted downstream.
          if (denial.stationComposedReason) {
            deniedError.stationComposedReason = true;
          }
          throw deniedError;
        }
      }
      if (sharedHooks?.afterToolCall) {
        const invocationToolCalls =
          pendingToolCalls.get(context) ??
          new Map<string, PendingVoltAgentToolCall>();
        invocationToolCalls.set(toolCallId, {
          tool: toolCall,
          invocation,
        });
        pendingToolCalls.set(context, invocationToolCalls);
      }
    },
    // archive#3171: `output.policyDenied` on the flattened tool-result (see
    // `normalizeVoltAgentToolErrors` above) was a bare own-enumerable
    // property copied verbatim by the installed package's own
    // `buildToolErrorResult` — indistinguishable, at that point, from any
    // thrown value that merely sets the same property. `onToolError` runs
    // BEFORE that flattening, with the real thrown value's prototype chain
    // still intact (`originalError`), so `instanceof ToolDeniedError` is a
    // check the throwing party cannot satisfy by setting a property; it
    // requires actually constructing the real class (only done above, in
    // `onToolStart`, gated by pre-tool-policy.ts's `deny()`). For anything
    // that ISN'T a genuine `ToolDeniedError`, strip `.policyDenied` off the
    // error object in place — `originalError` is the exact object
    // `buildToolErrorResult` copies properties from immediately after this
    // hook returns, so this guarantees a forged marker never reaches the
    // flattened output. Verified empirically (voltagent-adapter.test.ts): a
    // hand-forged plain `Error` with `.policyDenied = true` set directly by
    // a tool's own `execute()` arrives here with `instanceof
    // ToolDeniedError === false` and gets scrubbed before flattening; a
    // genuine denial (constructed above) reports `true` and is left alone.
    //
    // Reviewed alternative — requiring `output.code === 'TOOL_FORBIDDEN'` on
    // the ALREADY-FLATTENED output instead — was considered and rejected:
    // `code` is set on `ToolDeniedError` the exact same way `policyDenied`
    // is (a plain instance property), so `buildToolErrorResult` copies it
    // just as unconditionally. A forged `{code:'TOOL_FORBIDDEN'}` on a plain
    // thrown object would pass that check exactly as trivially as a forged
    // `{policyDenied:true}` — it is not a stronger discriminator, just a
    // differently-named convention. Only a check against the ORIGINAL
    // error's prototype, before it is flattened into a plain object, is
    // actually unforgeable by property assignment.
    onToolError: async ({ originalError }) => {
      if (!(originalError instanceof ToolDeniedError)) {
        try {
          delete (originalError as { policyDenied?: unknown }).policyDenied;
        } catch {
          // `delete` throws in strict mode on a non-configurable property, and
          // a deliberately hostile tool can freeze its own error. Swallowing
          // is safe on the axis that matters: this branch has already
          // established the error is NOT a genuine ToolDeniedError, so the
          // marker is untrusted either way. Letting the TypeError escape would
          // reject the hook and convert a tool error into a turn-level
          // failure — a worse outcome than a marker we already distrust.
        }
      }
      return undefined;
    },
    onToolEnd: async ({ tool, context, output, error, options }) => {
      const toolCallId = options?.toolContext?.callId || '';
      // archive#3179: recorded BEFORE the `afterToolCall` short-circuit
      // below — a denial must stay observable whether or not the caller
      // wired that hook, and this is the last moment it is observable at
      // all: `@voltagent/core` aborts the operation immediately after this
      // call returns. `toolArgs` is genuinely lost on this path (the
      // `pendingToolCalls` record below is stored only AFTER `onToolStart`
      // returns, and a denial throws out of it), so the derived chunk
      // carries identity and outcome only — the arguments the user sees
      // come from the engine's own `tool-call` chunk, never from here.
      const denial = observedToolDenial(error, tool.name, toolCallId);
      if (denial) {
        const sink = context.context.get(TOOL_DENIAL_OBSERVATIONS);
        if (Array.isArray(sink)) sink.push(denial);
      }
      if (!sharedHooks?.afterToolCall) return;
      const invocationToolCalls = pendingToolCalls.get(context);
      const pending = invocationToolCalls?.get(toolCallId);
      invocationToolCalls?.delete(toolCallId);
      if (invocationToolCalls?.size === 0) {
        pendingToolCalls.delete(context);
      }
      sharedHooks.afterToolCall(
        pending?.tool ?? {
          toolName: tool.name,
          toolCallId,
          toolArgs: undefined,
        },
        {
          output,
          error,
          ...(pending?.tool.mcp
            ? { mcp: Object.freeze({ trustedContent: output }) }
            : {}),
        },
        pending?.invocation ??
          voltAgentInvocationContext(
            slug,
            context as typeof context & { traceId?: string },
            options,
          ),
      );
    },
    onEnd: async ({ context, output }) => {
      try {
        if (!context.conversationId || !output) return;
        const usage = 'usage' in output ? output.usage : undefined;
        const toolCallCount =
          (context.context.get('toolCallCount') as number) || 0;
        await sharedHooks?.afterInvocation?.({
          invocation: voltAgentInvocationContext(
            slug,
            context as typeof context & { traceId?: string },
          ),
          // @voltagent/core's UsageInfo names these promptTokens /
          // completionTokens (verified against the installed package's own
          // type, not the raw AI SDK's differently-shaped LanguageModelUsage)
          // matching Station's TokenUsage contract - map explicitly anyway
          // rather than passing `usage` through as-is: reading the wrong
          // field here typechecks as `undefined` and silently zeroes token
          // accounting and cost estimates rather than failing.
          usage: usage
            ? {
                // Read both shapes. @voltagent/core's declared UsageInfo and
                // the AI SDK's LanguageModelUsage disagree on these names, and
                // which one arrives depends on whether VoltAgent normalized
                // before the hook. This mapping has been flipped between the
                // two names three times; reading the wrong one typechecks as
                // `undefined` and silently zeroes token accounting and cost
                // estimates rather than failing, so accept either.
                promptTokens:
                  usage.inputTokens ??
                  (usage as { promptTokens?: number }).promptTokens,
                completionTokens:
                  usage.outputTokens ??
                  (usage as { completionTokens?: number }).completionTokens,
                totalTokens: usage.totalTokens,
              }
            : undefined,
          toolCallCount,
        });
      } finally {
        pendingToolCalls.delete(context);
      }
    },
  });
}

export class VoltAgentFramework {
  async createAgent(
    slug: string,
    spec: AgentSpec,
    config: AgentCreationConfig,
    opts: CreateAgentOptions,
  ): Promise<AgentBundle> {
    const model = await this.createModel(spec, config);

    // Create memory. `createPromptOnlyMemoryView` filters the
    // `[CHAT_ERROR]` failed-turn marker out of this Memory instance's
    // own reads only (archive#191 code-review HIGH-1) — every other caller of
    // `opts.memoryAdapter` (UI history, stats, monitoring) keeps using
    // the raw, unwrapped adapter, so the marker still renders on
    // reload. See `memory-adapter-prompt-view.ts` for the full trace.
    const memory = new Memory({
      storage: createPromptOnlyMemoryView(opts.memoryAdapter),
    });

    // Load tools
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
    const fixedTokens = { systemPromptTokens, mcpServerTokens };

    // Create VoltAgent-native hooks that delegate to shared agent-hooks logic.
    // VoltAgent needs createHooks() for its internal lifecycle, but the
    // afterInvocation business logic (stats, cost, enrichment) comes from
    // the shared hooks passed via config.hooks.
    const sharedHooks = conformAgentHooks('voltagent', config.hooks);
    const _autoApprove = spec.tools?.autoApprove || [];
    const hooks = createVoltAgentLifecycleHooks(slug, sharedHooks);

    // Build agent
    const agent = new Agent({
      name: slug,
      instructions: opts.processedPrompt,
      model,
      memory,
      // Normalize to real VoltAgent Tools so builtin/hand-rolled tools (plain
      // objects) actually forward to the model; MCP/VoltAgent tools pass through.
      tools: tools.map(toVoltAgentTool),
      hooks,
      ...(spec.guardrails && {
        temperature: spec.guardrails.temperature,
        maxOutputTokens:
          spec.guardrails.maxTokens ?? config.appConfig.defaultMaxOutputTokens,
        topP: spec.guardrails.topP,
      }),
      // maxSteps controls VoltAgent's agentic loop limit (VoltAgent's own
      // default is a stingy 10). Priority: agent guardrails > agent spec >
      // app config > high default (no artificial limit).
      maxSteps: resolveMaxSteps({
        guardrailsMaxSteps: spec.guardrails?.maxSteps,
        specMaxSteps: spec.maxSteps,
        defaultMaxTurns: config.appConfig.defaultMaxTurns,
      }),
      ...(!spec.guardrails && config.appConfig.defaultMaxOutputTokens
        ? { maxOutputTokens: config.appConfig.defaultMaxOutputTokens }
        : {}),
    });

    return {
      agent: new VoltAgentWrapper(agent),
      tools: tools as ITool[],
      memoryAdapter: opts.memoryAdapter,
      fixedTokens,
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
      | 'mcpConnectionStatus'
      | 'integrationMetadata'
      | 'toolNameMapping'
      | 'toolNameReverseMapping'
      | 'mcpToolProvenanceGeneration'
      | 'integrationSecretResolver'
      | 'logger'
      | 'serverPort'
    >,
  ): Promise<ITool[]> {
    const loaded = (await MCPManager.loadAgentTools(
      slug,
      spec,
      opts.configLoader,
      opts.mcpConfigs,
      opts.mcpConnectionStatus,
      opts.integrationMetadata,
      opts.toolNameMapping,
      opts.toolNameReverseMapping,
      opts.logger,
      opts.serverPort,
      opts.mcpToolProvenanceGeneration!,
      opts.integrationSecretResolver,
      opts.mcpCustody,
    )) as ITool[];
    return [...loaded, createNativeOutputDeclarationTool() as ITool];
  }

  async destroyAgent(_slug: string): Promise<void> {
    // MCP cleanup handled by runtime (it owns the maps)
  }

  async createModel(
    spec: AgentSpec,
    config: AgentCreationConfig,
  ): Promise<any> {
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
    if (dispatchModel) return dispatchModel;
    return createVoltAgentManagedModel({
      providerConnection: binding.providerConnection,
      modelId: binding.modelId,
      spec,
      appConfig: config.appConfig,
    });
  }

  async createTempAgent(opts: {
    name: string;
    instructions: string | (() => string);
    model: any;
    tools?: ITool[];
    maxSteps?: number;
    memoryAdapter?: StorageAdapter;
    hooks?: IAgentHooks;
  }): Promise<IAgent> {
    // archive#914: without a memory the framework falls back to its own in-process
    // `InMemoryStorageAdapter`, so the agent reads a conversation history that
    // is neither durable nor the one Station persists — every turn arrived at
    // the model with no prior context while the UI showed a full transcript.
    // Wired exactly as `createAgent` does, prompt-only view included, so the
    // `[CHAT_ERROR]` marker stays out of the model's reads but still renders.
    const agent = new Agent({
      name: opts.name,
      instructions: opts.instructions,
      model: opts.model,
      // Temp/default agents bypass persisted-agent loading, but must still
      // register hand-rolled Station tools as real Volt tools.
      tools: (opts.tools || []).map(toVoltAgentTool),
      maxSteps: opts.maxSteps,
      // archive#1834: temp agents used to get NO lifecycle hooks, so the
      // default agent (and every scheduler//invoke/CLI call riding it)
      // executed tools without ever evaluating beforeToolCall. Wired exactly
      // as `createAgent` does when the caller supplies hooks.
      ...(opts.hooks
        ? {
            hooks: createVoltAgentLifecycleHooks(
              opts.name,
              conformAgentHooks('voltagent', opts.hooks),
            ),
          }
        : {}),
      ...(opts.memoryAdapter
        ? {
            memory: new Memory({
              storage: createPromptOnlyMemoryView(opts.memoryAdapter),
            }),
          }
        : {}),
    });
    return new VoltAgentWrapper(agent);
  }

  async shutdown(): Promise<void> {
    // No-op — runtime handles MCP disconnection and agent map cleanup
  }
}
