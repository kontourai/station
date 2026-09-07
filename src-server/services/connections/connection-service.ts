import { createHash, randomUUID } from 'node:crypto';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import {
  type EngineConnectionId,
  engineConnectionId,
  engineId,
} from '@kontourai/station-contracts/agent-identity';
import type { AppConfig } from '@kontourai/station-contracts/config';
import type { ConnectionQuotaResult } from '@kontourai/station-contracts/connection-quota';
import type {
  CredentialProfile,
  CredentialProfileApplicationCapability,
  CredentialProfileApplicationProjection,
  CredentialRecoveryGroupProjection,
} from '@kontourai/station-contracts/connection-recovery';
import { resolveCredentialProfileApplicationCapability } from '@kontourai/station-contracts/connection-recovery';
import type { FleetContributionManifest } from '@kontourai/station-contracts/fleet-contribution';
import {
  declaredContributionConnectionIds,
  isFleetContributionEnabled,
} from '@kontourai/station-contracts/fleet-contribution';
import type {
  ConnectionInventoryFailure,
  LaunchableModelInventory,
} from '@kontourai/station-contracts/model-inventory';
import { isLlmModelConnection } from '@kontourai/station-contracts/model-inventory';
import type { EngineId } from '@kontourai/station-contracts/provider';
import {
  type AgentConnectionView,
  CONNECTION_UNREACHABLE_GRACE_MS,
  CONNECTION_UNREACHABLE_GRACE_OBSERVATIONS,
  type ConnectionCheckEvidence,
  type ConnectionConfig,
  type ConnectionReadinessEvidence,
  type ConnectionSmokeFailureReason,
  type ConnectionStatus,
  connectionCheckGatesReadiness,
  type ModelOption,
  type Prerequisite,
  type ProviderConnectionConfig,
} from '@kontourai/station-contracts/tool';
import { sanitizeFreeText } from '@kontourai/station-shared/redaction';
import { type AgentRegistry } from '../../domain/agent-registry.js';
import {
  connectionIdForAdapter,
  engineIdForAdapter,
} from '../../providers/adapter-identity.js';
import type { ProviderAdapterShape } from '../../providers/adapter-shape.js';
import type { LegacyCredentialProfileRegistryState } from '../../providers/app-home/credential-profile-registry.js';
import {
  deleteCredentialProfile,
  normalizeCredentialProfileRegistry,
  projectCredentialProfileRegistry,
  setCredentialProfileEnrollment,
  setCredentialRecoveryAutomaticPolicy,
  upsertCredentialProfile,
} from '../../providers/app-home/credential-profile-registry.js';

type CredentialProfileApplicationSettlement =
  | { kind: 'staged' }
  | { kind: 'adopted' }
  | { kind: 'already-adopted' }
  | { kind: 'rolled-back' }
  | { kind: 'already-rolled-back' }
  | { kind: 'superseded' }
  | { kind: 'unknown' };

import {
  curatedModelIdentityFor,
  modelRouteFamilyFor,
} from '@kontourai/station-contracts/model-inventory';
import {
  createEmbeddingProvider,
  createLLMProvider,
  createVectorDbProvider,
} from '../../providers/connection-factories.js';
import {
  classifyCatalogFailure,
  type SafeModelCatalog,
  safeListModelCatalog,
} from '../../providers/llm/model-catalog.js';
import type {
  ILLMProvider,
  LLMModel,
} from '../../providers/llm/model-provider-types.js';
import { redactProviderIdentifiers } from '../../providers/llm/provider-reason-redaction.js';
import { providerHttpErrorStatus } from '../../providers/registries/catalog-http.js';
import {
  configOps,
  credentialProfileApplication,
  fleetContributionManifestTotal,
  fleetContributionModelCount,
  modelInventoryDiagnosticCount,
  modelInventoryModelCount,
  modelInventoryRefreshDuration,
  modelInventoryRefreshTotal,
  modelInventoryResponseTotal,
} from '../../telemetry/metrics.js';
import {
  awaitSettlementWithin,
  mapWithConcurrency,
  raceWithSignal,
  settleConcurrentWork,
  throwIfAborted,
} from '../../utils/bounded-async.js';
import type { CredentialApplicationHandle } from '../orchestration/credential-application-ledger.js';
import type { CredentialProfileRecoveryAdapter } from '../orchestration/credential-recovery-module.js';
import type { EventStore } from '../orchestration/event-store.js';
import { createConnectionInspector } from './connection-inspector.js';
import { deriveConnectionReadinessEvidence } from './connection-readiness-evidence.js';
import type {
  ClassifiedConnectionFailure,
  CredentialRecoverySelectionRefusalReason,
} from './connection-recovery-policy.js';
import { selectCredentialRecoveryCandidate } from './connection-recovery-policy.js';
import { redactConnectionSecretEchoes } from './connection-refusal-redaction.js';
import {
  type ACPConnectionStatus,
  hasRequiredMissing,
  MODEL_CAPABILITY_SET,
  type RuntimeConnectionProjection,
  sanitizeRuntimeConfig,
  toModelConnection,
} from './connection-service-helpers.js';
import {
  type ConnectionSmokeEvidenceStore,
  deriveConnectionSmokeFreshUntil,
  MemoryConnectionSmokeEvidenceStore,
  type StoredConnectionSmokeResult,
} from './connection-smoke-evidence-store.js';
import { projectFleetContributionManifest } from './fleet-contribution-manifest.js';
import type {
  AppConfigLaunchabilitySnapshot,
  AppConfigLaunchabilitySource,
  LaunchabilityRevisionSource,
} from './launchability-revision.js';
import {
  boundLaunchableModelInventory,
  buildLaunchableModelInventory,
  type ModelConnectionInventorySource,
} from './launchable-model-inventory.js';
import type {
  ProviderLaunchabilitySnapshot,
  ProviderService,
} from './provider-service.js';
import type {
  RuntimeAuthenticationFailure,
  RuntimeAuthHealthMonitor,
} from './runtime-auth-health-monitor.js';

const RUNTIME_AUTH_PREREQUISITE_ID = 'runtime-authentication';
const MODEL_INVENTORY_REFRESH_TIMEOUT_MS = 5000;
const MODEL_INVENTORY_ABORT_SETTLEMENT_MS = 650;
const MODEL_INVENTORY_DISCOVERY_TIMEOUT_MS =
  MODEL_INVENTORY_REFRESH_TIMEOUT_MS - MODEL_INVENTORY_ABORT_SETTLEMENT_MS;
const MODEL_INVENTORY_STALE_MAX_AGE_MS = 15 * 60 * 1000;
const MODEL_INVENTORY_MAX_CONNECTIONS = 64;
const MODEL_INVENTORY_DISCOVERY_CONCURRENCY = 4;
const MODEL_INVENTORY_DIAGNOSTIC_ID = 'station:model-inventory';

export class ModelSelectionRequiredError extends Error {
  readonly modelOptions: ModelOption[];

  constructor(message: string, modelOptions: ModelOption[] = []) {
    super(message);
    this.name = 'ModelSelectionRequiredError';
    this.modelOptions = modelOptions;
  }
}

/** Opaque, in-memory handoff between selection/staging and provider adoption. */
export interface CredentialProfileApplicationAttempt {
  connectionId: string;
  attemptId: string;
  candidateProfileRef: string;
  capability: CredentialProfileApplicationCapability;
}

interface AutomaticCredentialProfileStageResult {
  attempt?: CredentialProfileApplicationAttempt;
  refusalReason?: CredentialRecoverySelectionRefusalReason | 'conflict';
}

class InventorySiblingAbort extends Error {
  constructor(cause: unknown) {
    super('Model inventory sibling discovery aborted after a branch failed.', {
      cause,
    });
  }
}

interface ModelCatalogCacheEntry {
  fingerprint: string;
  observedAt: string;
  cachedAt: number;
  models: LLMModel[];
}

interface ModelInventoryRefreshGeneration {
  epoch: number;
  sourceRevisions: number[];
  controller: AbortController;
  promise: Promise<LaunchableModelInventory>;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function connectionFingerprint(connection: ProviderConnectionConfig): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonicalize({
          type: connection.type,
          enabled: connection.enabled,
          capabilities: [...connection.capabilities].sort(),
          config: connection.config,
        }),
      ),
    )
    .digest('hex');
}

function connectionSmokeFingerprint(connection: ConnectionConfig): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonicalize({
          id: connection.id,
          kind: connection.kind,
          type: connection.type,
          enabled: connection.enabled,
          capabilities: [...connection.capabilities].sort(),
          config: connection.config,
        }),
      ),
    )
    .digest('hex');
}

function externalEngineRegistryBinding(
  connection: ConnectionConfig,
  adapters: readonly ProviderAdapterShape[],
): { id: EngineConnectionId; settingsId: string } | null {
  if (connection.kind !== 'agent') return null;
  if (connection.config?.engineId === 'station') return null;
  if (connection.config?.engineId === 'acp') {
    return {
      id: engineConnectionId(connection.id),
      settingsId: connection.id,
    };
  }
  const adapter = adapters.find(
    (candidate) => engineIdForAdapter(candidate) === connection.type,
  );
  return adapter
    ? {
        id: connectionIdForAdapter(adapter),
        settingsId: engineIdForAdapter(adapter),
      }
    : null;
}

function valueFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function configuredModelsFor(connection: ProviderConnectionConfig): LLMModel[] {
  const defaultModel = connection.config.defaultModel;
  if (typeof defaultModel !== 'string' || defaultModel.trim().length === 0) {
    return [];
  }
  const id = defaultModel.trim();
  return [{ id, name: id }];
}

function staleInventorySnapshot(
  snapshot: LaunchableModelInventory,
): LaunchableModelInventory {
  const diagnostics = [
    ...snapshot.diagnostics,
    {
      connectionId: MODEL_INVENTORY_DIAGNOSTIC_ID,
      code: 'refresh-unavailable' as const,
      message:
        'Station is serving the last successful inventory because refresh is unavailable.',
    },
  ];
  const uniqueDiagnostics = [
    ...new Map(
      diagnostics.map((item) => [
        `${item.connectionId}\u0000${item.code}\u0000${item.message}`,
        item,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      (left.connectionId < right.connectionId
        ? -1
        : left.connectionId > right.connectionId
          ? 1
          : 0) ||
      (left.code < right.code ? -1 : left.code > right.code ? 1 : 0) ||
      (left.message < right.message
        ? -1
        : left.message > right.message
          ? 1
          : 0),
  );
  return boundLaunchableModelInventory({
    ...snapshot,
    models: snapshot.models.map((model) => ({
      ...model,
      availability: 'stale',
      freshness: model.freshness === 'live' ? 'cached' : model.freshness,
    })),
    diagnostics: uniqueDiagnostics,
  });
}

async function withinInventoryDeadline<T>(
  operation: () => Promise<T>,
  controller: AbortController,
  startedAt: number,
): Promise<T> {
  const pending = Promise.resolve().then(operation);
  const timer = setTimeout(
    () => controller.abort(new Error('Model inventory refresh timed out.')),
    MODEL_INVENTORY_DISCOVERY_TIMEOUT_MS,
  );
  try {
    const result = await raceWithSignal(pending, controller.signal);
    if (Date.now() - startedAt > MODEL_INVENTORY_REFRESH_TIMEOUT_MS) {
      controller.abort(new Error('Model inventory refresh timed out.'));
      throw controller.signal.reason;
    }
    return result;
  } catch (error) {
    if (!controller.signal.aborted) {
      controller.abort(new InventorySiblingAbort(error));
    }
    await awaitSettlementWithin(pending, MODEL_INVENTORY_ABORT_SETTLEMENT_MS);
    if (controller.signal.reason instanceof InventorySiblingAbort) {
      throw controller.signal.reason.cause;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export interface ConnectionSmokeRunInput {
  connectionId: string;
  provider: EngineId;
  modelId?: string;
  cwd: string;
  metadata?: Record<string, unknown>;
  /** Server-only profile selector; never copied into smoke metadata/events. */
  credentialProfileRef?: string;
  /** Turn deadline; orchestration adds one separately bounded cleanup grace. */
  timeoutMs: number;
}

export type ConnectionSmokeRunResult =
  | { ok: true; durationMs: number; model?: string }
  | {
      ok: false;
      durationMs: number;
      reasonCode: ConnectionSmokeFailureReason;
      reason: string;
      action: string;
      model?: string;
    };

export type ConnectionSmokeRunner = (
  input: ConnectionSmokeRunInput,
) => Promise<ConnectionSmokeRunResult>;

function applyRuntimeAuthenticationFailure<
  T extends RuntimeConnectionProjection,
>(runtime: T, failure: RuntimeAuthenticationFailure): T {
  const provider = runtime.config.provider as EngineId | undefined;
  const providerLabel =
    typeof runtime.config.providerLabel === 'string'
      ? runtime.config.providerLabel
      : runtime.name;
  const readinessReason = `${providerLabel} rejected a real runtime request. Sign in again; Station will automatically recheck this client shortly.`;
  return {
    ...runtime,
    status: 'missing_prerequisites',
    lastCheckedAt: failure.observedAt,
    config: {
      ...runtime.config,
      readinessState: 'missing_prerequisites',
      readinessReason,
    },
    prerequisites: [
      ...runtime.prerequisites.filter(
        (prerequisite) => prerequisite.id !== RUNTIME_AUTH_PREREQUISITE_ID,
      ),
      {
        id: RUNTIME_AUTH_PREREQUISITE_ID,
        name: `${providerLabel} authentication`,
        description: readinessReason,
        status: 'missing',
        category: 'required',
      },
    ],
    capabilityInventory: runtime.capabilityInventory
      ? {
          ...runtime.capabilityInventory,
          providerId: provider ?? runtime.capabilityInventory.providerId,
          status: 'warning',
          authStatus: 'unauthenticated',
          checkedAt: failure.observedAt,
          message: readinessReason,
        }
      : undefined,
  };
}

/** An explicit chat probe is bounded; it never blocks a listing. */
const CHAT_PROBE_TIMEOUT_MS = 15_000;

/**
 * How a provider's own answer about its catalogue becomes a check receipt.
 * One table, read by discovery and by the explicit test, so the two cannot
 * classify the same failure differently.
 */
/**
 * What the chat probe saw, in the provider's own terms.
 *
 * The status is read off the failure structurally
 * (`LLMStreamChunk.errorStatus`, or the thrown error's own field), never
 * matched out of the message — see `providerHttpErrorStatus`. A failure
 * carrying no status keeps the provider's message unchanged rather than being
 * sorted into a class Station cannot actually tell it belongs to.
 */
function describeChatProbeFailure(
  message: string | undefined,
  status: number | undefined,
): string {
  const detail = message?.trim() || 'The provider rejected the chat request.';
  if (status === 401 || status === 403) {
    return `The provider refused a minimal chat request with these credentials (HTTP ${status}). ${detail}`;
  }
  if (status === 404) {
    // The model id is deliberately NOT quoted here: every configured string
    // is redacted out of a surfaced reason (see
    // `connection-refusal-redaction.ts`), so naming it would print
    // "[redacted]" where the useful word should be.
    return `The provider has no such model on this endpoint (HTTP 404). Check this connection's default model, then test it again. ${detail}`;
  }
  return detail;
}

const MODEL_CHECK_STATUS_BY_REASON_KIND: Record<
  'refused' | 'no-catalog' | 'unreachable',
  ModelCheckStatus
> = {
  refused: 'failed',
  'no-catalog': 'catalog-unavailable',
  unreachable: 'unreachable',
};

type ModelCheckStatus = Exclude<
  ConnectionCheckEvidence['status'],
  'not-checked'
>;

type ModelCheckOutcome = {
  status: ModelCheckStatus;
  reason?: string;
};

/** One bound check receipt: what a real request with this exact config saw. */
interface ModelCheckObservation {
  configurationFingerprint: string;
  checkedAt: string;
  status: ModelCheckStatus;
  reason?: string;
  source: 'explicit-test' | 'catalog-discovery';
  /**
   * `unreachable` only — how long Station has been unable to reach this
   * endpoint, and whether it had ever reached it before (station RT-06 delta2
   * review M1).
   *
   * Discovery runs on every listing, so one DNS failure, connection reset or
   * momentary provider outage used to overwrite an explicit pass with a
   * durable refusal and drop an otherwise healthy connection out of every
   * recommendation. These three fields are what turn "one listing missed" into
   * "this connection is down": a run that follows a pass is tolerated for
   * `CONNECTION_UNREACHABLE_GRACE_OBSERVATIONS` consecutive observations or
   * `CONNECTION_UNREACHABLE_GRACE_MS`, whichever comes first. With no prior
   * pass there is nothing to protect and nothing to wait for.
   */
  unreachable?: { since: string; consecutive: number; afterPass: boolean };
}

export class ConnectionService {
  private smokeRunner: ConnectionSmokeRunner | null = null;
  private readonly modelCatalogCache = new Map<
    string,
    ModelCatalogCacheEntry
  >();
  /**
   * What the last explicit `Test Connection` observed, per model connection.
   *
   * Live-process only, deliberately: this is a cheap non-billable probe whose
   * whole value is being current, and a receipt that survived a restart would
   * be vouching for a provider nobody has asked since. It is bound to the
   * configuration it observed so a key edit retires it (RT-06).
   */
  private readonly modelCheckObservations = new Map<
    string,
    ModelCheckObservation
  >();
  private modelInventoryEpoch = 0;
  private modelInventorySnapshot: LaunchableModelInventory | null = null;
  private modelInventoryRefresh: ModelInventoryRefreshGeneration | null = null;
  private readonly appConfigLaunchabilitySource: AppConfigLaunchabilitySource | null;
  private readonly launchabilityUnsubscribes: Array<() => void> = [];
  /** Live conveniences only; restart opens the same durable ledger row. */
  private readonly credentialApplicationClaims = new Map<
    string,
    CredentialApplicationClaim
  >();
  private readonly credentialApplicationLegacyImports = new Map<
    string,
    Promise<boolean>
  >();
  /** Serializes stage/delete in this Module; SQLite remains the cross-process truth. */
  private readonly credentialApplicationWork = new Map<string, Promise<void>>();
  private disposed = false;

  createCredentialProfileRecoveryAdapter(
    resolveConnectionId: (provider: string) => string | undefined,
  ): CredentialProfileRecoveryAdapter {
    return {
      stage: async ({ provider, failure, recoveryFingerprint }) => {
        const connectionId = resolveConnectionId(provider);
        if (!connectionId) return { kind: 'unavailable' };
        try {
          const rawAttempt =
            await this.stageAutomaticCredentialProfileApplication(
              connectionId,
              failure,
              recoveryFingerprint as ReturnType<typeof randomUUID>,
            );
          const attempt = rawAttempt
            ? Object.freeze({
                candidateProfileRef: rawAttempt.candidateProfileRef,
                capability: rawAttempt.capability,
                commit: () =>
                  this.settleCredentialProfileApplication(
                    rawAttempt.connectionId,
                    rawAttempt.attemptId,
                    'commit',
                  ),
                rollback: () =>
                  this.settleCredentialProfileApplication(
                    rawAttempt.connectionId,
                    rawAttempt.attemptId,
                    'rollback',
                  ),
                inspect: (action: 'commit' | 'rollback') =>
                  this.inspectCredentialProfileApplication(
                    rawAttempt.connectionId,
                    rawAttempt.attemptId,
                    action,
                  ),
                acknowledge: () =>
                  this.acknowledgeCredentialProfileApplication(
                    rawAttempt.connectionId,
                    rawAttempt.attemptId,
                  ),
              })
            : undefined;
          return attempt
            ? { kind: 'staged', attempt }
            : { kind: 'unavailable' };
        } catch {
          return { kind: 'indeterminate' };
        }
      },
      inspectStartup: ({ provider, application, action }) => {
        const connectionId = resolveConnectionId(provider);
        return connectionId
          ? this.inspectCredentialApplicationHandle(
              connectionId,
              application,
              action,
            )
          : Promise.resolve({ kind: 'indeterminate' as const });
      },
      settleStartup: ({ provider, application, action }) => {
        const connectionId = resolveConnectionId(provider);
        return connectionId
          ? this.settleCredentialApplicationHandle(
              connectionId,
              application,
              action,
            )
          : Promise.resolve({ kind: 'indeterminate' as const });
      },
      acknowledgeStartup: ({ provider, application }) => {
        const connectionId = resolveConnectionId(provider);
        return connectionId
          ? this.acknowledgeCredentialApplicationHandle(
              connectionId,
              application,
            )
          : Promise.resolve({ kind: 'unavailable' as const });
      },
    };
  }

  constructor(
    private readonly providerService: Pick<
      ProviderService,
      | 'listProviderConnections'
      | 'saveProviderConnection'
      | 'deleteProviderConnection'
      | 'checkHealth'
    > &
      Partial<
        Pick<
          ProviderService,
          'captureLaunchabilitySnapshot' | 'getLaunchabilityRevision'
        >
      >,
    private readonly getProviderAdapters: () => ProviderAdapterShape[],
    private readonly getACPConnections: () => Promise<ACPConnectionConfig[]>,
    private readonly getACPStatus: () => {
      connections?: ACPConnectionStatus[];
    },
    private readonly getAppConfig: () => Promise<AppConfig>,
    private readonly updateAppConfig: (
      updates: Partial<AppConfig>,
    ) => Promise<AppConfig>,
    /** Private durable protocol; deliberately not derived from AppConfig. */
    private readonly credentialApplicationLedger: CredentialApplicationFactory,
    private readonly runtimeAuthHealth?: Pick<
      RuntimeAuthHealthMonitor,
      'getFailure'
    > &
      Partial<Pick<RuntimeAuthHealthMonitor, 'dispose'>>,
    private readonly smokeEvidenceStore: ConnectionSmokeEvidenceStore = new MemoryConnectionSmokeEvidenceStore(),
    private readonly launchabilityRevisionSources: LaunchabilityRevisionSource[] = [],
    private readonly mutateAppConfig?: (
      mutate: (current: Readonly<AppConfig>) => Partial<AppConfig>,
    ) => Promise<AppConfig>,
    /**
     * Identity authority is deliberately separate from provider/ACP config.
     * A config write that has not completed this registry step is an orphan:
     * retained for retry, but never projected as a connection or default.
     */
    private readonly agentRegistry?: {
      load: () => Promise<AgentRegistry>;
      register: (id: EngineConnectionId) => Promise<AgentRegistry>;
      unregister: (id: EngineConnectionId) => Promise<AgentRegistry>;
    },
  ) {
    this.appConfigLaunchabilitySource =
      this.launchabilityRevisionSources.find(
        (source): source is AppConfigLaunchabilitySource =>
          typeof (source as Partial<AppConfigLaunchabilitySource>)
            .captureAppConfigLaunchabilitySnapshot === 'function',
      ) ?? null;
    for (const source of this.launchabilityRevisionSources) {
      this.launchabilityUnsubscribes.push(
        source.onLaunchabilityChange(() => this.invalidateModelInventory()),
      );
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.launchabilityUnsubscribes.splice(0)) {
      unsubscribe();
    }
    this.invalidateModelInventory();
    // Runtime bootstrap constructs this monitor for this service; retain its
    // subscription/timers only for this ConnectionService lifetime.
    this.runtimeAuthHealth?.dispose?.();
  }

  setSmokeRunner(runner: ConnectionSmokeRunner): void {
    this.smokeRunner = runner;
  }

  /**
   * Fold one automatic catalogue fetch into the same bound check receipt an
   * explicit Test Connection writes — as one of THREE answers, not two
   * (station RT-06 delta review H1).
   *
   * - `passed`: a live, non-empty catalogue. The provider answered with
   *   usable models.
   * - `catalog-unavailable`: the endpoint is reachable but has no usable
   *   catalogue — a 404/405/501 on the catalogue route, a body that is not a
   *   catalogue, or a live but EMPTY list. Plenty of OpenAI-compatible
   *   servers serve chat and no `/models`; recording that as a refusal
   *   marked a working connection permanently broken, and recording an empty
   *   list as a pass claimed "Ready to use in chats and agents" off a
   *   response that established no model and no chat endpoint.
   * - `failed`: the provider refused these settings, or could not be reached.
   *
   * Everything else (a timeout, an abort, a fall back to configured
   * selectors with no provider answer, or no provider implementation at all)
   * is Station giving up, and must leave whatever was previously observed
   * alone rather than manufacture a refusal for a slow but healthy provider.
   */
  private recordModelCatalogDiscovery(
    connection: ProviderConnectionConfig,
    discovered: SafeModelCatalog,
    provider: ILLMProvider | null,
  ): void {
    if (!provider) return;
    const checkedAt = new Date().toISOString();
    const configurationFingerprint = connectionFingerprint(connection);
    if (discovered.source === 'live') {
      this.recordModelCheck(connection.id, {
        configurationFingerprint,
        checkedAt,
        status: discovered.models.length > 0 ? 'passed' : 'catalog-unavailable',
        ...(discovered.models.length > 0
          ? {}
          : {
              reason:
                'The provider answered with an empty model catalog, which proves it is reachable but not that it can chat.',
            }),
        source: 'catalog-discovery',
      });
      return;
    }
    if (!discovered.reason || !discovered.reasonKind) return;
    this.recordModelCheck(connection.id, {
      configurationFingerprint,
      checkedAt,
      status: MODEL_CHECK_STATUS_BY_REASON_KIND[discovered.reasonKind],
      reason: this.redactProviderReason(discovered.reason, connection),
      source: 'catalog-discovery',
    });
  }

  /**
   * Write a check receipt, unless a stronger standing one already says more.
   *
   * `catalog-unavailable` from discovery is the weakest observation there is:
   * "this endpoint has no model catalogue" says nothing new about a
   * connection an explicit Test Connection has already driven end to end, and
   * letting the next listing overwrite that pass is what made an earned
   * "Ready" un-earnable for a catalogue-less endpoint. A refusal or a live
   * catalogue is always news and always records; an explicit test always
   * records, because the operator just asked for it.
   *
   * Delta2 review H1 (widened): this holds for an explicit REFUSAL too, and
   * for exactly the same reason. An explicit test that reached the chat route
   * and was turned away is a stronger, later observation than "this endpoint
   * publishes no catalogue"; letting the next listing replace it with
   * `catalog-unavailable` silently un-gated a connection the provider had
   * just refused — the inverse of the false pass this exception was written
   * to prevent.
   */
  private recordModelCheck(
    connectionId: string,
    observation: ModelCheckObservation,
  ): void {
    const existing = this.modelCheckObservations.get(connectionId);
    const supersedable =
      observation.source === 'catalog-discovery' &&
      observation.status === 'catalog-unavailable' &&
      existing?.configurationFingerprint ===
        observation.configurationFingerprint &&
      existing.source === 'explicit-test' &&
      (existing.status === 'passed' || existing.status === 'failed');
    if (supersedable) return;
    this.modelCheckObservations.set(
      connectionId,
      this.withUnreachableRun(observation, existing),
    );
  }

  /**
   * Carry an unreachable run forward across observations of the SAME
   * configuration, so "how long has this been unreachable" is a fact about
   * the endpoint rather than about the last request.
   */
  private withUnreachableRun(
    observation: ModelCheckObservation,
    existing: ModelCheckObservation | undefined,
  ): ModelCheckObservation {
    if (observation.status !== 'unreachable') return observation;
    const prior =
      existing?.configurationFingerprint ===
      observation.configurationFingerprint
        ? existing
        : undefined;
    const priorRun =
      prior?.status === 'unreachable' ? prior.unreachable : undefined;
    return {
      ...observation,
      unreachable: {
        since: priorRun?.since ?? observation.checkedAt,
        consecutive: (priorRun?.consecutive ?? 0) + 1,
        // A run that began by replacing a pass keeps that provenance for as
        // long as it lasts; an edit to the connection retires the receipt
        // (different fingerprint) and starts a new run with no protection.
        afterPass: priorRun?.afterPass ?? prior?.status === 'passed',
      },
    };
  }

  /**
   * Project one recorded observation into the public check evidence — the
   * single place `retrying` is computed. Every consumer (the readiness
   * evidence, the recommendation gate, the provider card) then reads the ONE
   * shared predicate `connectionCheckGatesReadiness` rather than re-deriving
   * a grace window of its own.
   */
  private checkEvidenceFor(
    connectionId: string,
    configurationFingerprint: string,
    now = Date.now(),
  ): ConnectionCheckEvidence {
    const recorded = this.modelCheckObservations.get(connectionId);
    if (recorded?.configurationFingerprint !== configurationFingerprint) {
      return { status: 'not-checked' };
    }
    return {
      status: recorded.status,
      checkedAt: recorded.checkedAt,
      ...(recorded.reason ? { reason: recorded.reason } : {}),
      source: recorded.source,
      ...(recorded.status === 'unreachable'
        ? { retrying: this.unreachableIsRetrying(recorded, now) }
        : {}),
    };
  }

  private unreachableIsRetrying(
    observation: ModelCheckObservation,
    now: number,
  ): boolean {
    const run = observation.unreachable;
    if (!run?.afterPass) return false;
    if (run.consecutive >= CONNECTION_UNREACHABLE_GRACE_OBSERVATIONS) {
      return false;
    }
    const since = Date.parse(run.since);
    if (Number.isNaN(since)) return false;
    return now - since < CONNECTION_UNREACHABLE_GRACE_MS;
  }

  private resolveModelCatalog(
    connection: ProviderConnectionConfig,
    catalog: SafeModelCatalog,
    epoch: number,
  ): { catalog: SafeModelCatalog; observedAt: string | null } {
    const fingerprint = connectionFingerprint(connection);
    const cached = this.modelCatalogCache.get(connection.id);
    if (cached && cached.fingerprint !== fingerprint) {
      this.modelCatalogCache.delete(connection.id);
    }

    if (catalog.source === 'live') {
      const observedAt = new Date().toISOString();
      if (
        epoch === this.modelInventoryEpoch &&
        catalog.models.length > 0 &&
        !catalog.truncated
      ) {
        this.modelCatalogCache.set(connection.id, {
          fingerprint,
          observedAt,
          cachedAt: Date.now(),
          models: catalog.models,
        });
      } else if (epoch === this.modelInventoryEpoch) {
        this.modelCatalogCache.delete(connection.id);
      }
      return { catalog, observedAt };
    }

    if (
      (catalog.source === 'configured' || catalog.source === 'built-in') &&
      catalog.models.length > 0
    ) {
      return { catalog, observedAt: new Date().toISOString() };
    }

    const matchingCache = this.modelCatalogCache.get(connection.id);
    if (
      matchingCache?.fingerprint === fingerprint &&
      Date.now() - matchingCache.cachedAt <= MODEL_INVENTORY_STALE_MAX_AGE_MS
    ) {
      return {
        catalog: { source: 'cached', models: matchingCache.models },
        observedAt: matchingCache.observedAt,
      };
    }
    if (matchingCache) this.modelCatalogCache.delete(connection.id);
    return { catalog, observedAt: null };
  }

  private invalidateModelInventory(): void {
    this.modelInventoryEpoch += 1;
    this.modelInventoryRefresh?.controller.abort(
      new Error('Model inventory configuration changed.'),
    );
    this.modelInventoryRefresh = null;
    this.modelInventorySnapshot = null;
    this.modelCatalogCache.clear();
  }

  private captureLaunchabilityRevisions(): number[] {
    return this.launchabilityRevisionSources.map((source) =>
      source.getLaunchabilityRevision(),
    );
  }

  private revisionsAreCurrent(revisions: number[]): boolean {
    return this.launchabilityRevisionSources.every(
      (source, index) => source.getLaunchabilityRevision() === revisions[index],
    );
  }

  private providerSnapshotIsCurrent(
    snapshot: ProviderLaunchabilitySnapshot | null,
  ): boolean {
    return (
      snapshot === null ||
      this.providerService.getLaunchabilityRevision === undefined ||
      this.providerService.getLaunchabilityRevision() === snapshot.revision
    );
  }

  private appConfigSnapshotIsCurrent(
    snapshot: AppConfigLaunchabilitySnapshot | null,
  ): boolean {
    return (
      snapshot === null ||
      this.appConfigLaunchabilitySource === null ||
      this.appConfigLaunchabilitySource.getLaunchabilityRevision() ===
        snapshot.revision
    );
  }

  private invalidateUnobservedMutation(): void {
    if (this.launchabilityRevisionSources.length === 0) {
      this.invalidateModelInventory();
    }
  }

  async listConnections(): Promise<ConnectionConfig[]> {
    const discoveryPromise = this.discoverModelConnections();
    const modelsPromise = discoveryPromise.then((discovery) =>
      discovery.sources.map((item) => item.connection),
    );
    const [models, runtimes] = await Promise.all([
      modelsPromise,
      this.listRuntimeConnectionsForModels(modelsPromise),
    ]);
    return [...models, ...runtimes];
  }

  /**
   * The MODEL INVENTORY: the connections that can serve an LLM, plus the ones
   * that could not be read.
   *
   * archive#3747: this used to return every provider connection, vector stores
   * included, and left each consumer to re-derive `capabilities.includes('llm')`
   * for itself. The name is the contract now — `isLlmModelConnection` is the
   * one place that decides membership, and a vector store is read through
   * `listConnections()` (the full projection the Knowledge section already
   * uses), not through an inventory that says "models".
   *
   * archive#3748: `failures` travels with the rows so a caller can never mistake
   * "could not read this" for "you have none of these".
   */
  async listModelConnectionInventory(): Promise<{
    connections: ConnectionConfig[];
    failures: ConnectionInventoryFailure[];
  }> {
    const discovery = await this.discoverModelConnections();
    return {
      connections: discovery.sources
        .map((item) => item.connection)
        .filter(isLlmModelConnection),
      failures: discovery.failures,
    };
  }

  async listModelConnections(): Promise<ConnectionConfig[]> {
    return (await this.listModelConnectionInventory()).connections;
  }

  /**
   * Per-row isolation (archive#3748). One row that throws — a malformed
   * persisted config, a provider factory that rejects, a catalogue read that
   * blows up in a way `safeListModelCatalog` does not cover — used to abandon
   * the whole map, so BOTH `/api/connections/models` and
   * `/api/connections/agents` answered with an empty list. A record that cannot
   * be read now costs exactly itself and is named in `failures`.
   *
   * Two classes of throw are deliberately NOT isolated, because they are
   * control flow rather than a bad row: an aborted signal, and a generation
   * that went obsolete mid-flight. Both mean the whole result is void, and
   * swallowing them would publish a half-computed inventory as a complete one.
   * A caller that passes `abortOnFailure` has likewise said it wants the first
   * failure rather than the survivors (the launchable-model inventory, which
   * must not publish a partial catalogue as whole), so it still gets the throw.
   */
  private async discoverModelConnections(
    options: {
      connections?: ProviderConnectionConfig[];
      signal?: AbortSignal;
      epoch?: number;
      concurrency?: number;
      includePrerequisites?: boolean;
      abortOnFailure?: (error: unknown) => void;
    } = {},
  ): Promise<{
    sources: ModelConnectionInventorySource[];
    failures: ConnectionInventoryFailure[];
  }> {
    const connections =
      options.connections ?? this.providerService.listProviderConnections();
    const epoch = options.epoch ?? this.modelInventoryEpoch;
    const failures: ConnectionInventoryFailure[] = [];
    const discoverOne = async (
      connection: ProviderConnectionConfig,
    ): Promise<ModelConnectionInventorySource> => {
      const prerequisites =
        options.includePrerequisites === false
          ? []
          : await this.collectModelPrerequisites(connection, options.signal);
      const base = toModelConnection(connection, prerequisites);
      const provider = createLLMProvider(connection);
      if (!provider) this.modelCatalogCache.delete(connection.id);
      const discovered: SafeModelCatalog = provider
        ? await safeListModelCatalog(
            provider,
            configuredModelsFor(connection),
            undefined,
            options.signal,
          )
        : { source: 'unavailable', models: [] };
      throwIfAborted(options.signal);
      if (epoch !== this.modelInventoryEpoch) {
        throw new Error('Model inventory generation is obsolete.');
      }
      // RT-06 review H2: this listing's own catalogue fetch IS a check —
      // a real model-catalog request made with this exact configuration,
      // and the one whose result the user is looking at in the Models
      // count. Recording it is what makes "Ready" always trace to a
      // provider response instead of to a saved string.
      this.recordModelCatalogDiscovery(connection, discovered, provider);
      const { catalog, observedAt } = this.resolveModelCatalog(
        connection,
        discovered,
        epoch,
      );
      const models = catalog.models;
      // Identity is decided here, once, from the connection's own route
      // family -- so every client path (catalog query, raw connection rows,
      // New Chat) reads the same decoration instead of deriving or dropping
      // it. Review round on #1208.
      const family = modelRouteFamilyFor(connection);
      const modelOptions = models.map((model) => {
        const canonicalModelIdentity = curatedModelIdentityFor({
          family,
          providerModel: model.id,
        });
        return {
          id: model.id,
          name: model.name,
          originalId: model.id,
          ...(canonicalModelIdentity ? { canonicalModelIdentity } : {}),
        };
      });
      const projected = this.withReadinessEvidence(
        {
          ...base,
          kind: 'model' as const,
          config:
            modelOptions.length > 0
              ? { ...base.config, modelOptions }
              : base.config,
        },
        connectionFingerprint(connection),
      );
      return {
        connection: projected as ConnectionConfig & { kind: 'model' },
        execution: provider?.execution ?? null,
        catalog: {
          source: catalog.source,
          observedAt,
          models,
          ...(catalog.truncated ? { truncated: true } : {}),
        },
      } satisfies ModelConnectionInventorySource;
    };
    const settled = await mapWithConcurrency(
      connections,
      options.concurrency ?? MODEL_INVENTORY_DISCOVERY_CONCURRENCY,
      async (connection) => {
        try {
          return await discoverOne(connection);
        } catch (error) {
          // Control flow, not a bad row: the caller is being told the whole
          // result is void, and a survivor list would be a lie about it.
          if (options.signal?.aborted) throw error;
          if (epoch !== this.modelInventoryEpoch) throw error;
          if (options.abortOnFailure) throw error;
          failures.push({
            connectionId: connection.id,
            name: connection.name || connection.id,
            reason:
              error instanceof Error
                ? sanitizeFreeText(error.message)
                : 'This connection could not be read.',
          });
          return null;
        }
      },
      options.signal,
      options.abortOnFailure
        ? {
            settleInFlightOnAbort: true,
            onFirstFailure: options.abortOnFailure,
          }
        : undefined,
    );
    return {
      sources: settled.filter(
        (item): item is ModelConnectionInventorySource => item !== null,
      ),
      failures,
    };
  }

  /**
   * The AGENT/runtime inventory, carrying the same `failures` (archive#3748).
   * A model row that could not be read is exactly what used to empty this
   * route too, so the reason travels with it rather than being lost one seam
   * away from where it is rendered.
   */
  async listRuntimeConnectionInventory(): Promise<{
    connections: AgentConnectionView[];
    failures: ConnectionInventoryFailure[];
  }> {
    const inventoryPromise = this.listModelConnectionInventory();
    const connections = await this.listRuntimeConnectionsForModels(
      inventoryPromise.then((inventory) => inventory.connections),
    );
    return { connections, failures: (await inventoryPromise).failures };
  }

  async listRuntimeConnections(): Promise<AgentConnectionView[]> {
    return (await this.listRuntimeConnectionInventory()).connections;
  }

  /**
   * Canonical engine identity and navigable connection identity used by
   * readiness and other control-plane callers.
   */
  async listEngineConnectionStates(): Promise<
    Array<{
      engineId: EngineId;
      engineConnectionId: EngineConnectionId;
      enabled: boolean;
    }>
  > {
    const connections = await this.listRuntimeConnections();
    return connections.map((connection) => {
      const rawEngineId = connection.config.engineId;
      if (typeof rawEngineId !== 'string') {
        throw new Error(
          `Runtime connection '${connection.id}' is missing its engine identity.`,
        );
      }
      return {
        engineId: engineId(rawEngineId),
        engineConnectionId: engineConnectionId(connection.id),
        enabled: connection.enabled,
      };
    });
  }

  /**
   * Onboarding catalog. Unlike the configured listing, this includes
   * unregistered adapters, but still projects their clean public
   * EngineConnectionId paired with each Adapter's canonical EngineId.
   */
  async listRuntimeConnectionCatalog(): Promise<AgentConnectionView[]> {
    return this.listRuntimeConnectionsForModels(this.listModelConnections(), {
      registryAuthoritative: false,
    });
  }

  private async listRuntimeConnectionsForModels(
    modelsInput: ConnectionConfig[] | Promise<ConnectionConfig[]>,
    options: {
      adapters?: ProviderAdapterShape[];
      acpConnections?: ACPConnectionConfig[];
      appConfig?: AppConfig;
      signal?: AbortSignal;
      concurrency?: number;
      includeCommands?: boolean;
      includePrerequisites?: boolean;
      disableHostDiscovery?: boolean;
      allowBuiltInOnDiscoveryFailure?: boolean;
      abortOnFailure?: (error: unknown) => void;
      registryAuthoritative?: boolean;
    } = {},
  ): Promise<AgentConnectionView[]> {
    const [appConfig, acpConnections, models] = await Promise.all([
      options.appConfig ?? this.getAppConfig(),
      options.acpConnections ?? this.getACPConnections(),
      modelsInput,
    ]);
    const adapters = options.adapters ?? this.getProviderAdapters();
    const registry =
      this.agentRegistry && options.registryAuthoritative !== false
        ? await this.agentRegistry.load()
        : undefined;
    const inspector = createConnectionInspector({
      adapters: () => adapters,
      appConfig: () => appConfig,
      acpConnections: () => acpConnections,
      acpStatus: () => this.getACPStatus(),
      publicConnection: (engineIdentity) => {
        const adapter = adapters.find(
          (candidate) => engineIdForAdapter(candidate) === engineIdentity,
        );
        const publicId = engineConnectionId(
          adapter ? connectionIdForAdapter(adapter) : engineIdentity,
        );
        if (
          registry &&
          !registry.engineConnections.some(
            (connection) => connection.id === publicId,
          )
        ) {
          return undefined;
        }
        return { id: publicId, engineId: engineIdentity };
      },
      onInspectionFailure: options.abortOnFailure,
      now: () => Date.now(),
    });
    const inspection = await inspector.inspect({
      kind: 'runtime-capability-inventory',
      signal: options.signal,
      concurrency: options.concurrency,
      includeCommands: options.includeCommands,
      includePrerequisites: options.includePrerequisites,
      disableHostDiscovery:
        options.disableHostDiscovery ??
        process.env.STATION_E2E_FIRST_RUN === '1',
      allowBuiltInOnDiscoveryFailure: options.allowBuiltInOnDiscoveryFailure,
    });
    if (inspection.kind !== 'inspected') {
      throw new Error(
        `Runtime capability inspection ${inspection.kind}; retry before publishing inventory.`,
      );
    }
    const runtimes = inspection.connections;

    const hasReadyModel = models.some(
      (model) =>
        model.enabled &&
        model.capabilities.includes('llm') &&
        model.status === 'ready',
    );
    const projected = runtimes.map((runtime) => {
      const engineRuntime =
        runtime.config.provider === 'station-agent'
          ? {
              ...runtime,
              status: hasReadyModel
                ? ('ready' as const)
                : ('missing_prerequisites' as const),
              config: {
                ...runtime.config,
                readinessReason: hasReadyModel
                  ? 'Station’s engine has an available model connection.'
                  : 'Station’s engine requires an available model connection.',
              },
              prerequisites: [
                {
                  id: 'station-model-connection',
                  name: 'Model connection',
                  description:
                    'Station requires at least one ready model connection.',
                  status: hasReadyModel
                    ? ('installed' as const)
                    : ('missing' as const),
                  category: 'required' as const,
                },
              ],
            }
          : runtime;
      const provider = engineRuntime.config.provider;
      const failure =
        typeof provider === 'string'
          ? this.runtimeAuthHealth?.getFailure(provider)
          : null;
      const projected = failure
        ? applyRuntimeAuthenticationFailure(engineRuntime, failure)
        : engineRuntime;
      return this.withReadinessEvidence(
        projected,
        this.runtimeConnectionFingerprint(
          projected,
          appConfig,
          acpConnections,
          options.adapters ?? this.getProviderAdapters(),
        ),
      );
    });
    return projected;
  }

  private async refreshLaunchableModelInventory(
    signal: AbortSignal,
    epoch: number,
    providerSnapshot: ProviderLaunchabilitySnapshot | null,
    appConfigSnapshot: AppConfigLaunchabilitySnapshot | null,
    abortOnFailure: (error: unknown) => void,
  ): Promise<LaunchableModelInventory> {
    const allModelConnections = [
      ...(providerSnapshot?.connections ??
        this.providerService.listProviderConnections()),
    ].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
    const allAdapters = [...this.getProviderAdapters()].sort((left, right) => {
      const leftId = engineIdForAdapter(left);
      const rightId = engineIdForAdapter(right);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
    const modelConnectionsInput = allModelConnections.slice(
      0,
      MODEL_INVENTORY_MAX_CONNECTIONS,
    );
    const adapters = allAdapters.slice(0, MODEL_INVENTORY_MAX_CONNECTIONS);
    const discoveryPromise = this.discoverModelConnections({
      connections: modelConnectionsInput,
      signal,
      epoch,
      concurrency: MODEL_INVENTORY_DISCOVERY_CONCURRENCY,
      includePrerequisites: true,
      abortOnFailure,
    });
    const modelViewsPromise = discoveryPromise.then((discovery) =>
      discovery.sources.map((item) => item.connection),
    );
    const [discovery, agentConnections] = await settleConcurrentWork(
      [
        discoveryPromise,
        this.listRuntimeConnectionsForModels(modelViewsPromise, {
          adapters,
          acpConnections: [],
          ...(appConfigSnapshot ? { appConfig: appConfigSnapshot.config } : {}),
          signal,
          concurrency: MODEL_INVENTORY_DISCOVERY_CONCURRENCY,
          includeCommands: false,
          includePrerequisites: true,
          allowBuiltInOnDiscoveryFailure: false,
          abortOnFailure,
        }),
      ],
      abortOnFailure,
    );
    throwIfAborted(signal);
    if (epoch !== this.modelInventoryEpoch) {
      throw new Error('Model inventory generation is obsolete.');
    }
    const omittedCount =
      Math.max(0, allModelConnections.length - modelConnectionsInput.length) +
      Math.max(0, allAdapters.length - adapters.length);
    return buildLaunchableModelInventory({
      observedAt: new Date().toISOString(),
      // This path passes `abortOnFailure`, so per-row isolation is off and a
      // failure has already thrown: `failures` is empty by construction here.
      modelConnections: discovery.sources,
      agentConnections,
      diagnostics:
        omittedCount > 0
          ? [
              {
                connectionId: MODEL_INVENTORY_DIAGNOSTIC_ID,
                code: 'discovery-limited',
                message: `${omittedCount} connection inventories were omitted by the bounded refresh limit.`,
              },
            ]
          : [],
    });
  }

  private currentModelInventoryRefresh(): Promise<LaunchableModelInventory> {
    if (this.modelInventoryRefresh) return this.modelInventoryRefresh.promise;
    const providerSnapshot =
      this.providerService.captureLaunchabilitySnapshot?.() ?? null;
    if (!this.providerSnapshotIsCurrent(providerSnapshot)) {
      throw new Error('Model inventory generation is obsolete.');
    }
    const epoch = this.modelInventoryEpoch;
    const controller = new AbortController();
    const startedAt = Date.now();
    const generation: ModelInventoryRefreshGeneration = {
      epoch,
      sourceRevisions: [],
      controller,
      promise: Promise.resolve(null as never),
    };
    let appConfigSnapshot: AppConfigLaunchabilitySnapshot | null = null;
    const refresh = withinInventoryDeadline(
      async () => {
        appConfigSnapshot =
          (await this.appConfigLaunchabilitySource?.captureAppConfigLaunchabilitySnapshot()) ??
          null;
        generation.sourceRevisions = this.captureLaunchabilityRevisions();
        if (
          !this.providerSnapshotIsCurrent(providerSnapshot) ||
          !this.appConfigSnapshotIsCurrent(appConfigSnapshot)
        ) {
          throw new Error('Model inventory generation is obsolete.');
        }
        throwIfAborted(controller.signal);
        const abortOnFailure = (error: unknown): void => {
          if (!controller.signal.aborted) {
            controller.abort(new InventorySiblingAbort(error));
          }
        };
        return this.refreshLaunchableModelInventory(
          controller.signal,
          epoch,
          providerSnapshot,
          appConfigSnapshot,
          abortOnFailure,
        );
      },
      controller,
      startedAt,
    )
      .then((inventory) => {
        if (
          epoch !== this.modelInventoryEpoch ||
          !this.revisionsAreCurrent(generation.sourceRevisions) ||
          !this.providerSnapshotIsCurrent(providerSnapshot) ||
          !this.appConfigSnapshotIsCurrent(appConfigSnapshot)
        ) {
          throw new Error('Model inventory generation is obsolete.');
        }
        this.modelInventorySnapshot = inventory;
        modelInventoryRefreshTotal.add(1, { outcome: 'success' });
        modelInventoryModelCount.record(inventory.models.length);
        modelInventoryDiagnosticCount.record(inventory.diagnostics.length);
        modelInventoryRefreshDuration.record(Date.now() - startedAt, {
          outcome: 'success',
        });
        return inventory;
      })
      .catch((error) => {
        const abortReason = controller.signal.reason;
        const outcome =
          abortReason instanceof InventorySiblingAbort
            ? 'error'
            : controller.signal.aborted
              ? abortReason instanceof Error &&
                abortReason.message === 'Model inventory refresh timed out.'
                ? 'timeout'
                : 'aborted'
              : 'error';
        modelInventoryRefreshTotal.add(1, { outcome });
        modelInventoryRefreshDuration.record(Date.now() - startedAt, {
          outcome,
        });
        throw error;
      })
      .finally(() => {
        if (this.modelInventoryRefresh === generation) {
          this.modelInventoryRefresh = null;
        }
      });
    generation.promise = refresh;
    this.modelInventoryRefresh = generation;
    return refresh;
  }

  /**
   * The current in-memory model-inventory snapshot, or `null` before the
   * first refresh has completed. Deliberately synchronous and read-only —
   * unlike `listLaunchableModelInventory()` it never triggers a refresh, so
   * a caller on a hot per-request path (archive#1299: resolving a
   * model's real context-window size for the stats route) can consult
   * whatever is already cached without adding request latency or new I/O.
   * A caller that needs the freshest possible inventory should still use
   * `listLaunchableModelInventory()`.
   */
  getCachedLaunchableModelInventory(): LaunchableModelInventory | null {
    return this.modelInventorySnapshot;
  }

  async listLaunchableModelInventory(): Promise<LaunchableModelInventory> {
    try {
      const inventory = await this.currentModelInventoryRefresh();
      modelInventoryResponseTotal.add(1, { outcome: 'fresh' });
      return inventory;
    } catch (error) {
      const snapshot = this.modelInventorySnapshot;
      const snapshotAge = snapshot
        ? Date.now() - Date.parse(snapshot.observedAt)
        : Number.POSITIVE_INFINITY;
      if (
        !snapshot ||
        !Number.isFinite(snapshotAge) ||
        snapshotAge > MODEL_INVENTORY_STALE_MAX_AGE_MS
      ) {
        modelInventoryResponseTotal.add(1, { outcome: 'error' });
        throw error;
      }
      modelInventoryResponseTotal.add(1, { outcome: 'stale' });
      return staleInventorySnapshot(snapshot);
    }
  }

  /**
   * archive#1398: the contributed-subset manifest this Station would
   * offer to its owner's fleet (`docs/design/inference-fleet.md` §4.2). No
   * route serves it yet — slice 2 owns the authenticated
   * `inference:invoke`-scoped surface, and exposing contributed model names
   * on today's `orchestration:read` connections family would widen the
   * disclosure §5.3 is about to narrow.
   *
   * Two properties matter more than the projection itself:
   *
   * - **A Station that has not opted in does no work.** The inventory is
   *   only refreshed when the opt-in is on AND at least one connection is
   *   marked, so an untouched Station's behavior is byte-identical to before
   *   this method existed (pinned by `fleet-contribution-service.test.ts`).
   * - **An inventory failure is reported, not swallowed.** A rejected
   *   refresh becomes `inventory-unavailable` — "unknown", not "contributes
   *   nothing" — because those two read identically in an empty array and
   *   mean opposite things to a consumer deciding whether to route here.
   *
   * Reads through `listLaunchableModelInventory()` (compute-on-demand with a
   * bounded stale snapshot), never `getCachedLaunchableModelInventory()`:
   * archive#1430's second finding is that the cached snapshot is populated
   * as a side effect of the Connections route, so a manifest built from it
   * would be a function of whether this Station's operator opened a page.
   */
  async getFleetContributionManifest(): Promise<FleetContributionManifest> {
    const appConfig = await this.getAppConfig();
    const config = appConfig.fleetContribution;
    const projectedAt = new Date().toISOString();
    const offersAnything =
      isFleetContributionEnabled(config) &&
      declaredContributionConnectionIds(config).length > 0;

    let inventory: LaunchableModelInventory | null = null;
    if (offersAnything) {
      try {
        inventory = await this.listLaunchableModelInventory();
      } catch {
        inventory = null;
      }
    }

    const manifest = projectFleetContributionManifest({
      projectedAt,
      config,
      inventory,
    });
    fleetContributionManifestTotal.add(1, {
      participation: manifest.participation,
    });
    fleetContributionModelCount.record(manifest.models.length);
    return manifest;
  }

  /**
   * Live per-candidate tool-surface lookup for Dispatch's `structured-tools`
   * capability derivation (archive#1430, backs `DispatchEvidenceSource.getModelToolSurface`).
   *
   * Reads through `listLaunchableModelInventory()` — the same deterministic,
   * compute-on-demand accessor `getFleetContributionManifest()` uses, and for
   * the identical reason: a Dispatch grade must not depend on whether this
   * Station's operator happened to open the Connections page since the last
   * connection edit. Never `getCachedLaunchableModelInventory()`.
   *
   * One inventory computation for the whole batch, not one per binding
   * (`listLaunchableModelInventory()` itself dedupes concurrent callers into
   * one in-flight refresh). Returns one entry per requested binding, in the
   * SAME order as `bindings` — an array rather than a
   * connectionId-keyed map, because a single connection can expose many
   * models and `connectionId` alone is not a unique key here.
   *
   * A lookup failure (the inventory refresh itself throws — e.g. a
   * concurrent generation race) propagates to the caller rather than
   * silently returning `null` for every binding; `dispatch-model-policy.ts`'s
   * `fetchModelToolSurfaceList` is the layer that catches it and degrades to
   * "no candidate derives `structured-tools` for this turn," matching how
   * `fetchReadinessEvidenceMap` already treats a readiness-evidence failure.
   */
  async getModelToolSurface(
    bindings: readonly { connectionId: string; modelId: string }[],
  ): Promise<ReadonlyArray<readonly string[] | null>> {
    if (bindings.length === 0) return [];
    const inventory = await this.listLaunchableModelInventory();
    return bindings.map(({ connectionId, modelId }) => {
      const record = inventory.models.find(
        (model) =>
          model.connectionKind === 'model' &&
          model.connectionId === connectionId &&
          (model.providerModel === modelId || model.aliases.includes(modelId)),
      );
      return record ? record.toolSurface : null;
    });
  }

  async getConnection(id: string): Promise<ConnectionConfig | null> {
    const connections = await this.listConnections();
    return connections.find((connection) => connection.id === id) ?? null;
  }

  async saveConnection(
    connection: ConnectionConfig,
  ): Promise<ConnectionConfig> {
    if (connection.kind === 'model') {
      const prepared = await this.prepareModelConnectionForSave({
        id: connection.id,
        type: connection.type,
        name: connection.name,
        config: Object.fromEntries(
          Object.entries(connection.config).filter(
            ([key]) => key !== 'modelOptions',
          ),
        ),
        enabled: connection.enabled,
        capabilities: connection.capabilities.filter((capability) =>
          MODEL_CAPABILITY_SET.has(capability),
        ) as ProviderConnectionConfig['capabilities'],
      });
      await this.providerService.saveProviderConnection(prepared);
      this.invalidateUnobservedMutation();
    } else {
      // Resolve from the raw provider/ACP projection so a previous failed
      // registry CAS can be retried. The public listing remains registry-only.
      const current = (
        await this.listRuntimeConnectionsForModels(
          this.listModelConnections(),
          {
            registryAuthoritative: false,
          },
        )
      ).find((candidate) => {
        const binding = externalEngineRegistryBinding(
          candidate,
          this.getProviderAdapters(),
        );
        return (binding?.id ?? candidate.id) === connection.id;
      });
      if (current?.kind !== 'agent') {
        throw new Error(`Connection '${connection.id}' not found`);
      }
      const binding = externalEngineRegistryBinding(
        current,
        this.getProviderAdapters(),
      );
      const settingsId = binding?.settingsId ?? current.id;

      await this.mutateRuntimeConnections((agentConnections) => ({
        ...agentConnections,
        [settingsId]: {
          ...(agentConnections[settingsId] ?? {}),
          name: connection.name,
          enabled: connection.enabled,
          config: sanitizeRuntimeConfig(settingsId, connection.config),
        },
      }));
      if (binding) {
        await this.agentRegistry?.register(binding.id);
      }
      this.invalidateUnobservedMutation();
      configOps.add(1, {
        op: 'update_runtime_connection',
        id: settingsId,
      });
    }

    await this.invalidateQuotaSnapshot(connection.id);

    const saved = await this.getConnection(connection.id);
    if (!saved) {
      throw new Error(
        `Failed to reload connection '${connection.id}' after save.`,
      );
    }
    return saved;
  }

  private async prepareModelConnectionForSave(
    connection: ProviderConnectionConfig,
  ): Promise<ProviderConnectionConfig> {
    if (
      connection.type !== 'ollama' ||
      !connection.enabled ||
      !connection.capabilities.includes('llm')
    ) {
      return connection;
    }

    const provider = createLLMProvider(connection);
    if (!provider) {
      throw new ModelSelectionRequiredError(
        'Ollama is unavailable. Start Ollama and choose a model before saving this connection.',
      );
    }
    const catalog = await safeListModelCatalog(provider, []);
    const modelOptions = catalog.models.map((model) => ({
      id: model.id,
      name: model.name,
      originalId: model.id,
    }));
    const configuredModel =
      typeof connection.config.defaultModel === 'string'
        ? connection.config.defaultModel.trim()
        : '';
    const existingConnection = this.providerService
      .listProviderConnections()
      .find((candidate) => candidate.id === connection.id);
    const unchangedLaunchability =
      existingConnection !== undefined &&
      connectionFingerprint(existingConnection) ===
        connectionFingerprint(connection);

    if (catalog.source !== 'live') {
      if (configuredModel && unchangedLaunchability) {
        return connection;
      }
      throw new ModelSelectionRequiredError(
        'Could not load installed models from Ollama. Check the Base URL and make sure Ollama is running, then try again.',
      );
    }

    if (configuredModel) {
      if (!modelOptions.some((model) => model.id === configuredModel)) {
        throw new ModelSelectionRequiredError(
          `The Ollama model '${configuredModel}' is not currently available. Choose an installed model before saving.`,
          modelOptions,
        );
      }
      return connection;
    }

    if (modelOptions.length === 1) {
      return {
        ...connection,
        config: {
          ...connection.config,
          defaultModel: modelOptions[0].id,
        },
      };
    }

    throw new ModelSelectionRequiredError(
      modelOptions.length === 0
        ? 'No Ollama models are installed. Install a model, then save this connection again.'
        : 'Choose which installed Ollama model Station should use by default.',
      modelOptions,
    );
  }

  async deleteConnection(id: string): Promise<void> {
    const connection = await this.getConnection(id);
    if (!connection) {
      throw new Error(`Connection '${id}' not found`);
    }
    if (connection.kind === 'model') {
      await this.providerService.deleteProviderConnection(id);
      this.invalidateUnobservedMutation();
      await this.invalidateQuotaSnapshot(id);
      return;
    }

    const registry = await this.agentRegistry?.load();
    const registryConnection = registry?.engineConnections.find(
      (candidate) => String(candidate.id) === id,
    );
    const settingsId = String(registryConnection?.id ?? id);
    await this.mutateRuntimeConnections((agentConnections) => {
      const nextRuntimeConnections = { ...agentConnections };
      delete nextRuntimeConnections[settingsId];
      return nextRuntimeConnections;
    });
    if (this.agentRegistry) {
      const identity = registryConnection?.id;
      if (identity) await this.agentRegistry.unregister(identity);
    }
    this.invalidateUnobservedMutation();
    await this.invalidateQuotaSnapshot(id);
    configOps.add(1, { op: 'reset_runtime_connection', id });
  }

  private async mutateRuntimeConnections(
    mutate: (
      current: NonNullable<AppConfig['agentConnections']>,
    ) => NonNullable<AppConfig['agentConnections']>,
  ): Promise<AppConfig> {
    if (this.mutateAppConfig) {
      return this.mutateAppConfig((current) => ({
        agentConnections: mutate(current.agentConnections ?? {}),
      }));
    }
    const current = await this.getAppConfig();
    return this.updateAppConfig({
      agentConnections: mutate(current.agentConnections ?? {}),
    });
  }

  private credentialRecoveryAdapter(
    connectionId: string,
  ): ProviderAdapterShape | undefined {
    return this.getProviderAdapters().find((adapter) => {
      const runtimeId = engineIdForAdapter(adapter);
      return (
        runtimeId === connectionId ||
        connectionIdForAdapter(adapter) === connectionId
      );
    });
  }

  private credentialRecoverySettingsId(connectionId: string): string {
    const adapter = this.credentialRecoveryAdapter(connectionId);
    return adapter ? engineIdForAdapter(adapter) : connectionId;
  }

  private credentialRecoveryCapability(connectionId: string) {
    return resolveCredentialProfileApplicationCapability(
      this.credentialRecoveryAdapter(connectionId)?.metadata.recovery,
    );
  }

  private credentialApplicationProjection(
    capability: CredentialProfileApplicationCapability,
    activeProfileRef: string | undefined,
    application: CredentialApplication | undefined,
  ): CredentialProfileApplicationProjection {
    if (!application)
      return { capability, ...(activeProfileRef ? { activeProfileRef } : {}) };
    const outcome =
      application.state === 'reserved' ||
      application.state === 'staged' ||
      application.state === 'commit-pending'
        ? 'staged'
        : application.state === 'adopted'
          ? 'adopted'
          : application.state === 'rolled-back'
            ? 'rolled_back'
            : 'failed';
    return {
      capability,
      ...(activeProfileRef ? { activeProfileRef } : {}),
      ...(application.state === 'reserved' ||
      application.state === 'staged' ||
      application.state === 'commit-pending'
        ? { pendingProfileRef: application.candidateProfileRef }
        : {}),
      outcome,
    };
  }

  private async openCredentialApplication(
    connectionId: string,
    attemptId: string,
  ): Promise<CredentialApplicationClaim | undefined> {
    const claim = this.credentialApplicationClaims.get(attemptId);
    return claim?.application.connectionId === connectionId ? claim : undefined;
  }

  private async mutateCredentialRecovery(
    connectionId: string,
    mutate: (
      state: LegacyCredentialProfileRegistryState,
    ) => LegacyCredentialProfileRegistryState,
  ): Promise<CredentialRecoveryGroupProjection> {
    const connection = await this.getConnection(connectionId);
    if (connection?.kind !== 'agent') {
      throw new Error(`Agent connection '${connectionId}' not found`);
    }
    const capability = this.credentialRecoveryCapability(connectionId);
    const settingsId = this.credentialRecoverySettingsId(connectionId);
    let projected: CredentialRecoveryGroupProjection | undefined;
    await this.mutateRuntimeConnections((agentConnections) => {
      const current = agentConnections[settingsId] ?? {};
      const normalizedCurrent = normalizeCredentialProfileRegistry(
        current.credentialRecovery,
      );
      const requested = mutate(normalizedCurrent);
      const mutated =
        requested.pendingApplication || requested.applicationReceipts?.length
          ? {
              ...requested,
              pendingApplication: undefined,
              applicationReceipts: undefined,
            }
          : requested;
      const credentialRecovery =
        mutated === normalizedCurrent
          ? normalizedCurrent
          : normalizeCredentialProfileRegistry(mutated);
      projected = projectCredentialProfileRegistry(
        credentialRecovery,
        capability,
      );
      if (mutated === normalizedCurrent) return agentConnections;
      return {
        ...agentConnections,
        [settingsId]: { ...current, credentialRecovery },
      };
    });
    // A profile transition can change which Codex account the next pull sees.
    // Never retain a successful snapshot across that account boundary.
    await this.invalidateQuotaSnapshot(connectionId);
    return projected as CredentialRecoveryGroupProjection;
  }

  private async readCredentialRecoveryState(
    connectionId: string,
  ): Promise<LegacyCredentialProfileRegistryState> {
    const appConfig = await this.getAppConfig();
    return normalizeCredentialProfileRegistry(
      appConfig.agentConnections?.[
        this.credentialRecoverySettingsId(connectionId)
      ]?.credentialRecovery,
    );
  }

  private async withCredentialApplicationLock<T>(
    connectionId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const prior =
      this.credentialApplicationWork.get(connectionId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.credentialApplicationWork.set(connectionId, held);
    await prior;
    try {
      const mutation = await this.credentialApplicationLedger.mutate(
        connectionId,
        work,
      );
      if (mutation.kind !== 'applied')
        throw new Error('Credential profile mutation is busy.');
      return mutation.value;
    } finally {
      release?.();
      if (this.credentialApplicationWork.get(connectionId) === held)
        this.credentialApplicationWork.delete(connectionId);
    }
  }

  /**
   * Old config-backed receipts are imported once into the private ledger and
   * stripped in the same serialized config mutation. Afterwards config owns
   * profile catalog/policy/active selection only; it cannot forge or erase an
   * application obligation through a full-config PUT.
   */
  private async importLegacyCredentialApplications(
    connectionId: string,
  ): Promise<boolean> {
    const existing = this.credentialApplicationLegacyImports.get(connectionId);
    if (existing) return existing;
    const imported = (async () => {
      const state = await this.readCredentialRecoveryState(connectionId);
      const legacy = [
        ...(state.pendingApplication
          ? [{ ...state.pendingApplication, outcome: 'staged' as const }]
          : []),
        ...(state.applicationReceipts ?? []),
      ];
      if (legacy.length === 0) return true;
      for (const application of legacy) {
        const reserved = this.credentialApplicationLedger.start({
          recoveryFingerprint: application.attemptId,
          connectionId,
          candidateProfileRef: application.candidateProfileRef,
          previousProfileRef: state.activeProfileRef,
          now:
            ('recordedAt' in application
              ? application.recordedAt
              : undefined) ?? new Date().toISOString(),
        });
        const claim =
          reserved.kind === 'owner'
            ? reserved.claim
            : await this.openCredentialApplication(
                connectionId,
                application.attemptId,
              );
        // Preserve the source authority if SQLite cannot prove every legacy
        // obligation exists. A later startup can retry safely; stripping now
        // would turn a capacity or storage fault into lost compensation work.
        if (!claim) return false;
        if (reserved.kind !== 'owner') continue;
        const now = new Date().toISOString();
        if (claim.staged(now).kind !== 'applied') return false;
        if (application.outcome === 'adopted')
          if (claim.settle('adopted', now).kind !== 'applied') return false;
        if (application.outcome === 'rolled_back')
          if (claim.settle('rolled-back', now).kind !== 'applied') return false;
        if (application.outcome === 'superseded')
          if (claim.settle('superseded', now).kind !== 'applied') return false;
      }
      await this.mutateCredentialRecovery(connectionId, (current) => ({
        ...current,
        pendingApplication: undefined,
        applicationReceipts: undefined,
      }));
      return true;
    })();
    this.credentialApplicationLegacyImports.set(connectionId, imported);
    try {
      const complete = await imported;
      if (!complete)
        this.credentialApplicationLegacyImports.delete(connectionId);
      return complete;
    } catch (error) {
      this.credentialApplicationLegacyImports.delete(connectionId);
      throw error;
    }
  }

  /**
   * Moves legacy config-backed evidence before routes can accept a config
   * write. This is retryable: incomplete imports deliberately leave their
   * source records intact rather than silently deleting recovery authority.
   */
  async migrateLegacyCredentialApplicationsAtStartup(): Promise<void> {
    const appConfig = await this.getAppConfig();
    const connections = Object.entries(appConfig.agentConnections ?? {})
      .filter(([, connection]) => {
        const recovery = connection?.credentialRecovery as
          | Record<string, unknown>
          | undefined;
        return Boolean(
          recovery &&
            (Object.hasOwn(recovery, 'pendingApplication') ||
              Object.hasOwn(recovery, 'applicationReceipts')),
        );
      })
      .map(([connectionId]) => connectionId);
    for (const connectionId of connections) {
      const imported =
        await this.importLegacyCredentialApplications(connectionId);
      if (!imported) {
        throw new Error(
          `Credential recovery migration for '${connectionId}' is incomplete.`,
        );
      }
    }
  }

  async getCredentialRecovery(
    connectionId: string,
  ): Promise<CredentialRecoveryGroupProjection> {
    const connection = await this.getConnection(connectionId);
    if (connection?.kind !== 'agent') {
      throw new Error(`Agent connection '${connectionId}' not found`);
    }
    await this.importLegacyCredentialApplications(connectionId);
    const appConfig = await this.getAppConfig();
    const settingsId = this.credentialRecoverySettingsId(connectionId);
    const projected = projectCredentialProfileRegistry(
      appConfig.agentConnections?.[settingsId]?.credentialRecovery,
      this.credentialRecoveryCapability(connectionId),
    );
    return {
      ...projected,
      application: this.credentialApplicationProjection(
        this.credentialRecoveryCapability(connectionId),
        projected.application.activeProfileRef,
        this.credentialApplicationLedger.latest(connectionId),
      ),
    };
  }

  async upsertCredentialProfile(
    connectionId: string,
    profile: CredentialProfile,
  ): Promise<CredentialRecoveryGroupProjection> {
    return this.mutateCredentialRecovery(
      connectionId,
      (state) => upsertCredentialProfile(state, profile).state,
    );
  }

  async deleteCredentialProfile(
    connectionId: string,
    ref: string,
  ): Promise<CredentialRecoveryGroupProjection> {
    return this.withCredentialApplicationLock(connectionId, async () => {
      const obligation = this.credentialApplicationLedger.latest(connectionId);
      if (
        obligation &&
        (obligation.candidateProfileRef === ref ||
          obligation.previousProfileRef === ref)
      ) {
        throw new Error(
          'Credential profile is referenced by an unresolved application.',
        );
      }
      return this.mutateCredentialRecovery(
        connectionId,
        (state) => deleteCredentialProfile(state, ref).state,
      );
    });
  }

  async setCredentialProfileEnrollment(
    connectionId: string,
    ref: string,
    enrolled: boolean,
  ): Promise<CredentialRecoveryGroupProjection> {
    return this.mutateCredentialRecovery(
      connectionId,
      (state) => setCredentialProfileEnrollment(state, ref, enrolled).state,
    );
  }

  async setCredentialRecoveryAutomaticPolicy(
    connectionId: string,
    automatic: boolean,
  ): Promise<CredentialRecoveryGroupProjection> {
    if (
      automatic &&
      this.credentialRecoveryCapability(connectionId) === 'unsupported'
    ) {
      throw new Error(
        'Automatic credential recovery is unsupported for this connection.',
      );
    }
    return this.mutateCredentialRecovery(
      connectionId,
      (state) => setCredentialRecoveryAutomaticPolicy(state, automatic).state,
    );
  }

  async stageCredentialProfileApplication(
    connectionId: string,
    input: { candidateProfileRef: string; attemptId: string },
  ): Promise<CredentialProfileApplicationProjection> {
    return this.withCredentialApplicationLock(connectionId, () =>
      this.stageCredentialProfileApplicationUnlocked(connectionId, input),
    );
  }

  /** Caller holds the connection-scoped application lock. */
  private async stageCredentialProfileApplicationUnlocked(
    connectionId: string,
    input: { candidateProfileRef: string; attemptId: string },
  ): Promise<CredentialProfileApplicationProjection> {
    const current = await this.getCredentialRecovery(connectionId);
    const reserved = this.credentialApplicationLedger.start({
      recoveryFingerprint: input.attemptId,
      connectionId,
      candidateProfileRef: input.candidateProfileRef,
      previousProfileRef: current.application.activeProfileRef,
      now: new Date().toISOString(),
    });
    if (reserved.kind !== 'owner') return current.application;
    this.credentialApplicationClaims.set(input.attemptId, reserved.claim);
    // Another ConnectionService process may delete a profile after our first
    // config read. SQLite owns the reservation, but config is a separate
    // durable store, so verify the candidate again before exposing/staging it.
    const afterReserve = await this.readCredentialRecoveryState(connectionId);
    if (
      !afterReserve.profiles?.some(
        (profile) => profile.ref === input.candidateProfileRef,
      )
    ) {
      const now = new Date().toISOString();
      if (reserved.claim.settle('rolled-back', now).kind === 'applied')
        reserved.claim.acknowledge(now);
      this.credentialApplicationClaims.delete(input.attemptId);
      return current.application;
    }
    if (reserved.claim.staged(new Date().toISOString()).kind !== 'applied') {
      return current.application;
    }
    return this.credentialApplicationProjection(
      this.credentialRecoveryCapability(connectionId),
      current.application.activeProfileRef,
      { ...reserved.claim.application, state: 'staged' },
    );
  }

  /**
   * Manual application shares the exact same atomic staging transition as
   * recovery. It intentionally does not dispatch a verification turn: a UI,
   * API, or CLI caller must arrange that explicit/billable action and only
   * commit after its correlated completion.
   */
  private async beginCredentialProfileApplication(
    connectionId: string,
    candidateProfileRef: string,
  ): Promise<CredentialProfileApplicationAttempt> {
    const attempt: CredentialProfileApplicationAttempt = {
      connectionId,
      attemptId: randomUUID(),
      candidateProfileRef,
      capability: this.credentialRecoveryCapability(connectionId),
    };
    const application = await this.stageCredentialProfileApplication(
      connectionId,
      attempt,
    );
    if (
      application.outcome !== 'staged' ||
      application.pendingProfileRef !== candidateProfileRef
    ) {
      credentialProfileApplication.add(1, {
        source: 'manual',
        capability: application.capability,
        outcome: 'rejected',
        scope: 'not_applicable',
        reason:
          application.capability === 'unsupported' ? 'unsupported' : 'conflict',
      });
      throw new Error('Credential profile application could not be staged.');
    }
    credentialProfileApplication.add(1, {
      source: 'manual',
      capability: application.capability,
      outcome: 'staged',
      scope: 'not_applicable',
      reason: 'requested',
    });
    return attempt;
  }

  /**
   * Explicit, billable manual application. The one-turn provider smoke is the
   * adoption proof: process start alone never changes the active credential profile.
   */
  async applyCredentialProfile(
    connectionId: string,
    candidateProfileRef: string,
    options: { confirmed: boolean; timeoutMs?: number },
  ): Promise<CredentialProfileApplicationProjection> {
    if (!options.confirmed) {
      throw new Error(
        'Explicit confirmation is required because credential application sends one potentially billable chat turn.',
      );
    }
    const attempt = await this.beginCredentialProfileApplication(
      connectionId,
      candidateProfileRef,
    );
    try {
      await this.runCredentialProfileSmoke(attempt, options);
    } catch {
      return this.rollbackManualCredentialProfileApplication(attempt);
    }
    return this.commitManualCredentialProfileApplication(attempt);
  }

  private async runCredentialProfileSmoke(
    attempt: CredentialProfileApplicationAttempt,
    options: { timeoutMs?: number },
  ): Promise<void> {
    const connection = await this.getConnection(attempt.connectionId);
    const provider = connection?.config.provider as EngineId | undefined;
    if (
      connection?.kind !== 'agent' ||
      !connection.enabled ||
      !connection.capabilities.includes('agent-runtime') ||
      !provider ||
      !this.smokeRunner
    ) {
      throw new Error(
        'Credential profile application cannot run a provider smoke.',
      );
    }
    const result = await this.smokeRunner({
      connectionId: attempt.connectionId,
      provider,
      ...(typeof connection.config.defaultModel === 'string'
        ? { modelId: connection.config.defaultModel }
        : {}),
      cwd: process.cwd(),
      credentialProfileRef: attempt.candidateProfileRef,
      timeoutMs: Math.max(5_000, Math.min(options.timeoutMs ?? 45_000, 60_000)),
    });
    if (!result.ok) throw new Error('Credential profile adoption failed.');
  }

  private async commitManualCredentialProfileApplication(
    attempt: CredentialProfileApplicationAttempt,
  ): Promise<CredentialProfileApplicationProjection> {
    const committed = await this.confirmCredentialProfileApplication(
      attempt.connectionId,
      attempt.attemptId,
    );
    if (!committed)
      throw new Error('Credential profile application completion is stale.');
    const application = (await this.getCredentialRecovery(attempt.connectionId))
      .application;
    credentialProfileApplication.add(1, {
      source: 'manual',
      capability: attempt.capability,
      outcome: 'adopted',
      scope: 'not_applicable',
      reason: 'requested',
    });
    return application;
  }

  private async rollbackManualCredentialProfileApplication(
    attempt: CredentialProfileApplicationAttempt,
  ): Promise<CredentialProfileApplicationProjection> {
    const rolledBack = await this.confirmCredentialProfileRollback(
      attempt.connectionId,
      attempt.attemptId,
    ).catch(() => false);
    const application = (await this.getCredentialRecovery(attempt.connectionId))
      .application;
    credentialProfileApplication.add(1, {
      source: 'manual',
      capability: attempt.capability,
      outcome: rolledBack ? 'rolled_back' : 'failed',
      scope: 'not_applicable',
      reason: rolledBack ? 'adoption_failed' : 'conflict',
    });
    return application;
  }

  /**
   * Selects and stages one automatic candidate in the same config mutation.
   * The selector is the only account-switch decision point; it returns no
   * candidate identity for every refusal.
   */
  async stageAutomaticCredentialProfileApplication(
    connectionId: string,
    failure: ClassifiedConnectionFailure,
    attemptId: ReturnType<typeof randomUUID> = randomUUID(),
  ): Promise<CredentialProfileApplicationAttempt | undefined> {
    return this.withCredentialApplicationLock(connectionId, async () => {
      const capability = this.credentialRecoveryCapability(connectionId);
      if (capability !== 'restart_resume') {
        credentialProfileApplication.add(1, {
          source: 'recovery',
          capability,
          outcome: 'rejected',
          scope: failure.scope,
          reason: 'unsupported',
        });
        return undefined;
      }
      const result = await this.stageAutomaticCredentialProfileTransition(
        connectionId,
        failure,
        capability,
        attemptId,
      );
      if (result.attempt) return result.attempt;
      credentialProfileApplication.add(1, {
        source: 'recovery',
        capability,
        outcome: 'rejected',
        scope: failure.scope,
        reason: result.refusalReason ?? 'conflict',
      });
      return undefined;
    });
  }

  private async stageAutomaticCredentialProfileTransition(
    connectionId: string,
    failure: ClassifiedConnectionFailure,
    capability: CredentialProfileApplicationCapability,
    attemptId: ReturnType<typeof randomUUID>,
  ): Promise<AutomaticCredentialProfileStageResult> {
    const state = await this.readCredentialRecoveryState(connectionId);
    const candidateProfileRef = state.group?.enrolledProfileRefs.find(
      (ref) => ref !== state.activeProfileRef,
    );
    const selection = selectCredentialRecoveryCandidate({
      capability:
        this.credentialRecoveryAdapter(connectionId)?.metadata.recovery,
      failure,
      policy: state.policy,
      group: state.group,
      activeProfileRef: state.activeProfileRef,
      candidateProfileRef,
    });
    if (selection.outcome !== 'selected')
      return { refusalReason: selection.reason };
    const attempt: CredentialProfileApplicationAttempt = {
      connectionId,
      attemptId,
      candidateProfileRef: selection.candidateProfileRef,
      capability,
    };
    const application = await this.stageCredentialProfileApplicationUnlocked(
      connectionId,
      attempt,
    );
    return application.outcome === 'staged' &&
      application.pendingProfileRef === attempt.candidateProfileRef
      ? { attempt }
      : { refusalReason: 'conflict' };
  }

  async commitCredentialProfileApplication(
    connectionId: string,
    attemptId: string,
  ): Promise<CredentialProfileApplicationProjection> {
    await this.settleCredentialProfileApplication(
      connectionId,
      attemptId,
      'commit',
    );
    return (await this.getCredentialRecovery(connectionId)).application;
  }

  /** Returns false for a stale/superseded completion without disturbing it. */
  async confirmCredentialProfileApplication(
    connectionId: string,
    attemptId: string,
  ): Promise<boolean> {
    return (
      (
        await this.settleCredentialProfileApplication(
          connectionId,
          attemptId,
          'commit',
        )
      ).kind === 'adopted'
    );
  }

  /**
   * Total exact settlement for automatic recovery. The registry owns both the
   * durable write and its restart-visible receipt, so a post-write throw is
   * read back as an idempotent fact instead of guessed from an exception.
   */
  async settleCredentialProfileApplication(
    connectionId: string,
    attemptId: string,
    action: 'commit' | 'rollback',
  ): Promise<
    CredentialProfileApplicationSettlement | { kind: 'indeterminate' }
  > {
    let candidateProfileRef: string | undefined;
    try {
      const claim = await this.openCredentialApplication(
        connectionId,
        attemptId,
      );
      if (!claim) return { kind: 'indeterminate' };
      const transition = claim.settle(
        action === 'commit' ? 'commit-pending' : 'rolled-back',
        new Date().toISOString(),
      );
      if (transition.kind === 'applied') {
        if (action === 'commit') {
          candidateProfileRef = claim.application.candidateProfileRef;
          await this.mutateCredentialRecovery(connectionId, (state) => ({
            ...state,
            activeProfileRef: claim.application.candidateProfileRef,
            pendingApplication: undefined,
            applicationReceipts: undefined,
          }));
          if (
            claim.settle('adopted', new Date().toISOString()).kind !== 'applied'
          ) {
            return { kind: 'indeterminate' };
          }
        }
        return action === 'commit'
          ? { kind: 'adopted' }
          : { kind: 'rolled-back' };
      }
      return this.inspectCredentialProfileApplication(
        connectionId,
        attemptId,
        action,
      );
    } catch {
      // Config persistence may report after it durably adopted the exact
      // candidate. Read that non-secret fact back before classifying a commit
      // as unknown; retrying profile mutation after this boundary is unsafe.
      if (action === 'commit' && candidateProfileRef) {
        try {
          const state = await this.readCredentialRecoveryState(connectionId);
          if (state.activeProfileRef === candidateProfileRef) {
            const reopened = await this.openCredentialApplication(
              connectionId,
              attemptId,
            );
            if (
              reopened?.settle('adopted', new Date().toISOString()).kind ===
              'applied'
            )
              return { kind: 'adopted' };
            return { kind: 'already-adopted' };
          }
        } catch {
          // The durable registry remains commit-pending for exact startup
          // inspection; never infer a rollback from a failed readback.
        }
      }
      return { kind: 'indeterminate' };
    }
  }

  async inspectCredentialProfileApplication(
    connectionId: string,
    attemptId: string,
    _action: 'commit' | 'rollback' = 'commit',
  ): Promise<
    CredentialProfileApplicationSettlement | { kind: 'indeterminate' }
  > {
    try {
      const connection = await this.getConnection(connectionId);
      if (connection?.kind !== 'agent') return { kind: 'indeterminate' };
      const claim = await this.openCredentialApplication(
        connectionId,
        attemptId,
      );
      if (!claim) return { kind: 'indeterminate' };
      const state = claim.application.state;
      if (state === 'adopted') return { kind: 'adopted' };
      if (state === 'rolled-back') return { kind: 'rolled-back' };
      if (state === 'superseded') return { kind: 'superseded' };
      if (state === 'staged' || state === 'reserved') return { kind: 'staged' };
      return { kind: 'indeterminate' };
    } catch {
      return { kind: 'indeterminate' };
    }
  }

  /** Startup receives this opaque handle from EventStore's private join. */
  private async inspectCredentialApplicationHandle(
    connectionId: string,
    application: CredentialApplicationHandle,
    _action: 'commit' | 'rollback',
  ): Promise<
    CredentialProfileApplicationSettlement | { kind: 'indeterminate' }
  > {
    const connection = await this.getConnection(connectionId);
    if (connection?.kind !== 'agent') return { kind: 'indeterminate' };
    switch (application.application.state) {
      case 'adopted':
        return { kind: 'adopted' };
      case 'rolled-back':
        return { kind: 'rolled-back' };
      case 'superseded':
        return { kind: 'superseded' };
      case 'reserved':
      case 'staged':
        return { kind: 'staged' };
      default:
        return { kind: 'indeterminate' };
    }
  }

  private async settleCredentialApplicationHandle(
    connectionId: string,
    application: CredentialApplicationHandle,
    action: 'commit' | 'rollback',
  ): Promise<
    CredentialProfileApplicationSettlement | { kind: 'indeterminate' }
  > {
    const now = new Date().toISOString();
    if (action === 'rollback')
      return application.settle('rolled-back', now).kind === 'applied'
        ? { kind: 'rolled-back' }
        : { kind: 'indeterminate' };
    if (application.settle('commit-pending', now).kind !== 'applied')
      return { kind: 'indeterminate' };
    try {
      await this.mutateCredentialRecovery(connectionId, (state) => ({
        ...state,
        activeProfileRef: application.application.candidateProfileRef,
        pendingApplication: undefined,
        applicationReceipts: undefined,
      }));
      return application.settle('adopted', new Date().toISOString()).kind ===
        'applied'
        ? { kind: 'adopted' }
        : { kind: 'indeterminate' };
    } catch {
      const state = await this.readCredentialRecoveryState(connectionId).catch(
        () => undefined,
      );
      if (
        state?.activeProfileRef === application.application.candidateProfileRef
      ) {
        application.settle('adopted', new Date().toISOString());
        return { kind: 'already-adopted' };
      }
      return { kind: 'indeterminate' };
    }
  }

  private async acknowledgeCredentialApplicationHandle(
    connectionId: string,
    application: CredentialApplicationHandle,
  ): Promise<{ kind: 'applied' } | { kind: 'unavailable' }> {
    if ((await this.getConnection(connectionId))?.kind !== 'agent')
      return { kind: 'unavailable' };
    return application.acknowledge(new Date().toISOString()).kind === 'applied'
      ? { kind: 'applied' }
      : { kind: 'unavailable' };
  }

  /** A receipt is deleted only after the owning recovery has a durable terminal. */
  async acknowledgeCredentialProfileApplication(
    connectionId: string,
    attemptId: string,
  ): Promise<{ kind: 'applied' } | { kind: 'unavailable' }> {
    try {
      const claim = await this.openCredentialApplication(
        connectionId,
        attemptId,
      );
      if (!claim) return { kind: 'unavailable' };
      return claim.acknowledge(new Date().toISOString()).kind === 'applied'
        ? { kind: 'applied' }
        : { kind: 'unavailable' };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  async rollbackCredentialProfileApplication(
    connectionId: string,
    attemptId: string,
  ): Promise<CredentialProfileApplicationProjection> {
    await this.settleCredentialProfileApplication(
      connectionId,
      attemptId,
      'rollback',
    );
    return (await this.getCredentialRecovery(connectionId)).application;
  }

  /** Returns false for a stale/superseded rollback without disturbing it. */
  async confirmCredentialProfileRollback(
    connectionId: string,
    attemptId: string,
  ): Promise<boolean> {
    return (
      (
        await this.settleCredentialProfileApplication(
          connectionId,
          attemptId,
          'rollback',
        )
      ).kind === 'rolled-back'
    );
  }

  async testConnection(id: string): Promise<{
    healthy: boolean;
    status: ConnectionStatus;
    prerequisites: Prerequisite[];
    reason?: string;
    checkedAt?: string;
  }> {
    const connection = await this.getConnection(id);
    if (!connection) {
      throw new Error(`Connection '${id}' not found`);
    }

    if (connection.kind === 'model') {
      const providerConnection = this.providerService
        .listProviderConnections()
        .find((candidate) => candidate.id === id);
      if (!providerConnection) {
        throw new Error(`Connection '${id}' not found`);
      }

      const llmProvider = createLLMProvider(providerConnection);
      let outcome: ModelCheckOutcome;
      if (llmProvider) {
        // `healthCheck` is still the declared health contract (and carries the
        // provider metric), but it answers a bare boolean — exactly the
        // information the user needs and never got: "✗ Connection failed" with
        // no reason, no HTTP code and no remediation (RT-06). On the failure
        // path only, re-ask the same question so the answer can be classified
        // and quoted.
        outcome = (await this.providerService.checkHealth(
          llmProvider,
          providerConnection.type,
        ))
          ? { status: 'passed' }
          : await this.probeModelConnection(llmProvider, providerConnection);
      } else if (hasRequiredMissing(connection.prerequisites)) {
        outcome = {
          status: 'failed',
          reason:
            'This connection is missing required setup, so Station cannot reach the provider.',
        };
      } else {
        outcome = { status: 'passed' };
      }
      const healthy = outcome.status === 'passed';
      const reason = outcome.reason;
      // RT-06: the outcome is recorded against the configuration it observed,
      // so the connection view, the hub card and the provider page all read
      // one derivation instead of the prerequisite guess.
      const checkedAt = new Date().toISOString();
      this.recordModelCheck(id, {
        configurationFingerprint: connectionFingerprint(providerConnection),
        checkedAt,
        status: outcome.status,
        ...(reason ? { reason } : {}),
        source: 'explicit-test',
      });
      this.invalidateModelInventory();
      return {
        healthy,
        // Review M2: this used to fall back to the STORED status, so a
        // refused test answered `{ healthy: false, status: 'ready' }` — an
        // internally inconsistent payload for any direct API/SDK consumer,
        // and the same saved-string-as-readiness claim the rest of this
        // change removes. The status is re-derived from the receipt just
        // written, so the endpoint cannot contradict the connection view a
        // refetch is about to show.
        status: this.statusFromCheck(connection, healthy),
        prerequisites: connection.prerequisites,
        checkedAt,
        ...(reason ? { reason } : {}),
      };
    }

    return {
      healthy: !hasRequiredMissing(connection.prerequisites),
      status: connection.status,
      prerequisites: connection.prerequisites,
    };
  }

  /**
   * What an explicit Test Connection actually observed, classified.
   *
   * The catalogue answer alone cannot decide this. `listModels` flattens an
   * unavailable catalogue to an empty array on the key-based providers, so
   * asking it alone cannot tell "the provider refused" from "the provider has
   * no catalogue" — and an OpenAI-compatible endpoint that serves chat and no
   * `/models` is the second, not the first (delta review H1). When the
   * catalogue is merely absent, the operator has explicitly asked Station to
   * check, so it goes on to ask the chat route directly; that is the only way
   * such a connection can ever earn "Ready".
   */
  private async probeModelConnection(
    provider: ILLMProvider,
    connection: ProviderConnectionConfig,
  ): Promise<ModelCheckOutcome> {
    let catalogNote: string;
    try {
      const catalog = provider.listModelCatalog
        ? await provider.listModelCatalog()
        : { source: 'live' as const, models: await provider.listModels() };
      if (catalog.source === 'live' && catalog.models.length > 0) {
        return { status: 'passed' };
      }
      // Only an ANSWER can be `catalog-unavailable`: a live (if empty)
      // catalogue, or a route that reported it has none. An `unavailable`
      // carrying no classification means Station never got an answer at all,
      // which proves no reachability and must not read as if it had —
      // `unreachable`, not a refusal, because nothing here is the provider
      // turning these settings away (delta2 review M1).
      if (catalog.source !== 'live' && catalog.reasonKind !== 'no-catalog') {
        return {
          status: catalog.reasonKind
            ? MODEL_CHECK_STATUS_BY_REASON_KIND[catalog.reasonKind]
            : 'unreachable',
          reason: this.redactProviderReason(
            catalog.reason ??
              'Station could not complete a model-catalog request with these settings.',
            connection,
          ),
        };
      }
      catalogNote =
        catalog.source === 'live'
          ? 'The provider answered with an empty model catalog.'
          : (catalog.reason ?? 'This provider offers no model catalog.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reasonKind = classifyCatalogFailure(error);
      if (reasonKind !== 'no-catalog') {
        return {
          status: MODEL_CHECK_STATUS_BY_REASON_KIND[reasonKind],
          reason: this.redactProviderReason(message, connection),
        };
      }
      catalogNote = message;
    }

    const chat = await this.probeChatCompletion(provider, connection);
    if (chat.status === 'passed') return { status: 'passed' };
    if (chat.status === 'failed') {
      return {
        status: 'failed',
        reason: this.redactProviderReason(
          chat.reason ?? 'The minimal chat request did not succeed.',
          connection,
        ),
      };
    }
    return {
      status: 'catalog-unavailable',
      reason: this.redactProviderReason(
        `${catalogNote} ${chat.reason ?? ''}`.trim(),
        connection,
      ),
    };
  }

  /**
   * One bounded, minimal chat turn, run ONLY from an explicit Test Connection
   * and only when the catalogue route gave Station nothing to go on.
   *
   * COST: `maxTokens: 1` keeps this to a single generated token. Providers
   * that honour it bill approximately nothing; a provider that ignores it
   * bills one short completion. That is a deliberate judgement — it runs on
   * the explicit test ENDPOINT only (the operator's button, the CLI's
   * `connections test`, an SDK caller), never on a listing or a background
   * poll, and it is the only evidence that can earn "Ready" for an endpoint
   * with no model catalogue.
   *
   * Delta2 review M2: a failure is classified by the status the provider
   * attached, not by one word for everything. 401/403 is these credentials
   * being refused; 404 is this MODEL not being on this endpoint, which is a
   * fixable naming mistake and must not be reported as a refusal. A timeout
   * or a stream that produced nothing to judge stays `skipped` — Station gave
   * up, which is not an observation of the provider.
   */
  private async probeChatCompletion(
    provider: ILLMProvider,
    connection: ProviderConnectionConfig,
  ): Promise<{ status: 'passed' | 'failed' | 'skipped'; reason?: string }> {
    const model =
      typeof connection.config.defaultModel === 'string'
        ? connection.config.defaultModel.trim()
        : '';
    if (!model) {
      return {
        status: 'skipped',
        reason:
          // Names the field, not just the concept (review M1): every provider
          // form that can reach this now HAS a "Default model" field, and an
          // instruction is only actionable if it says where to carry it out.
          'Set a default model on this connection — its "Default model" field — so Station can verify chat directly.',
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('The chat check timed out.')),
      CHAT_PROBE_TIMEOUT_MS,
    );
    try {
      for await (const chunk of provider.createStream({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 1,
        signal: controller.signal,
      })) {
        // The ai-sdk path yields errors as chunks rather than throwing
        // (archive#3586), so a refusal arrives here, not in the catch.
        if (chunk.type === 'error') {
          return {
            status: 'failed',
            reason: describeChatProbeFailure(chunk.error, chunk.errorStatus),
          };
        }
        if (chunk.type === 'text-delta' || chunk.type === 'finish') {
          return { status: 'passed' };
        }
      }
      return {
        status: 'skipped',
        reason: 'The chat check produced no response to judge.',
      };
    } catch (error) {
      if (controller.signal.aborted) {
        return {
          status: 'skipped',
          reason: 'The chat check timed out before the provider answered.',
        };
      }
      return {
        status: 'failed',
        reason: describeChatProbeFailure(
          error instanceof Error ? error.message : String(error),
          providerHttpErrorStatus(error),
        ),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The connection's status once the check just observed is folded in. A
   * refusal is a live observation of the provider and outranks the stored
   * prerequisite-derived status; a pass cannot promote a connection whose
   * prerequisites are genuinely missing.
   */
  private statusFromCheck(
    connection: ConnectionConfig,
    healthy: boolean,
  ): ConnectionStatus {
    if (!healthy) {
      return connection.status === 'disabled'
        ? 'disabled'
        : 'missing_prerequisites';
    }
    return connection.status;
  }

  /**
   * Everything a recorded reason must not carry, in one place.
   *
   * Two passes, because they remove different things and neither can do the
   * other's job. `redactConnectionSecretEchoes` scrubs values this connection
   * HOLDS — see `connection-refusal-redaction.ts` for what that covers and
   * cannot. `redactProviderIdentifiers` scrubs identity the PROVIDER supplies:
   * an AWS refusal quotes the account, the principal and the resource, none of
   * which are in the config and all of which end up in a stored receipt and a
   * rendered notice (archive#3654 review, H3).
   *
   * Every reason a check records goes through here — catalogue and chat probe
   * alike. Redacting where each reason is built is what left the chat probe
   * uncovered in the first place.
   *
   * ORDER MATTERS, and the integration test for this found it the hard way:
   * the provider pass runs FIRST, on the text the provider actually produced.
   * The config pass rewrites substrings anywhere in the message, so a region
   * or a model id sitting INSIDE an ARN (`arn:aws:bedrock:us-east-1::
   * foundation-model/<model>`) becomes `arn:aws:bedrock:[redacted]::…` — no
   * longer an ARN to any pattern, and the account and resource around it
   * survive. Run it the other way and each pass sees the shape it was written
   * for.
   */
  private redactProviderReason(
    message: string,
    connection: ProviderConnectionConfig,
  ): string {
    return redactConnectionSecretEchoes(
      redactProviderIdentifiers(connection.type, message),
      connection.config,
    );
  }

  /**
   * Model connections whose latest check — bound to the configuration they
   * hold right now — is a fault that gates readiness, and which fault it is:
   * `failed` (the provider refused these settings) or `unreachable` (Station
   * could not reach the endpoint, past its grace window). The distinction
   * travels with the id so a consumer can say which one happened instead of
   * printing "refused" over a network outage (delta2 review M1).
   *
   * Review H1: `readinessEvidence` was the only thing a refusal changed,
   * while system status derived chat readiness from `activeAgents.has(
   * 'default')` and the Home/agent probe from "an enabled LLM connection
   * exists". So the hub could say a connection's check failed and, directly
   * above it, recommend the same connection as chat-capable. This is the one
   * derivation those legibility surfaces read.
   *
   * Deliberately NOT consulted by the execution path. A receipt is a claim
   * about the past; the delivery attempt performs its own authoritative
   * request and reports what actually happens. Gating execution on a stale
   * refusal could strand a connection that has since started working, which
   * is a worse failure than an over-cautious recommendation.
   */
  /**
   * The standing check receipt for ONE model connection — read, never probed
   * (archive#3654 review round 2).
   *
   * A caller that wants the classified state of a single connection had to go
   * through `listModelConnections()`, which runs catalogue discovery against
   * EVERY configured model connection at concurrency 4. That turned one
   * targeted read of a documented public endpoint into network traffic to
   * every provider the operator has, at whatever frequency an external client
   * chooses to poll — the caller cannot see the amplification, and neither can
   * the provider being called.
   *
   * This reads what is already recorded and nothing else: no provider is
   * constructed, no request is made, and no other connection is touched. The
   * receipt is bound to the configuration the connection holds RIGHT NOW, so
   * an edited key retires it rather than letting a stale pass vouch for new
   * settings; `not-checked` is the honest answer when nothing has observed
   * this configuration yet.
   */
  getModelConnectionCheck(id: string): ConnectionCheckEvidence | null {
    const connection = this.providerService
      .listProviderConnections()
      .find((candidate) => candidate.id === id);
    if (!connection) return null;
    return this.checkEvidenceFor(id, connectionFingerprint(connection));
  }

  checkGatedModelConnectionIds(): Map<string, 'failed' | 'unreachable'> {
    const gated = new Map<string, 'failed' | 'unreachable'>();
    const now = Date.now();
    for (const connection of this.providerService.listProviderConnections()) {
      const check = this.checkEvidenceFor(
        connection.id,
        connectionFingerprint(connection),
        now,
      );
      // `connectionCheckGatesReadiness` is the shared predicate, not a local
      // opinion: a refusal always gates, unreachability gates only once it is
      // out of its grace window, and `catalog-unavailable` never gates — the
      // endpoint answered and merely has no catalogue, which cannot claim
      // Ready but is not a broken connection (delta review H1).
      if (connectionCheckGatesReadiness(check)) {
        gated.set(
          connection.id,
          check.status === 'unreachable' ? 'unreachable' : 'failed',
        );
      }
    }
    return gated;
  }

  async readQuotaSnapshot(id: string): Promise<ConnectionQuotaResult> {
    const registry = await this.agentRegistry?.load();
    // Public IDs are the persisted contract, while runtime IDs are accepted at
    // this boundary because callers can legitimately hold an adapter identity.
    const registryConnection = registry?.engineConnections.find(
      (candidate) => String(candidate.id) === id,
    );
    const publicConnectionId = String(registryConnection?.id ?? id);
    const engineIdentity = String(registryConnection?.id ?? id);
    const connection = await this.getConnection(publicConnectionId);
    if (!connection) throw new Error(`Connection '${id}' not found`);
    const adapter = this.getProviderAdapters().find(
      (candidate) => engineIdForAdapter(candidate) === engineIdentity,
    );
    const appConfig = await this.getAppConfig();
    const credentialProfileRef = normalizeCredentialProfileRegistry(
      appConfig.agentConnections?.[engineIdentity]?.credentialRecovery,
    ).activeProfileRef;
    return adapter?.readQuotaSnapshot
      ? adapter.readQuotaSnapshot({
          connectionId: publicConnectionId,
          ...(credentialProfileRef ? { credentialProfileRef } : {}),
        })
      : { kind: 'unavailable', reason: 'unsupported-provider' };
  }

  private async invalidateQuotaSnapshot(id: string): Promise<void> {
    const registry = await this.agentRegistry?.load();
    const registryConnection = registry?.engineConnections.find(
      (candidate) => String(candidate.id) === id,
    );
    const publicConnectionId = String(registryConnection?.id ?? id);
    const engineIdentity = String(registryConnection?.id ?? id);
    for (const adapter of this.getProviderAdapters()) {
      if (engineIdForAdapter(adapter) === engineIdentity) {
        adapter.invalidateQuotaSnapshot?.({ connectionId: publicConnectionId });
      }
    }
  }

  async smokeConnection(
    id: string,
    options: { confirmed: boolean; timeoutMs?: number },
  ): Promise<ConnectionReadinessEvidence> {
    if (!options.confirmed) {
      throw new Error(
        'Explicit confirmation is required because this smoke sends one potentially billable chat turn.',
      );
    }
    const connection = await this.getConnection(id);
    if (!connection) throw new Error(`Connection '${id}' not found`);
    const configurationFingerprint =
      await this.captureConnectionSmokeFingerprint(connection);
    const startedAt = new Date();
    const provider =
      connection.type === 'acp'
        ? 'acp'
        : typeof connection.config.provider === 'string'
          ? (connection.config.provider as EngineId)
          : null;
    let result: ConnectionSmokeRunResult;
    if (!connection.enabled) {
      result = this.localSmokeFailure(
        'disabled',
        'This connection is disabled.',
        'Enable it before running the smoke.',
      );
    } else if (hasRequiredMissing(connection.prerequisites)) {
      result = this.localSmokeFailure(
        'missing-prerequisites',
        'Required connection prerequisites are missing.',
        'Complete the required setup, then run the smoke again.',
      );
    } else if (
      connection.kind !== 'agent' ||
      !connection.capabilities.includes('agent-runtime') ||
      !provider ||
      !this.smokeRunner
    ) {
      result = this.localSmokeFailure(
        'unsupported-runtime',
        'This connection does not expose a supported chat runtime smoke.',
        'Use a Claude, Codex, Ollama, or configured command-backed engine connection.',
      );
    } else {
      const configuredModel =
        typeof connection.config.defaultModel === 'string'
          ? connection.config.defaultModel.trim() || undefined
          : undefined;
      const runtimeModels = (connection as AgentConnectionView).runtimeCatalog
        ?.models;
      const adapter = this.getProviderAdapters().find(
        (candidate) => engineIdForAdapter(candidate) === connection.type,
      );
      const allowsOmittedModel =
        connection.type === 'acp' ||
        adapter?.metadata.modelLaunch?.defaultAtStart === 'engine-selected';
      try {
        if (!allowsOmittedModel && !configuredModel) {
          result = this.localSmokeFailure(
            'unsupported-runtime',
            'This runtime has no configured model selector.',
            'Configure an exact default model before running the smoke.',
          );
        } else if (
          configuredModel &&
          runtimeModels &&
          !runtimeModels.some((model) => model.id === configuredModel)
        ) {
          result = this.localSmokeFailure(
            'unsupported-runtime',
            'The configured model is absent from the runtime catalog.',
            'Select a model reported by the runtime before running the smoke.',
          );
        } else {
          result = await this.smokeRunner({
            connectionId: connection.id,
            provider,
            modelId: configuredModel,
            cwd: process.cwd(),
            ...(connection.type === 'acp'
              ? { metadata: { connectionId: connection.id } }
              : {}),
            timeoutMs: Math.max(
              5_000,
              Math.min(options.timeoutMs ?? 45_000, 60_000),
            ),
          });
        }
      } catch {
        result = this.localSmokeFailure(
          'unknown',
          'The bounded smoke runner failed before it could publish a safe receipt.',
          'Check Station logs for cleanup or runtime errors before trying again.',
        );
      }
    }
    const testedAt = new Date().toISOString();
    const stored: StoredConnectionSmokeResult = {
      evidenceVersion: 2,
      connectionId: connection.id,
      configurationFingerprint,
      status: result.ok ? 'passed' : 'failed',
      testedAt,
      freshUntil: deriveConnectionSmokeFreshUntil(testedAt),
      provider: provider ?? connection.type,
      ...(result.model ? { model: result.model } : {}),
      durationMs: result.durationMs || Date.now() - startedAt.getTime(),
      ...(!result.ok
        ? {
            reasonCode: result.reasonCode,
            reason: result.reason,
            action: result.action,
          }
        : {}),
      turnLimit: 1,
    };
    const currentConnection = await this.getConnection(id);
    if (
      !currentConnection ||
      (await this.captureConnectionSmokeFingerprint(currentConnection)) !==
        configurationFingerprint
    ) {
      throw new Error(
        `Connection '${id}' changed while its smoke was running; the result was discarded.`,
      );
    }
    await this.smokeEvidenceStore.record(stored);
    this.invalidateModelInventory();
    return deriveConnectionReadinessEvidence(connection, stored);
  }

  private localSmokeFailure(
    reasonCode: ConnectionSmokeFailureReason,
    reason: string,
    action: string,
  ): ConnectionSmokeRunResult {
    return { ok: false, durationMs: 0, reasonCode, reason, action };
  }

  private withReadinessEvidence<T extends ConnectionConfig>(
    connection: T,
    configurationFingerprint = connectionSmokeFingerprint(connection),
  ): T {
    const stored = this.smokeEvidenceStore.get(connection.id);
    const matchingStored =
      stored?.configurationFingerprint === configurationFingerprint
        ? stored
        : null;
    // RT-06: a model connection reads `ready` off "a non-empty key string is
    // saved". The explicit check is the only observation that can refute it,
    // and it is bound to the configuration it observed — editing the key
    // changes the fingerprint, which retires the receipt rather than letting a
    // stale pass vouch for new credentials.
    const check: ConnectionCheckEvidence | null =
      connection.kind === 'model'
        ? this.checkEvidenceFor(connection.id, configurationFingerprint)
        : null;
    return {
      ...connection,
      ...(check?.checkedAt ? { lastCheckedAt: check.checkedAt } : {}),
      readinessEvidence: deriveConnectionReadinessEvidence(
        connection,
        matchingStored,
        undefined,
        check,
      ),
    };
  }

  private async captureConnectionSmokeFingerprint(
    connection: ConnectionConfig,
  ): Promise<string> {
    if (connection.kind === 'model') {
      const raw = this.providerService
        .listProviderConnections()
        .find((candidate) => candidate.id === connection.id);
      return raw
        ? connectionFingerprint(raw)
        : connectionSmokeFingerprint(connection);
    }
    const [appConfig, acpConnections] = await Promise.all([
      this.getAppConfig(),
      this.getACPConnections(),
    ]);
    return this.runtimeConnectionFingerprint(
      connection as AgentConnectionView,
      appConfig,
      acpConnections,
      this.getProviderAdapters(),
    );
  }

  private runtimeConnectionFingerprint(
    connection: ConnectionConfig,
    appConfig: AppConfig,
    acpConnections: ACPConnectionConfig[],
    adapters: ProviderAdapterShape[],
  ): string {
    const acpConnection = acpConnections.find(
      (candidate) => candidate.id === connection.id,
    );
    if (acpConnection) {
      return valueFingerprint({ type: 'acp', connection: acpConnection });
    }
    const rawEngineIdentity = connection.config?.engineId;
    const engineIdentity =
      typeof rawEngineIdentity === 'string' ? rawEngineIdentity : connection.id;
    const adapter = adapters.find(
      (candidate) => engineIdForAdapter(candidate) === engineIdentity,
    );
    return valueFingerprint({
      type: 'adapter',
      provider: adapter?.provider ?? connection.type,
      engineId: adapter ? engineIdForAdapter(adapter) : engineIdentity,
      settings: appConfig.agentConnections?.[engineIdentity] ?? null,
    });
  }

  private async collectModelPrerequisites(
    connection: ProviderConnectionConfig,
    signal?: AbortSignal,
  ): Promise<Prerequisite[]> {
    const providers = [
      createLLMProvider(connection),
      createEmbeddingProvider(connection),
      createVectorDbProvider(connection),
    ].filter(Boolean);

    const prerequisiteSets = await Promise.all(
      providers.map(async (provider) => {
        if (
          provider &&
          'getPrerequisites' in provider &&
          typeof provider.getPrerequisites === 'function'
        ) {
          return (
            (await raceWithSignal(
              provider.getPrerequisites({ signal }),
              signal,
            )) ?? []
          );
        }
        return [];
      }),
    );

    const deduped = new Map<string, Prerequisite>();
    for (const prerequisites of prerequisiteSets) {
      for (const prerequisite of prerequisites) {
        deduped.set(prerequisite.id, prerequisite);
      }
    }
    return [...deduped.values()];
  }
}
type CredentialApplicationFactory = ReturnType<
  EventStore['createCredentialApplicationFactory']
>;
type CredentialApplicationClaim = Extract<
  ReturnType<CredentialApplicationFactory['start']>,
  { kind: 'owner' }
>['claim'];
type CredentialApplication = CredentialApplicationClaim['application'];
