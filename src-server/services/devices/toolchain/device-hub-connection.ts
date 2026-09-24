/**
 * README — the managed device hub, as the rest of Station sees it (#1970).
 *
 * Station runs expo-device-hub as a supervised child bound to 127.0.0.1 on an
 * ephemeral port. That port is internal: it never appears in a route
 * response, a contract, pane state or a URL a client can see. Everything
 * else reaches the hub through ONE of two doors, and both enforce the same
 * allowlists below:
 *
 * 1. Server code: a {@link DeviceHubConnection}, obtained from
 *    `DeviceToolchainService.hubConnection()` (undefined unless the hub is
 *    running) or `ensureHub()` (starts it when installed and consented).
 *    - `request(method, path + search)` forwards an allowlisted HTTP request.
 *    - `openWebSocket(path + search)` opens an allowlisted hub WebSocket
 *      (the iOS helper input socket, the Android SEMU stream/input socket,
 *      the device-list socket). A live-surface producer uses this; the
 *      browser never talks to a hub socket directly.
 *    - `baseUrl` + `headers` exist for `LocalMobileDeviceHost`, which reads
 *      only `/api/devices` and the screenshot routes. New code uses
 *      `request`. A direct request without `headers` gets 403 from the
 *      hub guard.
 *    - `onExit(fn)` fires once when this process instance goes away (crash,
 *      restart for an update, or shutdown). A restarted hub is a NEW
 *      connection with a new `baseUrl`; re-read `hubConnection()`.
 * 2. Clients: the Station proxy at
 *    `/api/mobile-devices/hosts/local/hub/<hub path>` (personal hosts only,
 *    `terminal:operate`; the operator, or an admin/owner of `?projectSlug=`
 *    when the device the path names is shared with that Project, D12). It
 *    forwards allowlisted GETs (and POSTs to the screenshot routes), strips
 *    tickets and credentials, and answers with `Cache-Control: no-store,
 *    no-transform` plus a sandboxing CSP.
 *
 * The hub itself runs under an in-process guard (`device-hub-guard.ts`,
 * `NODE_OPTIONS=--require`, inherited by every node child it spawns,
 * including serve-sim stream helpers): every request and WebSocket upgrade
 * without the per-launch secret header is refused with 403, and the hub's
 * own server admits only the lists below.
 *
 * What is NEVER reachable through either door: the hub dashboard, serve-sim's
 * shell-exec routes (`/vendor/serve-sim/exec`, `/exec-ws`) and its `/api`
 * config (which discloses the exec token), device boot/create/remove, app
 * install, and any path not on the lists below.
 *
 * Lease: a socket opened here is NOT fenced by the live-surface control
 * lease. Agent device control must
 * go through the lease (D8); a producer that forwards input must check the
 * lease epoch itself before each send.
 */
import WebSocket from 'ws';

/** The per-launch secret header the hub guard requires on every request. */
export const HUB_SECRET_HEADER = 'x-station-hub-secret';

/**
 * Who is asking. `client` is the browser-facing proxy; `station` is server
 * code holding a {@link DeviceHubConnection}, which may also attach a stream
 * helper to a simulator (serve-sim's grid start/shutdown). The hub guard
 * (`device-hub-guard.ts`) enforces the `station` lists in-process, so no
 * other path is reachable even by a local process that knows the port.
 */
export type HubAudience = 'client' | 'station';

type DevicePlatform = 'ios' | 'android';

/**
 * Every hub route a CLIENT may reach through the Station proxy, and the
 * authority each needs (D12). A route is device-scoped only when this table
 * says where its device is named — the path, the `device` query parameter
 * (a route that honours it), or the JSON body — and anything with no
 * `device` entry is the operator's alone (fleet listings, health, stream
 * mode). A route not in this table is refused.
 *
 * `purpose` is `drive` for anything with a side effect (capture, boot, the
 * stream-mode read that ensures a stream), `view` for a pure read, and
 * `operator` for a route only the operator may use at all (power off).
 */
export interface HubClientRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  purpose: 'view' | 'drive' | 'operator';
  device?: { platform: DevicePlatform; from: 'path' | 'query' | 'body' };
}

const UDID = '([A-Za-z0-9._-]{1,128})';

const HUB_CLIENT_ROUTES: readonly HubClientRoute[] = [
  // Fleet listings ignore any device parameter: operator only.
  { method: 'GET', pattern: /^\/api\/devices$/, purpose: 'view' },
  {
    method: 'GET',
    pattern: /^\/vendor\/serve-emu\/api\/devices$/,
    purpose: 'view',
  },
  { method: 'GET', pattern: /^\/vendor\/serve-emu\/health$/, purpose: 'view' },
  // Reading stream mode ensures a stream: a side effect, and not scoped.
  {
    method: 'GET',
    pattern: /^\/vendor\/serve-emu\/api\/stream-mode$/,
    purpose: 'drive',
  },
  {
    method: 'GET',
    pattern: /^\/vendor\/serve-emu\/api\/accessibility$/,
    purpose: 'view',
  },
  {
    method: 'GET',
    pattern: new RegExp(
      `^\\/vendor\\/serve-sim\\/helper\\/${UDID}\\/(stream\\.mjpeg|stream\\.avcc|config|health|ax|foreground)$`,
    ),
    purpose: 'view',
    device: { platform: 'ios', from: 'path' },
  },
  // stream-settings refuses a `device` that is not its active emulator.
  {
    method: 'GET',
    pattern: /^\/vendor\/serve-emu\/api\/stream-settings$/,
    purpose: 'view',
    device: { platform: 'android', from: 'query' },
  },
  {
    method: 'POST',
    pattern: /^\/vendor\/serve-sim\/api\/screenshot$/,
    purpose: 'drive',
    device: { platform: 'ios', from: 'query' },
  },
  {
    method: 'POST',
    pattern: /^\/vendor\/serve-emu\/api\/screenshot$/,
    purpose: 'drive',
    device: { platform: 'android', from: 'query' },
  },
  // Boot a shared device: drive. The body names `{platform, id}`.
  {
    method: 'POST',
    pattern: /^\/api\/devices\/boot$/,
    purpose: 'drive',
    device: { platform: 'ios', from: 'body' },
  },
  // Power off: the operator's alone.
  {
    method: 'POST',
    pattern: /^\/api\/devices\/shutdown$/,
    purpose: 'operator',
  },
];

/** Server-only POSTs: attach/detach a simulator's stream helper. */
const HUB_STATION_POST_PATHS: readonly RegExp[] = [
  /^\/vendor\/serve-sim\/grid\/api\/(start|shutdown)$/,
];

/** The readiness probe, server-only. */
const HUB_STATION_GET_PATHS: readonly RegExp[] = [/^\/readyz$/];

const HUB_WEBSOCKET_PATHS: readonly RegExp[] = [
  /^\/api\/devices\/ws$/,
  /^\/vendor\/serve-sim\/helper\/ws$/,
  /^\/vendor\/serve-emu\/ws$/,
];

/** Any shell/exec surface, refused even if a list above were ever widened. */
const HUB_FORBIDDEN = /(^|\/)(exec|exec-ws|shell)(\/|$)/i;

function clientPatterns(method: 'GET' | 'POST'): RegExp[] {
  return HUB_CLIENT_ROUTES.filter((route) => route.method === method).map(
    (route) => route.pattern,
  );
}

/** The lists the in-process guard enforces, as regex sources. */
export function hubGuardAllowlist(): {
  get: string[];
  post: string[];
  websocket: string[];
  forbidden: string;
} {
  return {
    get: [...clientPatterns('GET'), ...HUB_STATION_GET_PATHS].map(
      (re) => re.source,
    ),
    post: [...clientPatterns('POST'), ...HUB_STATION_POST_PATHS].map(
      (re) => re.source,
    ),
    websocket: HUB_WEBSOCKET_PATHS.map((re) => re.source),
    forbidden: HUB_FORBIDDEN.source,
  };
}

/** The client route a request matches, or undefined (refused). */
export function matchHubClientRoute(
  method: string,
  path: string,
): HubClientRoute | undefined {
  if (!isCleanHubPath(path)) return undefined;
  const verb = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  return HUB_CLIENT_ROUTES.find(
    (route) => route.method === verb && route.pattern.test(path),
  );
}

/**
 * Whether a hub request is admitted. `path` is the raw pathname only;
 * encoded separators or dot segments are refused outright.
 */
export function isHubHttpRequestAllowed(
  method: string,
  path: string,
  audience: HubAudience = 'client',
): boolean {
  if (matchHubClientRoute(method, path)) return true;
  if (audience !== 'station' || !isCleanHubPath(path)) return false;
  const verb = method.toUpperCase();
  if (verb === 'GET' || verb === 'HEAD')
    return HUB_STATION_GET_PATHS.some((pattern) => pattern.test(path));
  if (verb === 'POST')
    return HUB_STATION_POST_PATHS.some((pattern) => pattern.test(path));
  return false;
}

export function isHubWebSocketPathAllowed(path: string): boolean {
  return (
    isCleanHubPath(path) &&
    HUB_WEBSOCKET_PATHS.some((pattern) => pattern.test(path))
  );
}

function isCleanHubPath(path: string): boolean {
  return (
    path.startsWith('/') &&
    !path.includes('%') &&
    !path.includes('\\') &&
    !path.includes('//') &&
    !path.split('/').some((segment) => segment === '.' || segment === '..') &&
    !HUB_FORBIDDEN.test(path)
  );
}

/**
 * The device a client route names, from where {@link HUB_CLIENT_ROUTES}
 * says it is named. For a query route the FIRST `device` value is the one
 * authorized, and the proxy forwards only that one. Undefined when the route
 * names no device or the request omits it.
 */
export function hubRouteDevice(
  route: HubClientRoute,
  path: string,
  search: URLSearchParams,
  body?: { platform: DevicePlatform; id: string },
): { platform: DevicePlatform; deviceId: string } | undefined {
  if (!route.device) return undefined;
  if (route.device.from === 'path') {
    const id = route.pattern.exec(path)?.[1];
    return id ? { platform: route.device.platform, deviceId: id } : undefined;
  }
  if (route.device.from === 'query') {
    const id = search.get('device');
    return id ? { platform: route.device.platform, deviceId: id } : undefined;
  }
  return body ? { platform: body.platform, deviceId: body.id } : undefined;
}

/** Query keys that authenticate a caller and must never reach the hub. */
const CREDENTIAL_QUERY_KEYS = [
  'wsTicket',
  'ticket',
  'credential',
  'token',
  'access_token',
  'auth',
  // Station routing, not hub input.
  'projectSlug',
  'hostId',
];

/** The query string forwarded to the hub, with every ticket removed. */
export function hubForwardSearch(search: URLSearchParams): string {
  const forwarded = new URLSearchParams();
  for (const [key, value] of search) {
    if (
      CREDENTIAL_QUERY_KEYS.some(
        (name) => name.toLowerCase() === key.toLowerCase(),
      )
    )
      continue;
    forwarded.append(key, value);
  }
  const text = forwarded.toString();
  return text ? `?${text}` : '';
}

export class DeviceHubPathRefusedError extends Error {
  constructor(readonly path: string) {
    super('That device hub route is not available through Station.');
    this.name = 'DeviceHubPathRefusedError';
  }
}

export interface DeviceHubConnection {
  /** `local`, or the SSH device host whose forwarded hub this is (#1973). */
  readonly hostId: string;
  /** `http://127.0.0.1:<port>`. Server-internal; never send it to a client. */
  readonly baseUrl: string;
  readonly version: string;
  /** False once this process instance has exited. */
  readonly ready: boolean;
  /** Headers every direct request to the hub must carry (the guard secret). */
  readonly headers: Readonly<Record<string, string>>;
  onExit(listener: (reason: string) => void): () => void;
  /** Forward an allowlisted request. Throws {@link DeviceHubPathRefusedError}. */
  request(
    method: 'GET' | 'HEAD' | 'POST',
    pathAndSearch: string,
    init?: {
      body?: RequestInit['body'];
      headers?: Record<string, string>;
      signal?: AbortSignal;
    },
  ): Promise<Response>;
  /** Open an allowlisted hub WebSocket. Throws {@link DeviceHubPathRefusedError}. */
  openWebSocket(pathAndSearch: string): WebSocket;
}

function splitPath(pathAndSearch: string): { path: string; search: string } {
  const at = pathAndSearch.indexOf('?');
  return at === -1
    ? { path: pathAndSearch, search: '' }
    : { path: pathAndSearch.slice(0, at), search: pathAndSearch.slice(at) };
}

/** Built by the supervisor for each running process instance. */
export function createDeviceHubConnection(options: {
  /** Defaults to `local`; an SSH device host passes its own id. */
  hostId?: string;
  port: number;
  version: string;
  /** The per-launch secret the hub guard requires. */
  secret: string;
  fetch?: typeof fetch;
}): DeviceHubConnection & { markExited(reason: string): void } {
  const baseUrl = `http://127.0.0.1:${options.port}`;
  const secretHeader = { [HUB_SECRET_HEADER]: options.secret };
  const doFetch = options.fetch ?? fetch;
  const listeners = new Set<(reason: string) => void>();
  let ready = true;
  return {
    hostId: options.hostId ?? 'local',
    baseUrl,
    version: options.version,
    headers: secretHeader,
    get ready() {
      return ready;
    },
    onExit(listener) {
      if (!ready) {
        queueMicrotask(() => listener('exited'));
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    markExited(reason) {
      if (!ready) return;
      ready = false;
      for (const listener of [...listeners]) {
        try {
          listener(reason);
        } catch {
          // A listener's failure must not stop the others hearing it.
        }
      }
      listeners.clear();
    },
    request(method, pathAndSearch, init = {}) {
      const { path, search } = splitPath(pathAndSearch);
      if (!isHubHttpRequestAllowed(method, path, 'station'))
        return Promise.reject(new DeviceHubPathRefusedError(path));
      return doFetch(
        `${baseUrl}${path}${hubForwardSearch(new URLSearchParams(search))}`,
        {
          method,
          redirect: 'error',
          credentials: 'omit',
          headers: { ...init.headers, ...secretHeader },
          ...(init.signal ? { signal: init.signal } : {}),
          ...(method === 'POST' && init.body !== undefined
            ? { body: init.body, duplex: 'half' }
            : {}),
        } as RequestInit,
      );
    },
    openWebSocket(pathAndSearch) {
      const { path, search } = splitPath(pathAndSearch);
      if (!isHubWebSocketPathAllowed(path))
        throw new DeviceHubPathRefusedError(path);
      return new WebSocket(
        `ws://127.0.0.1:${options.port}${path}${hubForwardSearch(new URLSearchParams(search))}`,
        {
          origin: baseUrl,
          headers: secretHeader,
          handshakeTimeout: 10_000,
          followRedirects: false,
        },
      );
    },
  };
}
