import type {
  AccessEndpoint,
  AccessEndpointKind,
  ConnectionFailureReason,
} from './types';

export interface EndpointCompatibilityContext {
  /**
   * `'native:'` marks a native shell page origin (e.g. Tauri's
   * `tauri://localhost`) — it is a secure context, but it is not a "secure
   * web page" for mixed-content purposes (station#1286): the shell's CSP,
   * not the browser mixed-content algorithm, governs what it may fetch, and
   * every native release build allows plain `http:` in `connect-src`. Only
   * the host can know this; `packages/connect` stays platform-blind and
   * takes it as an explicit signal rather than inferring it.
   */
  clientProtocol: 'http:' | 'https:' | 'native:';
  online: boolean;
}

export type EndpointCompatibility =
  | { compatible: true }
  | { compatible: false; reason: ConnectionFailureReason };

/**
 * station#1776 — copy rewritten from the user's point of view. Every string
 * used to describe the *code's* concept of the failure (an "environment", a
 * "credential", an "endpoint"); the reader has none of that vocabulary and
 * is left to guess what "belongs to a different Station environment" even
 * means. Each entry now names the actual host the reader is looking at
 * (threaded in by the caller, which already has it — see
 * `connectionFailureCopy` below) and says what a person can concretely do.
 * Deliberately keyed on `Exclude<ConnectionFailureReason, 'awaiting-approval'>`:
 * that reason is never a failure to explain (see its doc comment in
 * `types.ts`), so there is intentionally no copy for it here — a caller must
 * route around it before ever reaching this table.
 *
 * Vocabulary rule (enforced by
 * `packages/connect/src/__tests__/environmentProfiles.test.ts`): none of
 * these strings may contain `endpoint`, `credential`, `environment`,
 * `loopback`, `instance`, or `context`. Those words stay legal in Advanced
 * surfaces only.
 *
 * `short`, where an entry has one (station#4512 review L-new-2): a
 * one-line form for a surface with room for a phrase but not `summary`'s
 * full sentence — the Stations-sheet card's dominant-state line
 * (`connectionCardMeta`) is the first consumer. This table stays the
 * single source for reason wording either way; a caller that needs
 * shorter copy adds a `short` entry here rather than hardcoding a literal
 * that can drift from `summary`/`action`.
 */
const FAILURE_COPY: Record<
  Exclude<ConnectionFailureReason, 'awaiting-approval'>,
  (
    host: string,
    address: string,
  ) => { summary: string; action: string; short?: string }
> = {
  offline: (host) => ({
    summary: 'This device is offline.',
    action: `Reconnect to a network; Station will retry reaching ${host}.`,
  }),
  'mixed-content': (host) => ({
    summary: `This page can't reach ${host} over an insecure address.`,
    action: 'Use its https address instead.',
  }),
  'invalid-endpoint': () => ({
    summary: "That doesn't look like a Station address.",
    action: 'It should start with http:// or https://.',
  }),
  // The signal this reason fires on (the handshake's environment identity
  // differing from the one this device last knew — see `serverHealth.ts`)
  // is equally consistent with a reset/reinstalled host AND with a
  // *different* device now answering at the same address (DHCP handing the
  // address to another machine, another host taking the same LAN name or
  // tailnet address). The copy states only what was actually observed and
  // offers the reset/reinstall explanation as a possibility, not a fact —
  // asserting it as fact would hide the case the reader most needs to know
  // about.
  'identity-mismatch': (host) => ({
    summary: `The Station at ${host} isn't the one this device paired with.`,
    action:
      'It may have been reset or reinstalled. Pair again, or remove this connection.',
  }),
  'access-method-mismatch': (host) => ({
    summary: `Reached ${host} a different way than last time.`,
    action: "Confirm it's the same Station, or save it separately.",
  }),
  // station#3297 — the copy this issue was filed about. What the reader used
  // to get for a stale credential was "Can't reach ..., it may be off, asleep,
  // or on another network", which sent them at the network while the host was
  // answering fine. It says instead that the address is not the problem and
  // names the one action that fixes it.
  //
  // What it deliberately does NOT say is "the host is reachable". This reason
  // is also produced by a desktop native-transport refusal
  // (`classifyNativeTransportRefusal`), where the request never left the
  // device and reachability was never observed — asserting it there would be
  // the same unearned network claim, pointed the other way.
  //
  // station#3903 rewrote the action. It used to read "pair this device again",
  // and the surfaces that render this sentence put a button labelled REQUEST
  // ACCESS next to it (`ConnectionListPanel`'s row, `OnboardingGate`'s banner)
  // — the copy named a remedy the product does not offer under that name. It
  // now names the fact the status proves (this device is not authorised there)
  // and the affordance that is actually beside it.
  //
  // What it still does not say is "revoked". A 401 proves the access on offer
  // was not accepted; it cannot tell a withdrawn one from a never-valid one,
  // and `classifyNativeTransportRefusal` reaches this same reason for a device
  // that was never configured at all.
  'authentication-failed': (host) => ({
    summary: `${host} isn't accepting this device.`,
    action: `The address is fine — this device isn't authorised there. Request access to ${host} again.`,
    // station#4512 review (M4/L-new-2): the Stations-sheet card's one-line
    // form for this reason — short enough for a dominant-state line, and
    // distinct from the generic "Credential required" bucket a connection
    // with no lastError at all still uses.
    short: "This device isn't authorised on this Station",
  }),
  'unsupported-capability-version': (host) => ({
    summary: `${host} is running an older Station than this app needs.`,
    action: `Update Station on ${host}, then try again.`,
  }),
  timeout: (host) => ({
    summary: `${host} didn't answer in time.`,
    action: 'It may be busy. Trying again shortly.',
  }),
  unreachable: (host, address) => ({
    summary:
      address && address !== host
        ? `Can't reach ${host} (${address}).`
        : `Can't reach ${host}.`,
    action: 'It may be off, asleep, or on another network.',
  }),
  'server-restarted': (host) => ({
    summary: `${host} restarted.`,
    action: 'Read-only data stays available while the session reconnects.',
  }),
  'host-unavailable': (host) => ({
    summary: `${host}'s server is down or recovering.`,
    action: 'The Station UI is still available and will keep trying.',
  }),
  // station#3297. Says what was observed (it answered, and said no) and points
  // at the only place the answer can change — the host's own allow-list. It
  // must not offer pairing: no credential this device can obtain affects it.
  'origin-not-allowed': (host) => ({
    summary: `${host} answered, but won't accept requests from this app.`,
    action: `Allow this app's web address on ${host}, then try again.`,
  }),
  // station#3297. Everything here is derived from having received a response
  // this client cannot use. It offers the possibility that something else is
  // answering rather than asserting it, for the same reason 'identity-mismatch'
  // does (station#1776 review).
  'unexpected-response': (host) => ({
    summary: `${host} answered, but not as a Station.`,
    action:
      'Something else may be answering at that address. Check it, or try again shortly.',
  }),
  // station#3297. The only copy in this table that names no cause, because the
  // state it describes is "no cause was determined". Anything more specific
  // would be the invented-network-condition defect wearing different words.
  undetermined: (host) => ({
    summary: `Couldn't confirm the connection to ${host}.`,
    action: 'Trying again shortly.',
  }),
};

/**
 * Every reason that has copy, derived from the table itself rather than
 * hand-listed — a hand-maintained mirror of this set is one merge away from
 * silently exempting a new reason from the copy/vocabulary tests that exist to
 * hold the whole table to the same standard (station#3297).
 */
export const FAILURE_COPY_REASONS = Object.keys(FAILURE_COPY) as ReadonlyArray<
  Exclude<ConnectionFailureReason, 'awaiting-approval'>
>;

/**
 * `host` is a short display label for the connection (a saved name, or the
 * address itself when there is no name) — every current caller already has
 * one (`SavedConnection.name || SavedConnection.url`, or `apiBase` before any
 * connection is saved). `address` is the literal network address, used only
 * by the `unreachable` copy to show both what the connection is called and
 * where it actually tried to reach; it defaults to `host` when the caller has
 * only a single value, which collapses the two mentions instead of repeating
 * one string twice.
 */
export function connectionFailureCopy(
  reason: Exclude<ConnectionFailureReason, 'awaiting-approval'>,
  host: string,
  address: string = host,
): {
  summary: string;
  action: string;
  /** A shorter one-line form, where this reason has one — see `FAILURE_COPY`'s doc comment. */
  short?: string;
} {
  return FAILURE_COPY[reason](host, address);
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

export function inferEndpointKind(
  value: string,
  currentOrigin?: string,
): AccessEndpointKind {
  try {
    const url = new URL(value);
    if (currentOrigin && url.origin === new URL(currentOrigin).origin) {
      return 'same-origin';
    }
    if (url.protocol === 'https:' && url.hostname.endsWith('.ts.net')) {
      return 'tailnet-https';
    }
    if (isPrivateIpv4(url.hostname) || url.hostname.endsWith('.local')) {
      return url.protocol === 'https:' ? 'lan-https' : 'lan-http';
    }
    return 'manual';
  } catch {
    return 'manual';
  }
}

export function endpointId(kind: AccessEndpointKind, url: string): string {
  return `endpoint:${kind}:${encodeURIComponent(url)}`;
}

export function createAccessEndpoint(
  url: string,
  options: {
    kind?: AccessEndpointKind;
    priority?: number;
    currentOrigin?: string;
    verifiedAt?: number;
  } = {},
): AccessEndpoint {
  const normalized = new URL(url).origin;
  const kind =
    options.kind ?? inferEndpointKind(normalized, options.currentOrigin);
  return {
    endpointVersion: 1,
    id: endpointId(kind, normalized),
    url: normalized,
    kind,
    priority: options.priority ?? 100,
    ...(options.verifiedAt === undefined
      ? {}
      : { verifiedAt: options.verifiedAt }),
  };
}

/**
 * Hostnames the mixed-content spec treats as "potentially trustworthy" even
 * over plain HTTP, because they can only ever resolve on the local machine
 * (fetch(), Web APIs spec §potentially-trustworthy-origin). A genuine HTTPS
 * page loading `http://localhost:...` is not blocked by real browsers, so
 * `classifyEndpoint` must not report `mixed-content` for these either.
 */
function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  );
}

export function classifyEndpoint(
  endpoint: AccessEndpoint,
  context: EndpointCompatibilityContext,
): EndpointCompatibility {
  if (!context.online) return { compatible: false, reason: 'offline' };
  try {
    const url = new URL(endpoint.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { compatible: false, reason: 'invalid-endpoint' };
    }
    // A native shell page (e.g. Tauri's `tauri://localhost`) is never subject
    // to the browser mixed-content algorithm — its CSP governs fetches
    // instead (station#1286). Only a genuine `https:` page can trigger it.
    if (
      context.clientProtocol === 'https:' &&
      url.protocol === 'http:' &&
      !isLoopbackHostname(url.hostname)
    ) {
      return { compatible: false, reason: 'mixed-content' };
    }
    return { compatible: true };
  } catch {
    return { compatible: false, reason: 'invalid-endpoint' };
  }
}

const KIND_RANK: Record<AccessEndpointKind, number> = {
  // A supervised loopback base is the most authoritative local endpoint.
  'managed-loopback': 0,
  'same-origin': 0,
  // A desktop-held ssh -L tunnel is loopback-direct on the device that owns
  // it, but dies with the launcher — rank below the supervised bases.
  'ssh-forward': 1,
  'tailnet-https': 1,
  'lan-https': 2,
  manual: 3,
  'lan-http': 4,
};

export function rankCompatibleEndpoints(
  endpoints: readonly AccessEndpoint[],
  context: EndpointCompatibilityContext,
): {
  endpoints: AccessEndpoint[];
  failures: Map<string, ConnectionFailureReason>;
} {
  const failures = new Map<string, ConnectionFailureReason>();
  const compatible = endpoints.filter((endpoint) => {
    const result = classifyEndpoint(endpoint, context);
    if (!result.compatible) failures.set(endpoint.id, result.reason);
    return result.compatible;
  });
  compatible.sort(
    (a, b) =>
      a.priority - b.priority ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      a.url.localeCompare(b.url),
  );
  return { endpoints: compatible, failures };
}

export function selectCompatibleEndpoint(
  endpoints: readonly AccessEndpoint[],
  context: EndpointCompatibilityContext,
): {
  endpoint: AccessEndpoint | null;
  failures: Map<string, ConnectionFailureReason>;
} {
  const ranked = rankCompatibleEndpoints(endpoints, context);
  return { endpoint: ranked.endpoints[0] ?? null, failures: ranked.failures };
}
