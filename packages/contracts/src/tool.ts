import type { EngineConnectionId } from './agent-identity';
import type { ProviderCapabilityInventory } from './catalog';
import type {
  CredentialProfileRegistryState,
  CredentialRecoveryGroupProjection,
} from './connection-recovery';
import type { ControlPlaneObservation } from './engine-capability-matrix';
import type { ModelInventoryExecutionIdentity } from './model-inventory';

/**
 * Filesystem-safety-only guard for a tool-server/integration id (repo
 * review, 2026-07-26). Every known caller (`config-loader-storage.ts`'s
 * load/save/deleteIntegrationConfig, `ACPConnectionConfig.provideToolServers`
 * → ACP MCP passthrough resolution) joins this id directly into a filesystem
 * path (`<projectHomeDir>/integrations/<id>/integration.json>`), so the ONLY
 * property that actually needs enforcing is "cannot escape that directory" —
 * not a naming aesthetic. This is deliberately looser than a first pass at
 * this rule (`TOOL_SERVER_ID_PATTERN`, since retired): plugin-installed and
 * hand-authored integrations on disk have historically used ids with dots
 * and uppercase (the `/integrations` registry list route's existing
 * `^[a-z0-9]`-leading filter in `src-server/routes/plugins/registry.ts` is a
 * *display* filter, not a write-time constraint, so real on-disk ids are not
 * guaranteed to satisfy it either) — a stricter pattern here would make an
 * already-installed, already-working tool server silently disappear from
 * listing/load, or become impossible to select for MCP passthrough even
 * though it's perfectly safe to reference. Rejects empty, `.`, `..`, path
 * separators, and the three legacy object-magic keys that cannot safely name
 * a credential bucket.
 */
export function isSafeToolServerId(id: string): boolean {
  return (
    id.length > 0 &&
    id !== '.' &&
    id !== '..' &&
    !['__proto__', 'constructor', 'prototype'].includes(id) &&
    !/[/\\]/.test(id)
  );
}

/** Credential-map keys that are representable without legacy object magic. */
export function isSafeToolServerCredentialKey(value: string): boolean {
  return (
    value.length > 0 &&
    !['__proto__', 'constructor', 'prototype'].includes(value)
  );
}

export interface ToolPermissions {
  filesystem?: boolean;
  network?: boolean;
  allowedPaths?: string[];
}

export interface ToolDef {
  id: string;
  kind: 'mcp' | 'builtin';
  /** Missing on pre-lifecycle records means enabled for read compatibility. */
  enabled?: boolean;
  /** Tool names excluded from delivery; updated atomically by the Apply action. */
  disabledTools?: string[];
  probe?: ToolServerProbeResult;
  displayName?: string;
  description?: string;
  /**
   * Manifest-declared glyph or relative local raster path. Remote values are
   * never rendered; valid paths resolve through the output-only `iconUrl`.
   */
  icon?: string;
  transport?: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  endpoint?: string;
  env?: Record<string, string>;
  /**
   * Station-owned references to secret bindings for a stdio MCP child. Values
   * are binding ids, never AuthRefs or secret material. They are deliberately
   * additive so existing inline/stored environment handling remains readable
   * until an explicit migration has established a binding.
   */
  secretEnvRefs?: Record<string, string>;
  /** Set-like list of env names whose values live in this server's credential-store bucket. */
  storedEnvNames?: string[];
  /** Portability-only metadata: env names required but deliberately absent from a redacted artifact. */
  requiredEnvNames?: string[];
  /** Write-only API input. Never persisted or returned by a read route. */
  secretEnv?: Record<string, string>;
  /** Write-only API input naming stored env values to remove explicitly. */
  removeSecretEnvKeys?: string[];
  builtinPolicy?: {
    name:
      | 'station_bash'
      | 'station_file_editor'
      | 'station_http_request'
      | 'station_notebook'
      | 'station_render_component';
    allowedPaths?: string[];
    timeout?: number;
  };
  permissions?: ToolPermissions;
  timeouts?: { startupMs?: number; requestMs?: number };
  healthCheck?: {
    kind?: 'jsonrpc' | 'http' | 'command';
    path?: string;
    intervalMs?: number;
  };
  exposedTools?: string[];
}

export interface ToolServerProbeResult {
  ok: boolean;
  error?: string;
  toolCount: number;
  /**
   * The tool names this probe actually saw, recorded alongside the count
   * (audit CI-R15). Before this the count was the only surviving evidence,
   * and the live catalogue that carries names is empty until an agent session
   * opens a client — so a server could report "1 tool" and no surface could
   * ever say which. Names only, capped, no schemas or descriptions.
   */
  toolNames?: string[];
  checkedAt: string;
  /** OAuth consent evidence attached to the existing probe/health projection. */
  authorization?:
    | { state: 'never-authorized' }
    | { state: 'awaiting-operator-consent' }
    | { state: 'authorized' }
    | { state: 'authorization-failed'; reason: string }
    | { state: 'token-expired-refresh-failed'; reason: string };
}

export interface ToolMetadata {
  id: string;
  kind: 'mcp' | 'builtin';
  displayName?: string;
  description?: string;
  /** Manifest-declared glyph; see `ToolDef.icon`. */
  icon?: string;
  /** Same-origin, output-only URL for signature-validated local raster art. */
  iconUrl?: string;
  transport?: string;
  source?: string;
  /**
   * True when the underlying `ToolDef.env` declares one or more entries.
   * Metadata-only signal — never the env values themselves — so UI surfaces
   * (e.g. the ACP MCP-passthrough tool-server picker,
   * docs/design/connections-onboarding.md §5) can disable/flag a tool server
   * that requires secrets without those secrets ever leaving the server.
   */
  requiresEnvSecrets?: boolean;
  enabled?: boolean;
  disabledTools?: string[];
  probe?: ToolServerProbeResult;
}

export interface Prerequisite {
  id: string;
  name: string;
  description: string;
  status: 'installed' | 'missing' | 'error';
  category: 'required' | 'optional';
  source?: string;
  installGuide?: {
    steps: string[];
    commands?: string[];
    links?: string[];
  };
}

export type ConnectionKind = 'model' | 'agent';

/** How a chat/agent is executed: by an external engine, or by Station's engine. */
export type ExecutionMode = 'external' | 'station';
export const EXECUTION_MODE = {
  EXTERNAL: 'external',
  STATION: 'station',
} as const;
/**
 * Read-compat for persisted `agent.json` `execution.runtimeOptions.executionMode`
 * values (and remote-Station payloads) predating the Phase-B value rename
 * (`'runtime'` -> `'external'`, `'provider-managed'` -> `'station'`). Never
 * used to rewrite the value on disk — read-time normalization only.
 */
export function normalizeExecutionMode(
  value: unknown,
): ExecutionMode | undefined {
  if (value === 'external' || value === 'station') return value;
  if (value === 'runtime') return 'external';
  if (value === 'provider-managed') return 'station';
  return undefined;
}

export type ConnectionCapability =
  | 'llm'
  | 'embedding'
  | 'vectordb'
  | 'agent-runtime'
  | 'session-lifecycle'
  | 'tool-calls'
  | 'interrupt'
  | 'approvals'
  | 'resume'
  | 'reasoning-events'
  | 'external-process'
  | 'acp'
  | 'image-input'
  | 'file-input'
  /**
   * The adapter accepts a new user message mid-turn and folds it into the
   * model's current turn (true interleaved steering) instead of queuing it
   * for the next turn boundary. #613: no built-in adapter declares this
   * capability yet — it is an honest, unclaimed seam. A provider's
   * transport looking steering-adjacent (e.g. Claude's
   * AsyncUserMessageQueue accepting a mid-turn push) is not sufficient
   * evidence to declare it: whether that actually yields interleaved
   * steering vs. sequential queuing is an SDK-behavior question that has
   * to be verified against the live provider, not assumed from reading
   * its API surface.
   */
  | 'steering';

export type ConnectionStatus =
  | 'ready'
  | 'degraded'
  | 'missing_prerequisites'
  | 'disabled'
  | 'error';

/**
 * Optional, provider-reported controls and traits for one concrete model.
 *
 * Absence means the runtime did not report the capability. Consumers must not
 * invent controls from the provider name or treat an absent value as false.
 */
export interface ModelOptionCapabilities {
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  /** Provider-authored display copy keyed by the corresponding effort value. */
  effortLabels?: Record<string, string>;
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  fastModeLabel?: string;
  supportsAutoMode?: boolean;
  contextWindow?: number;
}

export interface ModelOption {
  id: string;
  name: string;
  originalId: string;
  /**
   * For alias/default entries, the concrete model id the engine reports this
   * entry currently resolves to (e.g. Claude's 'default' → 'claude-opus-5[1m]').
   * Lets surfaces show what "default" actually means instead of hiding the
   * engine's choice (#1012).
   */
  resolvedModel?: string;
  capabilities?: ModelOptionCapabilities;
}

export type RuntimeCatalogSource = 'live' | 'cached' | 'built-in' | 'none';

export interface RuntimeCatalogStatus {
  source: RuntimeCatalogSource;
  fetchedAt?: string | null;
  reason?: string | null;
  models: ModelOption[];
  builtInModels: ModelOption[];
  /** True when the provider reported a bounded, incomplete live catalog. */
  truncated?: boolean;
}

export type ConnectionEvidenceLevel =
  | 'discovered'
  | 'prerequisite-ready'
  | 'catalog-ready'
  | 'smoke-passed';

export type ConnectionSmokeStatus = 'not-tested' | 'passed' | 'failed';

export type ConnectionEvidenceFreshness = 'fresh' | 'stale' | 'unknown';

export type ConnectionSmokeFailureReason =
  | 'disabled'
  | 'missing-prerequisites'
  | 'unsupported-runtime'
  | 'start-failed'
  | 'turn-failed'
  | 'timeout'
  | 'cleanup-failed'
  | 'empty-response'
  | 'unexpected-response'
  | 'cancelled'
  | 'unknown';

export interface ConnectionSmokeEvidence {
  status: ConnectionSmokeStatus;
  freshness: ConnectionEvidenceFreshness;
  testedAt?: string;
  freshUntil?: string;
  provider?: string;
  model?: string;
  durationMs?: number;
  reasonCode?: ConnectionSmokeFailureReason;
  reason?: string;
  action?: string;
  /** Explicit dogfood smoke is bounded to exactly one user turn. */
  turnLimit: 1;
}

/**
 * The outcome of a readiness check on a model connection — the listing's own
 * model-catalog fetch, or an explicit `Test Connection`.
 *
 * COST (delta2 review M2, correcting an earlier "non-billable" claim): the
 * catalog request itself is not a generation and is not billed. An explicit
 * test may additionally issue ONE minimal chat request (`max_tokens: 1`) when
 * the provider offers no model catalogue — the only evidence that can prove a
 * catalogue-less endpoint can actually run work. Providers that honour
 * `max_tokens` bill approximately nothing; one that ignores it bills one
 * short completion. That request is made only from the explicit test ENDPOINT
 * (`POST /api/connections/:id/test`), which the operator's button, the CLI's
 * `connections test`, and SDK callers all reach — never from a listing,
 * a discovery pass, or any background poll.
 *
 * Distinct from `ConnectionSmokeEvidence`, which proves a complete chat turn
 * with the agent stack behind it. `not-checked` means nobody has asked yet; a
 * check is always bound to the configuration it observed, so editing a key
 * retires it rather than letting a stale pass vouch for new credentials.
 */
export interface ConnectionCheckEvidence {
  /**
   * - `not-checked`: nothing has asked this provider with this configuration.
   * - `passed`: it answered with a usable model catalog, or an explicit test
   *   or smoke completed against it.
   * - `catalog-unavailable`: it is REACHABLE but exposes no usable model
   *   catalog — a 404/405/501 on the catalog route, a response that is not a
   *   catalog, or a live but empty list. This proves the endpoint answers; it
   *   proves nothing about chat, so it can never read as Ready. Keeping it
   *   distinct from `failed` is what stops an OpenAI-compatible endpoint with
   *   working chat and no `/models` from being permanently marked broken.
   * - `failed`: the provider refused these settings (401/403 and other
   *   error responses).
   * - `unreachable`: Station could not reach the endpoint at all — DNS, a
   *   connection reset, a transport error. Distinct from `failed` because one
   *   transient listing must not become a durable refusal that overwrites an
   *   explicit pass and drops the connection out of recommendations. A body that is not JSON, or one too large to
   *   read, is `catalog-unavailable` instead: the endpoint answered.
   */
  status:
    | 'not-checked'
    | 'passed'
    | 'catalog-unavailable'
    | 'failed'
    | 'unreachable';
  checkedAt?: string;
  /**
   * `unreachable` only: Station is still inside the documented grace window
   * (`CONNECTION_UNREACHABLE_GRACE_OBSERVATIONS` consecutive observations or
   * `CONNECTION_UNREACHABLE_GRACE_MS`, whichever comes first) after a prior
   * pass, so this observation does not yet gate readiness — it is rendered as
   * "Unreachable — retrying" rather than as a refusal. Computed server-side;
   * a consumer must never re-derive it from timestamps of its own.
   */
  retrying?: boolean;
  /** The provider's own refusal, verbatim minus any secret it echoed back. */
  reason?: string;
  /**
   * Which request observed it. Both are the same kind of evidence — a real
   * model-catalog request made with this exact configuration — and the most
   * recent one wins:
   * - `explicit-test`: the operator pressed Test Connection.
   * - `catalog-discovery`: the listing's own catalogue fetch, which is what
   *   populates the Models count the user is looking at. Recording it is why
   *   "Ready" can never come from a saved string alone: a catalogue nobody
   *   actually fetched leaves the check
   *   `not-checked`, and the connection reads "Saved — not verified".
   *
   * Recency decides between them, with one exception: a `catalog-unavailable`
   * discovery result is the WEAKEST observation there is — "no catalog here"
   * says nothing new about a connection an explicit test or smoke has already
   * driven end to end — so it never downgrades a passed `explicit-test`
   * receipt. A refusal or a live catalogue always records.
   *
   * Absent only on `not-checked`, where no request was observed.
   */
  source?: 'explicit-test' | 'catalog-discovery';
}

/**
 * How many consecutive unreachable observations a connection with a prior
 * pass is allowed before its unreachability gates readiness.
 *
 * Automatic catalogue discovery runs on every model-connection listing, so a
 * single DNS hiccup or connection reset is a routine event, not a verdict on
 * the connection. Repetition is: three listings in a row that could not reach
 * the endpoint is no longer a blip.
 */
export const CONNECTION_UNREACHABLE_GRACE_OBSERVATIONS = 3;

/**
 * How long unreachability is tolerated after a prior pass before it gates
 * readiness, whatever the observation count. Bounds the case where listings
 * are infrequent: ten minutes of not being able to reach a provider is a real
 * problem even if only one request has been made in that window.
 */
export const CONNECTION_UNREACHABLE_GRACE_MS = 10 * 60 * 1000;

/**
 * Does this check receipt gate readiness?
 *
 * ONE derivation, shared by the readiness evidence, the recommendation gate
 * and the provider presentation, so those three cannot disagree about what a
 * receipt means. A refusal always gates. Unreachability gates only once it is
 * out of its grace window (see `ConnectionCheckEvidence.retrying`, computed
 * server-side). `catalog-unavailable` never gates: the endpoint answered and
 * merely has no catalogue, which cannot claim Ready but is not a fault.
 */
export function connectionCheckGatesReadiness(
  check:
    | Pick<ConnectionCheckEvidence, 'status' | 'retrying'>
    | null
    | undefined,
): boolean {
  if (!check) return false;
  if (check.status === 'failed') return true;
  return check.status === 'unreachable' && check.retrying !== true;
}

/**
 * Does a check receipt outrank a passed smoke?
 *
 * A passed smoke is a complete chat turn — strictly stronger evidence than
 * any catalogue answer — so it is read before a `catalog-unavailable` or a
 * stale refusal, or a working connection could never repair its own
 * presentation. But precedence is not unconditional (delta2 review H3): smoke
 * receipts stay fresh for 24 hours, so an unconditional rule let a smoke that
 * passed at 09:00 keep rendering "Ready" through a genuine 401 observed at
 * 10:00, while system status was already gating the connection. A gating
 * receipt observed AFTER the smoke describes a later state of the world and
 * wins; an older one does not.
 */
export function connectionCheckOutranksSmoke(
  check:
    | Pick<ConnectionCheckEvidence, 'status' | 'retrying' | 'checkedAt'>
    | null
    | undefined,
  smoke: Pick<ConnectionSmokeEvidence, 'testedAt'> | null | undefined,
): boolean {
  if (!connectionCheckGatesReadiness(check) || !check?.checkedAt) return false;
  const smokeAt = smoke?.testedAt ? Date.parse(smoke.testedAt) : Number.NaN;
  const checkAt = Date.parse(check.checkedAt);
  if (Number.isNaN(checkAt)) return false;
  // An unparseable/absent smoke timestamp cannot be shown to be newer, and a
  // gating receipt must not be hidden by evidence whose age is unknown.
  return Number.isNaN(smokeAt) || checkAt > smokeAt;
}

export interface ConnectionReadinessEvidence {
  evidenceVersion: 1;
  level: ConnectionEvidenceLevel;
  observedAt: string;
  freshness: ConnectionEvidenceFreshness;
  summary: string;
  action?: string;
  smoke: ConnectionSmokeEvidence;
  /**
   * Present on model connections, whose `status` is derived from "a non-empty
   * string is saved in the key box" and therefore reads `ready` for a key the
   * provider has never accepted.
   */
  check?: ConnectionCheckEvidence;
}

export interface ConnectionConfig {
  id: string;
  kind: ConnectionKind;
  type: string;
  name: string;
  enabled: boolean;
  description?: string;
  capabilities: ConnectionCapability[];
  config: Record<string, unknown>;
  status: ConnectionStatus;
  prerequisites: Prerequisite[];
  lastCheckedAt?: string | null;
  readinessEvidence?: ConnectionReadinessEvidence;
}

export interface ModelConnectionConfig extends ConnectionConfig {
  kind: 'model';
}

export interface AgentConnectionView extends ConnectionConfig {
  id: EngineConnectionId;
  kind: 'agent';
  /**
   * User-facing placement for an engine connection.
   *
   * - ready: detected and usable now (including zero-config local apps)
   * - configured: explicitly added, but disabled or still needs setup
   * - available: supported by this Station, but not yet added or usable
   */
  setup: {
    state: 'ready' | 'configured' | 'available';
    detected: boolean;
    configured: boolean;
  };
  /** Adapter-declared model execution identity; absence is unknown. */
  modelExecution?: ModelInventoryExecutionIdentity;
  /** Adapter-declared continuity; absent older/plugin rows mean no native capability. */
  continuity?: import('./provider.js').ProviderContinuityCapabilities;
  runtimeCatalog?: RuntimeCatalogStatus;
  capabilityInventory?: ProviderCapabilityInventory;
  /** Non-secret credential-profile and recovery policy state, when configured. */
  credentialRecovery?: CredentialRecoveryGroupProjection;
  /**
   * station#1549: this connection's own live-handshake evidence for the
   * control-plane capability derivation
   * (`engine-capability-matrix.ts`'s `engineControlPlaneCapability`).
   * Carried on the connection, not on the matrix, because it is a property
   * of THE CONNECTED CLI negotiated at `initialize`, not of the engine
   * class. Absent means Station has not observed this connection — which is
   * a different fact from an observed "no", and the derivation treats them
   * differently.
   */
  controlPlaneObservation?: ControlPlaneObservation;
}

export interface AgentConnectionSettings {
  name?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  /** Explicit opt-in recovery configuration; credential values never belong here. */
  credentialRecovery?: CredentialProfileRegistryState;
}

export interface ProviderConnectionConfig {
  id: string;
  type: string;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  capabilities: ('llm' | 'embedding' | 'vectordb')[];
}
