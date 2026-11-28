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
  publication?: StationRoutePublication;
}

export interface StationRoutePublication {
  consentOrigin: string | null;
  source: 'configured' | 'tailscale' | 'unavailable';
  appOrigins: string[];
  status: 'ready' | 'unavailable' | 'ambiguous' | 'disabled';
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

export function isTrustedConsentOrigin(value: string): boolean {
  if (routeOrigin(value) !== value) return false;
  const url = new URL(value);
  const labels = url.hostname.split('.');
  return (
    url.protocol === 'https:' &&
    url.port !== '0' &&
    url.hostname.length <= 253 &&
    labels.every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    ) &&
    !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)
  );
}

function parsePublication(value: unknown): StationRoutePublication | null {
  if (!value || typeof value !== 'object') return null;
  const { consentOrigin, source, appOrigins, status } = value as Record<
    string,
    unknown
  >;
  if (
    consentOrigin !== null &&
    (typeof consentOrigin !== 'string' ||
      !isTrustedConsentOrigin(consentOrigin))
  ) {
    return null;
  }
  if (
    source !== 'configured' &&
    source !== 'tailscale' &&
    source !== 'unavailable'
  ) {
    return null;
  }
  if (
    status !== 'ready' &&
    status !== 'unavailable' &&
    status !== 'ambiguous' &&
    status !== 'disabled'
  ) {
    return null;
  }
  if (
    !Array.isArray(appOrigins) ||
    appOrigins.length > MAX_STATION_ROUTES ||
    (status === 'ready' && consentOrigin === null) ||
    (source === 'unavailable' && consentOrigin !== null)
  ) {
    return null;
  }
  const origins = new Set<string>();
  for (const candidate of appOrigins) {
    const origin = routeOrigin(candidate);
    if (origin === null) return null;
    origins.add(origin);
  }
  return {
    consentOrigin,
    source,
    appOrigins: [...origins],
    status,
  };
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
  const { environmentId, routes, publication } = value as Record<
    string,
    unknown
  >;
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
  const parsedPublication = parsePublication(publication);
  return {
    environmentId,
    routes: parsed,
    ...(parsedPublication ? { publication: parsedPublication } : {}),
  };
}
