import {
  type ACPConnectionInfo,
  type ACPConnectionRegistryEntry,
  recheckACPConnectionRegistry,
  useACPConnectionRegistryQuery,
  useACPConnectionsQuery,
} from '@kontourai/station-sdk';

export type { ACPConnectionInfo, ACPConnectionRegistryEntry };
export { recheckACPConnectionRegistry };

export function useACPConnections() {
  return useACPConnectionsQuery();
}

export function useACPConnectionRegistry() {
  return useACPConnectionRegistryQuery();
}
