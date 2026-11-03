import type { StationRoute } from '@kontourai/station-contracts/station-routes';
import { isLoopbackUrl } from './connectionProfile';

/**
 * The ways a phone can reach this Station, for "Pair phone" to offer as
 * routes. Each one becomes the endpoint embedded in a pairing code, and a
 * pairing code carries a secret, so only an `https:` origin on a
 * non-loopback host is listed: the phone's QR decoder accepts nothing else
 * (a local `http:` address uses the separate direct access flow instead).
 * A loopback address is never listed: a phone that scans it dials itself.
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

/**
 * Whether an address can be embedded in a pairing code a phone will use:
 * HTTPS (the QR decoder's rule for a secret-bearing code) and reachable from
 * another device.
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
  return url.protocol === 'https:';
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
