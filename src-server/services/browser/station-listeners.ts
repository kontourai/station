/**
 * The host Chromium must never reach a Station listener on this host
 * (#90 amendment "Station-listener deny").
 *
 * Station grants locality to loopback callers (`isSameMachineBrowserCaller`
 * in `runtime-routes.ts`). The server-side Chromium runs ON the Station host,
 * so any page it loads — including a hostile internet page — could fetch,
 * open a WebSocket to, or navigate to a Station listener and present as a
 * same-machine browser.
 *
 * The rule is decided on the RESOLVED destination, below the page: a
 * connection is refused when its resolved address belongs to this host
 * (loopback, the unspecified address, or any local interface address —
 * LAN, tailnet) AND its port is one of Station's listener ports. That covers
 * every hostname spelling, `*.localhost`, DNS rebinding and a Station bound
 * to 0.0.0.0, while leaving the user's other loopback dev servers reachable.
 * `browser-egress-proxy.ts` enforces it for every connection the browser
 * makes (HTTP, HTTPS, WebSocket, workers, service workers).
 *
 * Station listener ports: the server, terminal (+1), voice (+2) and consent
 * (+3 or `STATION_CONSENT_PORT`) listeners; the port of every configured
 * Station origin (the UI proxy listener and any tailnet/`tailscale serve`
 * origin, from `ALLOWED_ORIGINS`); and the same block for every other running
 * instance this Station home's instance registry lists.
 */
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

export interface StationListeners {
  /** Station listener ports (refused on any address of this host). */
  readonly ports: readonly number[];
  /** Hostnames of configured Station origins (for the URL-level layer). */
  readonly hostnames: readonly string[];
}

export interface StationInstancePorts {
  port: number;
  uiPort?: number;
  consentPort?: number;
}

export interface StationListenerInputs {
  /** The Station HTTP server port. */
  serverPort: number;
  /** The consent listener port (`STATION_CONSENT_PORT`, default port + 3). */
  consentPort?: number;
  /**
   * Every origin Station treats as its own (the resolved allowed-origin list:
   * `ALLOWED_ORIGINS`, which carries the UI proxy and any tailnet origin,
   * plus the server's own loopback origins).
   */
  configuredOrigins: readonly string[];
  /** Other Station instances registered in this home. */
  otherInstances?: readonly StationInstancePorts[];
}

function isPort(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65_535
  );
}

function effectivePort(url: URL): number | undefined {
  if (url.port !== '') return Number(url.port);
  if (url.protocol === 'http:' || url.protocol === 'ws:') return 80;
  if (url.protocol === 'https:' || url.protocol === 'wss:') return 443;
  return undefined;
}

function normalizeAddress(address: string): string {
  let value = address.toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) is the IPv4 address.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  return mapped?.[1] ?? value;
}

/** Addresses of this host's interfaces (LAN, tailnet, ...), normalized. */
export function localInterfaceAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? [])
      out.push(normalizeAddress(entry.address));
  }
  return out;
}

/**
 * Whether an IP literal reaches THIS host: loopback, the unspecified address
 * (which connects locally), or one of the given interface addresses.
 */
export function isLocalAddress(
  address: string,
  interfaceAddresses: readonly string[],
): boolean {
  const value = normalizeAddress(address);
  if (value === '0.0.0.0' || value === '::' || value === '::1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) return true;
  return interfaceAddresses.includes(value);
}

/** Loopback spellings Chromium connects to this machine without DNS. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = normalizeAddress(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return isIP(host) !== 0 && isLocalAddress(host, []);
}

function addInstance(ports: Set<number>, instance: StationInstancePorts): void {
  const add = (port: unknown) => {
    if (isPort(port)) ports.add(port);
  };
  if (isPort(instance.port)) {
    add(instance.port);
    add(instance.port + 1);
    add(instance.port + 2);
    add(instance.consentPort ?? instance.port + 3);
  }
  add(instance.uiPort);
}

export function deriveStationListeners(
  input: StationListenerInputs,
): StationListeners {
  if (!isPort(input.serverPort)) {
    throw new Error(
      `Station listener derivation needs the server port; got ${String(input.serverPort)}.`,
    );
  }
  const ports = new Set<number>();
  const hostnames = new Set<string>();
  addInstance(ports, {
    port: input.serverPort,
    consentPort: input.consentPort,
  });
  for (const origin of input.configuredOrigins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    const port = effectivePort(url);
    if (port !== undefined) ports.add(port);
    if (!isLoopbackHostname(url.hostname))
      hostnames.add(url.hostname.toLowerCase());
  }
  for (const instance of input.otherInstances ?? [])
    addInstance(ports, instance);
  return {
    ports: [...ports].sort((a, b) => a - b),
    hostnames: [...hostnames].sort(),
  };
}

/** The enforcement rule on a resolved destination. */
export function isStationListenerDestination(
  address: string,
  port: number,
  listeners: StationListeners,
  interfaceAddresses: readonly string[],
): boolean {
  return (
    listeners.ports.includes(port) &&
    isLocalAddress(address, interfaceAddresses)
  );
}

/**
 * URL-level approximation for the CDP Fetch defence-in-depth layer, which
 * cannot see resolved addresses: a Station port on a loopback spelling, a
 * local IP literal, or a configured Station origin's hostname.
 */
export function isStationSelfUrl(
  rawUrl: string,
  listeners: StationListeners,
  interfaceAddresses: readonly string[] = [],
): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const port = effectivePort(url);
  if (port === undefined || !listeners.ports.includes(port)) return false;
  const host = normalizeAddress(url.hostname);
  if (isLoopbackHostname(host)) return true;
  if (isIP(host) !== 0) return isLocalAddress(host, interfaceAddresses);
  return listeners.hostnames.includes(host);
}

/**
 * Coarse CDP Fetch URL globs; {@link isStationSelfUrl} makes the exact call
 * and continues anything that is not Station. A default port never appears
 * in a canonical URL, so those need host-specific patterns.
 */
export function stationSelfFetchPatterns(
  listeners: StationListeners,
): string[] {
  const patterns = listeners.ports
    .filter((port) => port !== 80 && port !== 443)
    .map((port) => `*:${port}/*`);
  if (listeners.ports.includes(80) || listeners.ports.includes(443)) {
    for (const host of ['localhost', '127.0.0.1', '[::1]'])
      patterns.push(`*://${host}/*`);
    for (const hostname of listeners.hostnames)
      patterns.push(`*://${hostname}/*`);
  }
  return patterns;
}
