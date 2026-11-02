import { useConnections } from '@kontourai/station-connect';
import type { DevicePresentation } from '@kontourai/station-contracts/system-status';
import { QueryClientContext } from '@tanstack/react-query';
import { useCallback, useContext, useSyncExternalStore } from 'react';

/**
 * The name `@kontourai/station-connect` gives the connection it seeds for
 * the Station that served this page (`makeDefaultStore`). The store finds
 * that connection by this name, so the stored name is never rewritten.
 */
export const SEEDED_STATION_CONNECTION_NAME = 'Default';

/**
 * #4402: the name a saved Station is shown by. The seeded "Default"
 * connection reads as the machine it runs on (`devicePresentation.hostName`,
 * read from the host), because "via Default" reads like a setting value. A
 * name the person gave a Station is shown as given.
 */
export function stationDisplayName(
  savedName: string | null | undefined,
  hostName: string | null | undefined,
): string | undefined {
  const name = savedName?.trim();
  if (!name) return undefined;
  // `resolveHostName` answers "the host" when the machine reports no name.
  const machine = hostName?.trim();
  return name === SEEDED_STATION_CONNECTION_NAME &&
    machine &&
    machine !== 'the host'
    ? machine
    : name;
}

const NO_SUBSCRIPTION = () => () => {};

/** The parts of `/api/system/status` the Station's name and details read. */
export interface CachedStationStatus {
  devicePresentation?: DevicePresentation;
  build?: { shortSha?: string; channel?: string };
}

/**
 * The `/api/system/status` answer already cached for the active Station
 * (`useSystemStatusForApiBaseQuery`'s key). Read only: this starts no request
 * of its own, and outside a query client it is simply unknown.
 */
export function useCachedStationStatus(): CachedStationStatus | undefined {
  const { apiBase } = useConnections();
  const client = useContext(QueryClientContext);
  const subscribe = useCallback(
    (notify: () => void) =>
      client ? client.getQueryCache().subscribe(notify) : () => {},
    [client],
  );
  // `useSystemStatusForApiBaseQuery` keys by base; `useSystemStatusQuery`
  // reads the active Station under the bare key.
  const read = () =>
    client?.getQueryData<CachedStationStatus>(['system-status', apiBase]) ??
    client?.getQueryData<CachedStationStatus>(['system-status']);
  return useSyncExternalStore(client ? subscribe : NO_SUBSCRIPTION, read, read);
}

/** The active saved Station's display name, or `undefined` without one. */
export function useActiveStationName(): string | undefined {
  const { activeConnection } = useConnections();
  const status = useCachedStationStatus();
  return stationDisplayName(
    activeConnection?.name,
    status?.devicePresentation?.hostName,
  );
}
