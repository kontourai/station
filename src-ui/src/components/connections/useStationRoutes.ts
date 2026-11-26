import {
  connectionAcceptsRoutes,
  type SavedConnection,
  useConnectionStatus,
  useConnections,
} from '@kontourai/station-connect';
import {
  parseStationRoutesResponse,
  STATION_ROUTES_PATH,
  type StationRoutesResponse,
} from '@kontourai/station-contracts/station-routes';
import { authenticatedFetch } from '@kontourai/station-sdk';
import { useQuery } from '@tanstack/react-query';
import { createElement, useEffect } from 'react';
import { useDeveloperFeatures } from '../../hooks/useDeveloperFeatures';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import {
  checkServerHealth,
  probeServerConnection,
} from '../../lib/serverHealth';
import {
  nativeProfileRepository,
  usePlatformProfile,
} from '../../platform/PlatformProfileContext';

/**
 * The routes the active Station reports (docs/design/station-routes.md).
 * `null` is "this Station does not report routes": an older host answers the
 * path 404, and a device whose grant cannot read it gets 401 or 403.
 * An answer from a different Station than the saved one is ignored.
 */
export function useStationRoutesQuery(
  connection: SavedConnection | null,
  enabled: boolean,
) {
  const { apiBase } = useConnections();
  const { isTauri } = usePlatformProfile();
  const nativeConnection =
    isTauri &&
    connection?.id.startsWith('station-profile:') &&
    !connection.nativeBrokerRoute;
  const nativeBindingId = nativeConnection
    ? (nativeProfileRepository().captureNativeRequestBinding(
        connection.id,
        connection.url,
      )?.bindingId ?? null)
    : null;
  return useQuery({
    queryKey: [
      'station-routes',
      connection?.id ?? null,
      connection?.environmentId ?? null,
      apiBase,
      nativeBindingId,
    ],
    enabled: enabled && Boolean(connection?.environmentId),
    staleTime: 5 * 60_000,
    refetchInterval: nativeConnection ? 5 * 60_000 : false,
    retry: false,
    queryFn: async ({ signal }): Promise<StationRoutesResponse | null> => {
      const response = await authenticatedFetch(
        `${apiBase}${STATION_ROUTES_PATH}`,
        { signal },
      );
      if ([401, 403, 404].includes(response.status)) return null;
      if (!response.ok) throw new Error('station_routes_unavailable');
      const parsed = parseStationRoutesResponse(await response.json());
      if (!parsed || parsed.environmentId !== connection?.environmentId) {
        return null;
      }
      if (nativeConnection) {
        await nativeProfileRepository().refreshNativeRoutes(connection.id);
      }
      return parsed;
    },
  });
}

export function useStationRoutesPreview(): boolean {
  const devicePreview = useDeveloperFeatures().stationRoutes;
  const flags = useSurfaceVisibilityFlags();
  return devicePreview || flags.has('dynamic-route-publications');
}

/**
 * Keeps the active Station's saved routes in step with what it reports, while
 * it is connected. Mounted once; renders nothing, and does nothing while the
 * preview is off.
 */
export function StationRouteLearning() {
  return useStationRoutesPreview() ? createElement(StationRouteLearner) : null;
}

function StationRouteLearner() {
  const { activeConnection, applyAdvertisedRoutes } = useConnections();
  const { status } = useConnectionStatus({
    checkHealth: checkServerHealth,
    probeEndpoint: probeServerConnection,
    pollInterval: 10_000,
  });
  const accepts = Boolean(
    activeConnection && connectionAcceptsRoutes(activeConnection),
  );
  const routes = useStationRoutesQuery(
    activeConnection,
    status === 'connected',
  );
  useEffect(() => {
    if (!routes.data || !activeConnection?.environmentId || !accepts) return;
    applyAdvertisedRoutes?.(
      activeConnection.id,
      activeConnection.environmentId,
      routes.data.routes,
    );
  }, [routes.data, activeConnection, accepts, applyAdvertisedRoutes]);
  return null;
}
