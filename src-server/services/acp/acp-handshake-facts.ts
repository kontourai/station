import type { AgentCapabilities } from '@agentclientprotocol/sdk';
import type {
  ProviderDeclaredAuthMethod,
  ProviderDeclaredHandshake,
  ProviderDeclaredHandshakeFact,
} from '@kontourai/station-contracts/catalog';
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
} as const;

type AcpSessionLifecycleCapability =
  AcpDeclaredHandshake['sessionCapabilities'][number];

const SESSION_LIFECYCLE_CAPABILITIES: readonly AcpSessionLifecycleCapability[] =
  ['list', 'resume', 'close', 'fork', 'delete'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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
  if (agentInfo === REFUSED) refused.push('agentInfo');
  if (authMethods === REFUSED) refused.push('authMethods');
  if (extensionMethods === REFUSED) refused.push('extensionMethods');
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
