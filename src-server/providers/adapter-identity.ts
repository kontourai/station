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
 */
export function nativeRuntimeConnectionIds(
  adapters: readonly ProviderAdapterShape[],
): Map<string, string> {
  const ids = new Map<string, string>();
  for (const adapter of adapters) {
    if (adapter.provider === 'acp') continue;
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
