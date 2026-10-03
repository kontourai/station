import {
  CLIENT_PROTOCOL_HEADER,
  STATION_COMPAT_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';

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
 * - to the page's own origin, the host that served it.
 * A cross-origin browser request stays unlabelled, and a host reads it as
 * the legacy protocol until hosts advertise that they accept the header.
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
    return new URL(url, page.href).origin === page.origin;
  } catch {
    return false;
  }
}
