import { AGENT_ICON_TOKEN_MAX_LENGTH } from './agent.js';
import type { EngineId } from './agent-identity.js';

export type { EngineId } from './agent-identity.js';

import type { ChatAttachmentInput } from './chat-attachment.js';
import type { TenantExecutionContext } from './tenancy.js';
import type {
  WorkspaceIsolationConfig,
  WorkspaceIsolationMetadata,
} from './workspace-isolation.js';

export const PROVIDER_BEDROCK = 'bedrock';
export const PROVIDER_CLAUDE = 'claude';
export const PROVIDER_CODEX = 'codex';

/**
 * Declared engine continuity, kept separate from Conversation policy. Station
 * owns the deterministic transcript replay fallback; an adapter declares only
 * the native mechanisms it can actually execute. Future fork mechanics must
 * consume this declaration rather than infer support from a provider name.
 */
export interface ProviderContinuityCapabilities {
  /** Continue the same execution Session beneath its Conversation. */
  resume: 'same-session' | 'none';
  /** Create an independent Conversation branch at a selected turn. */
  fork: 'native' | 'replay-seed' | 'none';
  /** Move an existing execution Session back to a prior turn. */
  rewind: 'in-place' | 'none';
}

export const NO_PROVIDER_CONTINUITY: ProviderContinuityCapabilities = {
  resume: 'none',
  fork: 'none',
  rewind: 'none',
};

/**
 * The complete model-selection decision Station makes before it invokes an
 * engine.  This is intentionally a closed union: callers must not turn an
 * omitted model into an invented id, nor treat an unavailable launch as a
 * nullable fourth state.
 */
export type ModelLaunchPlan =
  | {
      kind: 'station-resolved';
      modelConnectionId: string;
      modelId: string;
      /**
       * `catalog-pending` is an honest pre-dispatch selector. The Station
       * adapter changes it to `catalog-accepted` only after its own catalog
       * lookup has accepted the exact selector.
       */
      evidence: 'catalog-pending' | 'catalog-accepted';
    }
  | {
      kind: 'engine-selected';
      /**
       * `capability-absent` preserves omission-only reads for adapters that do
       * not declare model lifecycle capabilities. Such adapters never receive
       * a model override.
       * `adapter-retained` records that the adapter owns the previously
       * accepted selector and will hand it to its inner engine without
       * claiming a Station Model connection or catalog validation.
       */
      evidence: 'adapter-declared' | 'adapter-retained' | 'capability-absent';
    }
  | {
      kind: 'unavailable';
      reason:
        | 'model-required'
        | 'override-unsupported'
        | 'resume-override-unsupported'
        | 'turn-override-unsupported';
    };

/** Model controls are independent at each engine lifecycle point. */
export interface ModelLifecycleCapabilities {
  /** A start without a model can deliberately defer to the engine. */
  defaultAtStart: 'engine-selected' | 'station-resolved';
  /** Omission may retain the model already accepted for this session. */
  omissionAtResume: 'engine-selected' | 'retain-session-model';
  /** Omission may retain the model already accepted for this session. */
  omissionPerTurn: 'engine-selected' | 'retain-session-model';
  overrideAtStart: boolean;
  overrideAtResume: boolean;
  overridePerTurn: boolean;
}

/** Adapter-owned declaration used by the shared orchestration dispatch seam. */
export interface ModelLaunchCapabilities extends ModelLifecycleCapabilities {
  /** Required for Station-engine/model-backed exact selectors. */
  modelConnectionId?: string;
}

export type ModelLifecyclePoint = 'start' | 'resume' | 'turn';

export const MODEL_OVERRIDE_UNSUPPORTED_CODE = 'model-override-unsupported';
export const SESSION_REATTACH_CONFLICT_CODE = 'session-reattach-conflict';
export type SessionReattachConflictReason =
  | 'model-change'
  | 'model-options-not-idempotent';
/** Server-owned metadata key for the accepted start launch plan. */
export const MODEL_LAUNCH_PLAN_METADATA_KEY = 'modelLaunchPlan';
/** Server-owned boolean retained solely for bounded resolution telemetry. */
export const MODEL_LAUNCH_REQUESTED_OVERRIDE_METADATA_KEY =
  'modelLaunchRequestedOverride';
/** Typed requested/applied facts, emitted only at an adapter acceptance seam. */
export const MODEL_SELECTION_RECEIPT_METADATA_KEY = 'modelSelectionReceipt';
/** Capability delivery is another server-produced configuration receipt. */
export const SESSION_CAPABILITY_DELIVERY_METADATA_KEY = 'capabilityDelivery';
/** Station's requested selector and bounded option snapshot. */
export const EFFECTIVE_MODEL_METADATA_KEY = 'effectiveModel';
export const EFFECTIVE_MODEL_OPTIONS_METADATA_KEY = 'effectiveModelOptions';
/** An independently observed provider model identity. */
export const REPORTED_MODEL_METADATA_KEY = 'reportedModel';
/**
 * archive#2649: the `/chat` execution engine's own dispatch-time record of
 * what Station composed into the model input (see
 * `CONTEXT_INJECTION_METADATA_KEY` in `turn-provenance.ts` — same string,
 * re-declared here only to avoid a contracts-internal import cycle; the
 * `reserved-keys` test pins the two equal). Server-minted evidence: a public
 * caller claiming Station injected context it never injected is exactly the
 * fabricated receipt this list exists to strip.
 */
export const CONTEXT_INJECTION_RESERVED_METADATA_KEY = 'contextInjection';
/**
 * archive#2821 hardening L3: a server-owned visibility choice for
 * machine-triggered turns (currently only the inbound webhook seam). Reserved
 * so a public `startSession`/`chat` caller cannot forge it into the untyped
 * `metadata` bag and mark its own ordinary session ephemeral (hidden from
 * inventories/listings). The one legitimate writer — the foreground webhook
 * execution seam — sets it through `OrchestrationService.startSessionInternal`'s
 * `ephemeralSessionVisibility` internal-only option, which re-stamps this key
 * into `metadata` AFTER this strip runs, never by surviving the strip itself.
 */
export const SESSION_VISIBILITY_METADATA_KEY = 'sessionVisibility';
/** Durable conversation/Station ownership is always resolved by Station. */
export const CONVERSATION_ID_RESERVED_METADATA_KEY = 'conversationId';
export const ENVIRONMENT_ID_RESERVED_METADATA_KEY = 'environmentId';
/** Immutable Agent presentation copied into session start/configuration metadata. */
export const SESSION_AGENT_DISPLAY_NAME_METADATA_KEY = 'agentName';
export const SESSION_AGENT_ICON_METADATA_KEY = 'agentIcon';
export const SESSION_AGENT_DISPLAY_NAME_MAX_LENGTH = 100;
export const SESSION_AGENT_ICON_MAX_LENGTH = AGENT_ICON_TOKEN_MAX_LENGTH;
/**
 * Independent review MEDIUM-1 (station#895 wave C): a derivation, not a
 * label. `orchestration-service.ts`'s sendTurn dispatch stamps this `true`
 * into the turn's OWN metadata (server-owned, added after the reserved-key
 * strip below) at the exact moment it prepends a pending first-turn
 * instructions receipt into the composed model input — never merely
 * because a turn started. The delivering adapter carries it onto its
 * published `turn.started` event's own metadata, so
 * `station-control-delegation.ts`'s delivery disclosure can derive
 * `'delivered'` from "this turn's own record says composition happened
 * here", not from "some turn happened" (a label a receipt-present,
 * composition-skipped session would otherwise satisfy for free).
 */
export const FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY =
  'firstTurnInstructionsComposed';

/**
 * Complete set of orchestration evidence fields a public caller may never
 * provide. Keep this list aligned with session-summary model projections:
 * launch plan, typed receipt, requested/effective selector and options, and
 * independently reported identity are all server- or adapter-derived facts.
 */
export const RESERVED_ORCHESTRATION_METADATA_KEYS = [
  SESSION_CAPABILITY_DELIVERY_METADATA_KEY,
  MODEL_LAUNCH_PLAN_METADATA_KEY,
  MODEL_LAUNCH_REQUESTED_OVERRIDE_METADATA_KEY,
  MODEL_SELECTION_RECEIPT_METADATA_KEY,
  EFFECTIVE_MODEL_METADATA_KEY,
  EFFECTIVE_MODEL_OPTIONS_METADATA_KEY,
  REPORTED_MODEL_METADATA_KEY,
  CONTEXT_INJECTION_RESERVED_METADATA_KEY,
  SESSION_VISIBILITY_METADATA_KEY,
  CONVERSATION_ID_RESERVED_METADATA_KEY,
  ENVIRONMENT_ID_RESERVED_METADATA_KEY,
  SESSION_AGENT_DISPLAY_NAME_METADATA_KEY,
  SESSION_AGENT_ICON_METADATA_KEY,
  FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY,
] as const;

/**
 * Removes evidence keys that only Station may mint. This applies equally to
 * public metadata and to any adapter that projects a caller-controlled
 * options bag into canonical event metadata.
 */
export function stripReservedOrchestrationMetadata(
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (
    !metadata ||
    !RESERVED_ORCHESTRATION_METADATA_KEYS.some((key) => key in metadata)
  ) {
    return metadata;
  }
  return Object.fromEntries(
    Object.entries(metadata).filter(
      ([key]) =>
        !RESERVED_ORCHESTRATION_METADATA_KEYS.includes(
          key as (typeof RESERVED_ORCHESTRATION_METADATA_KEYS)[number],
        ),
    ),
  );
}

export interface ModelSelectionReceipt {
  requestedModel?: string;
  appliedModel?: string;
}

export function modelSelectionReceipt(
  requestedModel: unknown,
  appliedModel?: unknown,
): ModelSelectionReceipt {
  const bounded = (value: unknown) =>
    typeof value === 'string' && value.trim() && value.trim().length <= 256
      ? value.trim()
      : undefined;
  const requested = bounded(requestedModel);
  const applied = bounded(appliedModel);
  return {
    ...(requested ? { requestedModel: requested } : {}),
    ...(applied ? { appliedModel: applied } : {}),
  };
}

/** Converts a validated Station selector from pre-dispatch to accepted fact. */
export function acceptModelLaunchPlan(
  plan: ModelLaunchPlan | undefined,
  options: { modelId: string; modelConnectionId?: string },
): ModelLaunchPlan | undefined {
  if (plan?.kind !== 'station-resolved') return plan;
  return {
    kind: 'station-resolved',
    modelConnectionId: options.modelConnectionId ?? plan.modelConnectionId,
    modelId: options.modelId,
    evidence: 'catalog-accepted',
  };
}

/**
 * Resolves a plan from a capability declaration and a caller input. Exact
 * selector validation remains adapter-owned; this function governs only
 * whether the adapter may be invoked and never fabricates a model id.
 */
export function resolveModelLaunchPlan(
  capabilities: ModelLaunchCapabilities | undefined,
  options: {
    lifecycle: ModelLifecyclePoint;
    requestedModelId?: string;
    retainedModelId?: string;
  },
): ModelLaunchPlan {
  const requestedModelId = options.requestedModelId?.trim();
  const retainedModelId = options.retainedModelId?.trim();
  // A turn may restate the model the engine already confirmed for the
  // session. That is retention, not a per-turn override.
  const isRetainedRestatement =
    options.lifecycle === 'turn' &&
    capabilities?.overridePerTurn === false &&
    requestedModelId !== undefined &&
    requestedModelId !== '' &&
    retainedModelId !== undefined &&
    requestedModelId === retainedModelId;
  const isOverride =
    requestedModelId !== undefined &&
    requestedModelId !== '' &&
    !isRetainedRestatement;
  const lifecycleOverrideSupported =
    options.lifecycle === 'start'
      ? capabilities?.overrideAtStart
      : options.lifecycle === 'resume'
        ? capabilities?.overrideAtResume
        : capabilities?.overridePerTurn;

  if (isOverride) {
    if (!lifecycleOverrideSupported) {
      return {
        kind: 'unavailable',
        reason:
          options.lifecycle === 'resume'
            ? 'resume-override-unsupported'
            : options.lifecycle === 'turn'
              ? 'turn-override-unsupported'
              : 'override-unsupported',
      };
    }
    if (capabilities?.defaultAtStart === 'station-resolved') {
      return capabilities.modelConnectionId
        ? {
            kind: 'station-resolved',
            modelConnectionId: capabilities.modelConnectionId,
            modelId: requestedModelId,
            evidence: 'catalog-pending',
          }
        : { kind: 'unavailable', reason: 'model-required' };
    }
    return { kind: 'engine-selected', evidence: 'adapter-declared' };
  }

  if (!capabilities) {
    return { kind: 'engine-selected', evidence: 'capability-absent' };
  }

  const omission =
    options.lifecycle === 'start'
      ? capabilities.defaultAtStart
      : options.lifecycle === 'resume'
        ? capabilities.omissionAtResume
        : capabilities.omissionPerTurn;
  if (omission === 'retain-session-model') {
    if (!retainedModelId) {
      // archive#1995: a session can legitimately hold no accepted model yet —
      // an engine-selected start deliberately defers model choice to the
      // engine (`defaultAtStart: 'engine-selected'`, provider.ts:54), and the
      // engine that could serve that start can equally serve a later omitted
      // selector: there is nothing to retain, not a missing requirement.
      // Failing closed here made every Station-engine session started
      // without an override unable to take a single turn. Adapters that
      // require Station to resolve the model (station-resolved starts) keep
      // the fail-closed behavior.
      return capabilities.defaultAtStart === 'engine-selected'
        ? { kind: 'engine-selected', evidence: 'adapter-declared' }
        : { kind: 'unavailable', reason: 'model-required' };
    }
    if (!capabilities.modelConnectionId) {
      return capabilities.defaultAtStart === 'engine-selected'
        ? { kind: 'engine-selected', evidence: 'adapter-retained' }
        : { kind: 'unavailable', reason: 'model-required' };
    }
    return {
      kind: 'station-resolved',
      modelConnectionId: capabilities.modelConnectionId,
      modelId: retainedModelId,
      evidence: 'catalog-pending',
    };
  }
  if (omission === 'engine-selected') {
    return { kind: 'engine-selected', evidence: 'adapter-declared' };
  }
  return { kind: 'unavailable', reason: 'model-required' };
}

/** A bounded, content-free metric attribute projection for launch outcomes. */
export function modelLaunchTelemetryAttributes(
  provider: EngineId,
  lifecycle: ModelLifecyclePoint,
  requestedOverride: boolean,
  plan: ModelLaunchPlan,
): Record<string, string> {
  const providerKind = [
    PROVIDER_ACP,
    PROVIDER_BEDROCK,
    PROVIDER_CLAUDE,
    PROVIDER_CODEX,
    PROVIDER_OLLAMA,
  ].includes(provider)
    ? provider
    : 'other';
  return {
    provider: providerKind,
    lifecycle,
    requested_override: requestedOverride ? 'true' : 'false',
    plan: plan.kind,
    outcome: plan.kind === 'unavailable' ? 'rejected' : 'accepted',
    reason: plan.kind === 'unavailable' ? plan.reason : 'none',
  };
}

/**
 * Session-level approval posture for an External agent, carried additively
 * through `ProviderSessionStartInput.modelOptions` /
 * `ProviderSendTurnInput.modelOptions` (both already an untyped
 * `Record<string, unknown>` bag, so this adds no shape change for callers
 * that omit it). Absent/omitted is equivalent to `'connection-default'` —
 * existing sessions and payloads that never set this field keep behaving
 * exactly as before.
 *
 * - `ask` — the engine asks before actions its own rules do not already
 *   allow. NOT "asks every time": each engine keeps its own allow list and
 *   read-only classifier underneath this mode, so some calls run without a
 *   Station approval request. For Claude that list includes the operator's
 *   `~/.claude/settings.json` AND a trusted workspace's checked-in
 *   `.claude/settings.json` — an accepted gap with a same-user threat model
 *   (#1545, and the `settingSources` comment in claude-adapter.ts).
 * - `auto` — run some actions automatically; the exact boundary is
 *   provider-specific (see each adapter's mapping — e.g. Codex asks at its
 *   own discretion within a workspace-scoped sandbox, Claude auto-accepts
 *   file edits but still asks for everything else).
 * - `never` — never ask; the agent runs fully autonomously with no sandbox.
 * - `connection-default` — a *selectable* sentinel meaning "clear my
 *   session override" — never a resolved/displayed posture. Once cleared,
 *   the effective mode falls through to the engine connection's
 *   configured default, and then to the adapter's own built-in default.
 *
 * Adapters that expose no native approval knob (ACP, Ollama, Bedrock, the
 * Station agent runtime) simply never read this field — it has no effect
 * for them, and UI surfaces should render read-only for those providers.
 */
export type ApprovalMode = 'ask' | 'auto' | 'never' | 'connection-default';

export const APPROVAL_MODES: readonly ApprovalMode[] = [
  'ask',
  'auto',
  'never',
  'connection-default',
];

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return (
    typeof value === 'string' &&
    (APPROVAL_MODES as readonly string[]).includes(value)
  );
}

/**
 * Reads a validated `approvalMode` out of a `modelOptions` bag, ignoring
 * unrecognized/absent values rather than throwing — callers treat the
 * `undefined` result the same as `'connection-default'`.
 */
export function readApprovalMode(
  modelOptions?: Record<string, unknown>,
): ApprovalMode | undefined {
  const value = modelOptions?.approvalMode;
  return isApprovalMode(value) ? value : undefined;
}

export const PROVIDER_ACP = 'acp';
export const PROVIDER_OLLAMA = 'ollama';
export const PROVIDER_MUSE = 'muse';

/**
 * archive#978 — the per-provider `modelOptions` keys each adapter actually
 * reads and applies (not a wishlist of what a wire channel could carry).
 * Derived directly from each adapter's own `modelOptions` reads, cited here
 * so this table can't silently drift from adapter behavior:
 *
 * - `claude` (`claude-adapter.ts`): `resolvePermissionMode`/
 *   `resolveClaudePermissionMode` read `approvalMode`; `claudeAppliedModelOptions`
 *   reads `effort`/`thinking`/`fastMode`/`autoMode`, all four of which are
 *   diffed against the session's `currentModelOptions` and applied via the
 *   live SDK's `query.applyFlagSettings()` on every turn (`claude-adapter.ts`
 *   ~lines 548-583). Deviation from the plan's guess (`approvalMode`/`effort`/
 *   `thinking` only): `fastMode`/`autoMode` are genuinely read and applied
 *   too (flagSettings.fastMode/disableAutoMode), so they're included.
 * - `codex` (`codex-adapter.ts`/`codex-approval-mode.ts`): `resolveCodexApprovalKnobs`
 *   reads `approvalMode`; `mapReasoningEffort` reads `effort`, falling back to
 *   `reasoningEffort` — both genuinely applied, so both are listed; `fastMode`
 *   is read directly (`codex-adapter.ts` ~lines 71-73, 555-633, 683-718).
 * - `acp` (`acp-adapter.ts`): reads `modelOptions` in exactly two places
 *   (~lines 579, 650), both `effectiveModelMetadata(...)` calls that only
 *   ECHO the bag into a display-only `session.configured`/`turn.started`
 *   metadata snapshot — no key changes ACP's actual session/turn behavior
 *   today, so the support list is empty. Deviation from an earlier draft
 *   that guessed `approvalMode` here: ACP's own approval flow is the
 *   interactive `session/request_permission` handshake, unrelated to a
 *   settable `modelOptions.approvalMode`.
 * - `ollama`/`bedrock`: read only `modelOptions.systemPrompt` — system-prompt
 *   passthrough is explicitly excluded from archive#978's scope, so it is
 *   NOT added to either provider's support list; a caller-supplied
 *   `systemPrompt` is rejected as unsupported for every provider (review r1
 *   HIGH fix — see `unsupportedModelOptionKeys`'s docblock).
 *
 * A provider absent from this map (e.g. `station-agent`, the Station-owned
 * agent relay, out of scope for this table) is treated by
 * `unsupportedModelOptionKeys` as "no known restriction", never "block
 * everything" — callers targeting an unmapped provider are unaffected.
 */
export const PROVIDER_MODEL_OPTION_SUPPORT: Record<string, readonly string[]> =
  {
    [PROVIDER_CLAUDE]: [
      'approvalMode',
      'effort',
      'thinking',
      'fastMode',
      'autoMode',
    ],
    [PROVIDER_CODEX]: ['approvalMode', 'effort', 'reasoningEffort', 'fastMode'],
    [PROVIDER_ACP]: [],
    [PROVIDER_OLLAMA]: [],
    [PROVIDER_BEDROCK]: [],
    // `muse-adapter.ts` reads `modelOptions` nowhere at all: `sendTurn` uses
    // only `input.modelId`, and `buildMuseExecArgs` emits `--session-id`,
    // `--model`, `--workspace` and the prompt. An ABSENT entry would mean "no
    // known restriction", so a caller's `approvalMode`/`effort` would be
    // accepted and then silently ignored — the empty list is what makes the
    // rejection honest.
    [PROVIDER_MUSE]: [],
  };

/**
 * Keys in `modelOptions` the given provider's adapter does not read/apply —
 * everything not in `PROVIDER_MODEL_OPTION_SUPPORT[provider]`. A provider
 * absent from the map returns an empty array (no restriction known), never
 * "every key" — see the map's docblock.
 *
 * archive#978: this is unconditional, with NO
 * scope-exempt keys — an exemption of `systemPrompt`
 * (so `OrchestrationService.runConnectionSmoke`'s internal
 * connectivity-check `startSession`, which sets `modelOptions.systemPrompt`,
 * would keep working) applied to every caller of this
 * function, not just the internal one: `ollama`/`bedrock` genuinely read
 * and apply `modelOptions.systemPrompt` as the session's system prompt and
 * are reachable as ordinary Engine connections (`station chat
 * --connection=<id>`, and the CLI's unfiltered `--model-option key=value`
 * escape hatch), so it reopened exactly the out-of-scope "system-prompt
 * passthrough" capability the plan excludes — a client could silently
 * override an Engine connection's configured system prompt for a turn.
 * `runConnectionSmoke` now bypasses this check via a service-internal-only
 * flag no HTTP route can set (`orchestration-service.ts`'s
 * `dispatchWithReceipt`/`dispatch` `internal.skipModelOptionSupportCheck`),
 * so this function itself needs no exemption for any key, for any caller.
 */
/**
 * Providers deliberately exempt from the support table, listed rather than
 * inferred from absence (archive#2839).
 *
 * `station-agent` is the Station-owned agent relay: it forwards to `/chat`,
 * which owns its own option handling, so the table has nothing to say about
 * it. That exemption is real — but it used to be expressed as *absence* from
 * `PROVIDER_MODEL_OPTION_SUPPORT`, which made "unlisted" mean "unrestricted".
 * A newly added provider then inherited no restriction at all until someone
 * remembered to add it, and the failure was silent in the permissive
 * direction. Naming the exemption turns "remembered to add it" into "had to
 * opt out of it".
 */
export const MODEL_OPTION_UNRESTRICTED_PROVIDERS: readonly string[] = [
  'station-agent',
];

export function unsupportedModelOptionKeys(
  provider: EngineId,
  modelOptions?: Record<string, unknown>,
): string[] {
  if (!modelOptions) return [];
  const supported = PROVIDER_MODEL_OPTION_SUPPORT[provider];
  if (supported) {
    return Object.keys(modelOptions).filter((key) => !supported.includes(key));
  }
  if (MODEL_OPTION_UNRESTRICTED_PROVIDERS.includes(provider)) return [];
  // Fail closed. A provider in neither list has declared no supported option,
  // so every key is unsupported: an adapter that reads `modelOptions` before
  // anyone declares what it honours must not silently receive them.
  return Object.keys(modelOptions);
}

/**
 * Canonical 400 wording for an unsupported `modelOptions` key — used
 * identically by the orchestration command intake (chat/runtime sessions)
 * and the delegation service so a caller sees the same shape regardless of
 * path (archive#978 AC4).
 */
export function unsupportedModelOptionError(
  provider: EngineId,
  key: string,
  targetLabel: string,
): string {
  return `Unsupported option '${key}' for ${provider} target '${targetLabel}'`;
}

/**
 * `RuntimeWarningEvent.code` published when a mid-session escalation to
 * `'never'` (Claude's `bypassPermissions`) is rejected because the live
 * process wasn't spawned with the SDK's required
 * `allowDangerouslySkipPermissions` flag. Shared between the Claude adapter
 * (which publishes it) and the UI's orchestration event handling (which
 * reverts the session's displayed approval mode so the chip never shows a
 * posture that didn't actually apply) — see claude-adapter.ts and
 * src-ui/src/hooks/orchestration/turnHandlers.ts.
 */
export const APPROVAL_ESCALATION_REQUIRES_RESTART_CODE =
  'approval-escalation-requires-restart';

/**
 * `RuntimeErrorEvent.code` published when a provider adapter's own
 * STRUCTURED result signals that the underlying engine binding can never
 * make progress again (archive#1827) — e.g. the Claude Agent SDK's `result`
 * message reporting `is_error: true` for a `--resume`d session whose native
 * transcript no longer exists ("No conversation found with session ID:
 * ..."). Classified from the SDK's own structured `is_error` flag, never
 * from parsing the engine's English — see `claude-result-outcome.ts`. The
 * raw engine text still rides in the event's `message` (for a details
 * disclosure); this code is what the recovery path and the UI act on.
 *
 * Distinct from `SESSION_RECOVERY_FAILED_CODE`
 * (`orchestration-session-state.ts`, archive#1090): that code marks a
 * session `status: 'error'` and KEEPS replaying it on every boot, because
 * the failure is a config problem a person can fix (an ACP connection's
 * changed args, a missing credential) — the same binding may work again
 * once they do. This code marks a session `status: 'dead'` and STOPS
 * replaying it: the specific engine-side binding this session held is gone,
 * and no config change brings back that exact transcript. Starting a fresh
 * session for the same chat is the only way forward.
 */
export const ENGINE_SESSION_BINDING_DEAD_CODE = 'engine-session-binding-dead';

/**
 * Whether Station owns an orchestration session or only follows it.
 *
 * Older persisted sessions omit this field and are treated as station-owned
 * when projected into orchestration read models.
 */
export type SessionControlMode = 'station-owned' | 'read-only-attached';

/**
 * Stable, non-path metadata for a session followed from an external source.
 * Provider-specific discovery details remain outside the orchestration
 * contract so a source cannot leak local filesystem paths through APIs.
 */
export interface AttachedSessionSourceMetadata {
  kind: string;
  externalSessionId: string;
  revision?: string;
}

// ── #895 wave A: per-agent capability delivery (agent-engine-unification.md §3.2/§5/§6.2) ──

/**
 * A Station tool server resolved for delivery to an external engine.
 * Deliberately has NO `env` field: env-bearing tool servers are excluded at
 * resolution (the connections-onboarding.md §5 secret boundary) and recorded
 * as undelivered — the type cannot carry a secret.
 */
export interface ResolvedAgentToolServer {
  /** Station tool-server id (`ToolDef.id`, kind 'mcp'). */
  id: string;
  displayName?: string;
  transport?: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  endpoint?: string;
}

export interface ResolvedAgentSkill {
  /** Station skill id. */
  id: string;
  /** Absolute path of the installed skill directory (contains SKILL.md). */
  dir: string;
}

/**
 * The resolved agent definition a session runs as. Resolution happens once in
 * the orchestration layer; adapters provision from this field FIRST and fall
 * back to connection-level engine defaults only when a field is `undefined`
 * (never authored on the agent). An authored empty array is authoritative:
 * it disables the connection default for that capability.
 */
export interface ResolvedAgentDefinition {
  /** Real on-disk agent slug — never a synthetic `__agent:`/`__acp:` id. */
  slug: string;
  toolServers?: ResolvedAgentToolServer[];
  skills?: ResolvedAgentSkill[];
  /**
   * #895 wave B: the agent's authored prompt for delivery to an external
   * engine. Only attached when the spec's `prompt` is non-empty after
   * trimming — an empty/whitespace prompt is UNAUTHORED for delivery
   * purposes (external-agent records default it to ''), unlike the
   * authored-empty-array rule for toolServers/skills.
   */
  systemPrompt?: string;
  /**
   * Fix (external autoApprove parity): the agent's authored `tools.autoApprove` patterns
   * (`AgentTools.autoApprove`), carried through to external-engine adapters
   * so their tool-permission gates (Claude's `canUseTool`, ACP's
   * `session/request_permission`) can auto-approve a matching tool call
   * the same way Station's own engine already does via
   * `isAutoApproved`/`agent-hooks.ts`. Unlike `toolServers`/`skills`/
   * `systemPrompt` above, this is never delivered TO the engine — it is
   * consumed entirely Station-side as a gate in front of Station's
   * `ApprovalRegistry` — so it carries no delivery-channel/receipt
   * machinery and is attached whenever the spec authors it (including an
   * authored empty array, which simply means "no shortcuts").
   */
  autoApprove?: string[];
  // Later waves (additive): model preferences.
}

export type CapabilityDeliveryCapability =
  | 'toolServers'
  | 'skills'
  | 'systemPrompt';

/** Receipt id for the (single, unnamed) agent prompt — receipts never carry prompt text. */
export const SYSTEM_PROMPT_CAPABILITY_ID = 'agent-prompt';

export type CapabilityUndeliveredReason =
  | 'not-found' // id resolved to nothing (tool server or skill)
  | 'disabled' // configured tool server withheld by its lifecycle state
  | 'secret-boundary-env' // env-bearing tool server excluded at resolution
  | 'engine-unsupported' // agent authored it; this engine has no channel this wave
  | 'unsupported-transport' // channel-stage: ACP stdio-only passthrough
  | 'binary-not-found' // channel-stage: command missing on PATH
  | 'materialization-skipped' // channel-stage: skills copy skipped (detail carries the module's reason)
  | 'global-config-target-refused' // channel-stage: workspace materialization target resolves into the user's global engine config (agent-engine-unification.md §6.1 hard guard)
  | 'engine-capability-absent' // channel-stage: the connected engine's live handshake did not advertise the capability this delivery mechanism requires (archive#1684: an ACP CLI with no `mcpCapabilities.http`) — distinct from 'engine-unsupported', which is a static property of the engine CLASS
  | 'delivery-failed'; // channel-stage: unexpected resolution/materialization error

export interface CapabilityUndelivered {
  capability: CapabilityDeliveryCapability;
  id?: string;
  reason: CapabilityUndeliveredReason;
  detail?: string;
}

export interface CapabilityDeliveryChannelReport {
  /** 'agent' when the agent's authored field drove delivery; 'connection-default' otherwise. */
  source: 'agent' | 'connection-default';
  requested: string[];
  /** Filled by the delivering adapter in `session.configured` once the channel outcome is known. */
  delivered?: string[];
  /**
   * Ids Station added on its OWN account, delivered without anyone having
   * requested them (archive#1547 AC5: the credential-free `station-docs`
   * server on an engine that can never run the built-in assistant).
   *
   * A separate field rather than an extra entry in `requested` or a third
   * `source` value, because `source` and `requested` answer a question this
   * does not: whether the AGENT authored the capability, or the connection
   * defaulted it. Folding a Station grant into either would make one label
   * carry two facts — a session would read as though the agent asked for a
   * server it never mentioned, and the authored-vs-default distinction
   * `#895` wave A exists to record would blur on exactly the sessions where
   * a runtime grant is present. Every id here is also in `delivered`; this
   * names which of them nobody asked for.
   */
  runtimeProvided?: string[];
  undelivered: CapabilityUndelivered[];
  /**
   * Present only on the systemPrompt report when the prompt was NOT
   * delivered on the engine's system-prompt channel but is scheduled for
   * delivery as first-turn instructions (the `instructionsInFirstTurn`
   * capability row): the orchestration sendTurn choke point composes the
   * pending `firstTurnInstructions` into the conversation's first turn.
   * Absent means the ordinary channel semantics apply.
   */
  channel?: 'first-turn';
  /**
   * The pending authored prompt for first-turn composition. Server-owned
   * (reserved metadata key — a public caller can never forge it), present
   * only alongside `channel: 'first-turn'` and only until the conversation's
   * first turn composes it.
   */
  firstTurnInstructions?: string;
}

/**
 * Session configuration receipt for capability delivery, carried in
 * `session.started`/`session.configured` event metadata under
 * `SESSION_CAPABILITY_DELIVERY_METADATA_KEY`. Server-owned: the orchestration
 * layer strips any client-supplied value of this key before dispatch.
 */
export interface SessionCapabilityDeliveryMetadata {
  agentSlug?: string;
  toolServers?: CapabilityDeliveryChannelReport;
  skills?: CapabilityDeliveryChannelReport;
  systemPrompt?: CapabilityDeliveryChannelReport;
  /** Server-owned statement of the pre-tool seam actually reached by this session. */
  toolPolicy?: {
    coverage: 'partial';
    permissionHook: 'requestPermission';
    evidence: 'sharedStagedPolicy';
    toolIdentity: 'self-reported';
    limitation: string;
  };
  /**
   * Agent settings augment slice B: present when this engine-bound agent
   * (`AgentSpec.execution.agentConnectionId` set) authored the
   * Station-engine `AgentSpec.model` field while leaving
   * `execution.modelId` — the field an engine-bound agent's model
   * selection actually reads — unset (or blank). `model` is read only
   * for a Station-engine (unbound) agent, so authoring it here is a
   * silent no-op: the session still starts, on whatever model the engine
   * defaults to. A read-only disclosure, never a refusal; names the field
   * that actually applies.
   */
  modelFieldWarning?: string;
}

export interface ProviderSessionStartInput {
  threadId: string;
  provider: EngineId;
  cwd?: string;
  /**
   * archive#1174: true when `cwd` was NOT resolved from an explicit
   * caller-supplied directory or a project's own `workingDirectory` —
   * i.e. `orchestration-service.ts`'s `resolveStartSessionCwd` fell through
   * to its home-directory default (or, on a degenerate host where even that
   * is unavailable, left `cwd` unset) because there was no real
   * project/user cwd to bind the session to. Adapters that materialize
   * content into `<cwd>/...` (Claude's skills materialization,
   * agent-engine-unification.md §6.1) use this to distinguish a session
   * that merely HAPPENS to sit at $HOME (this flag) from one legitimately
   * bound there by a project or an explicit caller cwd (flag absent) — the
   * former must never be treated as a real workspace target for a
   * workspace-overlay channel. Absent/false preserves every existing
   * resolution path byte-for-byte; only `resolveStartSessionCwd` sets it.
   */
  cwdDefaulted?: boolean;
  modelId?: string;
  modelOptions?: Record<string, unknown>;
  resumeCursor?: unknown;
  workspaceIsolation?: WorkspaceIsolationConfig;
  /**
   * Server-owned independent-review policy. Public orchestration commands
   * omit this field. Supporting Adapters must enforce it at their native
   * process sandbox boundary; a detached worktree alone is not read-only.
   */
  reviewIsolation?: {
    workspaceAccess: 'read-only';
    requestId: string;
    reviewerId: string;
  };
  metadata?: Record<string, unknown>;
  /**
   * Server-only opaque app-home selector for a single provider spawn. It is
   * intentionally separate from `metadata`: adapters must never copy it into
   * canonical events, receipts, telemetry, or runtime rows.
   */
  credentialProfileRef?: string;
  /** Keep the provider transcript resumable across Station restarts. */
  persistSession?: boolean;
  signal?: AbortSignal;
  /**
   * #895: resolved agent definition for a session started as a known on-disk
   * agent. Absent for synthetic (`__agent:`/`__acp:`) or agent-less sessions —
   * adapters then use their connection-level engine defaults, unchanged.
   * Server-resolved only; the orchestration HTTP schema never accepts it.
   */
  agent?: ResolvedAgentDefinition;
  /**
   * Internal tenant authority, resolved by Station before adapter dispatch.
   * It is not public command metadata and must never be inferred from a
   * token, model selector, or tool argument.
   */
  tenantExecutionContext?: TenantExecutionContext;
}

/** Server-resolved input for creating a Station-owned continuation. */
export interface ProviderSessionAdoptInput
  extends Omit<ProviderSessionStartInput, 'resumeCursor'> {
  /** Provider cursor of the read-only source. Never returned in adoption responses. */
  sourceSessionId: string;
  sourceKind: string;
}

export interface ProviderSendTurnInput {
  threadId: string;
  /** Model-facing turn input (may carry server-composed ambient context). */
  input: string;
  /**
   * The user's typed text for transcript-facing events (e.g. the
   * `turn.started` prompt). When absent, `input` is both the model-facing
   * and display text. Set by the orchestration service when ambient context
   * was composed into `input`, so persisted/rendered user turns stay exactly
   * what the user typed.
   */
  displayInput?: string;
  /**
   * Relay-only passthrough of the raw ambient context. `input` already
   * carries the composed text, so adapters that talk to a model directly
   * MUST ignore this. Only adapters that re-enter a server pipeline with
   * its own composition choke point (station-agent → /chat) forward
   * `displayInput` + this field instead of the pre-composed `input`, so the
   * downstream pipeline persists typed text and composes exactly once.
   */
  ambientContext?: string;
  attachments?: ChatAttachmentInput[];
  modelId?: string;
  modelOptions?: Record<string, unknown>;
  /** Server-owned continuation of the start-session review sandbox policy. */
  reviewIsolation?: {
    workspaceAccess: 'read-only';
    requestId: string;
    reviewerId: string;
  };
  /**
   * Server-owned execution facts for this dispatch. HTTP/client schemas do
   * not accept this bag; adapters may use the model-launch plan only to
   * replace a pending Station selector with their accepted catalog result.
   */
  metadata?: Record<string, unknown>;
  /**
   * Server-owned opaque token used to correlate a recovery dispatch with the
   * canonical `turn.started` event before the provider acknowledges sendTurn.
   * HTTP/client schemas do not accept this field.
   */
  recoveryCorrelationId?: string;
  signal?: AbortSignal;
  /**
   * A client-generated per-turn idempotency
   * key (minted once per turn client-side, reused verbatim on retry/replay —
   * see `useActiveChatSessionMessaging.ts`). Optional and additive: absent
   * for any caller that predates this field. The dispatch layer
   * (`OrchestrationService`'s `sendTurn` case) uses it to recognize a turn
   * that was already accepted/processed for this thread and avoid starting a
   * second execution — see `EventStore.claimClientTurn`. Adapters that
   * re-enter a server pipeline with its own idempotency choke point
   * (station-agent → `/chat`) forward it so that pipeline's own dedup
   * (`chat-turn-dedup.ts`) applies too; direct-model adapters may ignore it.
   */
  clientTurnId?: string;
}

export interface ProviderSession {
  provider: EngineId;
  threadId: string;
  /**
   * archive#1827: `'dead'` is distinct from `'error'` and MUST stay that
   * way. `'error'` (archive#1090) means the failure may be user-recoverable
   * — a config problem (an ACP connection's changed args, a missing
   * credential) that the SAME persisted `resumeCursor` can retry once fixed
   * — so recovery keeps replaying it on every boot. `'dead'` means the
   * engine itself gave a structured, terminal answer about THIS binding
   * (e.g. Claude Agent SDK's `result` message reporting `is_error: true`
   * for a `--resume`d session whose native transcript no longer exists) —
   * no config change brings back that exact engine-side conversation, so
   * recovery must stop replaying it. Collapsing the two back into one
   * value would either resume a binding that structurally cannot resume
   * (the bug this fixes) or stop retrying a config problem a user just
   * fixed (the archive#1090 regression this must not reintroduce).
   */
  status: 'connecting' | 'ready' | 'running' | 'error' | 'dead' | 'closed';
  model?: string;
  cwd?: string;
  workspaceIsolation?: WorkspaceIsolationMetadata;
  resumeCursor?: unknown;
  controlMode?: SessionControlMode;
  attachedSource?: AttachedSessionSourceMetadata;
  /** Opaque Station lineage for an adopted continuation. */
  continuationSourceThreadId?: string;
  /** Server-owned key for durable attached-session adoption deduplication. */
  adoptionIdempotencyKey?: string;
  /** Whether provider recovery must preserve its durable transcript. */
  persistSession?: boolean;
  /** Retained for receipts/audit only; excluded from ordinary session lists. */
  ephemeral?: true;
  /** Server-owned hosted authority retained solely for recovery. */
  tenantExecutionContext?: TenantExecutionContext;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderTurnStartResult {
  threadId: string;
  turnId: string;
  resumeCursor?: unknown;
}
