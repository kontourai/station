import type { IncomingMessage } from 'node:http';
import { STATION_NATIVE_SHELL_ORIGINS } from '@kontourai/station-shared/native-shell-origin';
import type { VerifyClientCallbackAsync } from 'ws';
import {
  classifyRuntimePeer,
  type RuntimePeerClass,
} from './runtime-request-security.js';

/**
 * The browser origins Station treats as its own UI: every configured
 * `ALLOWED_ORIGINS` entry (the CLI adds the UI listener's origins and any
 * `--allowed-origin`), the runtime server's own loopback origins, the packaged
 * Tauri shells, and the bound host when it is a specific address.
 *
 * This is the single origin policy for browser callers. The HTTP API's origin
 * gate and the credential-free WebSocket listeners both read it, so a browser
 * page that may not call the API cannot reach a terminal or voice socket
 * either.
 */
export function resolveStationBrowserOrigins(input: {
  port: number;
  host?: string;
  allowedOriginsEnv?: string;
}): string[] {
  const origins = new Set(
    (input.allowedOriginsEnv ?? process.env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  origins.add(`http://localhost:${input.port}`);
  origins.add(`http://127.0.0.1:${input.port}`);
  origins.add(`http://[::1]:${input.port}`);
  for (const origin of STATION_NATIVE_SHELL_ORIGINS) origins.add(origin);
  if (input.host && input.host !== '0.0.0.0' && input.host !== '::') {
    // An IPv6 literal appears bracketed in a browser Origin.
    const authority =
      input.host.includes(':') && !input.host.startsWith('[')
        ? `[${input.host}]`
        : input.host;
    origins.add(`http://${authority}:${input.port}`);
    origins.add(`https://${authority}:${input.port}`);
  }
  return [...origins];
}

export const WEBSOCKET_ORIGIN_FORBIDDEN = {
  status: 403,
  reason: 'origin_forbidden',
} as const;

/**
 * Upgrade-time guard for a WebSocket listener that admits some callers
 * without a credential (loopback peers, or every peer when the listener runs
 * without authentication).
 *
 * Browsers let any page open a cross-origin WebSocket to a loopback port, and
 * a loopback peer is admitted without a credential, so an upgrade that carries
 * an `Origin` header (or `Sec-WebSocket-Origin`, which protocol-version-8
 * clients send) on that path must name one of Station's own UI origins. An
 * upgrade with neither header comes from a non-browser client (the CLI, the
 * native shell's Rust bridge, a local script); that caller is already a local
 * process with the operator's privileges, so it keeps today's loopback
 * admission. Peers that must present a credential are left to the
 * credential handshake: the origin check adds nothing there.
 */
export function createCredentialFreeOriginVerifier(options: {
  allowedOrigins: readonly string[];
  /** True when non-loopback peers must authenticate before admission. */
  credentialRequired: boolean;
  classifyPeer?: (address: string | undefined) => RuntimePeerClass;
  onRejected?: (peerClass: RuntimePeerClass) => void;
}): VerifyClientCallbackAsync<IncomingMessage> {
  const allowed = new Set(options.allowedOrigins);
  return ({ req }, callback) => {
    // `ws` reports only one of these as `info.origin` depending on the
    // client's Sec-WebSocket-Version, so read both headers directly: an
    // upgrade presenting either one is a browser-shaped caller.
    const presented = [
      req.headers.origin,
      req.headers['sec-websocket-origin'],
    ].flatMap((value) => (value === undefined ? [] : [value].flat()));
    if (presented.length === 0) {
      callback(true);
      return;
    }
    const address = req.socket.remoteAddress;
    const peerClass =
      options.classifyPeer?.(address) ?? classifyRuntimePeer(address).peerClass;
    if (options.credentialRequired && peerClass !== 'loopback') {
      callback(true);
      return;
    }
    // Exact, case-sensitive match, as the HTTP API's origin gate does.
    if (presented.every((origin) => allowed.has(origin))) {
      callback(true);
      return;
    }
    options.onRejected?.(peerClass);
    callback(
      false,
      WEBSOCKET_ORIGIN_FORBIDDEN.status,
      WEBSOCKET_ORIGIN_FORBIDDEN.reason,
    );
  };
}
