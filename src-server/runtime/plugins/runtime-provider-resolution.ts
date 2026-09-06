import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { AppConfig } from '@kontourai/station-contracts/config';
import { classifyManagedModelBinding } from '@kontourai/station-contracts/managed-model-binding';
import type { ProviderConnectionConfig } from '@kontourai/station-contracts/tool';
import {
  createEmbeddingProvider,
  createLLMProvider,
  createVectorDbProvider,
} from '../../providers/connection-factories.js';
import type { BedrockAuthMode } from '../../providers/llm/bedrock-credentials.js';
import { BedrockModelCatalog } from '../../providers/llm/bedrock-models.js';
import { resolveBedrockRegion } from '../../providers/llm/bedrock-region.js';
import { resolveExactModelSelector } from '../../providers/llm/model-catalog.js';
import type { ProviderService } from '../../services/connections/provider-service.js';
import type { Logger } from '../../utils/logger.js';
import type { DispatchEvidenceSource, IAgentFramework } from '../types.js';

type ProviderConnection = ReturnType<
  ProviderService['listProviderConnections']
>[number];
type ProviderCapability = ProviderConnection['capabilities'][number];

export interface ResolvedManagedModelBinding {
  providerConnection: ProviderConnectionConfig;
  providerType: string;
  modelId: string;
  region?: string;
}

export interface ResolvedManagedModelIdentity {
  providerConnection: ProviderConnectionConfig;
  providerType: string;
  modelId: string;
  region?: string;
}

export class ManagedModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedModelUnavailableError';
  }
}

interface BedrockModelResolver {
  resolveModelId(modelId: string): Promise<string>;
  forRegion?(region: string): BedrockModelResolver;
}

/**
 * archive#1557 review fix: this was a second copy of the region chain, with
 * its own `'us-east-1'` tail and no `AWS_REGION`. It now delegates, so the
 * chain has exactly one definition.
 */
export function resolveEffectiveBedrockRegion(
  spec: Pick<AgentSpec, 'region'>,
  providerConnection: ProviderConnectionConfig,
  appConfig: Pick<AppConfig, 'region'>,
): string {
  const connectionRegion = providerConnection.config?.region;
  return resolveBedrockRegion({
    agentRegion: spec.region,
    connectionRegion:
      typeof connectionRegion === 'string' ? connectionRegion : undefined,
    configRegion: appConfig.region,
    env: process.env,
  }).region;
}

export async function createRuntimeFrameworkModel(
  spec: AgentSpec,
  options: {
    framework: IAgentFramework;
    appConfig: AppConfig;
    projectHomeDir: string;
    modelCatalog?: BedrockModelCatalog;
    listProviderConnections?: () => ProviderConnectionConfig[];
    /** Live connection evidence for Dispatch candidate grading (archive#1426). */
    dispatchEvidenceSource?: DispatchEvidenceSource;
    logger?: Logger;
  },
) {
  return options.framework.createModel(spec, {
    appConfig: options.appConfig,
    projectHomeDir: options.projectHomeDir,
    modelCatalog: options.modelCatalog,
    listProviderConnections: options.listProviderConnections,
    dispatchEvidenceSource: options.dispatchEvidenceSource,
    logger: options.logger,
  });
}

export async function createRuntimeModelSelection(
  spec: AgentSpec,
  modelId: string,
  options: {
    framework: IAgentFramework;
    appConfig: AppConfig;
    projectHomeDir: string;
    modelCatalog?: BedrockModelCatalog;
    listProviderConnections?: () => ProviderConnectionConfig[];
    /** Live connection evidence for Dispatch candidate grading (archive#1426). */
    dispatchEvidenceSource?: DispatchEvidenceSource;
    logger?: Logger;
  },
): Promise<{
  model: Awaited<ReturnType<IAgentFramework['createModel']>>;
  identity: ResolvedManagedModelIdentity;
  spec: AgentSpec;
}> {
  const selectedSpec = {
    ...spec,
    model: modelId,
    execution: {
      ...spec.execution,
      modelId,
    },
  } as AgentSpec;
  const identity = resolveManagedModelIdentity(selectedSpec, options);
  if (identity.providerType === 'bedrock' && !options.modelCatalog) {
    throw new Error(
      'Bedrock model catalog is required to resolve the requested model.',
    );
  }
  return {
    model: await createRuntimeFrameworkModel(selectedSpec, options),
    identity,
    spec: selectedSpec,
  };
}

export async function resolveConfiguredModelId(
  spec: Pick<AgentSpec, 'model'>,
  options: {
    appConfig: Pick<AppConfig, 'defaultModel'>;
    modelCatalog?: BedrockModelResolver;
  },
): Promise<string> {
  const modelId = spec.model || options.appConfig.defaultModel || '';
  if (!modelId) {
    throw new Error('A Bedrock model selector is required.');
  }
  if (!options.modelCatalog) {
    throw new Error(
      'Bedrock model catalog is required to resolve a launchable selector.',
    );
  }
  return options.modelCatalog.resolveModelId(modelId);
}

export async function resolveManagedModelBinding(
  spec: Pick<AgentSpec, 'model' | 'execution' | 'region'>,
  options: {
    appConfig: Pick<
      AppConfig,
      'defaultLLMProvider' | 'defaultModel' | 'region'
    >;
    listProviderConnections?: () => ProviderConnectionConfig[];
    modelCatalog?: BedrockModelResolver;
  },
): Promise<ResolvedManagedModelBinding> {
  const identity = resolveManagedModelIdentity(spec, options);
  const providerConnection = identity.providerConnection;
  let modelId: string;
  try {
    modelId = await resolveManagedModelId(spec, {
      appConfig: options.appConfig,
      providerConnection,
      modelCatalog: options.modelCatalog,
    });
  } catch (error) {
    if (error instanceof ManagedModelUnavailableError) throw error;
    throw new ManagedModelUnavailableError(
      error instanceof Error ? error.message : String(error),
    );
  }

  return {
    providerConnection,
    providerType: providerConnection.type,
    modelId,
    ...(identity.region ? { region: identity.region } : {}),
  };
}

export function resolveManagedModelIdentity(
  spec: Pick<AgentSpec, 'model' | 'execution' | 'region'>,
  options: {
    appConfig: Pick<
      AppConfig,
      'defaultLLMProvider' | 'defaultModel' | 'region'
    >;
    listProviderConnections?: () => ProviderConnectionConfig[];
    /**
     * Connections whose latest check, bound to their current configuration,
     * is a readiness-gating fault, and which fault
     * (`ConnectionService.checkGatedModelConnectionIds`).
     *
     * Supplied only by the LEGIBILITY probe below, never by the execution
     * binding: a receipt is a claim about the past, and the delivery attempt
     * performs its own authoritative request. Passing it here is what makes
     * Home's "this agent can run" answer agree with the Connections hub's
     * "this connection's check failed" (station RT-06 review H1) without
     * letting a stale refusal strand a connection that has started working.
     */
    gatedConnectionIds?: ReadonlyMap<string, 'failed' | 'unreachable'>;
  },
): ResolvedManagedModelIdentity {
  const providerConnection = resolveManagedProviderConnection(
    spec,
    options.appConfig,
    options.listProviderConnections?.() ?? [],
  );
  // Selection semantics are untouched: the connection is resolved exactly as
  // before, and only then asked whether it is known to be refused. Filtering
  // the candidate list instead would have reported "No enabled LLM provider
  // connection is configured" for a connection that plainly exists.
  const gatingFault = options.gatedConnectionIds?.get(providerConnection.id);
  if (gatingFault) {
    const label = providerConnection.name || providerConnection.id;
    throw new ManagedModelUnavailableError(
      gatingFault === 'unreachable'
        ? `Model connection '${label}' could not be reached at its last check. Check that the provider is running and reachable, then test it again in Connections.`
        : `Model connection '${label}' was refused by its provider at its last check. Fix its settings and test it again in Connections.`,
    );
  }
  const modelId = firstDefinedString(
    spec.execution?.modelId,
    spec.model,
    getConnectionDefaultModel(providerConnection),
    options.appConfig.defaultModel,
  );
  if (!modelId) {
    throw new ManagedModelUnavailableError('A model selector is required.');
  }
  return {
    providerConnection,
    providerType: providerConnection.type,
    modelId,
    ...(providerConnection.type === 'bedrock'
      ? {
          region: resolveEffectiveBedrockRegion(
            spec,
            providerConnection,
            options.appConfig,
          ),
        }
      : {}),
  };
}

/**
 * Which model connection the managed engine would actually select, or which
 * kind of unanswerable this configuration is.
 *
 * Delta review H2: system status asked whether ANY enabled LLM connection
 * lacked a refusal, while selection honours the agent's explicit
 * `modelConnectionId` and then `defaultLLMProvider`. So an agent bound to a
 * refused connection could still be reported chat-ready "through" a healthy
 * sibling that is not its binding. This is the same resolver the binding
 * uses, exposed without throwing so a status route can ask "which one?"
 * rather than "is there one?".
 *
 * Delta2 review H2: and so it can tell `none` from `ambiguous`/`invalid`.
 * Collapsing all three to `null` is what let an ambiguous configuration —
 * where the agent resolves to nothing at all — be reported ready through
 * whichever sibling happened to sort first.
 */
export function resolveManagedChatBinding(
  spec: Pick<AgentSpec, 'execution'>,
  options: {
    appConfig: Pick<AppConfig, 'defaultLLMProvider'>;
    listProviderConnections?: () => ProviderConnectionConfig[];
  },
): ManagedChatBinding {
  const resolution = classifyManagedProviderConnection(
    spec,
    options.appConfig,
    options.listProviderConnections?.() ?? [],
  );
  switch (resolution.kind) {
    case 'resolved':
      return { kind: 'resolved', connectionId: resolution.connection.id };
    case 'invalid':
      return {
        kind: 'invalid',
        declaredConnectionId: resolution.declaredConnectionId,
      };
    case 'ambiguous':
      return { kind: 'ambiguous' };
    default:
      return { kind: 'none' };
  }
}

/**
 * Non-throwing legibility probe: returns `null` when `spec` resolves to a
 * launchable managed model identity, or the human-readable reason it does not
 * (the same `ManagedModelUnavailableError` message the registration path
 * swallows when it skips an agent — `runtime-agent-lifecycle.ts:88-93`). Used
 * by the agents route to surface store-only agents as `available: false` with
 * a concrete reason, and by the chat route to return a specific 409 instead of
 * a bare 404, without changing model-resolution semantics. Deliberately reuses
 * the synchronous `resolveManagedModelIdentity` (and therefore the private
 * `resolveManagedProviderConnection`) so it does no provider network I/O — it
 * detects the ambiguous/missing-connection and missing-model triggers, which
 * is exactly the class of failure that leaves an agent unregistered.
 */
export function resolveManagedAvailabilityReason(
  spec: Pick<AgentSpec, 'model' | 'execution' | 'region'>,
  options: {
    appConfig: Pick<
      AppConfig,
      'defaultLLMProvider' | 'defaultModel' | 'region'
    >;
    listProviderConnections?: () => ProviderConnectionConfig[];
    /** See `resolveManagedModelIdentity`; legibility only. */
    gatedConnectionIds?: ReadonlyMap<string, 'failed' | 'unreachable'>;
  },
): string | null {
  try {
    resolveManagedModelIdentity(spec, options);
    return null;
  } catch (error) {
    if (error instanceof ManagedModelUnavailableError) {
      return error.message;
    }
    throw error;
  }
}

/**
 * The minimum a caller has to expose for {@link
 * createStationEngineAvailabilityReader}. Narrowed to what the reader reads,
 * rather than the whole route context, so the reader stays out of the route
 * layer and its dependency is legible from the signature.
 */
export interface StationEngineAvailabilitySource {
  /**
   * The CURRENT app config, never the route-construction snapshot: the default
   * model connection is a setting a user changes while Station runs.
   */
  getLiveAppConfig: () => Pick<
    AppConfig,
    'defaultLLMProvider' | 'defaultModel' | 'region'
  >;
  providerService: {
    listProviderConnections: () => ProviderConnectionConfig[];
  };
  connectionService: {
    checkGatedModelConnectionIds: () => ReadonlyMap<
      string,
      'failed' | 'unreachable'
    >;
  };
}

/**
 * Whether a Station-engine Agent can run right now, and why not — the ONE
 * reader every surface that asks goes through (#1536 D8, review H2).
 *
 * Five call sites built this call separately, and they had already drifted:
 * three passed the app config as it stood when routes were CONSTRUCTED, and
 * one of those also omitted `gatedConnectionIds` (`runtime-routes.ts`'s own
 * docblock says to read `getLiveAppConfig()` for anything a user can change
 * while Station runs — the default model connection above all). So with two
 * enabled LLM connections, setting a default at runtime cleared the attention
 * item while the New Chat picker went on refusing until restart: the same
 * disagreement #1536 D8 exists to close, inverted. Same function, same
 * inputs, one place to change them.
 */
export function createStationEngineAvailabilityReader(
  source: StationEngineAvailabilitySource,
): (spec: Pick<AgentSpec, 'model' | 'execution' | 'region'>) => string | null {
  return (spec) =>
    resolveManagedAvailabilityReason(spec, {
      appConfig: source.getLiveAppConfig(),
      listProviderConnections: () =>
        source.providerService.listProviderConnections(),
      // The same receipts the Connections hub reads, so an agent bound to a
      // faulted connection is not reported runnable beside a card saying its
      // check failed.
      gatedConnectionIds:
        source.connectionService.checkGatedModelConnectionIds(),
    });
}

export function resolveDefaultManagedModelHint(
  appConfig: Pick<AppConfig, 'defaultLLMProvider' | 'defaultModel'>,
  providerConnections: ProviderConnectionConfig[],
): string | null {
  let providerConnection: ProviderConnectionConfig;
  try {
    providerConnection = resolveManagedProviderConnection(
      {},
      appConfig,
      providerConnections,
    );
  } catch {
    return null;
  }
  return (
    firstDefinedString(
      appConfig.defaultModel,
      getConnectionDefaultModel(providerConnection),
    ) || null
  );
}

export function resolveRuntimeVectorDbProvider(
  providerService: ProviderService,
) {
  const connection = findRuntimeCapabilityConnection(
    providerService,
    'vectordb',
  );
  return connection ? createVectorDbProvider(connection) : null;
}

export function resolveRuntimeEmbeddingProvider(
  providerService: ProviderService,
) {
  const connection = findRuntimeCapabilityConnection(
    providerService,
    'embedding',
  );
  return connection ? createEmbeddingProvider(connection) : null;
}

function findRuntimeCapabilityConnection(
  providerService: Pick<ProviderService, 'listProviderConnections'>,
  capability: ProviderCapability,
): ProviderConnection | undefined {
  return providerService
    .listProviderConnections()
    .find(
      (connection) =>
        connection.enabled && connection.capabilities.includes(capability),
    );
}

/**
 * Which connection managed chat would select, or WHY it cannot say.
 *
 * Delta2 review H2: the legibility probe used to answer `string | null`, and
 * `null` was read as "no opinion, fall back to any unrefused connection" —
 * which is the one thing selection never does. `ambiguous` (several enabled,
 * no declared default) and `invalid` (a declared default that is not there)
 * are states in which the agent resolves to NOTHING, so a caller that treats
 * them like an absent resolver reports readiness through a connection the
 * agent could never reach.
 */
export type ManagedChatBinding =
  | { kind: 'resolved'; connectionId: string }
  | { kind: 'none' }
  | { kind: 'ambiguous' }
  | { kind: 'invalid'; declaredConnectionId: string };

type ManagedProviderResolution =
  | { kind: 'resolved'; connection: ProviderConnectionConfig }
  | { kind: 'none'; reason: string }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'invalid'; reason: string; declaredConnectionId: string };

/**
 * The one selection rule applied to THIS runtime's connection records.
 *
 * The rule itself is `classifyManagedModelBinding`
 * (`@kontourai/station-contracts/managed-model-binding`) — shared, so the
 * agent editor gates on the same decision instead of mirroring it. This
 * function is the runtime's half: hand the classifier the connections, take
 * back the decision, and attach the record and the sentence a thrown
 * `ManagedModelUnavailableError` carries. Candidacy (enabled + `llm`) is the
 * classifier's, which is why callers no longer pre-filter.
 */
function classifyManagedProviderConnection(
  spec: Pick<AgentSpec, 'execution'>,
  appConfig: Pick<AppConfig, 'defaultLLMProvider'>,
  providerConnections: ProviderConnectionConfig[],
): ManagedProviderResolution {
  const binding = classifyManagedModelBinding({
    declaredConnectionId: spec.execution?.modelConnectionId,
    appDefaultConnectionId: appConfig.defaultLLMProvider,
    connections: providerConnections,
  });
  switch (binding.kind) {
    case 'resolved': {
      const connection = providerConnections.find(
        (candidate) => candidate.id === binding.connectionId,
      );
      // Unreachable: the classifier only names a connection it was given.
      return connection
        ? { kind: 'resolved', connection }
        : {
            kind: 'invalid',
            declaredConnectionId: binding.connectionId,
            reason: `Configured LLM provider connection '${binding.connectionId}' is unavailable.`,
          };
    }
    case 'invalid':
      return {
        kind: 'invalid',
        declaredConnectionId: binding.declaredConnectionId,
        reason:
          binding.source === 'explicit'
            ? `Configured LLM provider connection '${binding.declaredConnectionId}' is unavailable.`
            : `Default LLM provider connection '${binding.declaredConnectionId}' is unavailable.`,
      };
    case 'none':
      return {
        kind: 'none',
        reason: 'No enabled LLM provider connection is configured.',
      };
    default:
      return {
        kind: 'ambiguous',
        reason:
          'Multiple enabled LLM provider connections require an explicit default.',
      };
  }
}

function resolveManagedProviderConnection(
  spec: Pick<AgentSpec, 'execution'>,
  appConfig: Pick<AppConfig, 'defaultLLMProvider'>,
  providerConnections: ProviderConnectionConfig[],
): ProviderConnectionConfig {
  const resolution = classifyManagedProviderConnection(
    spec,
    appConfig,
    providerConnections,
  );
  if (resolution.kind === 'resolved') return resolution.connection;
  throw new ManagedModelUnavailableError(resolution.reason);
}

async function resolveManagedModelId(
  spec: Pick<AgentSpec, 'model' | 'execution' | 'region'>,
  options: {
    appConfig: Pick<AppConfig, 'defaultModel' | 'region'>;
    providerConnection: ProviderConnectionConfig;
    modelCatalog?: BedrockModelResolver;
  },
): Promise<string> {
  const preferredModel = firstDefinedString(
    spec.execution?.modelId,
    spec.model,
    getConnectionDefaultModel(options.providerConnection),
    options.appConfig.defaultModel,
  );
  if (options.providerConnection.type === 'bedrock') {
    const region = resolveEffectiveBedrockRegion(
      spec,
      options.providerConnection,
      options.appConfig,
    );
    const auth = resolveBedrockConnectionAuth(options.providerConnection);
    // HIGH-4 (review fix round): the injected `options.modelCatalog` is a
    // process-global catalog authenticated against the default credential
    // chain (see `runtime-initialize.ts`) — correct for the chain-auth
    // default path, but resolving a `profile`/`api-key` connection's model
    // launchability against it would silently check the WRONG AWS account.
    // A non-chain connection gets its own freshly bound catalog instead of
    // sharing (or being cached alongside) the global one.
    if (auth.authMode && auth.authMode !== 'chain') {
      const perConnectionCatalog = new BedrockModelCatalog(region, auth);
      try {
        return await resolveConfiguredModelId(
          { model: preferredModel },
          {
            appConfig: { defaultModel: preferredModel },
            modelCatalog: perConnectionCatalog,
          },
        );
      } finally {
        perConnectionCatalog.dispose();
      }
    }
    const regionalCatalog =
      options.modelCatalog?.forRegion?.(region) ?? options.modelCatalog;
    return resolveConfiguredModelId(
      { model: preferredModel },
      {
        appConfig: { defaultModel: preferredModel },
        modelCatalog: regionalCatalog,
      },
    );
  }

  const configuredModel = getConnectionDefaultModel(options.providerConnection);
  return resolveExactModelSelector(
    createLLMProvider(options.providerConnection),
    preferredModel,
    configuredModel ? [{ id: configuredModel, name: configuredModel }] : [],
  );
}

/**
 * Narrowed to what it actually reads (archive#3399 review): the connection's
 * saved `config` bag. Every caller holds some connection record, and demanding
 * one exact record type forced a cast at the seam where the shapes should have
 * reconciled.
 */
export function resolveBedrockConnectionAuth(
  providerConnection: Pick<ProviderConnectionConfig, 'config'>,
): { authMode?: BedrockAuthMode; profile?: string; apiKey?: string } {
  const config = providerConnection.config;
  const authMode = config?.authMode;
  const profile = config?.profile;
  const apiKey = config?.apiKey;
  return {
    authMode:
      typeof authMode === 'string' ? (authMode as BedrockAuthMode) : undefined,
    profile: typeof profile === 'string' ? profile : undefined,
    apiKey: typeof apiKey === 'string' ? apiKey : undefined,
  };
}

function firstDefinedString(
  ...values: Array<string | null | undefined>
): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return '';
}

function getConnectionDefaultModel(
  providerConnection: ProviderConnectionConfig,
): string {
  const value = providerConnection.config.defaultModel;
  return typeof value === 'string' ? value.trim() : '';
}
