import type { MobileDeviceHostFailure } from '@kontourai/station-contracts/mobile-device';
import WebSocket from 'ws';

/**
 * Where the device hub (`expo-device-hub`) answers, as the device services
 * consume it (#1970).
 *
 * Every hub call goes through a `DeviceHubAccessConnection`: an allowlisted
 * `request` and an allowlisted `openWebSocket`, never a raw origin. That is
 * the shape of the toolchain lane's `DeviceHubConnection`
 * (`toolchain/device-hub-connection.ts`), so its supervised hub drops in with
 * `deviceHubEndpointFromToolchain`. Two sources exist today:
 *
 * - an explicitly configured, externally owned hub
 *   (`STATION_MOBILE_DEVICE_HUB_URL`, a numeric-loopback origin with a
 *   non-default port) — `explicitDeviceHubEndpoint`;
 * - the toolchain lane's supervised hub — `deviceHubEndpointFromToolchain`.
 *
 * `connect` is asked on EVERY use and never cached by a consumer: a
 * supervised hub restarts on another port, and a stale connection would
 * send input to whatever now listens there.
 */

/** The subset of the toolchain lane's `DeviceHubConnection` Station uses. */
export interface DeviceHubAccessConnection {
  readonly baseUrl: string;
  request(
    method: 'GET' | 'HEAD' | 'POST',
    pathAndSearch: string,
    init?: {
      body?: RequestInit['body'];
      headers?: Record<string, string>;
      signal?: AbortSignal;
    },
  ): Promise<Response>;
  openWebSocket(pathAndSearch: string): WebSocket;
}

export type DeviceHubConnectResult =
  | { ok: true; connection: DeviceHubAccessConnection }
  | { ok: false; failure: MobileDeviceHostFailure };

export interface DeviceHubEndpoint {
  connect(): Promise<DeviceHubConnectResult>;
  /**
   * The hub went away (a supervised child exited). Every device session on it
   * is over: its surfaces are unregistered rather than left streaming nothing.
   * The explicit, externally owned hub never reports this — its absence shows
   * up as a failed request instead.
   */
  onExit(listener: (reason: string) => void): () => void;
}

/** Restrict raw syntax too: URL normalization must not admit numeric IP aliases. */
export function parseMobileDeviceHubOrigin(value: string): string | undefined {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})\/?$/.exec(value);
  if (!match) return undefined;
  const port = Number(match[1]);
  if (port <= 1024 || port > 65535 || port === 3000 || port === 3141)
    return undefined;
  return `http://127.0.0.1:${port}`;
}

export class DeviceHubPathRefused extends Error {
  constructor(readonly path: string) {
    super('That device hub route is not available through Station.');
    this.name = 'DeviceHubPathRefused';
  }
}

/**
 * The routes Station itself calls on an EXPLICITLY configured hub.
 *
 * The groups mirror the managed hub's allowlist
 * (`toolchain/device-hub-connection.ts`: reads, screenshot/stream-tuning
 * POSTs, the three sockets), plus the device lifecycle routes Start, Power
 * off and iOS stream attachment need — which that list also admits (boot as
 * `drive`, shutdown as `operator`, the grid routes as Station-only):
 *
 *   POST /api/devices/boot            (Start)
 *   POST /api/devices/shutdown        (Power off, Android)
 *   POST /vendor/serve-sim/grid/api/start     (attach the iOS helper)
 *   POST /vendor/serve-sim/grid/api/shutdown  (Power off, iOS)
 *
 * Each is called only with a typed JSON body the device services build from
 * a validated target. No shell/exec route is ever admitted.
 */
const READ_PATHS: readonly RegExp[] = [
  /^\/api\/devices$/,
  /^\/vendor\/serve-sim\/api\/screenshot$/,
  /^\/vendor\/serve-sim\/helper\/[A-Za-z0-9._-]{1,128}\/(stream\.mjpeg|stream\.avcc|config|health|ax|foreground)$/,
  /^\/vendor\/serve-emu\/api\/(devices|screenshot|stream-mode|stream-settings|accessibility)$/,
  /^\/vendor\/serve-emu\/health$/,
];
const POST_PATHS: readonly RegExp[] = [
  /^\/vendor\/serve-sim\/api\/screenshot$/,
  /^\/vendor\/serve-emu\/api\/(screenshot|stream-mode|stream-settings)$/,
  // Device lifecycle (see above).
  /^\/api\/devices\/(boot|shutdown)$/,
  /^\/vendor\/serve-sim\/grid\/api\/(start|shutdown)$/,
];
const SOCKET_PATHS: readonly RegExp[] = [
  /^\/api\/devices\/ws$/,
  /^\/vendor\/serve-sim\/helper\/ws$/,
  /^\/vendor\/serve-emu\/ws$/,
];
const FORBIDDEN = /(^|\/)(exec|exec-ws|shell)(\/|$)/i;

function cleanPath(path: string): boolean {
  return (
    path.startsWith('/') &&
    !path.includes('%') &&
    !path.includes('\\') &&
    !path.includes('//') &&
    !path.split('/').some((segment) => segment === '.' || segment === '..') &&
    !FORBIDDEN.test(path)
  );
}

function isExplicitHubRequestAllowed(method: string, path: string): boolean {
  if (!cleanPath(path)) return false;
  const verb = method.toUpperCase();
  if (verb === 'GET' || verb === 'HEAD')
    return READ_PATHS.some((pattern) => pattern.test(path));
  if (verb === 'POST') return POST_PATHS.some((pattern) => pattern.test(path));
  return false;
}

function isExplicitHubSocketAllowed(path: string): boolean {
  return cleanPath(path) && SOCKET_PATHS.some((pattern) => pattern.test(path));
}

function split(pathAndSearch: string): { path: string; search: string } {
  const at = pathAndSearch.indexOf('?');
  return at === -1
    ? { path: pathAndSearch, search: '' }
    : { path: pathAndSearch.slice(0, at), search: pathAndSearch.slice(at) };
}

/** An allowlisted connection to an explicit, externally owned hub. */
export function explicitHubConnection(
  origin: string,
  options: {
    fetch?: typeof fetch;
    openSocket?: (url: string) => WebSocket;
  } = {},
): DeviceHubAccessConnection {
  const doFetch = options.fetch ?? fetch;
  const open =
    options.openSocket ??
    ((url: string) =>
      new WebSocket(url, {
        origin,
        perMessageDeflate: false,
        handshakeTimeout: 5_000,
        followRedirects: false,
        maxPayload: 16 * 1024 * 1024,
      }));
  return {
    baseUrl: origin,
    request(method, pathAndSearch, init = {}) {
      const { path, search } = split(pathAndSearch);
      if (!isExplicitHubRequestAllowed(method, path))
        return Promise.reject(new DeviceHubPathRefused(path));
      return doFetch(`${origin}${path}${search}`, {
        method,
        redirect: 'error',
        credentials: 'omit',
        ...(init.headers ? { headers: init.headers } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
        ...(method === 'POST' && init.body !== undefined
          ? { body: init.body }
          : {}),
      });
    },
    openWebSocket(pathAndSearch) {
      const { path, search } = split(pathAndSearch);
      if (!isExplicitHubSocketAllowed(path))
        throw new DeviceHubPathRefused(path);
      return open(`${origin.replace(/^http:/, 'ws:')}${path}${search}`);
    },
  };
}

export function explicitDeviceHubEndpoint(
  configured: string | undefined,
  options: {
    fetch?: typeof fetch;
    openSocket?: (url: string) => WebSocket;
  } = {},
): DeviceHubEndpoint {
  const origin = configured
    ? parseMobileDeviceHubOrigin(configured)
    : undefined;
  const result: DeviceHubConnectResult = origin
    ? { ok: true, connection: explicitHubConnection(origin, options) }
    : {
        ok: false,
        failure: configured ? 'invalid-configuration' : 'not-configured',
      };
  return {
    connect: async () => result,
    onExit: () => () => {},
  };
}

/**
 * The toolchain lane's supervised hub, structurally: `ensureHub()` answers
 * the running connection (starting it when installed and consented), or
 * undefined. `DeviceToolchainService` satisfies it; the runtime wires
 * `deviceHubEndpointFromToolchain(service, explicitEndpoint)`.
 */
export interface DeviceHubToolchainLike {
  ensureHub(): Promise<
    | (DeviceHubAccessConnection & {
        readonly ready: boolean;
        onExit(listener: (reason: string) => void): () => void;
      })
    | undefined
  >;
}

/**
 * Prefer the supervised hub; fall back to `explicit` when the toolchain
 * answers none (it also answers none when an explicit
 * `STATION_MOBILE_DEVICE_HUB_URL` wins). `onExit` follows whichever
 * supervised connection was last handed out.
 */
export function deviceHubEndpointFromToolchain(
  toolchain: DeviceHubToolchainLike,
  explicit: DeviceHubEndpoint,
): DeviceHubEndpoint {
  const listeners = new Set<(reason: string) => void>();
  let watched: unknown;
  return {
    async connect() {
      let connection: Awaited<ReturnType<DeviceHubToolchainLike['ensureHub']>>;
      try {
        connection = await toolchain.ensureHub();
      } catch {
        return { ok: false, failure: 'hub-unavailable' };
      }
      if (!connection) return explicit.connect();
      if (!connection.ready) return { ok: false, failure: 'hub-unavailable' };
      if (watched !== connection) {
        watched = connection;
        connection.onExit((reason) => {
          for (const listener of [...listeners]) listener(reason);
        });
      }
      return { ok: true, connection };
    },
    onExit(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
