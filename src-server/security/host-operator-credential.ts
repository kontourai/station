import { identifyIngress } from '../services/identity/identity-source.js';
import {
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
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
 * D2). The device-admin routes will accept the raw operator credential only
 * from this Station's own host; S1 observes the off-host uses before any
 * refusal ships.
 *
 *  - `host-direct`: a process on this machine dialled the API socket directly
 *    on loopback and addressed it by a loopback name. The host CLI's
 *    `openLocalOperatorChannel` is this caller.
 *  - `host-ui-proxy`: a browser on this machine reached the API through
 *    Station's own attested UI proxy, and addressed this machine's loopback.
 *  - `off-host`: anything else, including any caller this host cannot prove
 *    is local.
 */
export type OperatorCredentialPosition =
  | 'host-direct'
  | 'host-ui-proxy'
  | 'off-host';

/** A Hono context, narrowed to what the position derivation reads. */
interface PositionContext {
  env: unknown;
  req: { header: (name: string) => string | undefined };
}

interface CallerContext extends PositionContext {
  req: PositionContext['req'] & { raw: Request };
}

/**
 * Same three facts as the same-machine browser predicate in
 * `runtime-routes.ts` (`isSameMachineBrowserCaller`), with one addition on
 * the direct path: the request's own `Host` must also name loopback. A
 * `tailscale serve` mapping pointed straight at the API port (the channel
 * apps' topology) re-dials from loopback with no proxy headers and, without a
 * configured trusted origin, no ingress identity. Its socket alone reads as
 * loopback, but Serve preserves the browser's tailnet `Host`, which this
 * check refuses.
 *
 * Not proved, as for every loopback position: an SSH local forward or any
 * process already running as this user satisfies all of it.
 */
export function classifyOperatorCredentialPosition(
  c: PositionContext,
): OperatorCredentialPosition {
  if (identifyIngress(c) !== null) return 'off-host';
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
 * Whether this request presents the raw operator credential from this
 * Station's host. False for every other credential: the question is about
 * the operator credential only, so a device credential (including the
 * desktop app's local-grant-minted one) is never "a host-local operator
 * credential use". Reads the principal the auth boundary already bound.
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
