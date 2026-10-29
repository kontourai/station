/**
 * The addresses a Station reports it can be reached on, for a paired device to
 * learn as additional routes to the same saved Station
 * (docs/design/station-routes.md). Only the Station the device is already
 * authenticated with is asked, and every learned route is still checked
 * against the handshake's `environmentId` before it is used.
 */
export const STATION_ROUTES_PATH = '/api/system/routes' as const;

/** How the Station is reached on an advertised address. */
export type StationRouteKind = 'lan' | 'tailscale' | 'tailscale-https';

export interface StationRoute {
  kind: StationRouteKind;
  /** An `http:` or `https:` origin, with no path. */
  url: string;
}

export interface StationRoutesResponse {
  environmentId: string;
  routes: StationRoute[];
}

const ROUTE_KINDS: ReadonlySet<string> = new Set<StationRouteKind>([
  'lan',
  'tailscale',
  'tailscale-https',
]);

/** Upper bound on routes a client accepts from one answer. */
export const MAX_STATION_ROUTES = 16;

function routeOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.origin === value ? value : null;
  } catch {
    return null;
  }
}

/**
 * Validates a `GET /api/system/routes` answer. Invalid entries are dropped
 * rather than failing the whole answer, so one bad address never hides the
 * rest; a missing `environmentId` fails it, because the client cannot tell
 * which Station the routes belong to.
 */
export function parseStationRoutesResponse(
  value: unknown,
): StationRoutesResponse | null {
  if (!value || typeof value !== 'object') return null;
  const { environmentId, routes } = value as Record<string, unknown>;
  if (typeof environmentId !== 'string' || !environmentId) return null;
  if (!Array.isArray(routes)) return null;
  const seen = new Set<string>();
  const parsed: StationRoute[] = [];
  for (const entry of routes) {
    if (!entry || typeof entry !== 'object') continue;
    const { kind, url } = entry as Record<string, unknown>;
    const origin = routeOrigin(url);
    if (typeof kind !== 'string' || !ROUTE_KINDS.has(kind) || !origin) {
      continue;
    }
    if (seen.has(origin)) continue;
    seen.add(origin);
    parsed.push({ kind: kind as StationRouteKind, url: origin });
    if (parsed.length === MAX_STATION_ROUTES) break;
  }
  return { environmentId, routes: parsed };
}
