import type { AddressInfo } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import {
  MAX_STATION_ROUTES,
  type StationRoute,
  type StationRoutesResponse,
} from '@kontourai/station-contracts/station-routes';

/**
 * The addresses this Station reports it can be reached on
 * (docs/design/station-routes.md). The LAN rule is nearby discovery's: a
 * private IPv4 address the API listener accepts on. A loopback-only listener
 * reports nothing, because no other device can reach it.
 */
function isPrivateLan(address: string): boolean {
  return (
    address.startsWith('10.') ||
    address.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  );
}

/** Tailscale assigns from the carrier-grade NAT range 100.64.0.0/10. */
function isTailscaleAddress(address: string): boolean {
  const match = /^100\.(\d{1,3})\./.exec(address);
  if (!match) return false;
  const second = Number(match[1]);
  return second >= 64 && second <= 127;
}

export function listenerStationRoutes(
  bound: AddressInfo | undefined,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): StationRoute[] {
  if (!bound) return [];
  const wildcard = bound.address === '0.0.0.0' || bound.address === '::';
  const routes: StationRoute[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue;
      if (!wildcard && bound.address !== entry.address) continue;
      const url = `http://${entry.address}:${bound.port}`;
      if (isPrivateLan(entry.address)) routes.push({ kind: 'lan', url });
      else if (isTailscaleAddress(entry.address)) {
        routes.push({ kind: 'tailscale', url });
      }
    }
  }
  return routes;
}

export interface StationRoutesResolverInput {
  boundAddress: () => AddressInfo | undefined;
  networkInterfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** Tailscale Serve origins proxying to this Station, when Tailscale is present. */
  servedOrigins: () => Promise<readonly string[] | undefined>;
  environmentId: () => Promise<string>;
}

export function createStationRoutesResolver(
  input: StationRoutesResolverInput,
): () => Promise<StationRoutesResponse> {
  return async () => {
    const [environmentId, served] = await Promise.all([
      input.environmentId(),
      input.servedOrigins().catch(() => undefined),
    ]);
    const seen = new Set<string>();
    const routes = [
      ...listenerStationRoutes(input.boundAddress(), input.networkInterfaces()),
      ...(served ?? []).map(
        (url): StationRoute => ({ kind: 'tailscale-https', url }),
      ),
    ].filter((route) => {
      if (seen.has(route.url)) return false;
      seen.add(route.url);
      return true;
    });
    return { environmentId, routes: routes.slice(0, MAX_STATION_ROUTES) };
  };
}
