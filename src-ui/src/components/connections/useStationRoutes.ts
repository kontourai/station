import {
  connectionAcceptsRoutes,
  type SavedConnection,
  useConnectionStatus,
  useConnections,
} from '@kontourai/station-connect';
import {
  parseStationRoutesResponse,
  STATION_ROUTES_PATH,
  type StationRoute,
} from '@kontourai/station-contracts/station-routes';
import { authenticatedFetch } from '@kontourai/station-sdk';
import { useQuery } from '@tanstack/react-query';
import { createElement, useEffect } from 'react';
import { useDeveloperFeatures } from '../../hooks/useDeveloperFeatures';
import {
  checkServerHealth,
  probeServerConnection,
} from '../../lib/serverHealth';

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
  return useQuery({
    queryKey: [
      'station-routes',
      connection?.id ?? null,
      connection?.environmentId ?? null,
      apiBase,
    ],
    enabled: enabled && Boolean(connection?.environmentId),
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async ({ signal }): Promise<StationRoute[] | null> => {
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
      return parsed.routes;
    },
  });
}

/** Whether the Station routes preview is on for this device. */
export function useStationRoutesPreview(): boolean {
  return useDeveloperFeatures().stationRoutes;
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
    accepts && status === 'connected',
  );
  useEffect(() => {
    if (!routes.data || !activeConnection?.environmentId || !accepts) return;
    applyAdvertisedRoutes?.(
      activeConnection.id,
      activeConnection.environmentId,
      routes.data,
    );
  }, [routes.data, activeConnection, accepts, applyAdvertisedRoutes]);
  return null;
}
