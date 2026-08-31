import type { EngineConnectionId } from '@kontourai/station-contracts/agent-identity';
import type { FleetContributionManifest } from '@kontourai/station-contracts/fleet-contribution';
import type { ConnectionInventoryFailure } from '@kontourai/station-contracts/model-inventory';
import { describeConnectionInventoryFailures } from '@kontourai/station-contracts/model-inventory';
import type {
  AgentConnectionView,
  ConnectionConfig,
  ConnectionReadinessEvidence,
  ModelConnectionConfig,
  ModelOption,
} from '@kontourai/station-contracts/tool';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import {
  type MutationOptions,
  type QueryConfig,
  useApiQuery,
} from '../query-core';

export interface GlobalKnowledgeStatus {
  vectorDb: { id: string; name: string; type: string; enabled: boolean } | null;
  embedding: {
    id: string;
    name: string;
    type: string;
    enabled: boolean;
  } | null;
  stats: { totalDocuments: number; totalChunks: number; projectCount: number };
}

export interface ModelConnectionMutationInput {
  connection: ModelConnectionConfig;
  isNew?: boolean;
}

export interface AgentConnectionMutationInput {
  connection: AgentConnectionView;
  isNew?: boolean;
}

export class ConnectionModelSelectionError extends Error {
  readonly modelOptions: ModelOption[];

  constructor(message: string, modelOptions: ModelOption[]) {
    super(message);
    this.name = 'ConnectionModelSelectionError';
    this.modelOptions = modelOptions;
  }
}

export interface ConnectionTestResult {
  healthy: boolean;
  status?: ConnectionConfig['status'];
  /**
   * The provider's own refusal when the check failed, redacted of anything it
   * echoed back from this connection's config. Absent on success and on
   * runtime connections, which have no provider to ask.
   */
  reason?: string;
  /** When the check ran; the connection view carries the same instant. */
  checkedAt?: string;
}

/**
 * The inventory reader every connection query shares (station#3748).
 *
 * The server now returns the rows it could read plus the ones it could not.
 * An empty list beside a non-empty `failures` is not "you have no
 * connections" — it is a read that failed — and it used to render as the
 * former everywhere: an empty picker, a disabled Create, a status panel
 * saying nothing is configured. Throwing here is what puts those surfaces
 * into the `ErrorState` they already have, with the failing connections named
 * in the sentence rather than a generic one.
 *
 * Surviving rows are NOT withheld when some rows failed: a partial inventory
 * is more useful than none, and the alternative — refusing to show four
 * working connections because a fifth is malformed — is the all-or-nothing
 * behaviour this replaced.
 */
function readInventoryEnvelope<TRow>(
  result: {
    success?: boolean;
    error?: string;
    data?: unknown;
    failures?: ConnectionInventoryFailure[];
  },
  kind: string,
): TRow[] {
  if (!result.success) {
    throw new Error(result.error);
  }
  const rows = (result.data ?? []) as TRow[];
  const failures = result.failures ?? [];
  if (rows.length === 0 && failures.length > 0) {
    throw new Error(describeConnectionInventoryFailures(kind, failures));
  }
  return rows;
}

export function useConnectionsQuery(config?: QueryConfig<ConnectionConfig[]>) {
  return useApiQuery(
    ['connections'],
    async () => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(`${apiBase}/api/connections`);
      const result = await response.json();
      if (!result.success) {
        throw new Error(result.error);
      }
      return result.data as ConnectionConfig[];
    },
    config,
  );
}

export function useModelConnectionsQuery(
  config?: QueryConfig<ModelConnectionConfig[]>,
) {
  return useApiQuery(
    ['connections', 'models'],
    async () => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/connections/models`,
      );
      return readInventoryEnvelope<ModelConnectionConfig>(
        await response.json(),
        'model',
      );
    },
    config,
  );
}

/**
 * How many records of each kind this projection could not read. A count, not a
 * boolean: "some connections were dropped" and "one connection was dropped"
 * are different facts, and a consumer that wants to say so needs the number.
 */
export interface ModelPickerCatalogExclusions {
  agents: number;
  models: number;
}

export interface ModelPickerCatalog {
  agentConnections: AgentConnectionView[];
  modelConnections: ModelConnectionConfig[];
  excluded: ModelPickerCatalogExclusions;
}

/**
 * Project every record, and let one bad record cost exactly itself
 * (station#3390). The projection below reads several fields without a type
 * guard — `connection.setup.state`, `connection.capabilities.filter`,
 * `connection.config.engineId` — and a throw from any of them used to abandon
 * the whole map, so ONE malformed connection returned BOTH lists empty for the
 * entire app: the composer degraded to raw model ids and the picker rendered
 * disabled, with nothing anywhere saying why.
 *
 * Isolation rather than a wider set of typeof guards, deliberately: a guard
 * has to be written once per field and only defends the field someone thought
 * of, while this defends every read in the projection including the ones added
 * later. A record that cannot be read contributes nothing — the alternative,
 * projecting it partially, would put a half-built connection into a picker
 * that cannot tell it from a whole one.
 */
function projectEach<TRecord, TProjected>(
  records: unknown,
  project: (record: TRecord) => TProjected,
  kind: string,
): { kept: TProjected[]; excluded: number } {
  // A payload that is not a list is a malformed RESPONSE, not a malformed
  // record, and isolation has nothing to isolate. Returning `{kept: [],
  // excluded: 0}` here would report "nothing was dropped" about a response
  // that dropped everything — a count nothing derives, which is the exact
  // defect this function exists to fix one level down — and it would do it
  // silently, where the unguarded code this replaced at least threw and put
  // the query into a visible error state. So it still throws (station#3390
  // review B-1).
  if (!Array.isArray(records)) {
    throw new Error(
      `[model-picker-catalog] ${kind} connections came back as ${records === null ? 'null' : typeof records}, not a list`,
    );
  }
  const kept: TProjected[] = [];
  let excluded = 0;
  for (const record of records) {
    try {
      kept.push(project(record as TRecord));
    } catch {
      excluded += 1;
    }
  }
  return { kept, excluded };
}

/**
 * Credential-free projection used by offline-capable model pickers. The raw
 * connection queries intentionally remain outside query persistence because
 * their `config` bags can contain authentication material.
 */
export function useModelPickerCatalogQuery(
  config?: QueryConfig<ModelPickerCatalog>,
) {
  return useApiQuery(
    ['model-picker-catalog'],
    async () => {
      const apiBase = await _getApiBase();
      const [agentResponse, modelResponse] = await Promise.all([
        authenticatedFetch(`${apiBase}/api/connections/agents`),
        authenticatedFetch(`${apiBase}/api/connections/models`),
      ]);
      const [agentResult, modelResult] = await Promise.all([
        agentResponse.json(),
        modelResponse.json(),
      ]);
      // station#3748: the same error-is-not-empty rule the raw queries apply.
      // A picker fed by a read that failed must not render as "no engines".
      readInventoryEnvelope<AgentConnectionView>(agentResult, 'engine');
      readInventoryEnvelope<ModelConnectionConfig>(modelResult, 'model');

      const safeModelOptions = (value: unknown): ModelOption[] =>
        Array.isArray(value)
          ? value.flatMap((candidate) => {
              if (
                !candidate ||
                typeof candidate !== 'object' ||
                typeof candidate.id !== 'string' ||
                typeof candidate.name !== 'string'
              ) {
                return [];
              }
              const model = candidate as Partial<ModelOption>;
              return [
                {
                  id: candidate.id,
                  name: candidate.name,
                  originalId:
                    typeof model.originalId === 'string'
                      ? model.originalId
                      : candidate.id,
                  ...(typeof model.resolvedModel === 'string'
                    ? { resolvedModel: model.resolvedModel }
                    : {}),
                  ...(model.capabilities
                    ? {
                        capabilities: {
                          ...(typeof model.capabilities.supportsEffort ===
                          'boolean'
                            ? {
                                supportsEffort:
                                  model.capabilities.supportsEffort,
                              }
                            : {}),
                          ...(Array.isArray(
                            model.capabilities.supportedEffortLevels,
                          )
                            ? {
                                supportedEffortLevels:
                                  model.capabilities.supportedEffortLevels.filter(
                                    (level): level is string =>
                                      typeof level === 'string',
                                  ),
                              }
                            : {}),
                          ...(model.capabilities.effortLabels &&
                          typeof model.capabilities.effortLabels === 'object'
                            ? {
                                effortLabels: Object.fromEntries(
                                  Object.entries(
                                    model.capabilities.effortLabels,
                                  ).filter(
                                    (entry): entry is [string, string] =>
                                      typeof entry[1] === 'string',
                                  ),
                                ),
                              }
                            : {}),
                          ...(typeof model.capabilities
                            .supportsAdaptiveThinking === 'boolean'
                            ? {
                                supportsAdaptiveThinking:
                                  model.capabilities.supportsAdaptiveThinking,
                              }
                            : {}),
                          ...(typeof model.capabilities.supportsFastMode ===
                          'boolean'
                            ? {
                                supportsFastMode:
                                  model.capabilities.supportsFastMode,
                              }
                            : {}),
                          ...(typeof model.capabilities.fastModeLabel ===
                          'string'
                            ? {
                                fastModeLabel: model.capabilities.fastModeLabel,
                              }
                            : {}),
                          ...(typeof model.capabilities.supportsAutoMode ===
                          'boolean'
                            ? {
                                supportsAutoMode:
                                  model.capabilities.supportsAutoMode,
                              }
                            : {}),
                          ...(typeof model.capabilities.contextWindow ===
                          'number'
                            ? {
                                contextWindow: model.capabilities.contextWindow,
                              }
                            : {}),
                        },
                      }
                    : {}),
                },
              ];
            })
          : [];
      const safeConfig = (connection: ConnectionConfig) => ({
        ...(typeof connection.config.engineId === 'string'
          ? { engineId: connection.config.engineId }
          : {}),
        ...(typeof connection.config.executionClass === 'string'
          ? { executionClass: connection.config.executionClass }
          : {}),
        ...(typeof connection.config.defaultModel === 'string'
          ? { defaultModel: connection.config.defaultModel }
          : {}),
        ...(typeof connection.config.approvalMode === 'string'
          ? { approvalMode: connection.config.approvalMode }
          : {}),
        ...(Array.isArray(connection.config.modelOptions)
          ? { modelOptions: safeModelOptions(connection.config.modelOptions) }
          : {}),
      });
      const baseProjection = (connection: ConnectionConfig) => ({
        id: connection.id,
        kind: connection.kind,
        type: connection.type,
        name: connection.name,
        enabled: connection.enabled,
        capabilities: connection.capabilities.filter(
          (capability) => typeof capability === 'string',
        ),
        status: connection.status,
        prerequisites: [],
        config: safeConfig(connection),
      });

      const agents = projectEach<AgentConnectionView, AgentConnectionView>(
        agentResult.data,
        (connection) =>
          ({
            ...baseProjection(connection),
            id: connection.id,
            kind: 'agent' as const,
            setup: {
              state: connection.setup.state,
              detected: connection.setup.detected,
              configured: connection.setup.configured,
            },
            ...(connection.runtimeCatalog
              ? {
                  runtimeCatalog: {
                    source: connection.runtimeCatalog.source,
                    ...(typeof connection.runtimeCatalog.fetchedAt === 'string'
                      ? { fetchedAt: connection.runtimeCatalog.fetchedAt }
                      : connection.runtimeCatalog.fetchedAt === null
                        ? { fetchedAt: null }
                        : {}),
                    ...(typeof connection.runtimeCatalog.reason === 'string'
                      ? { reason: connection.runtimeCatalog.reason }
                      : connection.runtimeCatalog.reason === null
                        ? { reason: null }
                        : {}),
                    models: safeModelOptions(connection.runtimeCatalog.models),
                    builtInModels: safeModelOptions(
                      connection.runtimeCatalog.builtInModels,
                    ),
                    ...(typeof connection.runtimeCatalog.truncated === 'boolean'
                      ? { truncated: connection.runtimeCatalog.truncated }
                      : {}),
                  },
                }
              : {}),
          }) as AgentConnectionView,
        'engine',
      );
      const models = projectEach<ModelConnectionConfig, ModelConnectionConfig>(
        modelResult.data,
        (connection) =>
          ({
            ...baseProjection(connection),
            kind: 'model' as const,
          }) as ModelConnectionConfig,
        'model',
      );
      const excluded = { agents: agents.excluded, models: models.excluded };
      if (excluded.agents || excluded.models) {
        // One line per fetch, not per record: a malformed list would otherwise
        // print once per entry. The count is on the returned value too, so a
        // surface can report this without reading the console.
        console.warn(
          `[model-picker-catalog] excluded ${excluded.agents} engine and ${excluded.models} model connection(s) this Station returned in a shape this client could not read`,
        );
      }
      return {
        agentConnections: agents.kept,
        modelConnections: models.kept,
        excluded,
      };
    },
    config,
  );
}

export function useEngineConnectionsQuery(
  config?: QueryConfig<AgentConnectionView[]>,
) {
  return useApiQuery(
    ['connections', 'engines'],
    async () => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/connections/agents`,
      );
      return readInventoryEnvelope<AgentConnectionView>(
        await response.json(),
        'engine',
      );
    },
    config,
  );
}

/** Engines exposed by the Connections / Engines surface. */

export function useAgentConnectionCatalogQuery(
  config?: QueryConfig<AgentConnectionView[]>,
) {
  return useApiQuery(
    ['connections', 'engines', 'catalog'],
    async () => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/connections/agents/catalog`,
      );
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      return result.data as AgentConnectionView[];
    },
    config,
  );
}

/**
 * `GET /api/connections/model-inventory` — the models this Station
 * CONTRIBUTES to its owner's fleet, as `station.fleet-contribution/v1`.
 *
 * Renamed and re-typed in station#1398 slice 2, deliberately rather than
 * silently: that endpoint used to return `station.model-inventory/v2` — every
 * model the Station could launch — and now requires the `inference:invoke`
 * pairing scope and returns only the contributed subset (§5.3, §10 OQ-2). A
 * type change under the old name would have compiled at every call site while
 * meaning something else; a rename makes the break visible where it happens.
 * The old names are not kept as aliases — this repo ships no compat shims.
 *
 * A caller holding a `read-only`, `standard`, or `delegation` credential now
 * receives 403; re-pair with the `inference` preset to read this.
 */
export async function fetchContributedModelManifest(): Promise<FleetContributionManifest> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/connections/model-inventory`,
  );
  const result = await response.json();
  if (!result.success) {
    throw new Error(
      apiErrorMessage(result, 'Failed to load contributed models'),
    );
  }
  return result.data as FleetContributionManifest;
}

/**
 * NOTE (recorded, not fixed): the query key is still
 * `['connections', 'model-inventory']` — the endpoint path, unchanged — even
 * though the cached VALUE changed shape from `station.model-inventory/v2` to
 * `station.fleet-contribution/v1`. Keeping it means the four connection
 * mutations that already invalidate this key (save/delete/test/smoke,
 * below) keep working with no edit, which is why it was left alone.
 *
 * The cost is one upgrade-time hazard: a persisted react-query cache
 * (`persistQueryClient`, which this repo does not use today) would rehydrate
 * a v2 inventory under this key and hand it to a consumer expecting a
 * manifest. Station's own UI never called this and holds no persisted cache,
 * so nothing in-repo is exposed. Rename the key to `['connections',
 * 'contributed-models']` — and update the four invalidations with it — if
 * cache persistence is ever adopted.
 */
export function useContributedModelManifestQuery(
  config?: QueryConfig<FleetContributionManifest>,
) {
  return useApiQuery(
    ['connections', 'model-inventory'],
    fetchContributedModelManifest,
    config,
  );
}

export function useConnectionQuery(
  id: string | undefined,
  config?: QueryConfig<ConnectionConfig | null>,
) {
  return useApiQuery(
    ['connections', id ?? ''],
    async () => {
      if (!id) {
        return null;
      }
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/connections/${encodeURIComponent(id)}`,
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(apiErrorMessage(result, 'Failed to load connection'));
      }
      return result.data as ConnectionConfig;
    },
    { ...config, enabled: !!id && (config?.enabled ?? true) },
  );
}

export function useAgentConnectionQuery(
  id: EngineConnectionId | undefined,
  config?: QueryConfig<AgentConnectionView | null>,
) {
  return useApiQuery(
    ['connections', id ?? ''],
    async () => {
      if (!id) return null;
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/connections/${encodeURIComponent(id)}`,
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(
          apiErrorMessage(result, 'Failed to load agent connection'),
        );
      }
      return result.data as AgentConnectionView;
    },
    { ...config, enabled: !!id && (config?.enabled ?? true) },
  );
}

export function useSaveModelConnectionMutation(
  options?: MutationOptions<
    ModelConnectionConfig,
    ModelConnectionMutationInput
  >,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ connection, isNew }: ModelConnectionMutationInput) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        isNew
          ? `${apiBase}/api/connections`
          : `${apiBase}/api/connections/${encodeURIComponent(connection.id)}`,
        {
          method: isNew ? 'POST' : 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(connection),
        },
      );
      const result = await response.json();
      if (!result.success) {
        if (Array.isArray(result.modelOptions)) {
          throw new ConnectionModelSelectionError(
            apiErrorMessage(
              result,
              'Choose a model before saving this connection',
            ),
            result.modelOptions,
          );
        }
        throw new Error(apiErrorMessage(result, 'Failed to save connection'));
      }
      return result.data as ModelConnectionConfig;
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['connections'] });
      queryClient.invalidateQueries({ queryKey: ['connections', 'models'] });
      queryClient.invalidateQueries({ queryKey: ['connections', 'runtimes'] });
      queryClient.invalidateQueries({
        queryKey: ['connections', 'model-inventory'],
      });
      queryClient.invalidateQueries({ queryKey: ['connections', data.id] });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

export function useSaveAgentConnectionMutation(
  options?: MutationOptions<AgentConnectionView, AgentConnectionMutationInput>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ connection, isNew }: AgentConnectionMutationInput) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        isNew
          ? `${apiBase}/api/connections`
          : `${apiBase}/api/connections/${encodeURIComponent(connection.id)}`,
        {
          method: isNew ? 'POST' : 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(connection),
        },
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(
          apiErrorMessage(result, 'Failed to save agent connection'),
        );
      }
      return result.data as AgentConnectionView;
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['connections'] });
      queryClient.invalidateQueries({ queryKey: ['connections', 'runtimes'] });
      queryClient.invalidateQueries({
        queryKey: ['connections', 'model-inventory'],
      });
      queryClient.invalidateQueries({ queryKey: ['connections', data.id] });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) =>
      options?.onError?.(error as Error, variables),
  });
}

export function useDeleteModelConnectionMutation(
  options?: MutationOptions<void, string>,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/connections/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(apiErrorMessage(result, 'Failed to delete connection'));
      }
    },
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['connections'] });
      queryClient.invalidateQueries({ queryKey: ['connections', 'models'] });
      queryClient.invalidateQueries({ queryKey: ['connections', 'runtimes'] });
      queryClient.invalidateQueries({
        queryKey: ['connections', 'model-inventory'],
      });
      queryClient.removeQueries({ queryKey: ['connections', id] });
      options?.onSuccess?.(undefined, id);
    },
    onError: (error, id) => {
      options?.onError?.(error as Error, id);
    },
  });
}

export function useDeleteAgentConnectionMutation(
  options?: MutationOptions<void, EngineConnectionId>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: EngineConnectionId) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/connections/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(
          apiErrorMessage(result, 'Failed to delete agent connection'),
        );
      }
    },
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['connections'] });
      queryClient.invalidateQueries({ queryKey: ['connections', 'runtimes'] });
      queryClient.invalidateQueries({
        queryKey: ['connections', 'model-inventory'],
      });
      queryClient.removeQueries({ queryKey: ['connections', id] });
      options?.onSuccess?.(undefined, id);
    },
    onError: (error, id) => options?.onError?.(error as Error, id),
  });
}

export function useTestModelConnectionMutation(
  options?: MutationOptions<ConnectionTestResult, string>,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/connections/${encodeURIComponent(id)}/test`,
        { method: 'POST' },
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(apiErrorMessage(result, 'Connection test failed'));
      }
      return result.data as ConnectionTestResult;
    },
    onSuccess: (data, id) => {
      queryClient.invalidateQueries({ queryKey: ['connections'] });
      queryClient.invalidateQueries({ queryKey: ['connections', 'models'] });
      queryClient.invalidateQueries({ queryKey: ['connections', 'runtimes'] });
      queryClient.invalidateQueries({
        queryKey: ['connections', 'model-inventory'],
      });
      queryClient.invalidateQueries({ queryKey: ['connections', id] });
      options?.onSuccess?.(data, id);
    },
    onError: (error, id) => {
      options?.onError?.(error as Error, id);
    },
  });
}

export function useTestAgentConnectionMutation(
  options?: MutationOptions<ConnectionTestResult, EngineConnectionId>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: EngineConnectionId) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/connections/${encodeURIComponent(id)}/test`,
        { method: 'POST' },
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(
          apiErrorMessage(result, 'Agent connection test failed'),
        );
      }
      return result.data as ConnectionTestResult;
    },
    onSuccess: (data, id) => {
      queryClient.invalidateQueries({ queryKey: ['connections'] });
      queryClient.invalidateQueries({ queryKey: ['connections', 'runtimes'] });
      queryClient.invalidateQueries({ queryKey: ['connections', id] });
      options?.onSuccess?.(data, id);
    },
    onError: (error, id) => options?.onError?.(error as Error, id),
  });
}

export interface ModelConnectionSmokeInput {
  id: string;
  confirmed: true;
  timeoutMs?: number;
}

export interface AgentConnectionSmokeInput {
  id: EngineConnectionId;
  confirmed: true;
  timeoutMs?: number;
}

function useSmokeConnectionMutation<
  TInput extends ModelConnectionSmokeInput | AgentConnectionSmokeInput,
>(options?: MutationOptions<ConnectionReadinessEvidence, TInput>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, confirmed, timeoutMs }: TInput) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/connections/${encodeURIComponent(id)}/smoke`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmed, timeoutMs }),
        },
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(apiErrorMessage(result, 'Connection smoke failed'));
      }
      return result.data as ConnectionReadinessEvidence;
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['connections'] });
      queryClient.invalidateQueries({ queryKey: ['connections', 'runtimes'] });
      queryClient.invalidateQueries({
        queryKey: ['connections', 'model-inventory'],
      });
      queryClient.invalidateQueries({
        queryKey: ['connections', variables.id],
      });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

export function useSmokeModelConnectionMutation(
  options?: MutationOptions<
    ConnectionReadinessEvidence,
    ModelConnectionSmokeInput
  >,
) {
  return useSmokeConnectionMutation(options);
}

export function useSmokeAgentConnectionMutation(
  options?: MutationOptions<
    ConnectionReadinessEvidence,
    AgentConnectionSmokeInput
  >,
) {
  return useSmokeConnectionMutation(options);
}

export function useGlobalKnowledgeStatusQuery(
  config?: QueryConfig<GlobalKnowledgeStatus | null>,
) {
  return useApiQuery(
    ['knowledge-status-global'],
    async () => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/knowledge/status`,
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(
          apiErrorMessage(result, 'Failed to load knowledge status'),
        );
      }
      return result.data as GlobalKnowledgeStatus;
    },
    config,
  );
}

export function useTestVectorDbConnectionMutation(
  options?: MutationOptions<{ healthy: boolean }, string>,
) {
  return useMutation({
    mutationFn: async (id: string) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/providers/${encodeURIComponent(id)}/test-vectordb`,
        { method: 'POST' },
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(apiErrorMessage(result, 'Vector database test failed'));
      }
      return result.data as { healthy: boolean };
    },
    onSuccess: (data, id) => {
      options?.onSuccess?.(data, id);
    },
    onError: (error, id) => {
      options?.onError?.(error as Error, id);
    },
  });
}

export interface AppHomeProfileStatus {
  profileDir: string;
  exists: boolean;
  seededFrom?: 'empty' | 'global-import';
  importedAt?: string;
  authState: 'authenticated' | 'unauthenticated' | 'unknown';
  keychainAuthPossible: boolean;
  /** #896 wave 2: bounded profile-GC usage report — present only when the profile exists. */
  usage?: { sizeBytes: number; entryCount: number; truncated: boolean };
}

/** The engine's verified sign-in state for one enrolled credential profile. */
export type EnrolmentAuthState =
  | 'authenticated'
  | 'unauthenticated'
  | 'unknown';

/** The interactive command the user may run to enrol a credential profile. */
export interface EnrolmentCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  description: string;
}

/**
 * The profile enrolment projection. `profileDir` is intentionally omitted:
 * it is an implementation detail and its existence does not prove sign-in.
 */
export interface EnrolmentStatus {
  authState: EnrolmentAuthState;
  detail?: string;
  command: EnrolmentCommand;
}

/**
 * Asks the engine whether one profile is signed in and returns the command the
 * user can run to enrol it. This is deliberately not polled: login is an
 * explicit user action and only an explicit re-check can confirm its result.
 */
export function useEnrolmentQuery(
  connectionId: string | undefined,
  profileRef: string | undefined,
  config?: QueryConfig<EnrolmentStatus | null>,
) {
  return useApiQuery(
    ['connections', 'agent', connectionId ?? '', 'enrolment', profileRef ?? ''],
    async () => {
      if (!connectionId || !profileRef) return null;
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/connections/agent/${encodeURIComponent(connectionId)}/enrolment/${encodeURIComponent(profileRef)}`,
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(
          apiErrorMessage(result, 'Failed to load profile sign-in state'),
        );
      }
      const { profileDir: _profileDir, ...status } = result.data ?? {};
      return status as EnrolmentStatus;
    },
    {
      ...config,
      enabled: !!connectionId && !!profileRef && (config?.enabled ?? true),
    },
  );
}

/**
 * App-home profile status (#896, `docs/design/agent-engine-unification.md`
 * §6.1's overlay model). Supports `claude` and `codex`
 * (#896 wave 2) — any other connection id 404s.
 */
export function useAppHomeProfileQuery(
  id: string | undefined,
  config?: QueryConfig<AppHomeProfileStatus | null>,
) {
  return useApiQuery(
    ['connections', 'agent', id ?? '', 'app-home'],
    async () => {
      if (!id) return null;
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/connections/agent/${encodeURIComponent(id)}/app-home`,
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(
          apiErrorMessage(result, 'Failed to load app-home profile status'),
        );
      }
      return result.data as AppHomeProfileStatus;
    },
    { ...config, enabled: !!id && (config?.enabled ?? true) },
  );
}

/** One quota window as the server normalized it (station#3552). */
export interface CredentialUsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt?: string;
}

/**
 * `unknown` is a first-class state, not a zeroed reading: a meter empty
 * because nothing was used and one empty because the request failed must never
 * render the same.
 */
export type CredentialUsage =
  | {
      status: 'ok';
      fetchedAt: string;
      planLabel?: string;
      windows: CredentialUsageWindow[];
      exhausted: boolean;
    }
  | { status: 'unknown'; fetchedAt: string; reason: string };

export interface CredentialUsageEntry {
  /** `null` is the connection's own account rather than an enrolled profile. */
  ref: string | null;
  label: string;
  usage: CredentialUsage;
}

/**
 * Each account's quota, read from the provider that owns it (station#3552).
 * Not polled on a timer: it spends a real credential against a remote endpoint,
 * so it refetches when asked, and the page shows when each reading was taken.
 */
export function useCredentialUsageQuery(
  id: string | undefined,
  config?: QueryConfig<CredentialUsageEntry[] | null>,
) {
  return useApiQuery(
    ['connections', 'agent', id ?? '', 'credential-usage'],
    async () => {
      if (!id) return null;
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/connections/agent/${encodeURIComponent(id)}/credential-usage`,
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(
          apiErrorMessage(result, 'Failed to load credential usage'),
        );
      }
      return (result.data?.credentials ?? []) as CredentialUsageEntry[];
    },
    { ...config, enabled: !!id && (config?.enabled ?? true) },
  );
}

export interface ImportAppHomeSnapshotInput {
  id: string;
  includeCredentials?: boolean;
}

export interface ImportAppHomeSnapshotResult {
  profileDir: string;
  /**
   * Always `'completed'` when this resolves — a `'failed'` import (an
   * unreadable/absent global config dir, or a containment refusal) always
   * comes back as an HTTP `success: false` from the route, which the
   * mutation below turns into a thrown `Error` instead of resolved data.
   * The thrown error IS the failure surface; there is deliberately no
   * `'failed'` member here to check that could never actually appear.
   */
  outcome: 'completed';
  copied: string[];
  skipped: Array<{ path: string; reason: string }>;
  /** `false` when this import copied zero entries — Station does not advance the profile's `seededFrom` provenance to `'global-import'` on an empty or wholly-refused import, even though the import itself still succeeded. */
  provenanceUpdated: boolean;
}

/**
 * Explicit, user-triggered import of a snapshot of the connection's global
 * engine config into its Station-managed app-home profile — never silent,
 * never runs on a save/toggle alone.
 */
export function useImportAppHomeSnapshotMutation(
  options?: MutationOptions<
    ImportAppHomeSnapshotResult,
    ImportAppHomeSnapshotInput
  >,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      includeCredentials,
    }: ImportAppHomeSnapshotInput) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/connections/agent/${encodeURIComponent(id)}/app-home/import`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            includeCredentials: includeCredentials === true,
          }),
        },
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(
          apiErrorMessage(result, 'Failed to import the app-home snapshot'),
        );
      }
      return result.data as ImportAppHomeSnapshotResult;
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['connections', 'agent', variables.id, 'app-home'],
      });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

export interface ClearAppHomeProfileResult {
  cleared: boolean;
}

/**
 * #896 wave 2: explicit, user-triggered clear of a Station-managed app-home
 * profile — never triggered by the toggle or a form save alone (the route
 * itself refuses with a 409 while the connection's saved `useAppHome` is
 * still on; this mutation surfaces that error verbatim, it never retries or
 * silently ignores it).
 */
export function useClearAppHomeProfileMutation(
  options?: MutationOptions<ClearAppHomeProfileResult, string>,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/connections/agent/${encodeURIComponent(id)}/app-home`,
        { method: 'DELETE' },
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(
          apiErrorMessage(result, 'Failed to clear the app home'),
        );
      }
      return result.data as ClearAppHomeProfileResult;
    },
    onSuccess: (data, id) => {
      queryClient.invalidateQueries({
        queryKey: ['connections', 'agent', id, 'app-home'],
      });
      options?.onSuccess?.(data, id);
    },
    onError: (error, id) => {
      options?.onError?.(error as Error, id);
    },
  });
}

import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
