import type {
  LaunchableModelInventory,
  LaunchableModelRecord,
  ModelInventoryComponentIdentity,
  ModelInventoryDiagnostic,
  ModelInventoryFreshness,
  ModelInventoryLocality,
} from '@kontourai/station-contracts/model-inventory';
import type {
  AgentConnectionView,
  ConnectionConfig,
  ModelOption,
} from '@kontourai/station-contracts/tool';
import type {
  LLMExecutionIdentity,
  LLMModel,
} from '../../providers/llm/model-provider-types.js';

export interface ModelConnectionInventorySource {
  connection: ConnectionConfig & { kind: 'model' };
  execution: LLMExecutionIdentity | null;
  catalog: {
    source: ModelInventoryFreshness | 'unavailable';
    observedAt: string | null;
    models: LLMModel[];
    truncated?: boolean;
  };
}

export interface LaunchableModelInventoryInput {
  observedAt: string;
  modelConnections: ModelConnectionInventorySource[];
  agentConnections: AgentConnectionView[];
  diagnostics?: ModelInventoryDiagnostic[];
  maxRecords?: number;
  maxResponseBytes?: number;
}

const MODEL_INVENTORY_MAX_RECORDS = 4096;
// Includes both the response prefix and its final closing brace.
const MODEL_INVENTORY_MAX_RESPONSE_BYTES =
  2 * 1024 * 1024 - Buffer.byteLength('{"success":true,"data":}');
const MODEL_INVENTORY_DIAGNOSTIC_ID = 'station:model-inventory';

interface ModelProjection {
  selector: string;
  providerModel: string;
  displayName: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
}

function stableRecordId(
  kind: 'model' | 'agent',
  connectionId: string,
  providerModel: string,
): string {
  return [kind, connectionId, providerModel].map(encodeURIComponent).join(':');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unanimous<T>(values: Array<T | undefined>): T | null {
  if (values.length === 0 || values.some((value) => value === undefined)) {
    return null;
  }
  const [first, ...rest] = values as T[];
  return rest.every((value) => Object.is(value, first)) ? first : null;
}

function groupModels(models: ModelProjection[]): Array<{
  providerModel: string;
  aliases: string[];
  displayName: string;
  effectiveContextTokens: number | null;
  toolSurface: string[] | null;
  supportsVision: boolean | null;
}> {
  const ordered = [...models].sort(
    (left, right) =>
      compareText(left.providerModel, right.providerModel) ||
      compareText(left.selector, right.selector) ||
      compareText(left.displayName, right.displayName),
  );
  const groups = new Map<string, ModelProjection[]>();
  for (const model of ordered) {
    const group = groups.get(model.providerModel) ?? [];
    group.push(model);
    groups.set(model.providerModel, group);
  }

  return [...groups.entries()].map(([providerModel, group]) => {
    const supportsTools = unanimous(group.map((model) => model.supportsTools));
    return {
      providerModel,
      aliases: [...new Set(group.map((model) => model.selector))].sort(
        compareText,
      ),
      displayName: group[0]!.displayName,
      effectiveContextTokens: unanimous(
        group.map((model) => model.contextWindow),
      ),
      toolSurface:
        supportsTools === null ? null : supportsTools ? ['tool-calls'] : [],
      supportsVision: unanimous(group.map((model) => model.supportsVision)),
    };
  });
}

function diagnostic(
  connectionId: string,
  code: ModelInventoryDiagnostic['code'],
  message: string,
): ModelInventoryDiagnostic {
  return { connectionId, code, message };
}

function unavailableDiagnostic(
  connection: Pick<ConnectionConfig, 'id' | 'enabled' | 'status'>,
): ModelInventoryDiagnostic | null {
  if (!connection.enabled || connection.status === 'disabled') {
    return diagnostic(connection.id, 'disabled', 'Connection is disabled.');
  }
  if (connection.status !== 'ready') {
    return diagnostic(
      connection.id,
      'not-ready',
      `Connection status is ${connection.status}.`,
    );
  }
  return null;
}

function record(options: {
  connectionId: string;
  connectionKind: 'model' | 'agent';
  providerId: string;
  runtime: ModelInventoryComponentIdentity | null;
  adapter: ModelInventoryComponentIdentity | null;
  locality: ModelInventoryLocality;
  freshness: ModelInventoryFreshness;
  observedAt: string | null;
  model: ReturnType<typeof groupModels>[number];
  knownToolSurface?: string[];
}): LaunchableModelRecord {
  return {
    id: stableRecordId(
      options.connectionKind,
      options.connectionId,
      options.model.providerModel,
    ),
    connectionId: options.connectionId,
    connectionKind: options.connectionKind,
    providerId: options.providerId,
    runtime: options.runtime,
    adapter: options.adapter,
    model: {
      id: options.model.providerModel,
      revision: null,
      quantization: null,
    },
    providerModel: options.model.providerModel,
    aliases: options.model.aliases,
    displayName: options.model.displayName,
    locality: options.locality,
    availability: options.freshness === 'live' ? 'available' : 'stale',
    freshness: options.freshness,
    observedAt: options.observedAt,
    effectiveContextTokens: options.model.effectiveContextTokens,
    toolSurface: options.knownToolSurface ?? options.model.toolSurface,
    supportsVision: options.model.supportsVision,
  };
}

function runtimeModels(connection: AgentConnectionView): {
  freshness: ModelInventoryFreshness;
  observedAt: string | null;
  reason: string;
  models: ModelOption[];
} | null {
  const catalog = connection.runtimeCatalog;
  if (!catalog || catalog.source === 'none') {
    return null;
  }
  const models =
    catalog.source === 'live'
      ? catalog.models
      : catalog.models.length > 0
        ? catalog.models
        : catalog.builtInModels;
  return {
    freshness: catalog.source,
    observedAt: catalog.fetchedAt ?? null,
    reason:
      catalog.source === 'cached'
        ? 'Connection is using a cached model catalog.'
        : catalog.source === 'built-in'
          ? 'Connection is using its built-in model catalog.'
          : 'Connection is using a live model catalog.',
    models,
  };
}

interface ConnectionProjection {
  models: LaunchableModelRecord[];
  diagnostics: ModelInventoryDiagnostic[];
}

function staleCatalogReason(freshness: ModelInventoryFreshness): string {
  if (freshness === 'cached') {
    return 'Connection is using a cached model catalog.';
  }
  if (freshness === 'configured') {
    return 'Connection is using explicitly configured model selectors because live discovery is unavailable.';
  }
  return 'Connection is using its built-in model catalog.';
}

function modelRecords(
  source: ModelConnectionInventorySource,
  freshness: ModelInventoryFreshness,
): LaunchableModelRecord[] {
  return groupModels(
    source.catalog.models.map((item) => ({
      selector: item.id,
      providerModel: item.id,
      displayName: item.name,
      contextWindow: item.contextWindow,
      supportsTools: item.supportsTools,
      supportsVision: item.supportsVision,
    })),
  ).map((model) =>
    record({
      connectionId: source.connection.id,
      connectionKind: 'model',
      providerId: source.connection.id,
      runtime: source.execution?.runtime ?? null,
      adapter: source.execution?.adapter ?? null,
      locality: source.execution?.locality ?? 'unknown',
      freshness,
      observedAt: source.catalog.observedAt,
      model,
    }),
  );
}

function projectModelConnection(
  source: ModelConnectionInventorySource,
): ConnectionProjection {
  const unavailable = unavailableDiagnostic(source.connection);
  if (unavailable) return { models: [], diagnostics: [unavailable] };
  if (
    source.catalog.source === 'unavailable' ||
    source.catalog.models.length === 0
  ) {
    return {
      models: [],
      diagnostics: [
        diagnostic(
          source.connection.id,
          'catalog-unavailable',
          'No model catalog or configured model selector is available.',
        ),
      ],
    };
  }
  if (
    !source.catalog.observedAt ||
    !Number.isFinite(Date.parse(source.catalog.observedAt))
  ) {
    return {
      models: [],
      diagnostics: [
        diagnostic(
          source.connection.id,
          'catalog-unavailable',
          'The model catalog has no valid observation timestamp.',
        ),
      ],
    };
  }
  const freshness = source.catalog.source;

  const diagnostics = [
    ...(freshness === 'live'
      ? []
      : [
          diagnostic(
            source.connection.id,
            'stale-catalog',
            staleCatalogReason(freshness),
          ),
        ]),
    ...(source.catalog.truncated
      ? [
          diagnostic(
            source.connection.id,
            'discovery-limited',
            'The model catalog was truncated by its bounded entry limit.',
          ),
        ]
      : []),
  ];
  return {
    diagnostics,
    models: modelRecords(source, freshness),
  };
}

function agentProviderId(connection: AgentConnectionView): string {
  if (connection.capabilityInventory?.providerId) {
    return connection.capabilityInventory.providerId;
  }
  return typeof connection.config.provider === 'string'
    ? connection.config.provider
    : connection.id;
}

function agentRecords(
  connection: AgentConnectionView,
  catalog: NonNullable<ReturnType<typeof runtimeModels>>,
): LaunchableModelRecord[] {
  const knownToolSurface = connection.capabilities.includes('tool-calls')
    ? ['tool-calls']
    : [];
  return groupModels(
    catalog.models.map((item) => ({
      selector: item.id,
      providerModel: item.originalId,
      displayName: item.name,
    })),
  ).map((model) =>
    record({
      connectionId: connection.id,
      connectionKind: 'agent',
      providerId: agentProviderId(connection),
      runtime: connection.modelExecution?.runtime ?? null,
      adapter: connection.modelExecution?.adapter ?? null,
      locality: connection.modelExecution?.locality ?? 'unknown',
      freshness: catalog.freshness,
      observedAt: catalog.observedAt,
      model,
      knownToolSurface,
    }),
  );
}

function projectAgentConnection(
  connection: AgentConnectionView,
): ConnectionProjection {
  const unavailable = unavailableDiagnostic(connection);
  if (unavailable) return { models: [], diagnostics: [unavailable] };
  const catalog = runtimeModels(connection);
  if (!catalog || catalog.models.length === 0) {
    return {
      models: [],
      diagnostics: [
        diagnostic(
          connection.id,
          'catalog-unavailable',
          'No runtime model catalog is available.',
        ),
      ],
    };
  }

  if (!catalog.observedAt || !Number.isFinite(Date.parse(catalog.observedAt))) {
    return {
      models: [],
      diagnostics: [
        diagnostic(
          connection.id,
          'catalog-unavailable',
          'The runtime model catalog has no valid observation timestamp.',
        ),
      ],
    };
  }

  return {
    diagnostics: [
      ...(catalog.freshness === 'live'
        ? []
        : [diagnostic(connection.id, 'stale-catalog', catalog.reason)]),
      ...(connection.runtimeCatalog?.truncated
        ? [
            diagnostic(
              connection.id,
              'discovery-limited',
              'The runtime model catalog was truncated by its bounded entry limit.',
            ),
          ]
        : []),
    ],
    models: agentRecords(connection, catalog),
  };
}

export interface LaunchableModelInventoryBounds {
  maxRecords?: number;
  maxResponseBytes?: number;
  omittedModels?: number;
}

function boundedRecordLimit(requested?: number): number {
  return Math.min(
    MODEL_INVENTORY_MAX_RECORDS,
    Math.max(1, Math.floor(requested ?? MODEL_INVENTORY_MAX_RECORDS)),
  );
}

function oldestPublishedObservation(
  generationObservedAt: string,
  models: LaunchableModelRecord[],
): string {
  const generationTime = Date.parse(generationObservedAt);
  if (!Number.isFinite(generationTime)) return generationObservedAt;
  const oldestTime = models.reduce((oldest, model) => {
    const observedTime = model.observedAt
      ? Date.parse(model.observedAt)
      : Number.NaN;
    return Number.isFinite(observedTime)
      ? Math.min(oldest, observedTime)
      : oldest;
  }, generationTime);
  return new Date(oldestTime).toISOString();
}

export function boundLaunchableModelInventory(
  source: LaunchableModelInventory,
  bounds: LaunchableModelInventoryBounds = {},
): LaunchableModelInventory {
  const maxRecords = boundedRecordLimit(bounds.maxRecords);
  const maxResponseBytes = Math.min(
    MODEL_INVENTORY_MAX_RESPONSE_BYTES,
    Math.max(
      1024,
      Math.floor(bounds.maxResponseBytes ?? MODEL_INVENTORY_MAX_RESPONSE_BYTES),
    ),
  );
  const orderedModels = [...source.models].sort((left, right) =>
    compareText(left.id, right.id),
  );
  const retainedModels = orderedModels.slice(0, maxRecords);
  const diagnostics = [
    ...new Map(
      source.diagnostics.map((item) => [
        `${item.connectionId}\u0000${item.code}\u0000${item.message}`,
        item,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      compareText(left.connectionId, right.connectionId) ||
      compareText(left.code, right.code) ||
      compareText(left.message, right.message),
  );
  const initiallyOmittedModels =
    Math.max(0, Math.floor(bounds.omittedModels ?? 0)) +
    Math.max(0, orderedModels.length - retainedModels.length);
  let omittedDiagnostics = 0;
  const limitDiagnostic = (
    omittedModels: number,
  ): ModelInventoryDiagnostic | null => {
    if (omittedModels > 0 && omittedDiagnostics > 0) {
      return {
        connectionId: MODEL_INVENTORY_DIAGNOSTIC_ID,
        code: 'discovery-limited',
        message: `${omittedModels} launchable models and ${omittedDiagnostics} diagnostics were omitted by aggregate inventory limits.`,
      };
    }
    if (omittedModels > 0) {
      return {
        connectionId: MODEL_INVENTORY_DIAGNOSTIC_ID,
        code: 'discovery-limited',
        message: `${omittedModels} launchable models were omitted by aggregate inventory limits.`,
      };
    }
    if (omittedDiagnostics > 0) {
      return {
        connectionId: MODEL_INVENTORY_DIAGNOSTIC_ID,
        code: 'discovery-limited',
        message:
          omittedDiagnostics === 1
            ? '1 diagnostic was omitted by aggregate inventory limits.'
            : `${omittedDiagnostics} diagnostics were omitted by aggregate inventory limits.`,
      };
    }
    return null;
  };

  const serializedModels = retainedModels.map((model) => ({
    model,
    bytes: Buffer.byteLength(JSON.stringify(model)),
  }));
  const serializedDiagnostics = diagnostics.map((diagnostic) => ({
    diagnostic,
    bytes: Buffer.byteLength(JSON.stringify(diagnostic)),
  }));
  const arrayContentBytes = (entries: Array<{ bytes: number }>): number =>
    entries.reduce((total, entry) => total + entry.bytes, 0) +
    Math.max(0, entries.length - 1);
  const envelopeBytes = (observedAt: string): number =>
    Buffer.byteLength(
      JSON.stringify({
        schemaVersion: source.schemaVersion,
        observedAt,
        models: [],
        diagnostics: [],
      }),
    );
  const diagnosticBytes = (omittedModels: number): number => {
    const aggregate = limitDiagnostic(omittedModels);
    const aggregateBytes = aggregate
      ? Buffer.byteLength(JSON.stringify(aggregate))
      : 0;
    return (
      arrayContentBytes(serializedDiagnostics) +
      aggregateBytes +
      (serializedDiagnostics.length > 0 && aggregate ? 1 : 0)
    );
  };

  const generationTime = Date.parse(source.observedAt);
  const emptyObservedAt = Number.isFinite(generationTime)
    ? new Date(generationTime).toISOString()
    : source.observedAt;
  const allModelsOmitted = initiallyOmittedModels + serializedModels.length;
  while (
    envelopeBytes(emptyObservedAt) + diagnosticBytes(allModelsOmitted) >
      maxResponseBytes &&
    serializedDiagnostics.length > 0
  ) {
    const largestDiagnosticIndex = serializedDiagnostics.reduce(
      (largestIndex, item, index, items) =>
        item.bytes > items[largestIndex]!.bytes ? index : largestIndex,
      0,
    );
    serializedDiagnostics.splice(largestDiagnosticIndex, 1);
    omittedDiagnostics += 1;
  }

  const includedModels: LaunchableModelRecord[] = [];
  let includedModelBytes = 0;
  let oldestTime = generationTime;
  for (const candidate of serializedModels) {
    const candidateCount = includedModels.length + 1;
    const omittedModels =
      initiallyOmittedModels + serializedModels.length - candidateCount;
    const observedTime = candidate.model.observedAt
      ? Date.parse(candidate.model.observedAt)
      : Number.NaN;
    const candidateOldestTime = Number.isFinite(observedTime)
      ? Math.min(oldestTime, observedTime)
      : oldestTime;
    const observedAt = Number.isFinite(candidateOldestTime)
      ? new Date(candidateOldestTime).toISOString()
      : source.observedAt;
    const modelBytes =
      includedModelBytes +
      candidate.bytes +
      (includedModels.length > 0 ? 1 : 0);
    const totalBytes =
      envelopeBytes(observedAt) + modelBytes + diagnosticBytes(omittedModels);
    if (totalBytes <= maxResponseBytes) {
      includedModels.push(candidate.model);
      includedModelBytes = modelBytes;
      oldestTime = candidateOldestTime;
    }
  }
  const omittedModels =
    initiallyOmittedModels + serializedModels.length - includedModels.length;
  const aggregate = limitDiagnostic(omittedModels);
  const boundedDiagnostics = serializedDiagnostics.map(
    ({ diagnostic }) => diagnostic,
  );
  if (aggregate) boundedDiagnostics.push(aggregate);
  boundedDiagnostics.sort(
    (left, right) =>
      compareText(left.connectionId, right.connectionId) ||
      compareText(left.code, right.code) ||
      compareText(left.message, right.message),
  );
  return {
    schemaVersion: source.schemaVersion,
    observedAt: oldestPublishedObservation(source.observedAt, includedModels),
    models: includedModels,
    diagnostics: boundedDiagnostics,
  };
}

export function buildLaunchableModelInventory(
  input: LaunchableModelInventoryInput,
): LaunchableModelInventory {
  const maxRecords = boundedRecordLimit(input.maxRecords);
  const models: LaunchableModelRecord[] = [];
  const diagnostics = [...(input.diagnostics ?? [])];
  let projectedModelCount = 0;
  const retainProjection = (projection: ConnectionProjection): void => {
    projectedModelCount += projection.models.length;
    models.push(...projection.models);
    diagnostics.push(...projection.diagnostics);
    if (models.length > maxRecords) {
      models.sort((left, right) => compareText(left.id, right.id));
      models.length = maxRecords;
    }
  };
  for (const connection of input.modelConnections) {
    retainProjection(projectModelConnection(connection));
  }
  for (const connection of input.agentConnections) {
    retainProjection(projectAgentConnection(connection));
  }
  return boundLaunchableModelInventory(
    {
      schemaVersion: 'station.model-inventory/v2',
      observedAt: input.observedAt,
      models,
      diagnostics,
    },
    {
      maxRecords: input.maxRecords,
      maxResponseBytes: input.maxResponseBytes,
      omittedModels: projectedModelCount - models.length,
    },
  );
}
