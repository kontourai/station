import type { AgentCapabilities } from '@agentclientprotocol/sdk';
import type { ProviderDeclaredHandshake } from '@kontourai/station-contracts/catalog';
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

type AcpSessionLifecycleCapability =
  AcpDeclaredHandshake['sessionCapabilities'][number];

const SESSION_LIFECYCLE_CAPABILITIES: readonly AcpSessionLifecycleCapability[] =
  ['list', 'resume', 'close', 'fork', 'delete'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

export function projectAcpDeclaredHandshake(
  initResult: InitializeResult,
): AcpDeclaredHandshake {
  const agentInfo = initResult.agentInfo;
  const sessionCapabilities = initResult.agentCapabilities?.sessionCapabilities;
  return {
    protocolVersion: initResult.protocolVersion,
    ...(agentInfo && typeof agentInfo.name === 'string'
      ? {
          agentInfo: {
            name: agentInfo.name,
            ...(typeof agentInfo.title === 'string'
              ? { title: agentInfo.title }
              : {}),
            ...(typeof agentInfo.version === 'string'
              ? { version: agentInfo.version }
              : {}),
          },
        }
      : {}),
    sessionCapabilities: SESSION_LIFECYCLE_CAPABILITIES.filter(
      (capability) =>
        isRecord(sessionCapabilities) &&
        sessionCapabilities[capability] != null,
    ),
    authMethods: Array.isArray(initResult.authMethods)
      ? [...initResult.authMethods]
      : [],
    extensionMethods: declaredAcpExtensionMethods(initResult.agentCapabilities),
  };
}

/**
 * #352: read a session answer's `models` field. Entries without a string
 * `modelId` are dropped; a field with no usable entry is absent, not empty,
 * so it never outranks or fakes a catalog.
 */
export function parseAcpSessionModelState(
  value: unknown,
): AcpSessionModelState | undefined {
  if (!isRecord(value) || !Array.isArray(value.availableModels)) {
    return undefined;
  }
  const availableModels = value.availableModels.flatMap((entry) =>
    isRecord(entry) &&
    typeof entry.modelId === 'string' &&
    entry.modelId.trim().length > 0
      ? [
          {
            modelId: entry.modelId,
            ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
            ...(typeof entry.description === 'string'
              ? { description: entry.description }
              : {}),
          },
        ]
      : [],
  );
  if (availableModels.length === 0) return undefined;
  return {
    ...(typeof value.currentModelId === 'string' &&
    value.currentModelId.trim().length > 0
      ? { currentModelId: value.currentModelId }
      : {}),
    availableModels,
  };
}
