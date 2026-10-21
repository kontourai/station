import {
  type ACPConnectionInfo,
  type ACPConnectionRegistryEntry,
  fetchACPConnectionRegistry,
  useACPConnectionRegistryQuery,
  useACPConnectionsQuery,
} from '@kontourai/station-sdk';

export type { ACPConnectionInfo, ACPConnectionRegistryEntry };

export function useACPConnections() {
  return useACPConnectionsQuery();
}

export function useACPConnectionRegistry() {
  return useACPConnectionRegistryQuery();
}

/** Asks the host to re-read its login-shell PATH, then lists the catalogue. */
export function recheckACPConnectionRegistry() {
  return fetchACPConnectionRegistry({ recheck: true });
}
