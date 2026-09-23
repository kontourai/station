/**
 * Who a browser profile may connect to (#90 D2 + D7), decided on a resolved or
 * connected IP address — never on a hostname.
 *
 * - Every profile: no Station listener on this host, and not the egress proxy
 *   itself (`station-listeners.ts`).
 * - Operator profiles: otherwise full http(s) reach, loopback and LAN included.
 * - Project admin/owner profiles: public addresses only, plus the Project's
 *   registered local targets. Loopback, RFC1918, link-local (incl. the cloud
 *   metadata address), CGNAT/tailnet, ULA, multicast and every address of
 *   this host's own interfaces are refused unless registered.
 * - Every profile, operator included: an ordinary HOSTNAME that resolves to a
 *   non-public or local address is refused (DNS-rebinding defence, review
 *   round 2). A hostile public page can point its own name at 127.0.0.1 and
 *   then read a loopback or LAN service same-origin; resolved-IP matching
 *   alone cannot tell that apart from a real visit. Non-public destinations
 *   are therefore reachable only by their IP literal, `localhost` or
 *   `*.localhost` — names a remote page cannot control. Accepted cost: LAN
 *   and tailnet names (a NAS's `.local` name, MagicDNS) must be opened by
 *   address.
 */
import {
  type CanonicalIp,
  canonicalIp,
  isLoopbackIp,
  isNonPublicIp,
  sameIp,
} from './ip-address.js';
import { isLocalAddress, type StationListeners } from './station-listeners.js';

export type EgressRefusal =
  | 'station-listener'
  | 'non-public-address'
  | 'hostname-to-non-public'
  | 'resolve-failed'
  | 'invalid-target';

export interface RegisteredLocalTarget {
  /** An IP literal, or `localhost` (any loopback address). */
  host: string;
  port: number;
}

export type EgressReach =
  | { kind: 'operator' }
  | {
      kind: 'project';
      /** Read live for every connection: (un)registration applies at once. */
      localTargets: () => readonly RegisteredLocalTarget[];
    };

export interface EgressPolicy {
  listeners: () => StationListeners;
  interfaceAddresses: () => readonly string[];
  reach: EgressReach;
}

function matchesTarget(
  ip: CanonicalIp,
  port: number,
  target: RegisteredLocalTarget,
): boolean {
  if (target.port !== port) return false;
  const host = target.host.trim().toLowerCase();
  if (host === 'localhost') return isLoopbackIp(ip);
  const targetIp = canonicalIp(host);
  if (!targetIp) return false;
  // A loopback target matches any loopback spelling the browser resolved.
  if (isLoopbackIp(targetIp)) return isLoopbackIp(ip);
  return sameIp(ip, targetIp);
}

/**
 * Whether a requested host may lead to a non-public address: an IP literal,
 * `localhost` or a `*.localhost` name (all resolved locally, not by DNS the
 * page's owner controls).
 */
export function isLocalSpellingHost(requestedHost: string): boolean {
  const host = requestedHost
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return canonicalIp(host) !== undefined;
}

/**
 * Decide one destination address. Undefined means allowed. `selfPort` is the
 * egress proxy's own port, which is never a destination. `requestedHost` is
 * the host the browser asked for (a name or an IP literal); when given, a
 * non-public address reached through an ordinary hostname is refused.
 */
export function decideEgress(
  address: string,
  port: number,
  policy: EgressPolicy,
  selfPort?: number,
  requestedHost?: string,
): EgressRefusal | undefined {
  const ip = canonicalIp(address);
  if (!ip || !Number.isInteger(port) || port < 1 || port > 65_535)
    return 'invalid-target';
  const interfaces = policy.interfaceAddresses();
  const local = isLocalAddress(ip.address, interfaces);
  if (local && (port === selfPort || policy.listeners().ports.includes(port)))
    return 'station-listener';
  const nonPublic = local || isNonPublicIp(ip);
  if (
    nonPublic &&
    requestedHost !== undefined &&
    !isLocalSpellingHost(requestedHost)
  )
    return 'hostname-to-non-public';
  if (policy.reach.kind === 'operator') return undefined;
  if (!nonPublic) return undefined;
  return policy.reach
    .localTargets()
    .some((target) => matchesTarget(ip, port, target))
    ? undefined
    : 'non-public-address';
}
