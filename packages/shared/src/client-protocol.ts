import {
  CLIENT_PROTOCOL_HEADER,
  CLIENT_PROTOCOL_HEADER_CAPABILITY,
  STATION_COMPAT_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';

/**
 * Origins whose handshake advertised {@link CLIENT_PROTOCOL_HEADER_CAPABILITY}.
 * Process-local on purpose: a host can be downgraded, so the observation is
 * never persisted, and a fresh page load observes the handshake again.
 */
const hostsAllowingClientProtocol = new Set<string>();
const handshakeGenerations = new Map<string, symbol>();

function originOf(url: string | URL): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Record what the host at `url` said about the header in its handshake
 * `compatibility` block (or forget it, when it no longer says so). Call it
 * wherever a client reads a handshake, before it sends credentialed requests.
 */
export function observeClientProtocolSupport(
  url: string | URL,
  compatibility: unknown,
): void {
  const origin = originOf(url);
  if (!origin) return;
  const capabilities =
    compatibility && typeof compatibility === 'object'
      ? (compatibility as { capabilities?: unknown }).capabilities
      : undefined;
  const advertised =
    capabilities && typeof capabilities === 'object'
      ? (capabilities as Record<string, unknown>)[
          CLIENT_PROTOCOL_HEADER_CAPABILITY
        ]
      : undefined;
  if (typeof advertised === 'number' && advertised >= 1) {
    hostsAllowingClientProtocol.add(origin);
  } else {
    hostsAllowingClientProtocol.delete(origin);
  }
}

/** Only the latest-started handshake at an origin may restore acceptance. */
export function beginClientProtocolObservation(
  url: string | URL,
): (compatibility: unknown) => void {
  const origin = originOf(url);
  const generation = Symbol();
  if (origin) handshakeGenerations.set(origin, generation);
  observeClientProtocolSupport(url, undefined);
  return (compatibility) => {
    if (origin && handshakeGenerations.get(origin) === generation) {
      observeClientProtocolSupport(url, compatibility);
    }
  };
}

/** Test seam: forget every observed host. */
export function resetClientProtocolObservations(): void {
  hostsAllowingClientProtocol.clear();
  handshakeGenerations.clear();
}

/**
 * The client API protocol header this build sends to a Station at `url`, or
 * an empty record when sending it could cost the request.
 *
 * A browser preflights a cross-origin request carrying a custom header, and
 * every host released before #2962 leaves this header off its CORS
 * allow-list. Sending it cross-origin would leave a current client unable to
 * reach an older host it is otherwise compatible with. It is therefore sent
 * only where no preflight can refuse it:
 * - outside a browser page (the CLI, MCP servers and other Node callers);
 * - through a host-owned transport (`viaTransport`), which is not subject to
 *   CORS and whose header allow-list ships in the same build as this code;
 * - to the page's own origin, the host that served it;
 * - to a host whose handshake advertised
 *   {@link CLIENT_PROTOCOL_HEADER_CAPABILITY}, i.e. one that allow-lists it.
 * A cross-origin browser request to any other host stays unlabelled, and a
 * host reads it as the legacy protocol.
 */
export function clientProtocolHeaders(
  url: string | URL,
  viaTransport = false,
): Record<string, string> {
  return canCarryClientProtocol(url, viaTransport)
    ? { [CLIENT_PROTOCOL_HEADER]: String(STATION_COMPAT_PROTOCOL_VERSION) }
    : {};
}

function canCarryClientProtocol(
  url: string | URL,
  viaTransport: boolean,
): boolean {
  if (viaTransport) return true;
  const page = (
    globalThis as { location?: { origin?: unknown; href?: unknown } }
  ).location;
  if (typeof page?.href !== 'string') return true;
  try {
    const target = new URL(url, page.href).origin;
    return target === page.origin || hostsAllowingClientProtocol.has(target);
  } catch {
    return false;
  }
}
