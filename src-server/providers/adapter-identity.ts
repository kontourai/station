import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import {
  type EngineConnectionId,
  type EngineId,
  engineConnectionId,
  engineId,
} from '@kontourai/station-contracts/agent-identity';
import type { ProviderAdapterShape } from './adapter-shape.js';

/** The one derivation point for a capability-matrix engine identity. */
export function engineIdForAdapter(adapter: ProviderAdapterShape): EngineId {
  if (adapter.metadata.engineId) return adapter.metadata.engineId;
  return engineId(adapter.provider);
}

/** The one derivation point for an Adapter's public registry identity. */
export function connectionIdForAdapter(
  adapter: ProviderAdapterShape,
): EngineConnectionId {
  return (
    adapter.metadata.connectionId ??
    engineConnectionId(engineIdForAdapter(adapter))
  );
}

/**
 * The ids a native (non-ACP) runtime Adapter answers to — its engine id and
 * its public connection id — mapped to the engine that owns each. An ACP
 * connection given one of these ids resolves to the same public connection
 * as that engine, so engine attribution can no longer tell the two apart and
 * the native engine's Agents read as `acp` (#3355).
 *
 * An Adapter whose identity cannot be read (a plugin with a throwing
 * `metadata` accessor) reserves only its `provider` key, owned by itself.
 *
 * An Adapter backed by saved ACP connections (`connectionBacking:
 * 'acp-registry'`, OpenCode) reserves nothing: the connections it runs are
 * ACP records, and the ACP connection named like its engine (`opencode`)
 * stays an ACP connection whether or not the adapter claims it.
 */
export function nativeRuntimeConnectionIds(
  adapters: readonly ProviderAdapterShape[],
): Map<string, string> {
  const ids = new Map<string, string>();
  for (const adapter of adapters) {
    if (adapter.provider === 'acp' || isAcpConnectionBacked(adapter)) continue;
    const provider = String(adapter.provider);
    let owner = provider;
    try {
      owner = String(engineIdForAdapter(adapter));
      if (!ids.has(owner)) ids.set(owner, owner);
      const connectionId = String(connectionIdForAdapter(adapter));
      if (!ids.has(connectionId)) ids.set(connectionId, owner);
    } catch {}
    if (!ids.has(provider)) ids.set(provider, owner);
  }
  return ids;
}

/** Whether `adapter` runs saved ACP connection records instead of its own. */
export function isAcpConnectionBacked(adapter: ProviderAdapterShape): boolean {
  try {
    return adapter.metadata.connectionBacking === 'acp-registry';
  } catch {
    return false;
  }
}

/**
 * The adapter that runs new sessions on a saved ACP connection now: an
 * ACP-backed adapter that claims it, or `undefined` for the ACP adapter.
 * Each claim is asked at the call, so a Feature Preview behind one is read
 * where the connection is projected, not cached.
 */
export function acpConnectionRuntimeAdapter(
  adapters: readonly ProviderAdapterShape[],
  config: ACPConnectionConfig,
): ProviderAdapterShape | undefined {
  return adapters.find((adapter) => {
    if (!isAcpConnectionBacked(adapter)) return false;
    try {
      return adapter.claimsAcpConnection?.(config) === true;
    } catch {
      return false;
    }
  });
}
