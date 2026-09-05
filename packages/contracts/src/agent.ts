import type { AgentId, EngineConnectionId } from './agent-identity.js';
import type {
  WorkspaceIsolationConfig,
  WorkspaceIsolationMode,
} from './workspace-isolation.js';

export const AGENT_ICON_TOKEN_MAX_LENGTH = 16;
export const AGENT_ICON_BRAND_KEYS = [
  'claude',
  'codex',
  'pi',
  'kiro',
  'opencode',
] as const;
export type AgentIconBrandKey = (typeof AGENT_ICON_BRAND_KEYS)[number];

export function agentIconBrandKey(
  value: unknown,
): AgentIconBrandKey | undefined {
  if (typeof value !== 'string' || !value.startsWith('brand:'))
    return undefined;
  const key = value.slice('brand:'.length);
  return AGENT_ICON_BRAND_KEYS.find((candidate) => candidate === key);
}

export function isSupportedAgentIconGlyphToken(
  value: unknown,
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= AGENT_ICON_TOKEN_MAX_LENGTH &&
    !value.startsWith('brand:') &&
    !/^(?:https?:|data:|\/|[A-Za-z]:[\\/])/.test(value) &&
    !/[\\/]/.test(value) &&
    !/\.(?:png|jpe?g|webp|ico)$/i.test(value)
  );
}

export function isSupportedAgentIconToken(value: unknown): value is string {
  return (
    Boolean(agentIconBrandKey(value)) || isSupportedAgentIconGlyphToken(value)
  );
}

export interface AgentGuardrails {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  /**
   * station#3239: typed and accepted, but no runtime/adapter reads it today
   * — unlike its siblings, it does not constrain generation on any engine.
   * Do not treat it as a working safety control until an adapter wires it.
   */
  stopSequences?: string[];
  maxSteps?: number;
}

/** Default agent guardrails applied when an agent doesn't specify its own. */
export const DEFAULT_GUARDRAILS = {
  maxTokens: 4096,
  temperature: 0.7,
} as const;

/**
 * The capabilities that define the reserved Station role, independent of
 * which engine executes it. Keep the ids here so bootstrap, persistence,
 * catalog projection, and session delivery cannot drift into separate
 * hand-maintained defaults.
 */
export const BUILTIN_STATION_AGENT_MCP_SERVER_IDS = [
  'station-control',
  'station-docs',
] as const;

/** Where an agent comes from: a local Station agent or an ACP-connected one. */
export type AgentSource = 'local' | 'acp';

export interface AgentTools {
  mcpServers: string[];
  available?: string[];
  autoApprove?: string[];
}

export interface SlashCommand {
  name: string;
  description?: string;
  prompt: string;
  params?: SlashCommandParam[];
}

export interface SlashCommandParam {
  name: string;
  description?: string;
  required?: boolean;
  default?: string;
}

export interface AgentQuickPrompt {
  id: string;
  label: string;
  prompt: string;
  agent?: AgentId;
}

export interface AgentUIConfig {
  component?: string;
  quickPrompts?: AgentQuickPrompt[];
  workflowShortcuts?: string[];
}

export interface AgentExecutionConfig {
  /**
   * The engine connection this Agent runs on. ABSENT means Station's own
   * engine (`engineId 'station'`) — the target contract in
   * `docs/design/agent-engine-unification.md` §3.2/§7.1: "an external custom
   * Agent persists an `engineConnectionId`, while a Station-engine Agent
   * omits it."
   *
   * station#3662: this used to be required, which forced the seeded `station`
   * Agent to name a connection id (`'station'`) that the registry itself
   * refuses to accept as an engine connection (`ReservedStationIdentityError`)
   * — a binding nothing could ever resolve. `resolveExecutionTarget`
   * (`src-server/services/execution-target/execution-target-resolver.ts`)
   * already reads absence exactly this way: no binding → `engine: 'station'`,
   * `provider: 'station-agent'`; a present binding is looked up and must be
   * ready. Making the field optional lets the record say what that resolver
   * already means.
   */
  agentConnectionId?: EngineConnectionId;
  modelConnectionId?: string | null;
  modelId?: string | null;
  /**
   * station#3530: which credential profile (account) of the bound engine this
   * agent runs on. Absent means "whatever the connection's own
   * `credentialRecovery.activeProfileRef` selects" — today's behavior,
   * byte-identical.
   *
   * Credential profiles already store per-account app-homes
   * (`credentialProfileStorageId(engineId, ref)` keys them two-dimensionally),
   * but only one was reachable at a time because selection lived on the
   * CONNECTION. This field moves selection to the agent, so a personal and a
   * work account of one engine can back two agents simultaneously.
   *
   * Resolution order, highest first: an explicit per-call ref (credential
   * recovery supplies one) → this field → the connection's active profile →
   * `useAppHome` → the user's global engine config.
   *
   * Fail-closed, like every other selected profile, in BOTH directions: if the
   * profile cannot be prepared the session start fails, and if the agent's own
   * execution config cannot be READ the start also fails — a failed read means
   * we do not know whether a pin exists, which is not the same as knowing
   * there is none. A turn can never be attributed to credentials that were not
   * the ones applied.
   */
  credentialProfileRef?: string | null;
  workspaceIsolationMode?: WorkspaceIsolationMode;
  runtimeOptions?: Record<string, unknown>;
  modelOptions?: Record<string, unknown>;
  workspaceIsolation?: WorkspaceIsolationConfig;
  /**
   * station#2959: per-agent override for the turn-stall window — how long a
   * turn may run with no observed progress event (a streamed chunk, a tool
   * lifecycle event, or a session state transition) before Station treats it
   * as stalled and enters the same cooperative-stop protocol a user-initiated
   * Stop uses. Absent (or non-positive) means this agent uses
   * `DEFAULT_TURN_STALL_WINDOW_MS`
   * (`@kontourai/station-contracts/turn-stall-window`), not "never".
   */
  turnStallWindowMs?: number;
}

export interface AgentDelegationPolicy {
  maxDepth?: number;
  allowedTools?: string[];
  blockedTools?: string[];
  denyApprovals?: boolean;
}

/**
 * A built-in restriction applied to every delegated child Agent. The runtime
 * consumes this exact catalog when it creates a child delegation context; its
 * text is also the user-facing explanation of what the pattern refuses.
 */
export interface BuiltinDelegationDenial {
  pattern: string;
  refusal: string;
}

/**
 * Station's non-overridable delegated-child denials. Keep the enforcement
 * patterns and their human explanation together: callers must project this
 * constant rather than maintaining a second list for display.
 */
export const BUILTIN_DELEGATION_DENIALS: readonly BuiltinDelegationDenial[] = [
  {
    pattern: 'station-control_send_message',
    refusal:
      'Refuses a delegated child from sending messages through Station control.',
  },
  {
    pattern: 'station-control_delegate_task',
    refusal: 'Refuses a delegated child from delegating additional tasks.',
  },
  {
    pattern: 'station-control_add_*',
    refusal: 'Refuses a delegated child from adding Station-managed resources.',
  },
  {
    pattern: 'station-control_create_*',
    refusal:
      'Refuses a delegated child from creating Station-managed resources.',
  },
  {
    pattern: 'station-control_delete_*',
    refusal:
      'Refuses a delegated child from deleting Station-managed resources.',
  },
  {
    pattern: 'station-control_run_job',
    refusal: 'Refuses a delegated child from starting scheduled jobs.',
  },
  {
    pattern: 'station-control_update_*',
    refusal:
      'Refuses a delegated child from changing Station-managed resources.',
  },
  {
    pattern: 'station-control_remove_*',
    refusal:
      'Refuses a delegated child from removing Station-managed resources.',
  },
  {
    pattern: 'station-control_connect_*',
    refusal: 'Refuses a delegated child from connecting managed environments.',
  },
  {
    pattern: 'station-control_disconnect_*',
    refusal:
      'Refuses a delegated child from disconnecting managed environments.',
  },
];

export interface DelegationDeniedCommandCatalog {
  builtIn: readonly BuiltinDelegationDenial[];
  operatorConfigured: readonly BuiltinDelegationDenial[];
}

/**
 * Renderable catalog for an Agent's delegated children. Built-ins always come
 * from the enforcement constant above; configured patterns remain a separate
 * source so an operator can tell what Station refuses by default.
 */
export function delegationDeniedCommandCatalog(
  blockedTools: readonly string[] | undefined,
): DelegationDeniedCommandCatalog {
  return {
    builtIn: BUILTIN_DELEGATION_DENIALS,
    operatorConfigured: (blockedTools ?? []).map((pattern) => ({
      pattern,
      refusal: `Refuses a delegated child from using tools matching '${pattern}' because this Agent is configured to deny them.`,
    })),
  };
}

export interface AgentDelegationContext {
  mode: 'isolated-child';
  depth: number;
  maxDepth: number;
  parentAgentSlug: AgentId;
  parentConversationId?: string;
  rootAgentSlug: AgentId;
  rootConversationId?: string;
  allowedTools?: string[];
  blockedTools?: string[];
  denyApprovals?: boolean;
}

export interface AgentSpec {
  name: string;
  prompt: string;
  description?: string;
  icon?: string;
  model?: string;
  /** Owning project slug; absent = global scope (agent-engine-unification.md §3.3). */
  project?: string;
  execution?: AgentExecutionConfig;
  delegation?: AgentDelegationPolicy;
  region?: string;
  maxSteps?: number;
  guardrails?: AgentGuardrails;
  streaming?: {
    useNewPipeline?: boolean;
    enableThinking?: boolean;
    debugStreaming?: boolean;
  };
  tools?: AgentTools;
  skills?: string[];
  commands?: Record<string, SlashCommand>;
  ui?: AgentUIConfig;
  /** How this otherwise ordinary, editable definition was first created. */
  provenance?: {
    origin: 'engine-detection';
    engineId: string;
    detectedAt: string;
  };
}

export interface AgentMetadata {
  slug: AgentId;
  name: string;
  model?: string;
  updatedAt: string;
  description?: string;
  prompt?: string;
  plugin?: string;
  /** Owning project slug; absent = global scope (agent-engine-unification.md §3.3). */
  project?: string;
  ui?: AgentUIConfig;
  workflowWarnings?: string[];
  /**
   * Carried through from the spec (station#954 cold-boot fix) so the
   * managed-runtime agent registry (`runtime-agent-registry.ts`) can
   * classify external-engine-bound records — via
   * `resolveEngineCapabilityMatrix` (`engine-capability-matrix.ts`) — and
   * skip attempting to build a Station-engine (managed) VoltAgent instance
   * for them, without loading the full spec twice.
   */
  execution?: AgentExecutionConfig;
}
