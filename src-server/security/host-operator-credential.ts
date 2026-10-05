import { identifyIngress } from '../services/identity/identity-source.js';
import {
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
  INTERNAL_PROXY_CLIENT_FORWARDED_HEADER,
} from '../utils/internal-api-token.js';
import {
  attestedBrowserVisibleHost,
  attestedProxyPeerAddress,
  classifyRuntimePeer,
  getDirectSocketAddress,
  getRuntimeAuthenticatedRequestPrincipal,
  isLoopbackAuthority,
} from './runtime-request-security.js';

/**
 * Where a raw operator-credential use came from (#2894 S1, owner decision
 * D2). S1 only observes this; it is telemetry, not authority.
 *
 *  - `host-direct`: a direct loopback socket, no forwarding evidence, and a
 *    loopback `Host`. The host CLI's `openLocalOperatorChannel` is this
 *    caller.
 *  - `host-ui-proxy`: Station's own attested UI proxy, whose client was on
 *    loopback, addressed loopback, and sent no forwarding evidence.
 *  - `off-host`: anything else, including any caller this host cannot place.
 *
 * WHAT THIS DOES NOT PROVE. `Host` is client-controlled, and so is the
 * forwarded host the UI proxy copies from its client. Any proxy or tunnel on
 * this machine that re-dials loopback and strips forwarding headers (an SSH
 * local forward, a reverse proxy, a tunnel client) makes a remote caller read
 * as `host-direct` or `host-ui-proxy`. Refusing a raw operator credential
 * (S1b) must therefore rest on proof of a host-only secret, never on this
 * position. See `docs/design/operator-device-access.md`.
 */
export type OperatorCredentialPosition =
  | 'host-direct'
  | 'host-ui-proxy'
  | 'off-host';

/**
 * Headers a forwarding hop adds. Any of them present means the request did
 * not originate on this machine as far as the hop is concerned. Their
 * presence can only move a request to `off-host`, so a forger gains nothing
 * by adding them.
 */
const FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-real-ip',
] as const;

/** A Hono context, narrowed to what the position derivation reads. */
interface CallerContext {
  env: unknown;
  req: { header: (name: string) => string | undefined; raw: Request };
}

/**
 * Forwarding evidence on THIS request: a forwarding header, any `tailscale-*`
 * header, or the UI proxy's own marker that its client sent one (it strips
 * `tailscale-*` before relaying, so the marker carries that fact across).
 */
function carriesForwardingEvidence(c: CallerContext): boolean {
  if (c.req.header(INTERNAL_PROXY_CLIENT_FORWARDED_HEADER) !== undefined) {
    return true;
  }
  if (FORWARDING_HEADERS.some((name) => c.req.header(name) !== undefined)) {
    return true;
  }
  for (const name of c.req.raw.headers.keys()) {
    if (name.startsWith('tailscale-')) return true;
  }
  return false;
}

/**
 * Like the same-machine browser predicate in `runtime-routes.ts`
 * (`isSameMachineBrowserCaller`), plus two refusals: any forwarding evidence,
 * and, on the direct path, a `Host` that does not name loopback.
 */
export function classifyOperatorCredentialPosition(
  c: CallerContext,
): OperatorCredentialPosition {
  if (identifyIngress(c) !== null) return 'off-host';
  if (carriesForwardingEvidence(c)) return 'off-host';
  const socket = getDirectSocketAddress(c.env);
  if (classifyRuntimePeer(socket).peerClass !== 'loopback') return 'off-host';
  const request = {
    environment: c.env,
    header: (name: string) => c.req.header(name),
  };
  const attestedClient = attestedProxyPeerAddress(request);
  if (attestedClient === undefined) {
    // No attested Station-proxy hop. Attestation headers that are present
    // but untrusted fail closed instead of reading the socket.
    if (
      c.req.header(INTERNAL_PROXY_CALLER_HEADER) !== undefined ||
      c.req.header(INTERNAL_API_TOKEN_HEADER) !== undefined
    ) {
      return 'off-host';
    }
    return isLoopbackAuthority(c.req.header('host'))
      ? 'host-direct'
      : 'off-host';
  }
  return classifyRuntimePeer(attestedClient).peerClass === 'loopback' &&
    isLoopbackAuthority(attestedBrowserVisibleHost(request))
    ? 'host-ui-proxy'
    : 'off-host';
}

/**
 * Whether this request presents the raw operator credential from what looks
 * like this Station's host. False for every other credential, including the
 * desktop app's local-grant-minted device credential. Telemetry only: see
 * {@link OperatorCredentialPosition} for what it does not prove.
 */
export function isHostLocalOperatorCredentialUse(c: CallerContext): boolean {
  return (
    usesOperatorCredential(c) &&
    classifyOperatorCredentialPosition(c) !== 'off-host'
  );
}

/** The raw operator credential, as the auth boundary resolved it. */
export function usesOperatorCredential(c: { req: { raw: Request } }): boolean {
  return (
    getRuntimeAuthenticatedRequestPrincipal(c.req.raw)?.authority ===
    'operator-credential'
  );
}

/**
 * One raw operator-credential use on a device-admin route (#2894 S1). Carries
 * no device id, device name, credential or address.
 */
export interface OperatorCredentialUseRecord {
  readonly event: 'station.pairing.operator_credential_used';
  readonly route:
    | 'GET /api/pairing/devices'
    | 'DELETE /api/pairing/devices/:deviceId'
    | 'POST /api/pairing/devices/:deviceId/scope'
    | 'DELETE /api/pairing/devices/:deviceId/record';
  readonly position: OperatorCredentialPosition;
  readonly hostLocal: boolean;
  /** Off-host uses this process has observed so far, this one included. */
  readonly offHostUses: number;
  readonly timestamp: number;
}

const OPERATOR_CREDENTIAL_OFF_HOST_LOG_MESSAGE =
  'Operator credential used off-host for device administration';

/**
 * The production sink for {@link OperatorCredentialUseRecord}: every use is
 * counted by route and position, and an off-host use is logged at warn so it
 * is readable beside the pairing approval audit.
 */
export function reportOperatorCredentialUse(
  record: OperatorCredentialUseRecord,
  sinks: {
    counter: {
      add: (
        value: number,
        attributes: Pick<OperatorCredentialUseRecord, 'route' | 'position'>,
      ) => void;
    };
    logger: { warn: (message: string, attributes: object) => void };
  },
): void {
  sinks.counter.add(1, { route: record.route, position: record.position });
  if (!record.hostLocal) {
    sinks.logger.warn(OPERATOR_CREDENTIAL_OFF_HOST_LOG_MESSAGE, { ...record });
  }
}
