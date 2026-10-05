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
 * The ids a native (non-ACP) runtime Adapter answers to: its engine id and its
 * public connection id. An ACP connection given one of these ids resolves to
 * the same public connection as the native engine, so engine attribution can
 * no longer tell the two apart and a native Agent reads as `acp` (#3355).
 *
 * An Adapter whose identity cannot be read (a plugin with a throwing
 * `metadata` accessor) reserves only its `provider` key.
 */
export function nativeRuntimeConnectionIds(
  adapters: readonly ProviderAdapterShape[],
): Set<string> {
  const ids = new Set<string>();
  for (const adapter of adapters) {
    if (adapter.provider === 'acp') continue;
    ids.add(String(adapter.provider));
    try {
      ids.add(String(engineIdForAdapter(adapter)));
      ids.add(String(connectionIdForAdapter(adapter)));
    } catch {}
  }
  return ids;
}
