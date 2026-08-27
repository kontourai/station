import {
  type EngineConnectionId,
  type EngineId,
  type EngineRuntimeId,
  engineConnectionId,
  engineId,
  engineRuntimeId,
} from '@kontourai/station-contracts/agent-identity';
import type { ProviderKind } from '@kontourai/station-contracts/provider';
import type { ProviderAdapterShape } from './adapter-shape.js';

/** The one derivation point for an Adapter-private runtime selector. */
export function runtimeIdForProvider(provider: ProviderKind): EngineRuntimeId {
  return engineRuntimeId(`${provider}-runtime`);
}

export function runtimeIdForAdapter(
  adapter: ProviderAdapterShape,
): EngineRuntimeId {
  return adapter.metadata.runtimeId ?? runtimeIdForProvider(adapter.provider);
}

/** The one derivation point for a capability-matrix engine identity. */
export function engineIdForAdapter(adapter: ProviderAdapterShape): EngineId {
  if (adapter.metadata.engineId) return adapter.metadata.engineId;
  return adapter.metadata.executionClass === 'managed'
    ? engineId('station')
    : engineId(runtimeIdForAdapter(adapter));
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
 * Resolves the pre-brand AppConfig selector through live registry identity.
 * Older Station versions persisted an Adapter-private runtime id here; new
 * versions persist the public connection id. Keeping this join beside every
 * other Adapter identity derivation prevents bootstrap and connection
 * surfaces from growing separate compatibility maps.
 */
export function connectionIdForPersistedSelection(
  value: string | null | undefined,
  connections: readonly {
    id: EngineConnectionId;
    runtimeId: EngineRuntimeId;
  }[],
): EngineConnectionId | null | undefined {
  if (value === null || value === undefined) return value;
  // A current public identity always outranks a legacy runtime selector,
  // regardless of inventory order: these are deliberately separate
  // namespaces and their text can overlap.
  const publicMatch = connections.find((connection) => connection.id === value);
  if (publicMatch) return publicMatch.id;
  const runtimeMatches = connections.filter(
    (connection) => connection.runtimeId === value,
  );
  // Ambiguous legacy identity is kept unchanged and therefore fails safe to
  // Station. Inventory order must never choose one principal for the owner.
  return runtimeMatches.length === 1
    ? runtimeMatches[0]?.id
    : engineConnectionId(value);
}
