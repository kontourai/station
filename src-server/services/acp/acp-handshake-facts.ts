import type { AgentCapabilities } from '@agentclientprotocol/sdk/unstable';
import type {
  ProviderDeclaredAuthMethod,
  ProviderDeclaredEngineVariant,
  ProviderDeclaredFeatures,
  ProviderDeclaredHandshake,
  ProviderDeclaredHandshakeFact,
} from '@kontourai/station-contracts/catalog';
import { isRecord } from '../../utils/is-record.js';
import type { AcpSessionModelState, InitializeResult } from './acp-process.js';

/**
 * ADR 0013 Layer 2: what one connection's agent declared at `initialize`,
 * recorded as declared (never as working) beside the capability matrix. The
 * connection status dates it with `handshakeObservedAt`.
 */
export type AcpDeclaredHandshake = Omit<
  ProviderDeclaredHandshake,
  'observedAt'
>;

/**
 * Bounds on engine-declared facts Station serves. An identifier or label
 * matches `modelSelectionReceipt`'s 256 characters. A fact that exceeds a
 * bound is refused whole (absent, and named as refused), never shortened.
 */
export const ACP_DECLARED_FACT_BOUNDS = {
  label: 256,
  description: 1024,
  authMethods: 32,
  extensionMethods: 256,
  availableModels: 1024,
  /** Entries in one declared feature list (`executionTargets`, …). */
  featureList: 16,
  logChannels: 16,
  /** A declared log directory or file path. */
  path: 4096,
} as const;

/** One declared handshake fact, matched exactly. */
export type AcpHandshakeIdentity =
  | { agentInfoName: string }
  | { capabilityMetaNamespace: string }
  | { initializeMetaFlag: string };

/** The parts of an `initialize` answer an identity is read from. */
export type AcpIdentityHandshake = Pick<
  InitializeResult,
  'agentInfo' | 'agentCapabilities' | '_meta'
>;

function hasRecordKey(value: unknown, key: string): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.hasOwn(value as object, key)
  );
}

/**
 * Whether the live handshake says this about itself: its `agentInfo.name`,
 * a vendor namespace in `agentCapabilities._meta`, or a `true` flag in the
 * result's own `_meta`. Never the launch command.
 */
export function matchesAcpHandshakeIdentity(
  handshake: AcpIdentityHandshake,
  identity: AcpHandshakeIdentity,
): boolean {
  if ('agentInfoName' in identity) {
    return handshake.agentInfo?.name === identity.agentInfoName;
  }
  if ('capabilityMetaNamespace' in identity) {
    return hasRecordKey(
      handshake.agentCapabilities?._meta,
      identity.capabilityMetaNamespace,
    );
  }
  return handshake._meta?.[identity.initializeMetaFlag] === true;
}

/**
 * Engine variants a handshake identifies, most specific first. The agent
 * service declares `_meta.kiro` and, on 2.35, no `agentInfo`; kiro-cli's own
 * engine names itself and declares no `_meta`. Were one handshake to do both,
 * the declared namespace wins: it is what carries the features.
 */
const ACP_ENGINE_VARIANTS: ReadonlyArray<{
  variant: ProviderDeclaredEngineVariant;
  identity: AcpHandshakeIdentity;
  observed: string;
}> = [
  {
    variant: 'kiro-v3',
    identity: { capabilityMetaNamespace: 'kiro' },
    observed: 'kiro-cli 2.35.0 `acp --agent-engine v3` (2026-11-13)',
  },
  {
    variant: 'kiro-v2',
    identity: { agentInfoName: 'Kiro CLI Agent' },
    observed: 'kiro-cli 2.35.0 `acp --agent-engine v2` (2026-11-13)',
  },
];

export function resolveAcpEngineVariant(
  handshake: AcpIdentityHandshake | null | undefined,
): ProviderDeclaredEngineVariant | undefined {
  if (!handshake) return undefined;
  return ACP_ENGINE_VARIANTS.find(({ identity }) =>
    matchesAcpHandshakeIdentity(handshake, identity),
  )?.variant;
}

/**
 * Vendor namespaces whose `agentCapabilities._meta` feature flags Station
 * reads. Another namespace's flags are not projected: their meaning has not
 * been reviewed.
 */
const ACP_DECLARED_FEATURE_NAMESPACES: readonly string[] = ['kiro'];

type AcpSessionLifecycleCapability =
  AcpDeclaredHandshake['sessionCapabilities'][number];

const SESSION_LIFECYCLE_CAPABILITIES: readonly AcpSessionLifecycleCapability[] =
  ['list', 'resume', 'close', 'fork', 'delete'];

const REFUSED = Symbol('refused');
type Bounded<T> = T | undefined | typeof REFUSED;

/** An optional string field: absent, within `max`, or refused. */
function boundedString(value: unknown, max: number): Bounded<string> {
  if (typeof value !== 'string') return undefined;
  return value.length <= max ? value : REFUSED;
}

/**
 * The extension methods a handshake declares. ACP leaves the advertisement to
 * `_meta` in capability objects; the only shape observed is a vendor
 * namespace carrying an `extensionMethods` string list (Kiro `--v3`:
 * `_meta.kiro.extensionMethods`). Other `_meta` content declares nothing.
 */
export function declaredAcpExtensionMethods(
  agentCapabilities: AgentCapabilities | null | undefined,
): string[] {
  const meta = agentCapabilities?._meta;
  if (!isRecord(meta)) return [];
  const methods = new Set<string>();
  for (const namespace of Object.values(meta)) {
    if (!isRecord(namespace) || !Array.isArray(namespace.extensionMethods)) {
      continue;
    }
    for (const method of namespace.extensionMethods) {
      if (typeof method === 'string' && method.length > 0) methods.add(method);
    }
  }
  return [...methods];
}

function projectAgentInfo(
  agentInfo: InitializeResult['agentInfo'],
): Bounded<AcpDeclaredHandshake['agentInfo']> {
  if (!agentInfo || typeof agentInfo.name !== 'string') return undefined;
  const { label } = ACP_DECLARED_FACT_BOUNDS;
  const name = boundedString(agentInfo.name, label);
  const title = boundedString(agentInfo.title, label);
  const version = boundedString(agentInfo.version, label);
  if (name === REFUSED || title === REFUSED || version === REFUSED) {
    return REFUSED;
  }
  if (!name) return undefined;
  return {
    name,
    ...(title !== undefined ? { title } : {}),
    ...(version !== undefined ? { version } : {}),
  };
}

/**
 * Only id, name, description and type are served. A terminal method's `args`
 * and `env`, and any `_meta`, stay on the live `initialize` result.
 */
function projectAuthMethods(
  authMethods: unknown,
): Bounded<ProviderDeclaredAuthMethod[]> {
  if (!Array.isArray(authMethods)) return [];
  const { label, description: descriptionMax } = ACP_DECLARED_FACT_BOUNDS;
  if (authMethods.length > ACP_DECLARED_FACT_BOUNDS.authMethods) return REFUSED;
  const projected: ProviderDeclaredAuthMethod[] = [];
  for (const method of authMethods) {
    if (!isRecord(method)) continue;
    const id = boundedString(method.id, label);
    const name = boundedString(method.name, label);
    const description = boundedString(method.description, descriptionMax);
    const type = boundedString(method.type, label);
    if (
      id === REFUSED ||
      name === REFUSED ||
      description === REFUSED ||
      type === REFUSED
    ) {
      return REFUSED;
    }
    if (!id || name === undefined) continue;
    projected.push({
      id,
      name,
      ...(description !== undefined ? { description } : {}),
      ...(type !== undefined ? { type } : {}),
    });
  }
  return projected;
}

function projectExtensionMethods(
  agentCapabilities: AgentCapabilities | null | undefined,
): Bounded<string[]> {
  const methods = declaredAcpExtensionMethods(agentCapabilities);
  if (
    methods.length > ACP_DECLARED_FACT_BOUNDS.extensionMethods ||
    methods.some((method) => method.length > ACP_DECLARED_FACT_BOUNDS.label)
  ) {
    return REFUSED;
  }
  return methods;
}

/** A declared flag: `true`/`false` as declared, anything else absent. */
function declaredFlag(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** A declared list of short labels: absent, within bounds, or refused. */
function declaredLabelList(value: unknown): Bounded<string[]> {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return REFUSED;
  if (value.length > ACP_DECLARED_FACT_BOUNDS.featureList) return REFUSED;
  const labels: string[] = [];
  for (const entry of value) {
    if (
      typeof entry !== 'string' ||
      !entry ||
      entry.length > ACP_DECLARED_FACT_BOUNDS.label
    )
      return REFUSED;
    if (!labels.includes(entry)) labels.push(entry);
  }
  return labels;
}

/** Integer percentages with `min <= default <= max`, all within 0-100. */
function declaredPercentRange(
  value: unknown,
): Bounded<ProviderDeclaredFeatures['autoCompactionThreshold']> {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return REFUSED;
  const { min, max, default: initial } = value;
  const percent = (n: unknown): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 100;
  if (!percent(min) || !percent(max) || !percent(initial)) return REFUSED;
  if (!(min <= initial && initial <= max)) return REFUSED;
  return { min, max, default: initial };
}

/**
 * The feature flags a reviewed vendor namespace declared. Booleans are read
 * as declared; a list or range that is malformed or beyond the bounds
 * refuses the whole set, so a partial set never reads as complete.
 */
function projectDeclaredFeatures(
  agentCapabilities: AgentCapabilities | null | undefined,
): Bounded<ProviderDeclaredFeatures> {
  const meta = agentCapabilities?._meta;
  if (!isRecord(meta)) return undefined;
  const namespace = ACP_DECLARED_FEATURE_NAMESPACES.find((candidate) =>
    isRecord(meta[candidate]),
  );
  if (!namespace) return undefined;
  const flags = meta[namespace] as Record<string, unknown>;
  const sessionCapabilities: unknown = agentCapabilities?.sessionCapabilities;
  const fork = isRecord(sessionCapabilities)
    ? sessionCapabilities.fork
    : undefined;
  const forkMeta = isRecord(fork) && isRecord(fork._meta) ? fork._meta : null;
  const forkFlags =
    forkMeta && isRecord(forkMeta[namespace]) ? forkMeta[namespace] : null;
  const executionTargets = declaredLabelList(flags.executionTargets);
  const sessionSources = declaredLabelList(flags.sessionSources);
  const sessionListScopes = declaredLabelList(flags.sessionListScopes);
  const autoCompactionThreshold = declaredPercentRange(
    flags.autoCompactionThreshold,
  );
  if (
    executionTargets === REFUSED ||
    sessionSources === REFUSED ||
    sessionListScopes === REFUSED ||
    autoCompactionThreshold === REFUSED
  )
    return REFUSED;
  const booleans = {
    checkpoints: declaredFlag(flags.checkpoints),
    sessionList: declaredFlag(flags.sessionList),
    replayMarking: declaredFlag(flags.replayMarking),
    modelFallbackReporting: declaredFlag(flags.modelFallbackReporting),
    policyNotifications: declaredFlag(flags.policyNotifications),
    forkAtMessage: declaredFlag(forkFlags?.messageId),
  };
  const features: ProviderDeclaredFeatures = Object.assign(
    { namespace },
    Object.fromEntries(
      Object.entries(booleans).filter(([, value]) => value !== undefined),
    ),
  );
  if (autoCompactionThreshold)
    features.autoCompactionThreshold = autoCompactionThreshold;
  if (executionTargets) features.executionTargets = executionTargets;
  if (sessionSources) features.sessionSources = sessionSources;
  if (sessionListScopes) features.sessionListScopes = sessionListScopes;
  return features;
}

/**
 * Log channels an engine declared under a reviewed namespace's `logging`:
 * a log directory and named files. Host paths: served only to the server
 * (an administrator's tail read checks each real path is inside `logDir`,
 * itself inside a root the engine's descriptor declares). The public
 * handshake carries the channel names alone.
 */
export interface AcpDeclaredLogging {
  logDir: string;
  channels: Array<{ name: string; filePath: string }>;
}

const LOG_CHANNEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function absolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= ACP_DECLARED_FACT_BOUNDS.path &&
    !value.includes('\0') &&
    (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value))
  );
}

function readDeclaredLogging(
  agentCapabilities: AgentCapabilities | null | undefined,
): Bounded<AcpDeclaredLogging> {
  const meta = agentCapabilities?._meta;
  if (!isRecord(meta)) return undefined;
  const namespace = ACP_DECLARED_FEATURE_NAMESPACES.find((candidate) =>
    isRecord(meta[candidate]),
  );
  if (!namespace) return undefined;
  const logging = (meta[namespace] as Record<string, unknown>).logging;
  if (logging === undefined) return undefined;
  if (!isRecord(logging) || !absolutePath(logging.logDir)) return REFUSED;
  if (
    !Array.isArray(logging.channels) ||
    logging.channels.length > ACP_DECLARED_FACT_BOUNDS.logChannels
  )
    return REFUSED;
  const channels: AcpDeclaredLogging['channels'] = [];
  for (const channel of logging.channels) {
    if (
      !isRecord(channel) ||
      typeof channel.name !== 'string' ||
      channel.name.length > ACP_DECLARED_FACT_BOUNDS.label ||
      !LOG_CHANNEL_NAME.test(channel.name) ||
      !absolutePath(channel.filePath) ||
      channels.some((other) => other.name === channel.name)
    )
      return REFUSED;
    channels.push({ name: channel.name, filePath: channel.filePath });
  }
  return { logDir: logging.logDir, channels };
}

/** The declared log channels with their host paths, for server use only. */
export function projectAcpDeclaredLogging(
  initResult: Pick<InitializeResult, 'agentCapabilities'>,
): AcpDeclaredLogging | undefined {
  const logging = readDeclaredLogging(initResult.agentCapabilities);
  return logging === REFUSED ? undefined : logging;
}

export function projectAcpDeclaredHandshake(
  initResult: InitializeResult,
): AcpDeclaredHandshake {
  const sessionCapabilities = initResult.agentCapabilities?.sessionCapabilities;
  const refused: ProviderDeclaredHandshakeFact[] = [];
  const agentInfo = projectAgentInfo(initResult.agentInfo);
  const authMethods = projectAuthMethods(initResult.authMethods);
  const extensionMethods = projectExtensionMethods(
    initResult.agentCapabilities,
  );
  const declaredFeatures = projectDeclaredFeatures(
    initResult.agentCapabilities,
  );
  const logging = readDeclaredLogging(initResult.agentCapabilities);
  const engineVariant = resolveAcpEngineVariant(initResult);
  if (agentInfo === REFUSED) refused.push('agentInfo');
  if (authMethods === REFUSED) refused.push('authMethods');
  if (extensionMethods === REFUSED) refused.push('extensionMethods');
  if (declaredFeatures === REFUSED) refused.push('declaredFeatures');
  if (logging === REFUSED) refused.push('logChannels');
  return {
    protocolVersion: initResult.protocolVersion,
    ...(agentInfo && agentInfo !== REFUSED ? { agentInfo } : {}),
    sessionCapabilities: SESSION_LIFECYCLE_CAPABILITIES.filter(
      (capability) =>
        isRecord(sessionCapabilities) &&
        sessionCapabilities[capability] != null,
    ),
    ...(authMethods !== REFUSED && authMethods !== undefined
      ? { authMethods }
      : {}),
    ...(extensionMethods !== REFUSED && extensionMethods !== undefined
      ? { extensionMethods }
      : {}),
    ...(engineVariant ? { engineVariant } : {}),
    ...(declaredFeatures !== REFUSED && declaredFeatures !== undefined
      ? { declaredFeatures }
      : {}),
    ...(logging !== REFUSED && logging !== undefined
      ? { logChannels: logging.channels.map((channel) => channel.name) }
      : {}),
    ...(refused.length > 0 ? { refused } : {}),
  };
}

/** #352: a session answer's `models` field, read against the bounds. */
export type AcpSessionModelsObservation =
  | { kind: 'absent' }
  | { kind: 'refused' }
  | { kind: 'listed'; state: AcpSessionModelState };

/**
 * Entries without a string `modelId` are skipped, and a list with no usable
 * entry is absent, so it never outranks or fakes a catalog. A list beyond the
 * bounds, or any oversized id, name, description or current id, is refused
 * whole.
 */
export function parseAcpSessionModelState(
  value: unknown,
): AcpSessionModelsObservation {
  if (!isRecord(value) || !Array.isArray(value.availableModels)) {
    return { kind: 'absent' };
  }
  const { label, description: descriptionMax } = ACP_DECLARED_FACT_BOUNDS;
  if (value.availableModels.length > ACP_DECLARED_FACT_BOUNDS.availableModels) {
    return { kind: 'refused' };
  }
  const availableModels: AcpSessionModelState['availableModels'] = [];
  for (const entry of value.availableModels) {
    if (!isRecord(entry)) continue;
    const modelId = boundedString(entry.modelId, label);
    const name = boundedString(entry.name, label);
    const description = boundedString(entry.description, descriptionMax);
    if (modelId === REFUSED || name === REFUSED || description === REFUSED) {
      return { kind: 'refused' };
    }
    if (!modelId?.trim()) continue;
    availableModels.push({
      modelId,
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
    });
  }
  const currentModelId = boundedString(value.currentModelId, label);
  if (currentModelId === REFUSED) return { kind: 'refused' };
  if (availableModels.length === 0) return { kind: 'absent' };
  return {
    kind: 'listed',
    state: {
      ...(currentModelId?.trim() ? { currentModelId } : {}),
      availableModels,
    },
  };
}

/** The `model` config option Station selects with: category `model` and a non-empty id. */
export interface AcpModelConfigOption {
  id: string;
  category: 'model';
  currentValue?: string;
  options: Array<{ value: string; name: string }>;
}

/**
 * The one rule for which config option is a session's model selector. Select
 * options are `{ value, name }`; bare strings are tolerated.
 */
export function findAcpModelConfigOption(
  configOptions: unknown,
): AcpModelConfigOption | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  for (const option of configOptions) {
    if (!isRecord(option)) continue;
    if (
      option.category !== 'model' ||
      typeof option.id !== 'string' ||
      !option.id.trim()
    ) {
      continue;
    }
    const options = Array.isArray(option.options)
      ? option.options.flatMap((entry) => {
          const value =
            typeof entry === 'string'
              ? entry
              : isRecord(entry) && typeof entry.value === 'string'
                ? entry.value
                : undefined;
          if (!value) return [];
          const name =
            isRecord(entry) && typeof entry.name === 'string'
              ? entry.name
              : value;
          return [{ value, name }];
        })
      : [];
    return {
      id: option.id,
      category: 'model',
      ...(typeof option.currentValue === 'string' && option.currentValue.trim()
        ? { currentValue: option.currentValue }
        : {}),
      options,
    };
  }
  return undefined;
}

/**
 * The models a session or connection advertised, and its current one: the
 * `model` config option when there is one, else the `models` list (#352).
 * The current model falls back to the list's when the option reports none.
 * Served to the composer and used to apply a start-time selection.
 */
export function acpAdvertisedModelCatalog(
  configOptions: unknown,
  sessionModels: AcpSessionModelState | undefined,
): {
  dialect: 'config-option' | 'session-models' | 'none';
  currentModelId?: string;
  models: Array<{ id: string; name: string }>;
} {
  const option = findAcpModelConfigOption(configOptions);
  const currentModelId = option?.currentValue ?? sessionModels?.currentModelId;
  const current = currentModelId ? { currentModelId } : {};
  if (option) {
    return {
      dialect: 'config-option',
      ...current,
      models: option.options.map((entry) => ({
        id: entry.value,
        name: entry.name,
      })),
    };
  }
  if (sessionModels) {
    return {
      dialect: 'session-models',
      ...current,
      models: sessionModels.availableModels.map((model) => ({
        id: model.modelId,
        name: model.name ?? model.modelId,
      })),
    };
  }
  return { dialect: 'none', models: [] };
}
