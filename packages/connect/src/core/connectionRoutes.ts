import type { StationRoute } from '@kontourai/station-contracts/station-routes';
import { createDirectHttpAccessMethod } from './accessMethods';
import { isLoopbackUrl } from './connectionProfile';
import {
  createAccessEndpoint,
  type EndpointCompatibilityContext,
} from './environmentProfiles';
import type { AccessEndpoint, SavedConnection } from './types';

/**
 * Routes: the addresses one saved Station is reached on
 * (docs/design/station-routes.md). A route is an `AccessEndpoint`; these
 * helpers derive how it is shown and change the set without touching any
 * other part of the profile.
 */
export type ConnectionRouteKind =
  | 'local'
  | 'lan'
  | 'tailscale'
  | 'tailscale-https'
  | 'relay'
  | 'ssh'
  | 'internet';

export const CONNECTION_ROUTE_LABELS: Readonly<
  Record<ConnectionRouteKind, string>
> = {
  local: 'This computer',
  lan: 'Local network',
  tailscale: 'Tailscale',
  'tailscale-https': 'Tailscale HTTPS',
  relay: 'Relay',
  ssh: 'SSH tunnel',
  internet: 'Internet',
};

function ipv4(hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  return octets.every((part) => Number.isInteger(part) && part >= 0)
    ? octets
    : null;
}

/** Derived from the address; the endpoint's stored kind decides only relay and SSH. */
export function connectionRouteKind(
  endpoint: Pick<AccessEndpoint, 'url' | 'kind'>,
): ConnectionRouteKind {
  if (endpoint.kind === 'broker-route') return 'relay';
  if (endpoint.kind === 'ssh-forward') return 'ssh';
  if (endpoint.kind === 'managed-loopback' || isLoopbackUrl(endpoint.url)) {
    return 'local';
  }
  try {
    const url = new URL(endpoint.url);
    if (url.hostname.endsWith('.ts.net')) {
      return url.protocol === 'https:' ? 'tailscale-https' : 'tailscale';
    }
    const octets = ipv4(url.hostname);
    if (octets) {
      const [a, b] = octets;
      if (a === 100 && b >= 64 && b <= 127) return 'tailscale';
      if (
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168)
      ) {
        return 'lan';
      }
    }
    if (url.hostname.endsWith('.local')) return 'lan';
  } catch {
    // An unparsable address is still a route the user saved.
  }
  return 'internet';
}

export type RouteState = Pick<
  SavedConnection,
  | 'url'
  | 'endpoints'
  | 'selectedEndpointId'
  | 'accessMethods'
  | 'selectedAccessMethodId'
>;

/**
 * Only a profile reached by plain direct HTTP takes routes: a relay, a native
 * relay or an SSH tunnel owns its own single address.
 */
export function connectionAcceptsRoutes(connection: SavedConnection): boolean {
  return (
    !connection.injected &&
    !connection.brokerRoute &&
    !connection.nativeBrokerRoute &&
    !connection.sshForward &&
    connection.accessMethods.every((method) => method.kind === 'direct-http')
  );
}

function withEndpoints(
  connection: SavedConnection,
  endpoints: AccessEndpoint[],
  selectedEndpointId: string,
): RouteState {
  const selected =
    endpoints.find((endpoint) => endpoint.id === selectedEndpointId) ??
    endpoints[0];
  const accessMethods = endpoints.map(createDirectHttpAccessMethod);
  return {
    url: selected?.url ?? connection.url,
    endpoints,
    selectedEndpointId: selected?.id ?? '',
    accessMethods,
    selectedAccessMethodId:
      accessMethods.find((method) => method.endpointId === selected?.id)?.id ??
      '',
  };
}

function usableOn(
  url: string,
  context: Pick<EndpointCompatibilityContext, 'clientProtocol'>,
): boolean {
  // The browser blocks plain HTTP from an HTTPS page; learning such a route
  // would only add a row that can never connect.
  return (
    context.clientProtocol !== 'https:' ||
    new URL(url).protocol === 'https:' ||
    isLoopbackUrl(url)
  );
}

/**
 * Folds the routes a Station reported into its saved profile. Adds new ones,
 * drops advertised ones it stopped reporting (never the one in use), and
 * leaves routes the user added alone. Returns null when nothing changes.
 */
export function mergeAdvertisedRoutes(
  connection: SavedConnection,
  advertised: readonly StationRoute[],
  context: Pick<EndpointCompatibilityContext, 'clientProtocol'>,
): RouteState | null {
  if (!connectionAcceptsRoutes(connection)) return null;
  const reported = new Map<string, AccessEndpoint>();
  for (const route of advertised) {
    let endpoint: AccessEndpoint;
    try {
      endpoint = {
        ...createAccessEndpoint(route.url),
        source: 'advertised',
      };
    } catch {
      continue;
    }
    if (usableOn(endpoint.url, context)) {
      reported.set(endpoint.url, endpoint);
    }
  }
  const known = new Set(connection.endpoints.map((endpoint) => endpoint.url));
  const kept = connection.endpoints.filter(
    (endpoint) =>
      endpoint.source !== 'advertised' ||
      reported.has(endpoint.url) ||
      endpoint.id === connection.selectedEndpointId,
  );
  const added = [...reported.values()].filter(
    (endpoint) => !known.has(endpoint.url),
  );
  if (!added.length && kept.length === connection.endpoints.length) {
    return null;
  }
  return withEndpoints(
    connection,
    [...kept, ...added],
    connection.selectedEndpointId,
  );
}

/** Adds a route the user typed. Throws on an address that is not http(s). */
export function addConnectionRoute(
  connection: SavedConnection,
  address: string,
): RouteState | null {
  if (!connectionAcceptsRoutes(connection)) {
    throw new Error('This Station is reached through a single fixed route.');
  }
  let endpoint: AccessEndpoint;
  try {
    const parsed = new URL(address.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('unsupported');
    }
    endpoint = createAccessEndpoint(parsed.origin);
  } catch {
    throw new Error('Enter an address that starts with http:// or https://.');
  }
  const existing = connection.endpoints.find(
    (candidate) => candidate.url === endpoint.url,
  );
  if (existing && existing.source !== 'advertised') return null;
  return withEndpoints(
    connection,
    [
      ...connection.endpoints.filter(
        (candidate) => candidate.url !== endpoint.url,
      ),
      endpoint,
    ],
    connection.selectedEndpointId,
  );
}

/**
 * Removes a route the user added. Advertised routes are not removable (the
 * Station would report them again), and the last route never is.
 */
export function removeConnectionRoute(
  connection: SavedConnection,
  endpointId: string,
): RouteState | null {
  if (!connectionAcceptsRoutes(connection)) return null;
  const target = connection.endpoints.find(
    (endpoint) => endpoint.id === endpointId,
  );
  if (
    !target ||
    target.source === 'advertised' ||
    connection.endpoints.length < 2
  ) {
    return null;
  }
  const remaining = connection.endpoints.filter(
    (endpoint) => endpoint.id !== endpointId,
  );
  const nextSelected =
    connection.selectedEndpointId === endpointId
      ? [...remaining].sort((a, b) => a.priority - b.priority)[0]?.id
      : connection.selectedEndpointId;
  return withEndpoints(connection, remaining, nextSelected ?? '');
}

/** Whether the routes UI may offer to remove this route. */
export function connectionRouteRemovable(
  connection: SavedConnection,
  endpoint: AccessEndpoint,
): boolean {
  return (
    connectionAcceptsRoutes(connection) &&
    endpoint.source !== 'advertised' &&
    connection.endpoints.length > 1
  );
}
