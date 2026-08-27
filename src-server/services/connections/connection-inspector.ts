import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import {
  type EngineConnectionId,
  type EngineRuntimeId,
  engineRuntimeId,
} from '@kontourai/station-contracts/agent-identity';
import type { AppConfig } from '@kontourai/station-contracts/config';
import type {
  AgentConnectionView,
  Prerequisite,
} from '@kontourai/station-contracts/tool';
import {
  engineIdForAdapter,
  runtimeIdForAdapter,
} from '../../providers/adapter-identity.js';
import type {
  ProviderAdapterModelCatalog,
  ProviderAdapterShape,
} from '../../providers/adapter-shape.js';
import { getProviderAdapterRegistrationProvenance } from '../../providers/adapter-shape.js';
import { ACP_ADAPTER_CAPABILITIES } from '../../providers/adapters/acp-adapter.js';
import {
  connectionStatusFromRuntimeReadiness,
  resolveRuntimeAdapterReadiness,
} from '../../runtime/frameworks/runtime-adapter-readiness.js';
import {
  awaitSettlementWithin,
  mapWithConcurrency,
  raceWithSignal,
  throwIfAborted,
} from '../../utils/bounded-async.js';
import {
  type ACPConnectionStatus,
  acpRuntimeCatalogStatus,
  buildACPCapabilityInventory,
  buildRuntimeCapabilityInventory,
  buildRuntimeCatalogStatus,
  credentialRecoveryProjectionForAdapter,
  mergeRuntimeConfig,
  projectControlPlaneObservation,
  providerLabelForAdapter,
  recordRuntimeCatalogStatus,
  runtimeSettingsFor,
  runtimeSetupState,
} from './connection-service-helpers.js';

const MODEL_OPTION_MAX_ENTRIES = 1000;
const ADAPTER_ABORT_SETTLEMENT_MS = 650;

/** A public identity is never inferred from an Adapter-private runtime selector. */
export type InspectedPublicConnection = {
  id: EngineConnectionId;
  runtimeId: EngineRuntimeId;
};

export type ConnectionInspectionRequest = {
  kind: 'runtime-capability-inventory';
  signal?: AbortSignal;
  concurrency?: number;
  includeCommands?: boolean;
  includePrerequisites?: boolean;
  disableHostDiscovery?: boolean;
  allowBuiltInOnDiscoveryFailure?: boolean;
};

export type ConnectionInspectionOutcome =
  | {
      kind: 'inspected';
      connections: AgentConnectionView[];
      freshness: 'live' | 'partial' | 'stale' | 'unknown';
      provenance: 'adapter-observation' | 'adapter-and-built-in';
      partial: boolean;
      retry: 'on-next-inspection';
    }
  | {
      kind: 'timed-out' | 'aborted' | 'unavailable';
      connections: AgentConnectionView[];
      freshness: 'unknown';
      provenance: 'none';
      partial: true;
      retry: 'on-next-inspection';
    };

/**
 * The ConnectionInspector Interface owns inspection freshness, provenance,
 * partial availability, timeout and retry semantics. This first vertical is
 * intentionally uncached: each inspection is a fresh Adapter observation;
 * inventory/quota cache ownership is a later ConnectionInspector vertical.
 * Callers receive public connection identities and never branch on Adapter
 * discovery contributions. Remaining Adapter optional methods (quota and
 * command/model-picker execution validation) are later verticals.
 */
export interface ConnectionInspector {
  inspect(
    request: ConnectionInspectionRequest,
  ): Promise<ConnectionInspectionOutcome>;
}

interface ConnectionInspectorDependencies {
  adapters(): ProviderAdapterShape[];
  appConfig(): AppConfig;
  acpConnections(): ACPConnectionConfig[];
  acpStatus(): { connections?: ACPConnectionStatus[] };
  /** Composition Seam mapping from Adapter-private runtime to public identity. */
  publicConnection(
    runtimeId: EngineRuntimeId,
  ): InspectedPublicConnection | undefined;
  now(): number;
  onInspectionFailure?(error: unknown): void;
}

type AdapterCommands = Array<{
  name: string;
  description: string;
  argumentHint?: string;
  passthrough: boolean;
}>;

class ConnectionInspectorImplementation implements ConnectionInspector {
  constructor(private readonly dependencies: ConnectionInspectorDependencies) {}

  async inspect(
    request: ConnectionInspectionRequest,
  ): Promise<ConnectionInspectionOutcome> {
    const controller = new AbortController();
    const mirrorAbort = () => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) mirrorAbort();
    else request.signal?.addEventListener('abort', mirrorAbort, { once: true });
    const scopedRequest = { ...request, signal: controller.signal };
    try {
      const connections = await this.inspectInventory(
        scopedRequest,
        (error) => {
          controller.abort(error);
          try {
            this.dependencies.onInspectionFailure?.(error);
          } catch {
            // Observation cannot break the total inspection Interface.
          }
        },
      );
      const catalogs = connections.map(
        (connection) => connection.runtimeCatalog,
      );
      const live = catalogs.filter(
        (catalog) => catalog?.source === 'live',
      ).length;
      const stale = catalogs.filter(
        (catalog) => catalog?.source === 'built-in',
      ).length;
      return {
        kind: 'inspected',
        connections,
        freshness:
          live === connections.length && connections.length > 0
            ? 'live'
            : live > 0
              ? 'partial'
              : stale > 0
                ? 'stale'
                : 'unknown',
        provenance: stale > 0 ? 'adapter-and-built-in' : 'adapter-observation',
        partial: connections.some(
          (connection) =>
            connection.runtimeCatalog?.source === 'none' ||
            connection.runtimeCatalog?.source === 'built-in' ||
            connection.runtimeCatalog?.truncated === true ||
            connection.config.inspectionPartial === true,
        ),
        retry: 'on-next-inspection',
      };
    } catch {
      return {
        kind: isTimeoutAbort(request.signal)
          ? 'timed-out'
          : request.signal?.aborted
            ? 'aborted'
            : 'unavailable',
        connections: [],
        freshness: 'unknown',
        provenance: 'none',
        partial: true,
        retry: 'on-next-inspection',
      };
    } finally {
      request.signal?.removeEventListener('abort', mirrorAbort);
    }
  }

  private async inspectInventory(
    request: ConnectionInspectionRequest,
    onFirstFailure: (error: unknown) => void,
  ): Promise<AgentConnectionView[]> {
    throwIfAborted(request.signal);
    const appConfig = this.dependencies.appConfig();
    const adapters = this.dependencies.adapters();
    const inspected = await mapWithConcurrency(
      adapters.filter((adapter) => adapter.provider !== 'acp'),
      request.concurrency ?? 4,
      async (adapter) => this.inspectAdapter(adapter, appConfig, request),
      request.signal,
      {
        settleInFlightOnAbort: true,
        onFirstFailure,
      },
    );
    throwIfAborted(request.signal);
    const connections = inspected.flatMap((connection) =>
      connection ? [connection] : [],
    );
    const acpSettings = runtimeSettingsFor(appConfig, 'acp');
    for (const config of this.dependencies.acpConnections()) {
      const runtimeId = engineRuntimeId(config.id);
      const identity = this.dependencies.publicConnection(runtimeId);
      if (!identity) continue;
      const liveStatus = this.dependencies
        .acpStatus()
        .connections?.find((connection) => connection.id === config.id);
      const enabled = (acpSettings.enabled ?? true) && config.enabled !== false;
      const status = !enabled
        ? 'disabled'
        : liveStatus?.status === 'available'
          ? 'ready'
          : 'degraded';
      const prerequisites: Prerequisite[] = [
        {
          id: 'acp-connection',
          name: config.name || config.id,
          description: `Configure the "${config.name || config.id}" custom engine to use its agents.`,
          status: liveStatus?.status === 'available' ? 'installed' : 'missing',
          category: 'optional',
        },
      ];
      connections.push({
        id: identity.id,
        kind: 'agent',
        type: 'acp',
        name: config.name || config.id,
        enabled,
        description:
          'External engine connection, driven as a command-backed CLI.',
        // station#3344: the adapter's own declaration, never a second literal
        // — this view is the only capability source the composer sees for an
        // ACP session, and the copy that used to live here had lost
        // `image-input`.
        capabilities: [...ACP_ADAPTER_CAPABILITIES],
        // `loadSession` is a live initialize observation for THIS configured
        // CLI. Never reuse a former handshake after reconnect/offline: absent
        // or false is honestly no native resume.
        continuity: {
          resume:
            liveStatus?.status === 'available' &&
            liveStatus.capabilities?.loadSession === true
              ? 'same-session'
              : 'none',
          fork: 'none',
          rewind: 'none',
        },
        config: {
          engineId: 'acp',
          runtimeConnectionId: runtimeId,
        },
        setup: {
          state: status === 'ready' ? 'ready' : 'configured',
          detected: liveStatus?.status === 'available',
          configured: true,
        },
        capabilityInventory: buildACPCapabilityInventory({
          connection: liveStatus,
          configuredCount: 1,
          connectedCount: liveStatus ? 1 : 0,
          enabled,
        }),
        controlPlaneObservation: projectControlPlaneObservation(liveStatus),
        // station#3054: the handshake's model config option IS this engine's
        // catalog — project it so the composer's wire-channel gate sees the
        // observed evidence it requires instead of an absent field.
        runtimeCatalog: acpRuntimeCatalogStatus(liveStatus),
        prerequisites,
        status,
        lastCheckedAt: null,
      });
    }
    return connections;
  }

  private async inspectAdapter(
    adapter: ProviderAdapterShape,
    appConfig: AppConfig,
    request: ConnectionInspectionRequest,
  ): Promise<AgentConnectionView | undefined> {
    const runtimeId = runtimeIdForAdapter(adapter);
    const identity = this.dependencies.publicConnection(runtimeId);
    if (!identity) return undefined;
    const hostDiscoveryDisabled =
      request.disableHostDiscovery === true &&
      engineIdForAdapter(adapter) !== 'station';
    let probePartial = false;
    const prerequisites = hostDiscoveryDisabled
      ? [
          {
            id: `${runtimeId}-host-discovery`,
            name: `${adapter.metadata.displayName} host discovery`,
            description: 'Host discovery is disabled for this run.',
            status: 'missing' as const,
            category: 'required' as const,
          },
        ]
      : request.includePrerequisites === false
        ? []
        : await this.prerequisites(adapter, runtimeId, request.signal, () => {
            probePartial = true;
          });
    const settings = runtimeSettingsFor(appConfig, runtimeId);
    const enabled = settings.enabled ?? true;
    const readiness = resolveRuntimeAdapterReadiness({
      adapter,
      runtimeId,
      enabled,
      prerequisites,
    });
    let liveCatalog: ProviderAdapterModelCatalog | undefined;
    let liveDiscoveryFailed = false;
    if (!hostDiscoveryDisabled) {
      try {
        const discovery = adapter.listModelCatalog
          ? adapter.listModelCatalog({
              signal: request.signal,
              maxEntries: MODEL_OPTION_MAX_ENTRIES,
            })
          : adapter.listModels
            ? adapter
                .listModels({
                  signal: request.signal,
                  maxEntries: MODEL_OPTION_MAX_ENTRIES,
                })
                .then((models) => ({ models }))
            : undefined;
        if (discovery) {
          liveCatalog =
            getProviderAdapterRegistrationProvenance(adapter) === 'builtin' &&
            adapter.metadata.abortSettlement === 'await'
              ? await this.inspectWithSettlement(discovery, request.signal)
              : await raceWithSignal(discovery, request.signal);
        }
      } catch {
        throwIfAborted(request.signal);
        liveDiscoveryFailed = true;
      }
    }
    const runtimeCatalog = buildRuntimeCatalogStatus({
      adapter,
      liveCatalog,
      liveDiscoveryFailed,
      allowBuiltInOnDiscoveryFailure:
        request.allowBuiltInOnDiscoveryFailure !== false,
      now: this.dependencies.now(),
    });
    recordRuntimeCatalogStatus({ adapter, catalog: runtimeCatalog });
    let commands: AdapterCommands = [];
    if (!hostDiscoveryDisabled && request.includeCommands !== false) {
      try {
        commands = await raceWithSignal(
          adapter.getCommands?.({ signal: request.signal }) ??
            Promise.resolve([]),
          request.signal,
        );
      } catch {
        throwIfAborted(request.signal);
        probePartial = true;
      }
    }
    const name = settings.name?.trim() || adapter.metadata.displayName;
    return {
      id: identity.id,
      kind: 'agent',
      type: runtimeId,
      name,
      enabled,
      description: adapter.metadata.description,
      capabilities: [...adapter.metadata.capabilities],
      continuity: adapter.metadata.continuity,
      config: {
        ...mergeRuntimeConfig(runtimeId, appConfig, settings),
        provider: adapter.provider,
        providerLabel: providerLabelForAdapter(adapter),
        engineId: engineIdForAdapter(adapter),
        runtimeConnectionId: runtimeId,
        inspectionPartial: probePartial,
        readinessState: readiness.state,
        readinessReason: readiness.reason,
      },
      setup: runtimeSetupState(
        appConfig,
        runtimeId,
        prerequisites,
        readiness.ready,
      ),
      modelExecution: adapter.metadata.modelExecution,
      runtimeCatalog,
      capabilityInventory: buildRuntimeCapabilityInventory({
        adapter,
        id: runtimeId,
        displayName: name,
        enabled,
        prerequisites,
        catalog: runtimeCatalog,
        commands,
      }),
      credentialRecovery: credentialRecoveryProjectionForAdapter(
        adapter,
        settings.credentialRecovery,
      ),
      prerequisites,
      status: connectionStatusFromRuntimeReadiness(readiness),
      lastCheckedAt: null,
    };
  }

  private async prerequisites(
    adapter: ProviderAdapterShape,
    runtimeId: EngineRuntimeId,
    signal: AbortSignal | undefined,
    partial: () => void,
  ): Promise<Prerequisite[]> {
    try {
      const probe =
        adapter.getPrerequisites?.({ signal }) ?? Promise.resolve([]);
      return getProviderAdapterRegistrationProvenance(adapter) === 'builtin' &&
        adapter.metadata.abortSettlement === 'await'
        ? await this.inspectWithSettlement(probe, signal)
        : await raceWithSignal(probe, signal);
    } catch {
      throwIfAborted(signal);
      partial();
      return [
        {
          id: `${runtimeId}-inspection`,
          name: `${adapter.metadata.displayName} inspection`,
          description:
            'Station could not verify this connection’s prerequisites. Retry inspection before using it.',
          status: 'missing',
          category: 'required',
        },
      ];
    }
  }

  private async inspectWithSettlement<T>(
    discovery: Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await raceWithSignal(discovery, signal);
    } catch (error) {
      if (signal?.aborted)
        await awaitSettlementWithin(discovery, ADAPTER_ABORT_SETTLEMENT_MS);
      throw error;
    }
  }
}

function isTimeoutAbort(signal: AbortSignal | undefined): boolean {
  const reason = signal?.reason;
  return reason instanceof DOMException && reason.name === 'TimeoutError';
}

/** Creates the deep inspection Module at the connection composition Seam. */
export function createConnectionInspector(
  dependencies: ConnectionInspectorDependencies,
): ConnectionInspector {
  return new ConnectionInspectorImplementation(dependencies);
}
