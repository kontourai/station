import type { ACPStatusValue } from '@kontourai/station-contracts/acp';
import type { EngineId } from '@kontourai/station-contracts/agent-identity';
import type {
  GuidanceAssetReference,
  ProviderCapabilityFreshness,
  ProviderCapabilityInventory,
  ProviderCapabilityStatus,
  ProviderSessionSurfaceEvidence,
} from '@kontourai/station-contracts/catalog';
import type { AppConfig } from '@kontourai/station-contracts/config';
import {
  type CredentialProfileRegistryState,
  type CredentialRecoveryGroupProjection,
  resolveCredentialProfileApplicationCapability,
} from '@kontourai/station-contracts/connection-recovery';
import type { ControlPlaneObservation } from '@kontourai/station-contracts/engine-capability-matrix';
import type {
  AgentConnectionSettings,
  AgentConnectionView,
  ConnectionCapability,
  ConnectionConfig,
  ConnectionStatus,
  ModelOption,
  ModelOptionCapabilities,
  Prerequisite,
  ProviderConnectionConfig,
  RuntimeCatalogStatus,
} from '@kontourai/station-contracts/tool';
import { isSafeToolServerId } from '@kontourai/station-contracts/tool';
import type {
  ProviderAdapterModelCatalog,
  ProviderAdapterShape,
} from '../../providers/adapter-shape.js';
import { getProviderAdapterRegistrationProvenance } from '../../providers/adapter-shape.js';

import {
  normalizeCredentialProfileRegistry,
  projectCredentialProfileRegistry,
} from '../../providers/app-home/credential-profile-registry.js';
import { hasRequiredMissingPrerequisites } from '../../runtime/frameworks/runtime-adapter-readiness.js';
import {
  providerCatalogBuiltInModelCount,
  providerCatalogModelCount,
  providerCatalogOps,
} from '../../telemetry/metrics.js';

export type RuntimeConnectionProjection = Omit<AgentConnectionView, 'id'> & {
  /** Adapter-private selector; ConnectionService brands the public projection. */
  id: string;
};

/** archive#895 wave B: per-connection session-surface evidence from a live ACP
 * `initialize` handshake (see `ProviderSessionSurfaceEvidence`). archive#1549:
 * the same handshake now also feeds `controlPlaneObservation` below — the
 * binding/picker layer's evidence half. Still NOT the session-delivery map,
 * which stays static per matrix (agent-engine-unification.md §4.1b). */
export type ACPConnectionCapabilitiesStatus = {
  loadSession?: boolean;
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  sessionCapabilities?: { resume?: unknown };
};

export type ACPConnectionStatus = {
  id: string;
  status?: ACPStatusValue;
  slashCommands?: Array<{
    name: string;
    description?: string;
    hint?: string;
  }>;
  capabilities?: ACPConnectionCapabilitiesStatus;
  /** archive#1549: ISO-8601 instant of the last SUCCESSFUL initialize handshake. */
  handshakeObservedAt?: string;
  /**
   * archive#3054: the connection's live config options from the initialize
   * handshake. The category 'model' entry IS the engine's model catalog —
   * the manager status has always carried it; this type finally admits it
   * so the connection view can project a runtimeCatalog from it.
   */
  configOptions?: Array<{
    category?: string;
    currentValue?: string;
    options?: Array<string | { name?: string; value?: string }>;
  }>;
};

export const MODEL_CAPABILITY_SET = new Set<ConnectionCapability>([
  'llm',
  'embedding',
  'vectordb',
]);

export function hasRequiredMissing(prerequisites: Prerequisite[]): boolean {
  return hasRequiredMissingPrerequisites(prerequisites);
}

export function statusFromPrerequisites(
  enabled: boolean,
  prerequisites: Prerequisite[],
): ConnectionStatus {
  if (!enabled) {
    return 'disabled';
  }
  if (hasRequiredMissing(prerequisites)) {
    return 'missing_prerequisites';
  }
  return 'ready';
}

export function toModelConnection(
  connection: ProviderConnectionConfig,
  prerequisites: Prerequisite[],
): ConnectionConfig {
  const capabilities = connection.capabilities.filter((capability) =>
    MODEL_CAPABILITY_SET.has(capability as ConnectionCapability),
  ) as ConnectionCapability[];
  return {
    id: connection.id,
    kind: 'model',
    type: connection.type,
    name: connection.name,
    enabled: connection.enabled,
    capabilities,
    config: connection.config,
    description: connection.type,
    prerequisites,
    status: statusFromPrerequisites(connection.enabled, prerequisites),
    lastCheckedAt: null,
  };
}

/** Drops malformed persisted recovery state before it reaches a runtime view. */
export function sanitizeCredentialRecoverySettings(
  value: unknown,
): CredentialProfileRegistryState {
  return normalizeCredentialProfileRegistry(value);
}

export function credentialRecoveryProjectionForAdapter(
  adapter: ProviderAdapterShape,
  value: unknown,
): CredentialRecoveryGroupProjection {
  return projectCredentialProfileRegistry(
    sanitizeCredentialRecoverySettings(value),
    resolveCredentialProfileApplicationCapability(adapter.metadata.recovery),
  );
}

export function providerLabelForAdapter(adapter: ProviderAdapterShape): string {
  return adapter.metadata.displayName.replace(/\s+Runtime$/, '');
}

export function runtimeSettingsFor(
  appConfig: AppConfig,
  id: EngineId | string,
): AgentConnectionSettings {
  return appConfig.agentConnections?.[id] ?? {};
}

export function runtimeSetupState(
  appConfig: AppConfig,
  id: string,
  prerequisites: Prerequisite[],
  ready: boolean,
): AgentConnectionView['setup'] {
  const configured = Object.hasOwn(appConfig.agentConnections ?? {}, id);
  const cliPrerequisites = prerequisites.filter((prerequisite) =>
    prerequisite.id.endsWith('-cli'),
  );
  const detected =
    cliPrerequisites.length > 0
      ? cliPrerequisites.every(
          (prerequisite) => prerequisite.status === 'installed',
        )
      : ready;

  return {
    state: ready ? 'ready' : configured ? 'configured' : 'available',
    detected,
    configured,
  };
}

/**
 * The claude connection's opted-in skill materialization ids
 * (docs/design/connections-onboarding.md §5). Filesystem-safety-checked
 * with the same predicate the MCP passthrough slice added
 * (`isSafeToolServerId`) — this list ultimately joins into
 * `<sessionCwd>/.claude/skills/<id>/` (claude-skills-materialization.ts),
 * so the only property that matters is "cannot escape that directory".
 */
const CLAUDE_RUNTIME_ID = 'claude';

/**
 * archive#896 wave 2: codex's app-home opt-in (docs/design/
 * connections-onboarding.md §1.1) — mirrors claude's `useAppHome`
 * field. Codex does not get `provideSkills`: skills stay claude/
 * workspace-channel only this wave.
 */
const CODEX_RUNTIME_ID = 'codex';

function sanitizeProvideSkills(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || !isSafeToolServerId(raw) || seen.has(raw)) {
      continue;
    }
    seen.add(raw);
    result.push(raw);
  }
  return result;
}

function runtimeDefaultConfig(
  id: string,
  appConfig: AppConfig,
): Record<string, unknown> {
  if (id === 'acp') {
    return {};
  }
  return {
    defaultModel: appConfig.defaultModel,
    ...(id === CLAUDE_RUNTIME_ID
      ? {
          provideSkills: [],
          // App-home profile opt-in (archive#896, agent-engine-unification.md
          // §6.1's overlay model, channel 2) — absent/off by default, same
          // "never silent" hygiene rule as `provideSkills`.
          useAppHome: false,
        }
      : {}),
    // archive#896 wave 2: codex gets the same app-home opt-in as claude,
    // but never `provideSkills` (skills stay claude/workspace-channel only
    // this wave).
    ...(id === CODEX_RUNTIME_ID ? { useAppHome: false } : {}),
  };
}

export function sanitizeRuntimeConfig(
  id: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (id === 'acp') {
    return {};
  }
  const defaultModel = config.defaultModel;
  const sanitized: Record<string, unknown> =
    typeof defaultModel === 'string' && defaultModel.trim().length > 0
      ? { defaultModel: defaultModel.trim() }
      : {};
  if (id === CLAUDE_RUNTIME_ID) {
    // Absent/empty ⇒ off, the default — never inferred (docs/design/
    // connections-onboarding.md §5's "never silent" hygiene rule).
    sanitized.provideSkills = sanitizeProvideSkills(config.provideSkills);
    // `useAppHome` is kept ONLY as a literal boolean — anything else
    // (absent, a string, an object) collapses to `false`, never inferred.
    sanitized.useAppHome = config.useAppHome === true;
  }
  if (id === CODEX_RUNTIME_ID) {
    // archive#896 wave 2: same boolean-only contract as claude; codex
    // never gains `provideSkills`.
    sanitized.useAppHome = config.useAppHome === true;
  }
  return sanitized;
}

export function mergeRuntimeConfig(
  id: string,
  appConfig: AppConfig,
  overrides: AgentConnectionSettings,
): Record<string, unknown> {
  return {
    ...runtimeDefaultConfig(id, appConfig),
    ...sanitizeRuntimeConfig(id, overrides.config ?? {}),
  };
}

function runtimeModelOptionsForAdapter(
  adapter: ProviderAdapterShape,
): ModelOption[] | undefined {
  switch (adapter.provider) {
    case 'claude':
      // Bounded built-in catalog — the live path asks the SDK's supportedModels().
      // Values verified against @anthropic-ai/claude-agent-sdk supportedModels()
      // on 2026-07-27 (archive#1012): the current family is Claude 5.
      return [
        {
          id: 'claude-sonnet-5',
          name: 'Claude Sonnet 5',
          originalId: 'claude-sonnet-5',
        },
        {
          id: 'claude-opus-5',
          name: 'Claude Opus 5',
          originalId: 'claude-opus-5',
        },
        {
          id: 'claude-fable-5',
          name: 'Claude Fable 5',
          originalId: 'claude-fable-5',
        },
      ];
    case 'codex':
      // Bounded built-in catalog — the live path asks the app-server's model/list.
      // Values verified against a live `codex app-server` model/list probe on
      // 2026-07-27 (archive#1012): the top entries of the current catalog, in the
      // catalog's own order.
      return [
        {
          id: 'gpt-5.6-sol',
          name: 'GPT-5.6-Sol',
          originalId: 'gpt-5.6-sol',
        },
        {
          id: 'gpt-5.6-terra',
          name: 'GPT-5.6-Terra',
          originalId: 'gpt-5.6-terra',
        },
        {
          id: 'gpt-5.6-luna',
          name: 'GPT-5.6-Luna',
          originalId: 'gpt-5.6-luna',
        },
      ];
    default:
      return undefined;
  }
}

const MODEL_OPTION_MAX_ENTRIES = 1000;
const MODEL_OPTION_TEXT_MAX_LENGTH = 512;
const MODEL_OPTION_CAPABILITY_VALUE_MAX_ENTRIES = 32;

function normalizeModelCapabilities(
  value: unknown,
): ModelOptionCapabilities | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const capabilities: ModelOptionCapabilities = {};
  let reported = false;
  for (const key of [
    'supportsEffort',
    'supportsAdaptiveThinking',
    'supportsFastMode',
    'supportsAutoMode',
  ] as const) {
    if (typeof candidate[key] === 'boolean') {
      capabilities[key] = candidate[key];
      reported = true;
    }
  }
  if (
    typeof candidate.contextWindow === 'number' &&
    Number.isSafeInteger(candidate.contextWindow) &&
    candidate.contextWindow > 0
  ) {
    capabilities.contextWindow = candidate.contextWindow;
    reported = true;
  }
  if (Array.isArray(candidate.supportedEffortLevels)) {
    const levels: string[] = [];
    const seen = new Set<string>();
    for (const level of candidate.supportedEffortLevels) {
      if (
        typeof level !== 'string' ||
        level.length === 0 ||
        level.length > MODEL_OPTION_TEXT_MAX_LENGTH ||
        seen.has(level)
      ) {
        continue;
      }
      if (levels.length === MODEL_OPTION_CAPABILITY_VALUE_MAX_ENTRIES) {
        break;
      }
      seen.add(level);
      levels.push(level);
    }
    capabilities.supportedEffortLevels = levels;
    reported = true;
  }
  if (
    candidate.effortLabels &&
    typeof candidate.effortLabels === 'object' &&
    !Array.isArray(candidate.effortLabels)
  ) {
    const labels: Record<string, string> = {};
    for (const [key, label] of Object.entries(candidate.effortLabels).slice(
      0,
      MODEL_OPTION_CAPABILITY_VALUE_MAX_ENTRIES,
    )) {
      if (
        key.length > 0 &&
        key.length <= MODEL_OPTION_TEXT_MAX_LENGTH &&
        typeof label === 'string' &&
        label.length > 0 &&
        label.length <= MODEL_OPTION_TEXT_MAX_LENGTH
      ) {
        labels[key] = label;
      }
    }
    if (Object.keys(labels).length > 0) {
      capabilities.effortLabels = labels;
      reported = true;
    }
  }
  if (
    typeof candidate.fastModeLabel === 'string' &&
    candidate.fastModeLabel.length > 0 &&
    candidate.fastModeLabel.length <= MODEL_OPTION_TEXT_MAX_LENGTH
  ) {
    capabilities.fastModeLabel = candidate.fastModeLabel;
    reported = true;
  }
  return reported ? capabilities : undefined;
}

function normalizeModelOptionsWithBounds(value: unknown): {
  models: ModelOption[];
  truncated: boolean;
} {
  if (!Array.isArray(value)) {
    return { models: [], truncated: false };
  }
  const models: ModelOption[] = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.id !== 'string' ||
      item.id.length === 0 ||
      item.id.length > MODEL_OPTION_TEXT_MAX_LENGTH ||
      typeof item.name !== 'string' ||
      item.name.length === 0 ||
      item.name.length > MODEL_OPTION_TEXT_MAX_LENGTH
    ) {
      continue;
    }
    const originalId =
      typeof item.originalId === 'string' ? item.originalId : item.id;
    if (
      originalId.length === 0 ||
      originalId.length > MODEL_OPTION_TEXT_MAX_LENGTH
    ) {
      continue;
    }
    if (models.length === MODEL_OPTION_MAX_ENTRIES) {
      return { models, truncated: true };
    }
    const capabilities = normalizeModelCapabilities(
      (item as Record<string, unknown>).capabilities,
    );
    const rawResolved = (item as Record<string, unknown>).resolvedModel;
    const trimmedResolved =
      typeof rawResolved === 'string' ? rawResolved.trim() : '';
    const resolvedModel =
      trimmedResolved.length > 0 &&
      trimmedResolved.length <= MODEL_OPTION_TEXT_MAX_LENGTH &&
      trimmedResolved !== item.id
        ? trimmedResolved
        : undefined;
    models.push({
      id: item.id,
      name: item.name,
      originalId,
      ...(resolvedModel ? { resolvedModel } : {}),
      ...(capabilities ? { capabilities } : {}),
    });
  }
  return { models, truncated: false };
}

export function buildRuntimeCatalogStatus({
  adapter,
  liveCatalog,
  liveDiscoveryFailed,
  allowBuiltInOnDiscoveryFailure,
  now,
}: {
  adapter: ProviderAdapterShape;
  liveCatalog?: ProviderAdapterModelCatalog;
  liveDiscoveryFailed: boolean;
  allowBuiltInOnDiscoveryFailure: boolean;
  now: number;
}): RuntimeCatalogStatus | undefined {
  const builtInModels = runtimeModelOptionsForAdapter(adapter) ?? [];
  const normalizedLiveCatalog = normalizeModelOptionsWithBounds(
    liveCatalog?.models,
  );
  const liveModels = normalizedLiveCatalog.models;
  const liveCatalogTruncated = Boolean(
    liveCatalog?.truncated || normalizedLiveCatalog.truncated,
  );
  if (liveCatalog !== undefined) {
    return {
      source: 'live',
      fetchedAt: new Date(now).toISOString(),
      reason: liveCatalogTruncated
        ? 'Live runtime catalog was truncated by its bounded entry limit.'
        : null,
      models: liveModels,
      builtInModels,
      ...(liveCatalogTruncated ? { truncated: true } : {}),
    };
  }

  if (liveDiscoveryFailed && !allowBuiltInOnDiscoveryFailure) {
    return {
      source: 'none',
      fetchedAt: null,
      reason: 'Live runtime model discovery failed.',
      models: [],
      builtInModels: [],
    };
  }

  if (builtInModels.length > 0) {
    return {
      source: 'built-in',
      fetchedAt: null,
      reason: adapter.listModels
        ? 'Live runtime catalog is unavailable, so Station is showing its built-in models.'
        : 'This runtime uses built-in models because it does not expose a live catalog.',
      models: [],
      builtInModels,
    };
  }

  return {
    source: 'none',
    fetchedAt: null,
    reason: 'No runtime model catalog is available for this connection.',
    models: [],
    builtInModels: [],
  };
}

export function recordRuntimeCatalogStatus({
  adapter,
  catalog,
}: {
  adapter: ProviderAdapterShape;
  catalog: RuntimeCatalogStatus | undefined;
}): void {
  const builtin =
    getProviderAdapterRegistrationProvenance(adapter) === 'builtin';
  const attributes = {
    provider: builtin ? adapter.provider : 'plugin',
    source: catalog?.source ?? 'none',
    hasModelCapabilities:
      catalog?.models.some((model) => model.capabilities !== undefined) ??
      false,
  };
  providerCatalogOps.add(1, {
    op: 'resolve_catalog',
    ...attributes,
    hasLiveDiscovery: Boolean(adapter.listModelCatalog ?? adapter.listModels),
  });
  providerCatalogModelCount.record(catalog?.models.length ?? 0, attributes);
  providerCatalogBuiltInModelCount.record(
    catalog?.builtInModels.length ?? 0,
    attributes,
  );
}

function providerCapabilityStatusFor(
  enabled: boolean,
  prerequisites: Prerequisite[],
  catalog: RuntimeCatalogStatus | undefined,
): ProviderCapabilityStatus {
  if (!enabled) return 'disabled';
  if (hasRequiredMissing(prerequisites)) return 'warning';
  if (!catalog || catalog.source === 'none') return 'unknown';
  return 'ready';
}

function providerCapabilityFreshnessFor(
  catalog: RuntimeCatalogStatus | undefined,
): ProviderCapabilityFreshness {
  if (!catalog) return 'unknown';
  if (catalog.source === 'live') return 'live';
  if (catalog.source === 'cached') return 'cached';
  if (catalog.source === 'built-in') return 'stale';
  return 'unknown';
}

function runtimeCapabilityProvenance({
  connectionId,
  connectionName,
}: {
  connectionId: string;
  connectionName: string;
}): GuidanceAssetReference {
  return {
    kind: 'provider-capability',
    id: connectionId,
    name: connectionName,
    owner: 'provider',
    providerId: connectionId,
    connectionId,
  };
}

export function buildRuntimeCapabilityInventory({
  adapter,
  id,
  displayName,
  enabled,
  prerequisites,
  catalog,
  commands,
}: {
  adapter: ProviderAdapterShape;
  id: string;
  displayName: string;
  enabled: boolean;
  prerequisites: Prerequisite[];
  catalog: RuntimeCatalogStatus | undefined;
  commands: Awaited<
    ReturnType<NonNullable<ProviderAdapterShape['getCommands']>>
  >;
}): ProviderCapabilityInventory {
  const visibleModels =
    catalog && catalog.models.length > 0
      ? catalog.models
      : (catalog?.builtInModels ?? []);
  return {
    providerId: adapter.provider,
    connectionId: id,
    displayName,
    status: providerCapabilityStatusFor(enabled, prerequisites, catalog),
    authStatus: hasRequiredMissing(prerequisites)
      ? 'unauthenticated'
      : 'unknown',
    checkedAt: catalog?.fetchedAt ?? undefined,
    freshness: providerCapabilityFreshnessFor(catalog),
    source: 'provider',
    message: catalog?.reason ?? undefined,
    models: visibleModels.map((model) => ({
      id: model.id,
      name: model.name,
      provider: adapter.provider,
    })),
    skills: [],
    slashCommands: (commands ?? []).map((command) => ({
      id: command.name.replace(/^\//, ''),
      name: `/${command.name.replace(/^\//, '')}`,
      description: command.description,
      inputHint: command.argumentHint,
      provenance: runtimeCapabilityProvenance({
        connectionId: id,
        connectionName: displayName,
      }),
    })),
  };
}

/** archive#895 wave B: project a single connection's live-handshake capabilities
 * (`ACPConnectionCapabilitiesStatus`) into `ProviderSessionSurfaceEvidence` —
 * stdio is always included in `mcpTransports` (the probe-not-advertisement
 * baseline, agent-engine-unification.md §4.1); http/sse are added only when
 * the handshake actually advertised them. `undefined` when no live
 * capabilities were captured (probe never succeeded yet). */
function projectSessionSurfaces(
  connection: ACPConnectionStatus | undefined,
): ProviderSessionSurfaceEvidence | undefined {
  const capabilities = connection?.capabilities;
  if (!capabilities) return undefined;
  const mcpTransports: Array<'stdio' | 'http' | 'sse'> = ['stdio'];
  if (capabilities.mcpCapabilities?.http) mcpTransports.push('http');
  if (capabilities.mcpCapabilities?.sse) mcpTransports.push('sse');
  return {
    loadSession: capabilities.loadSession,
    mcpTransports,
    promptImage: capabilities.promptCapabilities?.image,
    promptAudio: capabilities.promptCapabilities?.audio,
    promptEmbeddedContext: capabilities.promptCapabilities?.embeddedContext,
    sessionResume: capabilities.sessionCapabilities?.resume !== undefined,
  };
}

/**
 * archive#1549: takes THE ONE connection's live status, not a list.
 *
 * It previously took `{ connections?: ACPConnectionStatus[] }` and read
 * `connections?.[0]` for `sessionSurfaces` — which reads as a
 * first-connection collapse and was reported as one. It is not: the sole
 * call site already passes a synthetic single-element array built from that
 * connection's own `liveStatus`, and
 * `connection-service-helpers.test.ts`'s per-connection test pins it. The
 * defect was in the SHAPE, which invited exactly that misreading; taking the
 * single connection makes the per-connection contract structural.
 */
export function buildACPCapabilityInventory({
  connection,
  configuredCount,
  connectedCount,
  enabled,
}: {
  connection: ACPConnectionStatus | undefined;
  configuredCount: number;
  connectedCount: number;
  enabled: boolean;
}): ProviderCapabilityInventory {
  // Narrowed once rather than optional-chained inside the map: `connection`
  // is necessarily defined there (the array came off it), and
  // `${connection?.id}` is the one form that would silently mint the literal
  // id "undefined:cmd" instead of failing — a substitute that participates in an
  // IDENTITY, not a display (docs/guides/code-quality.md).
  const slashCommands = connection
    ? (connection.slashCommands ?? []).map((command) => ({
        id: `${connection.id}:${command.name.replace(/^\//, '')}`,
        name: command.name.startsWith('/') ? command.name : `/${command.name}`,
        description: command.description,
        inputHint: command.hint,
        provenance: runtimeCapabilityProvenance({
          connectionId: connection.id,
          connectionName: connection.id,
        }),
      }))
    : [];

  return {
    providerId: 'acp',
    connectionId: 'acp',
    displayName: 'Custom engine',
    status: !enabled
      ? 'disabled'
      : configuredCount === 0
        ? 'warning'
        : connectedCount > 0
          ? 'ready'
          : 'warning',
    authStatus: configuredCount > 0 ? 'unknown' : 'unauthenticated',
    freshness: connectedCount > 0 ? 'live' : 'unknown',
    source: 'provider',
    message:
      configuredCount === 0
        ? 'Configure a command-backed engine connection to expose external runtime capabilities.'
        : undefined,
    models: [],
    skills: [],
    slashCommands,
    sessionSurfaces: projectSessionSurfaces(connection),
  };
}

/**
 * archive#1549: the per-connection `ControlPlaneObservation` the capability
 * derivation (`engineControlPlaneCapability`) consumes — derived from the
 * SAME live handshake `projectSessionSurfaces` above projects, so the
 * evidence a surface explains and the evidence a capability is derived from
 * are one record.
 *
 * Keyed on the HANDSHAKE, not on the presence of capabilities (review
 * finding). A successful `initialize` that carried no `agentCapabilities` at
 * all — legal in the ACP SDK, and not defaulted on the client path — is a
 * real observation whose answer is `mcpHttp: false`. Keying on capability
 * presence would report a CLI Station has connected to, handshaked with, and
 * created a session on as "not checked yet", permanently and unfixably.
 *
 * `undefined` therefore means exactly one thing: no handshake has ever
 * succeeded for this connection. That is NOT `{ mcpHttp: false }` — "never
 * met this CLI" and "this CLI says no" are different facts and the derivation
 * gives them different answers (`observation-required` vs `chat-only`).
 *
 * An observation without a timestamp is not recorded: undated evidence
 * cannot be reasoned about for staleness, and inventing `Date.now()` here
 * would date the read, not the observation.
 */
export function projectControlPlaneObservation(
  connection: ACPConnectionStatus | undefined,
): ControlPlaneObservation | undefined {
  const observedAt = connection?.handshakeObservedAt;
  if (!observedAt) return undefined;
  return {
    mcpHttp: connection?.capabilities?.mcpCapabilities?.http === true,
    observedAt,
  };
}

/**
 * archive#3054: project an ACP connection's live model catalog into the
 * RuntimeCatalogStatus every other engine connection already carries. The
 * catalog is the handshake's category-'model' config option — a real runtime
 * observation (archive#1549's handshakeObservedAt dates it), which is exactly
 * the evidence the acp capability matrix's wire-channel model-selection gate
 * requires. Without this projection the in-chat model button stayed disabled
 * for every ACP engine while the catalog sat in the manager status.
 */
export function acpRuntimeCatalogStatus(
  liveStatus: ACPConnectionStatus | undefined,
): RuntimeCatalogStatus {
  const modelOption = liveStatus?.configOptions?.find(
    (option) => option.category === 'model',
  );
  const models = (modelOption?.options ?? [])
    .map((entry) =>
      typeof entry === 'string' ? { value: entry, name: entry } : entry,
    )
    .flatMap((entry) =>
      typeof entry?.value === 'string' && entry.value.length > 0
        ? [
            {
              id: entry.value,
              name: entry.name ?? entry.value,
              originalId: entry.value,
            },
          ]
        : [],
    );
  if (models.length === 0) {
    return {
      source: 'none',
      reason: liveStatus?.handshakeObservedAt
        ? "The engine's initialize handshake advertised no model catalog."
        : 'No successful initialize handshake has been observed yet.',
      models: [],
      builtInModels: [],
    };
  }
  return {
    source: 'live',
    fetchedAt: liveStatus?.handshakeObservedAt ?? null,
    reason: null,
    models,
    builtInModels: [],
  };
}
