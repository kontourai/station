/**
 * Framework-agnostic interfaces for the agent runtime boundary.
 *
 * These types decouple Station's application layer (routes, streaming pipeline,
 * memory, services) from the underlying agent framework (currently VoltAgent +
 * Vercel AI SDK, eventually Strands).
 *
 * The adapter pattern: one file implements IAgentFramework per framework.
 * Everything else imports from here.
 *
 * Key design: the runtime defines WHAT should happen (approve tools, track
 * usage, persist messages) via IAgentHooks. The adapter defines HOW to wire
 * those hooks into its native lifecycle system. Adding a new framework means
 * implementing the hook wiring, not reimplementing business logic.
 */
import type {
  AgentDelegationContext,
  AgentSpec,
} from '@kontourai/station-contracts/agent';
import type { AppConfig } from '@kontourai/station-contracts/config';
import type { FleetRoutingReceiptEnvelope } from '@kontourai/station-contracts/fleet-routing-receipt';
import type {
  ConnectionReadinessEvidence,
  ProviderConnectionConfig,
} from '@kontourai/station-contracts/tool';
import type { FleetCandidateResolution } from '../services/inference/fleet-candidate-service.js';
import type { EventStore } from '../services/orchestration/event-store.js';
import type { MCPToolLoaderProvenance } from '../services/orchestration/mcp-tool-provenance.js';
import type { PluginActivationSession } from '../services/plugins/plugin-activation-composition.js';
import type { Logger } from '../utils/logger.js';
import type { UnsealedFleetRoutingEnvelope } from './conversation/fleet-routing-envelope.js';

// ── Stream Events ──────────────────────────────────────

/**
 * Framework-agnostic stream chunk.
 *
 * Intentionally mirrors Vercel AI SDK's TextStreamPart shape so the existing
 * streaming pipeline (handlers, SSE output) works unchanged. The framework
 * adapter maps its native events INTO this format.
 */
export interface IStreamChunk {
  type: string;
  [key: string]: any;
}

/**
 * archive#3113: the single fixed message either engine adapter substitutes
 * for an ORDINARY (non-policy) tool failure's real error text before it
 * leaves the framework boundary — see voltagent-adapter.ts's
 * `normalizeVoltAgentToolErrors` and strands-stream-events.ts's
 * `mapStrandsStreamEvent`. A tool's own thrown/returned error text may embed
 * remote-server or caller-controlled content (the tool could be backed by an
 * MCP server, a shell command, arbitrary user input echoed back, etc.), and
 * Station has no way to know it is safe — so it never crosses this
 * boundary. A denial is exempt from this substitution when — and only when —
 * its reason carries `ToolCallDenial.stationComposedReason`: the marker meaning
 * `denial-message.ts` composed the text (Station prose, a sanitized tool name,
 * and any foreign fragment flattened, capped, quoted and attributed —
 * archive#3210). It is NOT `policyDenied` that grants the exemption; that
 * marker derives provenance, not authorship, and the two came apart.
 * One shared literal, not two independently-worded ones, so the failure
 * reads identically regardless of which engine ran the agent.
 */
export const GENERIC_TOOL_FAILURE_MESSAGE = 'Tool call failed.';

/**
 * archive#3179: the `finish` chunk's `finishReason` when a turn ended
 * because a tool call was denied rather than because the model stopped.
 *
 * `@voltagent/core` aborts its own operation controller the moment a
 * `ToolDeniedError` is seen, so the engine never emits a `finish` chunk of
 * its own on that path — the stream simply stops. Without a substitute the
 * route's `CompletionHandler` keeps its `'completed'` default and the turn
 * is reported to monitoring, the dedup store, and the client as a SUCCESS
 * that produced nothing (verified end to end, not inferred). This literal
 * is emitted ONLY from a real observed denial, and only when the engine
 * emitted no `finish` of its own.
 */
export const TOOL_DENIED_FINISH_REASON = 'tool-denied';

// ── Tool ───────────────────────────────────────────────

export interface ITool {
  name: string;
  id?: string;
  description?: string;
  parameters?: any;
  _meta?: Record<string, unknown>;
  ui?: { resourceUri: string };
  resource?: { uri: string };
  execute(input: any, options?: any): Promise<any>;
}

// ── Memory ─────────────────────────────────────────────

export interface IConversation {
  id: string;
  resourceId: string;
  userId: string;
  title?: string;
  metadata?: Record<string, any>;
}

export interface IMemory {
  getConversation(id: string): Promise<IConversation | null>;
  createConversation(opts: {
    id: string;
    resourceId: string;
    userId: string;
    title?: string;
    metadata?: any;
  }): Promise<IConversation>;
  getConversations(resourceId: string): Promise<IConversation[]>;
  getMessages(userId: string, conversationId: string): Promise<any[]>;
  addMessage(
    msg: any,
    userId: string,
    conversationId: string,
    metadata?: any,
  ): Promise<void>;
  updateConversation(id: string, updates: any): Promise<void>;
  clearMessages(userId: string, conversationId?: string): Promise<void>;
  removeLastMessage?(userId: string, conversationId: string): Promise<void>;
}

// ── Agent ──────────────────────────────────────────────

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface IGenerateResult {
  text?: string;
  object?: any;
  usage?: TokenUsage;
  toolCalls?: any[];
  toolResults?: any[];
  reasoning?: string;
  steps?: any[];
}

export interface IStreamResult {
  fullStream: AsyncIterable<IStreamChunk>;
  text?: Promise<string>;
  usage?: Promise<TokenUsage>;
  finishReason?: Promise<string>;
}

export interface IAgent {
  readonly id: string;
  readonly name: string;
  readonly model?: any;
  generateText(prompt: string, options?: any): Promise<IGenerateResult>;
  streamText(input: string, options?: any): Promise<IStreamResult>;
  generateObject?(prompt: string, options?: any): Promise<IGenerateResult>;
  getMemory(): IMemory | null;
}

// ── Lifecycle Hooks ────────────────────────────────────
//
// The runtime provides these implementations. The adapter wires them
// into the framework's native hook system. This means approval logic,
// usage tracking, and persistence sync are written ONCE and work
// across all frameworks.

export interface ToolCallContext {
  toolName: string;
  toolCallId: string;
  toolArgs: any;
  toolDescription?: string;
  /** Server-only loader authority; never inferred from a model-visible name. */
  mcp?: Readonly<{
    provenance: MCPToolLoaderProvenance;
    trustedArguments: unknown;
  }>;
}

export interface ToolCallResult {
  output?: any;
  error?: Error;
  /** Unprojected MCP result content, kept separate from model output. */
  mcp?: Readonly<{ trustedContent: unknown }>;
}

/**
 * Identity of an invocation that has no human approval channel. A principal
 * must faithfully denote what actually executes and never be constructed for
 * a non-existent or non-executing target. Selection among targets the caller
 * is authorized to run is legitimate; fabricating identity is not.
 * Request-supplied values may be used only after the server resolves them to a
 * real executing target. This is descriptive identity for future standing-
 * grant resolution only; it MUST NOT by itself change an approval decision.
 * `delegated-child` is the target shape for the next slice: production code
 * does not construct it yet.
 */
export type UnattendedPrincipal =
  | { kind: 'voice'; agentSlug: string; sessionId: string }
  | { kind: 'scheduled-job'; jobId: string }
  | { kind: 'delegated-child'; originAgentSlug: string };

export interface InvocationContext {
  agentSlug: string;
  conversationId?: string;
  /** Exact Session/turn/principal exist only on an authorized orchestration relay. */
  sessionId?: string;
  turnId?: string;
  principalId?: string;
  userId?: string;
  traceId?: string;
  delegation?: AgentDelegationContext;
  /**
   * Identifies who invokes on an unattended surface for later standing-grant
   * resolution. It is descriptive identity only and MUST NOT by itself change
   * any approval decision in this slice.
   */
  unattendedPrincipal?: UnattendedPrincipal;
}

/**
 * A denied tool call with the human-readable reason for the denial. The
 * adapters surface `reason` in the error the model/user sees, so it should
 * say what happened and what to do about it — never a generic label
 * (archive#1834: every denial used to read as a delegated-child block).
 */
export interface ToolCallDenial {
  allowed: false;
  reason: string;
  /**
   * Set ONLY by Station's own staged pre-tool policy evaluator
   * (`pre-tool-policy.ts`'s `deny()`) — never inferred elsewhere, and never
   * set by a denial that originated from a human declining an interactive
   * approval request (that path returns this same shape without the marker).
   * archive#3091: this is the one authoritative signal that distinguishes
   * "Station's policy blocked this" from "the user declined this" once the
   * denial crosses into the UI's approval vocabulary — an absent value means
   * "we don't know why", never "policy denied it".
   *
   * archive#3210: this is PROVENANCE ("the policy evaluator produced this"),
   * not a statement about who wrote `reason`. It deliberately no longer gates
   * whether `reason` reaches the user verbatim — see
   * `stationComposedReason` below.
   */
  policyDenied?: true;
  /**
   * archive#3210: on a `ToolCallDenial` this is set by `denial-message.ts`'s
   * `stationDenial()` and by nothing else — that function is the one composer
   * of a user-visible denial reason. It derives exactly
   * one thing: this `reason` string was composed by Station — its sentence is
   * Station prose, its tool name has been reduced to a safe identifier charset
   * and capped, and any foreign fragment inside it (an LLM guardian's verdict,
   * an external config-protection hook's `stderr`) has been flattened to one
   * line, capped, wrapped in quotes it cannot contain, and attributed to the
   * source that spoke it.
   *
   * This — not `policyDenied` — is what licenses an engine adapter to carry
   * the reason to the user (and to the model, which reads it as the failed
   * call's error) instead of `GENERIC_TOOL_FAILURE_MESSAGE`. The two markers
   * are independent on purpose: a human decline is composed but not policy
   * denied, and a denial synthesized outside the composer is redacted even if
   * some future caller marks it policy denied.
   *
   * The bound this does NOT give you, because the mechanism does not support
   * it: downstream the marker travels as an own property on a thrown error
   * (`@voltagent/core` copies every own-enumerable property of a thrown error
   * into the tool's resolved output, and that copy is exactly how the marker
   * arrives). An IN-PROCESS tool can therefore set it on an error of its own
   * and have its own text rendered verbatim. A remote MCP server cannot — its
   * error crosses the protocol as `{ code, data }` and is reconstructed on
   * this side. See `denial-message.ts`'s `stationDenial()` for the full
   * statement of the limit.
   */
  stationComposedReason?: true;
}

export interface IAgentHooks {
  /**
   * Called before a tool executes. Return `true` to allow; ANY other value
   * denies execution (adapters must compare against `true`, never rely on
   * truthiness — a `ToolCallDenial` object is truthy). A `ToolCallDenial`
   * carries the denial reason for the surfaced error.
   * Used for: tool approval/elicitation flow.
   */
  beforeToolCall?(
    tool: ToolCallContext,
    invocation: InvocationContext,
  ): Promise<boolean | ToolCallDenial>;

  /**
   * Called after a tool executes.
   * Used for: tool call counting, monitoring events.
   */
  afterToolCall?(
    tool: ToolCallContext,
    result: ToolCallResult,
    invocation: InvocationContext,
  ): void;

  /**
   * Called after the full agent invocation completes.
   * Used for: usage tracking, cost calculation, message enrichment,
   * conversation stats update.
   *
   * Does NOT handle message persistence — that's the adapter's job,
   * since each framework has its own message format.
   */
  afterInvocation?(context: {
    invocation: InvocationContext;
    usage?: TokenUsage;
    toolCallCount: number;
    error?: Error;
  }): Promise<void>;
}

// ── Framework Adapter ──────────────────────────────────

/**
 * Live connection evidence for Dispatch candidate grading (archive#1426).
 *
 * Backed by `ConnectionService`, so callers get every requested connection's
 * actual current `ConnectionEvidenceLevel` instead of a self-asserted
 * constant. Batched by design (fix round, SF-5): resolving connection
 * readiness triggers a full connection-discovery pass, including health
 * probes, so a Dispatch candidate set — small and bounded — is resolved in
 * ONE call per resolution, never once per candidate. archive#1431:
 * `createConfiguredDispatchModel` resolves candidate evidence lazily behind
 * a short TTL rather than once at construction, so this source is now
 * invoked once per TTL window over the life of a built Dispatch model
 * (still never once per candidate, and never once per Dispatch request
 * within a window).
 *
 * A connection id absent from the returned map means "no evidence
 * available" — callers must treat that as `unavailable`, never assume a
 * default level. The map may also come back empty on a lookup failure (see
 * `dispatch-model-policy.ts`'s `fetchReadinessEvidenceMap`, which wraps this
 * call in try/catch and degrades to an empty map rather than throwing).
 */
export interface DispatchEvidenceSource {
  getConnectionReadinessEvidence(
    connectionIds: readonly string[],
  ): Promise<ReadonlyMap<string, ConnectionReadinessEvidence>>;
  /**
   * Live per-candidate tool-surface evidence (archive#1430), backing
   * `deriveDispatchCapabilities`'s `structured-tools` derivation.
   *
   * Optional so every existing `DispatchEvidenceSource` (test doubles, and
   * any call path that predates this field) still satisfies the interface;
   * `dispatch-model-policy.ts` treats its absence identically to "no signal
   * for any candidate" — capabilities grade exactly as they did before this
   * method existed, never a crash and never an inferred `true`.
   *
   * Returns one entry PER requested binding, in the SAME order (not a map —
   * a `connectionId` alone is not a unique key here, since one connection
   * can expose many models). Each entry is the matching
   * `LaunchableModelRecord.toolSurface` from the deterministic,
   * compute-on-demand model inventory (`ConnectionService.listLaunchableModelInventory()`
   * via `ConnectionService.getModelToolSurface`, never the route-populated
   * `getCachedLaunchableModelInventory()` snapshot — archive#1430's second
   * finding is that the cached snapshot depends on whether the Connections
   * page happened to be visited) — `null` when the model is unknown to the
   * inventory or its tool support is genuinely unreported, `[]` when the
   * inventory affirmatively knows it does NOT support tools, and an array
   * containing `'tool-calls'` when it does.
   *
   * Batched like `getConnectionReadinessEvidence` (SF-5 discipline): ONE
   * inventory computation for every requested candidate, not one per
   * candidate.
   */
  getModelToolSurface?(
    bindings: readonly { connectionId: string; modelId: string }[],
  ): Promise<ReadonlyArray<readonly string[] | null>>;
}

/**
 * Everything the fleet half of Dispatch routing needs, in one object
 * (archive#1398).
 *
 * Bundled rather than threaded as three optional fields because they are
 * useless apart: routing to a peer without recording the decision is the
 * "no artifact" posture this feature exists to differentiate against, and
 * recording a decision without the deciding Station's own environment id
 * produces a receipt that cannot say whose log it is. Absent means fleet
 * routing is simply not wired on this call path, and an agent that asked for
 * it is warned loudly rather than silently served local-only routing.
 */
export interface DispatchFleetRouting {
  /** The DECIDING Station's environment id — stamped on every envelope. */
  environmentId: string;
  /**
   * Consults every paired peer and returns routable candidates plus a named
   * exclusion for everything that did not make it
   * (`services/inference/fleet-candidate-service.ts`). Never throws.
   */
  resolveCandidates(): Promise<FleetCandidateResolution>;
  /**
   * Appends one sealed record to the hash-chained local receipt log and
   * returns it.
   *
   * Returns the SEALED envelope rather than `void` (archive#1398 security
   * review, L-5) because `receiptId` is only knowable after sealing, and it
   * is the value anything wanting to reference this decision needs — the
   * `TurnProvenanceRoutingReceiptRef` shape in `turn-provenance.ts` is
   * literally `{ kind, receiptId }`. Discarding it here would force any
   * later consumer to re-read the log and guess which record was theirs.
   * Nothing consumes it yet: the envelope→turn join stays deferred because
   * Dispatch carries no turn identity, and a positional join is the wrong
   * answer (see that file's corrected docblock).
   */
  appendReceipt(
    envelope: UnsealedFleetRoutingEnvelope,
  ): Promise<FleetRoutingReceiptEnvelope>;
  /**
   * Optional durable-operation adapter. It observes an already-authorized
   * Station turn and the sealed fleet receipt; it never decides routing or
   * changes the Dispatch result.
   */
  observer?: import('./conversation/authorized-turn-correlation.js').FleetDispatchCorrelationObserver;
}

export interface AgentCreationConfig {
  appConfig: AppConfig;
  projectHomeDir: string;
  usageAggregator?: any;
  modelCatalog?: any;
  approvalRegistry?: any;
  listProviderConnections?: () => ProviderConnectionConfig[];
  /** Live connection evidence for Dispatch candidate grading. */
  dispatchEvidenceSource?: DispatchEvidenceSource;
  /** Fleet candidates + the routing-receipt log (archive#1398). */
  fleetRouting?: DispatchFleetRouting;
  /** Used for Dispatch grading diagnostics (loud-path/exclusion logging). */
  logger?: Logger;
  /** Runtime-provided hooks — adapter wires these into native lifecycle */
  hooks?: IAgentHooks;
}

export interface AgentBundle {
  agent: IAgent;
  tools: ITool[];
  memoryAdapter: any; // FileMemoryAdapter
  fixedTokens: { systemPromptTokens: number; mcpServerTokens: number };
}

export interface IAgentFramework {
  createAgent(
    slug: string,
    spec: AgentSpec,
    config: AgentCreationConfig,
    opts: any, // Framework-specific options
  ): Promise<AgentBundle>;
  destroyAgent(slug: string): Promise<void>;
  loadTools(slug: string, spec: AgentSpec, opts: any): Promise<ITool[]>;
  shutdown(): Promise<void>;

  /** Create a model provider instance for the given spec */
  createModel(spec: AgentSpec, config: AgentCreationConfig): Promise<any>;

  /** Create a lightweight agent for one-shot invocations (no persistence) */
  createTempAgent(opts: {
    name: string;
    instructions: string | (() => string);
    model: any;
    tools?: ITool[];
    maxSteps?: number;
    /**
     * The conversation store this agent reads and writes. Optional only for
     * callers that genuinely want a throwaway agent; omitting it gives the
     * framework's own in-process default, which is what left Model-connection
     * agents with no conversation history at all (archive#914).
     */
    memoryAdapter?: StorageAdapter;
    /**
     * archive#1834: the shared beforeToolCall gate for this agent's tools.
     * Any temp agent given tools MUST also be given hooks — omitting them
     * leaves those tools completely ungated (the default agent, scheduler
     * jobs, /invoke and the CLI all execute through temp agents). Callers
     * that pass `tools: []` may omit this.
     */
    hooks?: IAgentHooks;
  }): Promise<IAgent>;
}

// ── Runtime Context ────────────────────────────────────
//
// Shared state passed to extracted route modules so they can
// access runtime internals without importing StationRuntime.

import type { StorageAdapter, Tool } from '@voltagent/core';
import type { FileMemoryAdapter } from '../adapters/file/memory-adapter.js';
import type { ConfigLoader } from '../domain/config-loader.js';
import type { IStorageAdapter } from '../domain/storage-adapter.js';
import type { BedrockModelCatalog } from '../providers/llm/bedrock-models.js';
import type { ACPManager } from '../services/acp/acp-bridge.js';
import type { ApprovalRegistry } from '../services/approvals/approval-registry.js';
import type { ProviderService } from '../services/connections/provider-service.js';
import type { FeedbackService } from '../services/feedback/feedback-service.js';
import type { KnowledgeService } from '../services/knowledge/knowledge-service.js';
import type { EventBus } from '../services/orchestration/event-bus.js';
import type { ACPProviderSecretResolver } from '../services/secrets/secret-binding-administration.js';
import type { createAgentHooks } from './agents/agent-hooks.js';

export type AgentConfigurationMutationOperation<T> = (
  beginMutation: () => void,
  activation?: AgentConfigurationActivation,
) => Promise<T>;

export interface AgentConfigurationActivation {
  /**
   * Acceptance-time activation state. A pending receipt means activation was
   * queued after the durable write; it is not a live status subscription and
   * may have completed by the time a caller inspects the response.
   */
  status: 'applied' | 'pending';
  reason?: string;
}

export interface AgentConfigurationMutationOptions<T> {
  /** Private installer session. The runtime owns composition, final ready CAS,
   * and invalidation on failure/deadline; request data cannot construct it. */
  pluginActivation?: PluginActivationSession;
  /**
   * The mutation changed installed plugin bytes, so the live Skill registry
   * must be rediscovered before the rebuilt Agent generation is published.
   * The runtime retains this obligation across failed or timed-out activation
   * and its reconciliation rail retries it.
   */
  rediscoverSkills?: boolean;
  /**
   * A persisted agent can be activated without rebuilding the unrelated
   * provider and connection graph. Connection/provider writes omit this and
   * continue through the full runtime reload path.
   */
  resolveAgentSlug?: (result: T) => string;
  /**
   * Return after the durable write and reconcile the live runtime separately.
   * Agent CRUD uses this so a slow model/runtime rebuild cannot hold the save
   * response open; connection, provider, and plugin mutations keep their
   * existing synchronous activation semantics.
   */
  activationMode?: 'wait' | 'defer';
}

export type AgentConfigurationMutationRunner = <T>(
  operation: AgentConfigurationMutationOperation<T>,
  options?: AgentConfigurationMutationOptions<T>,
) => Promise<T>;

export interface RuntimeContext {
  // Maps
  activeAgents: Map<string, any>;
  agentSpecs: Map<string, AgentSpec>;
  agentTools: Map<string, Tool<any>[]>;
  memoryAdapters: Map<string, FileMemoryAdapter>;
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
  globalToolRegistry: Map<string, Tool<any>>;
  agentFixedTokens: Map<
    string,
    { systemPromptTokens: number; mcpServerTokens: number }
  >;
  agentStatus: Map<string, 'idle' | 'running'>;
  agentHooksMap: Map<string, ReturnType<typeof createAgentHooks>>;

  // Services
  approvalRegistry: ApprovalRegistry;
  configLoader: ConfigLoader;
  appConfig: AppConfig;
  modelCatalog?: BedrockModelCatalog;
  framework: IAgentFramework;
  acpBridge: ACPManager;
  acpProviderSecretResolver?: ACPProviderSecretResolver;
  providerService: ProviderService;
  knowledgeService: KnowledgeService;
  feedbackService: FeedbackService;
  usageAggregator?: import('../analytics/usage-aggregator.js').UsageAggregator;
  storageAdapter: IStorageAdapter;
  eventBus: EventBus;
  orchestrationEventStore: EventStore;
  logger: any;
  /** Live connection evidence for Dispatch candidate grading (archive#1426). */
  dispatchEvidenceSource?: DispatchEvidenceSource;
  /** Fleet candidates + the routing-receipt log (archive#1398). */
  fleetRouting?: DispatchFleetRouting;

  // Monitoring / metrics (used by chat and monitoring routes)
  monitoringEvents: import('node:events').EventEmitter;
  monitoringEmitter?: import('../monitoring/emitter.js').MonitoringEmitter;
  agentStats: Map<
    string,
    { conversationCount: number; messageCount: number; lastUpdated: number }
  >;
  metricsLog: Array<{
    timestamp: number;
    agentSlug: string;
    event: string;
    conversationId?: string;
    messageCount?: number;
    cost?: number;
  }>;

  // Methods
  createBedrockModel(spec: AgentSpec): Promise<any>;
  replaceTemplateVariables(text: string): string;
  getNormalizedToolName(originalName: string): string;
  getOriginalToolName(normalizedName: string): string;
  getAgentConfigurationRevision(): number | null;
  /**
   * Whether THIS agent's activation is running right now. Lets a read route
   * distinguish "still being activated" from "exists but is not active" —
   * two very different things that read identically from `activeAgents`
   * alone.
   *
   * Per slug, and derived from the in-flight work itself, because the first
   * version was neither: a global "reconciliation is scheduled" flag told an
   * unrelated inactive agent it was activating, and flipped false the instant
   * reconciliation began, so the one agent genuinely mid-activation was told
   * it simply was not active. Optional so route unit tests and transport-only
   * fixtures need not supply it; absent means "no claim".
   */
  isAgentConfigurationActivationPending?: (slug: string) => boolean;
  /**
   * Why this agent's activation was abandoned, if it was. Set only after
   * repeated passes failed to activate it — the point at which "still
   * activating" stops being true and a caller is owed the actual reason
   * instead of an indefinite retry. Absent means no claim.
   */
  getAgentActivationFailure?: (
    slug: string,
  ) => { reason: string; at: string } | undefined;
  commitAgentConfigurationRead<T>(
    expectedRevision: number,
    operation: () => Promise<T>,
  ): Promise<T>;
  reloadAgents(): Promise<void>;
  applyAgentConfigurationMutation: AgentConfigurationMutationRunner;
  initialize(): Promise<void>;
  persistEvent(event: any): Promise<void>;
}
