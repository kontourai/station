import type { StationRoute } from '@kontourai/station-contracts/station-routes';
import { isLoopbackUrl } from './connectionProfile';

/**
 * The ways a phone can reach this Station, for "Pair phone" to offer as
 * routes. Each one becomes the endpoint embedded in a pairing code, so only
 * an address the server will accept for an offer is listed: `https:` on any
 * non-loopback host, or `http:` on a private one (RFC1918, link-local,
 * tailnet CGNAT, `.local`), the same split `DevicePairingService.createOffer`
 * enforces. A loopback address is never listed: a phone that scans it dials
 * itself.
 */
export type PairingRouteKind =
  | StationRoute['kind']
  /** The address this panel is talking to, when no reported route matches. */
  | 'current';

export interface PairingRoute {
  kind: PairingRouteKind;
  /** An origin with no path. */
  url: string;
  label: string;
  hint: string;
}

const ROUTE_COPY: Record<PairingRouteKind, { label: string; hint: string }> = {
  'tailscale-https': {
    label: 'Tailscale HTTPS',
    hint: 'Any device on your tailnet, including a phone browser',
  },
  tailscale: {
    label: 'Tailscale',
    hint: 'Devices signed in to your tailnet',
  },
  lan: {
    label: 'Local network',
    hint: 'Devices on the same Wi-Fi',
  },
  current: {
    label: 'This address',
    hint: 'The address this browser uses',
  },
};

/** Best first: the route most likely to work from a phone anywhere. */
const ROUTE_ORDER: readonly PairingRouteKind[] = [
  'tailscale-https',
  'tailscale',
  'lan',
  'current',
];

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host.endsWith('.local')) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  return (
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * Whether an address can be embedded in a pairing code a phone will use:
 * reachable from another device, and accepted by the server for an offer.
 */
export function isPairableEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (isLoopbackUrl(url.origin)) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isPrivateHost(url.hostname);
}

/**
 * Turns the Station's reported routes (`GET /api/system/routes`) and the
 * address this panel is using into the routes "Pair phone" offers, best
 * first, without duplicates or anything a phone cannot use.
 */
export function pairingRoutesFrom(
  reported: readonly StationRoute[],
  currentAddress: string | undefined,
): PairingRoute[] {
  const seen = new Set<string>();
  const routes: PairingRoute[] = [];
  const add = (kind: PairingRouteKind, value: string) => {
    let origin: string;
    try {
      origin = new URL(value).origin;
    } catch {
      return;
    }
    if (seen.has(origin) || !isPairableEndpoint(origin)) return;
    seen.add(origin);
    routes.push({ kind, url: origin, ...ROUTE_COPY[kind] });
  };
  for (const route of reported) add(route.kind, route.url);
  if (currentAddress) add('current', currentAddress);
  return routes.sort(
    (left, right) =>
      ROUTE_ORDER.indexOf(left.kind) - ROUTE_ORDER.indexOf(right.kind),
  );
}

/**
 * The route to open "Pair phone" on: the one the owner last paired with on
 * this Station when it is still offered, else the best route.
 */
export function preferredPairingRoute(
  routes: readonly PairingRoute[],
  remembered: string | undefined,
): PairingRoute | undefined {
  if (remembered) {
    try {
      const origin = new URL(remembered).origin;
      const match = routes.find((route) => route.url === origin);
      if (match) return match;
    } catch {
      // A malformed remembered address is simply not preferred.
    }
  }
  return routes[0];
}
