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
