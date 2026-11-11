/**
 * #4769: the loopback egress broker a restricted-network confinement allows
 * and nothing else. A process sandbox cannot allow by host name, only by
 * address and port, so the sandbox allows outbound TCP to one loopback port
 * and this HTTP `CONNECT` proxy listens there. `CONNECT` names the host
 * before any DNS lookup and without TLS interception, so the broker decides
 * on the name, then resolves and connects itself.
 *
 * - Allowed: the hosts the policy lists, and the engine's own model endpoint
 *   (derived from the resolved connection, never typed by hand).
 * - Everything else is refused with HTTP 403: an unlisted host, a host
 *   whose addresses are not public (a listed name that resolves to loopback
 *   would reach Station's own port), a request that is not `CONNECT`
 *   (405), a malformed one (400) and one that does not finish its header in
 *   time (408).
 * - Every request appends one decision record: host, port, verdict, reason
 *   and time. Never a payload, a URL path or a header. The records are kept
 *   in memory, at most {@link MAX_EGRESS_DECISIONS}, oldest dropped first,
 *   and go when the broker closes.
 *
 * Design after Shepherd's `_egress_broker.py` (MIT); no code is shared.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import {
  createServer,
  isIP,
  connect as netConnect,
  type Socket,
} from 'node:net';

/** The port an allowed-host entry without one means. */
export const EGRESS_DEFAULT_PORT = 443;
/** The longest host name DNS can carry. */
export const MAX_EGRESS_HOST_LENGTH = 253;
/** The most allowed-host entries a policy may list. */
export const MAX_EGRESS_ALLOWED_HOSTS = 256;
/** The decision records a broker keeps, oldest dropped first. */
export const MAX_EGRESS_DECISIONS = 256;
/** How long a client has to finish its request header. */
export const EGRESS_HEADER_DEADLINE_MS = 10_000;
/** The longest request header the broker reads. */
export const MAX_EGRESS_HEADER_BYTES = 8 * 1024;
/** How long the broker waits for an allowed upstream to accept. */
export const EGRESS_CONNECT_TIMEOUT_MS = 15_000;
/** The most connections a broker holds open at once. */
export const MAX_EGRESS_CONNECTIONS = 256;

/** A `CONNECT` target: a lowercase host name or an IP literal, and a port. */
export interface EgressTarget {
  host: string;
  port: number;
}

/**
 * One allowed-host entry: an exact host (a name or an IP literal), or every
 * subdomain of a name (`*.example.com`, not `example.com` itself), on one
 * port.
 */
export type EgressHostRule =
  | { kind: 'exact'; host: string; port: number }
  | { kind: 'subdomains'; suffix: string; port: number };

export type EgressDecisionReason =
  | 'model-endpoint'
  | 'allowed-host'
  | 'not-allowed'
  | 'non-public-address'
  | 'unresolved'
  | 'method-not-allowed'
  | 'malformed-request'
  | 'header-deadline';

/**
 * One request's decision. Content-free: no payload, no URL path, no header.
 * `host` and `port` are absent when the request named none the broker could
 * read.
 */
export interface EgressDecisionRecord {
  at: string;
  verdict: 'allowed' | 'denied';
  reason: EgressDecisionReason;
  host?: string;
  port?: number;
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * `raw` as the broker compares hosts: lowercase, one trailing dot removed,
 * an IPv6 literal without brackets. `undefined` for anything else: an empty
 * or over-long name, a label DNS cannot carry, a non-ASCII name (it must
 * arrive in its `xn--` form) or a bracketed literal that is not IPv6.
 */
export function normalizeEgressHost(raw: string): string | undefined {
  // An IPv6 zone names an interface of this host, not a destination.
  if (raw.includes('%')) return undefined;
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const literal = raw.slice(1, -1).toLowerCase();
    return isIP(literal) === 6 ? literal : undefined;
  }
  if (isIP(raw) === 4) return raw;
  if (isIP(raw) === 6) return raw.toLowerCase();
  const host = (raw.endsWith('.') ? raw.slice(0, -1) : raw).toLowerCase();
  if (host.length === 0 || host.length > MAX_EGRESS_HOST_LENGTH)
    return undefined;
  return host.split('.').every((label) => LABEL.test(label)) ? host : undefined;
}

function parsePort(text: string): number | undefined {
  if (!/^[0-9]{1,5}$/.test(text)) return undefined;
  const port = Number(text);
  return port >= 1 && port <= 65_535 ? port : undefined;
}

/** `host:port` or `[v6]:port`, the port required. */
function splitAuthority(
  text: string,
): { host: string; port: string | undefined } | undefined {
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    if (close < 0) return undefined;
    const rest = text.slice(close + 1);
    if (rest !== '' && !rest.startsWith(':')) return undefined;
    return {
      host: text.slice(0, close + 1),
      port: rest === '' ? undefined : rest.slice(1),
    };
  }
  const colon = text.lastIndexOf(':');
  // A bare IPv6 literal has colons of its own.
  if (colon < 0 || text.indexOf(':') !== colon)
    return { host: text, port: undefined };
  return { host: text.slice(0, colon), port: text.slice(colon + 1) };
}

/** A `CONNECT` request target (`host:port`), or `undefined` when malformed. */
export function parseConnectAuthority(text: string): EgressTarget | undefined {
  const parts = splitAuthority(text);
  if (!parts || parts.port === undefined) return undefined;
  const host = normalizeEgressHost(parts.host);
  const port = parsePort(parts.port);
  return host && port ? { host, port } : undefined;
}

/**
 * One allowed-host entry as written in the policy: `host`, `host:port`,
 * `*.domain`, `*.domain:port`, an IPv4 literal or a bracketed IPv6 literal,
 * each optionally with a port ({@link EGRESS_DEFAULT_PORT} otherwise).
 * `undefined` for anything else; a policy holding one is refused whole.
 */
export function parseEgressHostRule(text: string): EgressHostRule | undefined {
  if (typeof text !== 'string' || text.length > MAX_EGRESS_HOST_LENGTH + 8)
    return undefined;
  const wildcard = text.startsWith('*.');
  const parts = splitAuthority(wildcard ? text.slice(2) : text);
  if (!parts) return undefined;
  const port =
    parts.port === undefined ? EGRESS_DEFAULT_PORT : parsePort(parts.port);
  const host = normalizeEgressHost(parts.host);
  if (!host || !port || (parts.host.endsWith('.') && wildcard))
    return undefined;
  if (!wildcard) return { kind: 'exact', host, port };
  // A wildcard names DNS subdomains: never of an IP literal or a single label.
  return isIP(host) === 0 && host.includes('.')
    ? { kind: 'subdomains', suffix: host, port }
    : undefined;
}

/** Whether `rule` admits `target`. */
export function egressRuleMatches(
  rule: EgressHostRule,
  target: EgressTarget,
): boolean {
  if (rule.port !== target.port) return false;
  return rule.kind === 'exact'
    ? rule.host === target.host
    : target.host.endsWith(`.${rule.suffix}`) && isIP(target.host) === 0;
}

function ipv4Octets(address: string): number[] {
  return address.split('.').map(Number);
}

function ipv4IsPublic(address: string): boolean {
  const [a = 0, b = 0, c = 0] = ipv4Octets(address);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/**
 * An IPv6 literal (already accepted by `isIP`) as eight 16-bit groups, a
 * trailing dotted IPv4 part folded into the last two; `undefined` when it
 * cannot be expanded.
 */
function ipv6Groups(address: string): number[] | undefined {
  let text = address;
  const v4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const [a = 0, b = 0, c = 0, d = 0] = ipv4Octets(v4[2]!);
    text = `${v4[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  const groups = [
    ...left,
    ...Array<string>(halves.length === 2 ? missing : 0).fill('0'),
    ...right,
  ].map((group) => Number.parseInt(group, 16));
  return groups.length === 8 &&
    groups.every((group) => group >= 0 && group <= 0xffff)
    ? groups
    : undefined;
}

function ipv6IsPublic(address: string): boolean {
  const groups = ipv6Groups(address.toLowerCase());
  if (!groups || groups.some((group) => Number.isNaN(group))) return false;
  const [g0 = 0, g1 = 0] = groups;
  if (groups.every((group) => group === 0)) return false; // ::
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1)
    return false; // ::1
  // An IPv4-mapped address is judged as the IPv4 address it maps.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff)
    return ipv4IsPublic(
      `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`,
    );
  return !(
    (g0 & 0xfe00) === 0xfc00 || // unique local
    (g0 & 0xffc0) === 0xfe80 || // link-local
    (g0 & 0xff00) === 0xff00 || // multicast
    (g0 === 0x2001 && g1 === 0x0db8) // documentation
  );
}

/**
 * Whether `address` (an IP literal) is a public unicast address: not
 * loopback, unspecified, private, unique-local, carrier-grade NAT,
 * link-local (cloud metadata lives there), multicast or reserved.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return ipv4IsPublic(address);
  if (family === 6) return ipv6IsPublic(address);
  return false;
}

/** Whether `address` is a loopback or unspecified address. */
function isLocalAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a] = ipv4Octets(address);
    return a === 127 || a === 0;
  }
  const groups = ipv6Groups(address.toLowerCase());
  if (!groups) return true;
  const mapped =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (mapped) return groups[6]! >> 8 === 127 || groups[6]! >> 8 === 0;
  return (
    groups.slice(0, 7).every((group) => group === 0) &&
    (groups[7] === 0 || groups[7] === 1)
  );
}

/** What a policy decides for a target before any address is known. */
export interface EgressPolicyDecision {
  verdict: 'allowed' | 'denied';
  reason: 'model-endpoint' | 'allowed-host' | 'not-allowed';
  /** For an allowed host: whether the entry that admitted it is an IP literal. */
  literal?: boolean;
}

/**
 * The policy's decision for `target`, in a pinned order: the model
 * endpoint, then any allowed-host entry (a union: one admitting entry is
 * enough), else denied.
 */
export function decideEgress(
  target: EgressTarget,
  policy: {
    allowedHosts: readonly EgressHostRule[];
    modelEndpoint?: EgressTarget | undefined;
  },
): EgressPolicyDecision {
  const model = policy.modelEndpoint;
  if (model && model.host === target.host && model.port === target.port)
    return { verdict: 'allowed', reason: 'model-endpoint' };
  const rule = policy.allowedHosts.find((entry) =>
    egressRuleMatches(entry, target),
  );
  if (!rule) return { verdict: 'denied', reason: 'not-allowed' };
  return {
    verdict: 'allowed',
    reason: 'allowed-host',
    literal: rule.kind === 'exact' && isIP(rule.host) !== 0,
  };
}

/**
 * Whether the addresses a target resolved to may be dialled for `decision`.
 * The model endpoint is what the engine would reach unconfined, so any
 * address is. A host named by an IP literal entry may be private, never
 * loopback or unspecified (Station's own ports listen there). A host named
 * by name must resolve only to public addresses, so a listed name that
 * resolves to loopback or a private network (DNS rebinding) is refused.
 */
export function addressesAdmitted(
  decision: EgressPolicyDecision,
  addresses: readonly string[],
): boolean {
  if (addresses.length === 0) return false;
  if (decision.reason === 'model-endpoint') return true;
  if (decision.literal)
    return addresses.every((address) => !isLocalAddress(address));
  return addresses.every(isPublicAddress);
}

export type EgressLookup = (host: string) => Promise<readonly string[]>;

async function defaultLookup(host: string): Promise<readonly string[]> {
  const results = await dnsLookup(host, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

export interface EgressBrokerOptions {
  allowedHosts: readonly EgressHostRule[];
  /** The engine's model endpoint, when known before the broker starts. */
  modelEndpoint?: EgressTarget;
  /** Called with every record, after it is kept. */
  onDecision?: (record: EgressDecisionRecord) => void;
  /** Resolves a host name; defaults to the system resolver. */
  lookup?: EgressLookup;
  /**
   * Opens the upstream connection to a checked address; defaults to a TCP
   * connect. Tests point it at a local stand-in.
   */
  dial?: (address: string, port: number) => Socket;
  now?: () => Date;
  headerDeadlineMs?: number;
  maxHeaderBytes?: number;
  maxDecisions?: number;
  connectTimeoutMs?: number;
}

export interface EgressBroker {
  /** The loopback port the broker listens on. */
  readonly port: number;
  /** Sets the model endpoint, from the environment the engine is spawned with. */
  setModelEndpoint(endpoint: EgressTarget | undefined): void;
  /** The kept decision records, oldest first. */
  decisions(): readonly EgressDecisionRecord[];
  /** Stops listening and closes every connection. */
  close(): Promise<void>;
}

const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  403: 'Forbidden',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  431: 'Request Header Fields Too Large',
  502: 'Bad Gateway',
  504: 'Gateway Timeout',
};

function refuse(socket: Socket, status: number, body: string): void {
  const text = `${body}\n`;
  // Whatever the client still sends is read and dropped, so the socket can
  // finish closing.
  socket.resume();
  socket.end(
    [
      `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`,
      'Content-Type: text/plain; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(text)}`,
      ...(status === 405 ? ['Allow: CONNECT'] : []),
      'Connection: close',
      '',
      text,
    ].join('\r\n'),
  );
}

/** The host and port of an absolute-form `http://` request target, if any. */
function absoluteFormTarget(target: string): EgressTarget | undefined {
  try {
    const url = new URL(target);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    const host = normalizeEgressHost(url.hostname);
    const port = url.port
      ? Number(url.port)
      : url.protocol === 'https:'
        ? 443
        : 80;
    return host ? { host, port } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Starts a broker on `127.0.0.1`, on a port the system picks. One broker
 * serves one confined session; it is closed when the session stops.
 */
export async function startEgressBroker(
  options: EgressBrokerOptions,
): Promise<EgressBroker> {
  if (options.allowedHosts.length > MAX_EGRESS_ALLOWED_HOSTS)
    throw new Error(
      `An egress policy may list at most ${MAX_EGRESS_ALLOWED_HOSTS} allowed hosts.`,
    );
  const allowedHosts = [...options.allowedHosts];
  let modelEndpoint = options.modelEndpoint;
  const lookup = options.lookup ?? defaultLookup;
  const dial =
    options.dial ??
    ((address: string, port: number) => netConnect({ host: address, port }));
  const now = options.now ?? (() => new Date());
  const headerDeadlineMs =
    options.headerDeadlineMs ?? EGRESS_HEADER_DEADLINE_MS;
  const maxHeaderBytes = options.maxHeaderBytes ?? MAX_EGRESS_HEADER_BYTES;
  const maxDecisions = options.maxDecisions ?? MAX_EGRESS_DECISIONS;
  const connectTimeoutMs =
    options.connectTimeoutMs ?? EGRESS_CONNECT_TIMEOUT_MS;
  const records: EgressDecisionRecord[] = [];
  const open = new Set<Socket>();

  const record = (
    verdict: EgressDecisionRecord['verdict'],
    reason: EgressDecisionReason,
    target?: EgressTarget,
  ): void => {
    const entry: EgressDecisionRecord = {
      at: now().toISOString(),
      verdict,
      reason,
      ...(target ? { host: target.host, port: target.port } : {}),
    };
    records.push(entry);
    if (records.length > maxDecisions)
      records.splice(0, records.length - maxDecisions);
    options.onDecision?.(entry);
  };

  const track = (socket: Socket): void => {
    open.add(socket);
    socket.once('close', () => open.delete(socket));
  };

  const tunnel = async (
    client: Socket,
    target: EgressTarget,
    rest: Buffer,
  ): Promise<void> => {
    const decision = decideEgress(target, { allowedHosts, modelEndpoint });
    if (decision.verdict === 'denied') {
      record('denied', decision.reason, target);
      refuse(
        client,
        403,
        `Station refused a connection to ${target.host}:${target.port}: it is not an allowed host for this confined session.`,
      );
      return;
    }
    let addresses: readonly string[];
    try {
      addresses = isIP(target.host) ? [target.host] : await lookup(target.host);
    } catch {
      addresses = [];
    }
    if (addresses.length === 0) {
      record('denied', 'unresolved', target);
      refuse(client, 403, `Station could not resolve ${target.host}.`);
      return;
    }
    if (!addressesAdmitted(decision, addresses)) {
      record('denied', 'non-public-address', target);
      refuse(
        client,
        403,
        `Station refused a connection to ${target.host}:${target.port}: it resolves to an address that is not public.`,
      );
      return;
    }
    record('allowed', decision.reason, target);
    if (client.destroyed) return;
    // The address that was checked is the one dialled: no second lookup.
    const upstream = dial(addresses[0]!, target.port);
    track(upstream);
    let connected = false;
    const timer = setTimeout(() => {
      upstream.destroy();
      refuse(client, 504, `Station could not reach ${target.host} in time.`);
    }, connectTimeoutMs);
    upstream.once('connect', () => {
      clearTimeout(timer);
      connected = true;
      if (client.destroyed) {
        upstream.destroy();
        return;
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (rest.length > 0) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.once('error', () => {
      clearTimeout(timer);
      if (connected) client.destroy();
      else refuse(client, 502, `Station could not reach ${target.host}.`);
    });
    upstream.once('close', () => {
      if (connected) client.destroy();
    });
    client.once('error', () => upstream.destroy());
    client.once('close', () => {
      clearTimeout(timer);
      upstream.destroy();
    });
  };

  const server = createServer((client) => {
    track(client);
    let buffered = Buffer.alloc(0);
    let settled = false;
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      record('denied', 'header-deadline');
      refuse(client, 408, 'Station closed a request that took too long.');
    }, headerDeadlineMs);
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buffered.length > maxHeaderBytes) {
          settled = true;
          clearTimeout(deadline);
          client.off('data', onData);
          record('denied', 'malformed-request');
          refuse(client, 431, 'Station refused an over-long request header.');
        }
        return;
      }
      settled = true;
      clearTimeout(deadline);
      client.off('data', onData);
      if (end > maxHeaderBytes) {
        record('denied', 'malformed-request');
        refuse(client, 431, 'Station refused an over-long request header.');
        return;
      }
      const header = buffered.subarray(0, end).toString('latin1');
      const rest = buffered.subarray(end + 4);
      const requestLine = header.split('\r\n', 1)[0] ?? '';
      const parts = requestLine.split(' ');
      if (parts.length !== 3 || !/^HTTP\/1\.[01]$/.test(parts[2]!)) {
        record('denied', 'malformed-request');
        refuse(client, 400, 'Station could not read the request.');
        return;
      }
      const [method, requestTarget] = parts as [string, string, string];
      if (method !== 'CONNECT') {
        record(
          'denied',
          'method-not-allowed',
          absoluteFormTarget(requestTarget),
        );
        refuse(
          client,
          405,
          'Station only tunnels CONNECT requests for a confined session.',
        );
        return;
      }
      const target = parseConnectAuthority(requestTarget);
      if (!target) {
        record('denied', 'malformed-request');
        refuse(client, 400, 'Station could not read the requested host.');
        return;
      }
      // Paused until the tunnel is piped (which resumes it) or refused.
      client.pause();
      void tunnel(client, target, rest);
    };
    client.on('data', onData);
    client.on('error', () => client.destroy());
    client.once('close', () => clearTimeout(deadline));
  });
  server.maxConnections = MAX_EGRESS_CONNECTIONS;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('The egress broker did not bind a TCP port.');
  }
  let closed: Promise<void> | undefined;
  return {
    port: address.port,
    setModelEndpoint(endpoint) {
      modelEndpoint = endpoint;
    },
    decisions: () => [...records],
    close() {
      closed ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of open) socket.destroy();
      });
      return closed;
    },
  };
}
