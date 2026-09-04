import { execFileSync, execSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createConnection, isIP } from 'node:net';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import {
  canonicalTenantAuthority,
  type HostedTenantRegistry,
  parseHostedTenantRegistry,
} from '@kontourai/station-contracts/tenancy';
import { resolveGitInfo } from '@kontourai/station-shared/git';
import {
  claimInstanceEntry,
  findRunning as findRunningHomeInstances,
  readInstanceRegistry,
  reconcileStaleInstance,
  removeOwnedInstance,
  resolveInstanceRegistryPath,
} from '@kontourai/station-shared/instance-registry';
import {
  acquireFileMutationLock,
  appendLifecycleEvent,
  type StopIntent,
} from '@kontourai/station-shared/lifecycle-events';
import {
  birthProvesReuse,
  lookupProcessBirthFingerprint,
} from '@kontourai/station-shared/process-identity';
import { spawnedStationRoot } from '@kontourai/station-shared/runtime-path-resolver';
import {
  type StoreIntegrityReport,
  type StoreIntegrityResult,
  stationHomeStorePaths,
  storeIntegrityExitCode,
  verifySqliteStore,
} from '@kontourai/station-shared/sqlite-store-integrity';
import {
  createStationHomeBackup,
  restoreStationHomeBackup,
  type StationHomeBackupResult,
  type StationHomeRestoreResult,
} from '@kontourai/station-shared/station-home-archive';
import { inspectStationHomeRecovery } from '@kontourai/station-shared/station-home-recovery-preflight';
import {
  ensureStationHomeSchemaSync,
  stationHomeSchemaNeedsReset,
} from '@kontourai/station-shared/station-home-schema';
import {
  publishActiveLocalStation,
  removeOwnedActiveLocalStation,
} from './active-local-station.js';
import {
  CWD,
  DEFAULT_INSTANCE_ID,
  DEFAULT_PROJECT_HOME,
  DEFAULT_SERVER_PORT,
  DEFAULT_UI_PORT,
  getInstanceStatePath,
  INSTANCE_STATE_DIR,
  type LifecycleHomeSource,
  normalizeHomePath,
  normalizeInstanceName,
  PIDFILE,
  resolveLifecycleHomeTarget,
  resolveLifecycleInstanceId,
} from './helpers.js';
import {
  captureStableProcessFingerprint,
  createAppShortcut,
  createPathLink,
  fingerprintMatchesRecorded,
  inspectProcessFingerprint,
  killProcessTree,
  type ProcessFingerprint,
  promptYN,
  sleepSync,
} from './platform.js';
import {
  renderServiceInstallRemedy,
  renderServiceStatusCommand,
} from './service-remedy.js';
import { inspectServiceSchedulingPolicy } from './service-scheduling.js';

const SERVER_ENTRY_FILENAME = 'command-station.js';

/** MIME map for the static UI server. */
export const UI_MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

/**
 * Bare top-level backend mounts the UI-server proxy forwards to when a
 * request has no matching static asset. Mirrors the non-`/api` mounts in
 * `src-server/runtime/routes/runtime-routes.ts` (`/agents`, `/acp`, `/events`,
 * `/integrations`, `/config`, `/bedrock`, `/monitoring`, `/scheduler`,
 * `/notifications`) plus bare framework routes registered directly on the
 * same Hono app by `@voltagent/server-core`/`@voltagent/server-hono` that are
 * not declared in `runtime-routes.ts` at all: `/tools` and `/observability`
 * (confirmed via their framework route registrations in
 * `node_modules/@voltagent/server-core/dist/index.js`, wired
 * unconditionally by `honoServer`'s `createApp` — no current `src-ui` call
 * site hits it yet, but it is a live mount today, not hypothetical). `/api`
 * covers every `/api/*` mount as one prefix. This list is empirically
 * derived, not a static enumeration of `runtime-routes.ts` alone — re-check
 * both `runtime-routes.ts` and the VoltAgent server packages' own route
 * wiring before assuming it is exhaustive.
 */
export const UI_PROXY_BACKEND_PREFIXES: string[] = [
  '/.well-known',
  '/api',
  '/agents',
  '/acp',
  '/events',
  '/integrations',
  '/config',
  '/bedrock',
  '/monitoring',
  '/scheduler',
  '/notifications',
  '/tools',
  '/observability',
];

/**
 * Backend-owned HTML documents that must not be replaced by the SPA fallback.
 * Keep this list narrow: ordinary Station routes remain client-side deep links.
 *
 * station#3677 RETIRED the only entry (`/api/plugins/host-approvals`): the
 * host-approval review page moved off the main origin onto the dedicated
 * consent listener (its own port — a URL that never traverses this proxy),
 * and the old same-origin review/approve routes were removed rather than
 * left as a fallback. The plumbing stays so the next backend-owned document
 * has a declared seam instead of an ad-hoc bypass.
 */
export const UI_PROXY_BACKEND_NAVIGATION_PREFIXES: string[] = [];

interface UiServerDeps {
  http: typeof import('node:http');
  crypto: typeof import('node:crypto');
  fs: typeof import('node:fs');
  path: typeof import('node:path');
  dir: string;
  mime: Record<string, string>;
  inject: string;
  /** Port of the sibling server process; the proxy forwards here. */
  upstreamPort: number;
  /** Bare backend prefixes to proxy instead of 404ing (see {@link UI_PROXY_BACKEND_PREFIXES}). */
  backendPrefixes: string[];
  /** Backend-owned HTML paths that bypass the navigation SPA fallback. */
  backendNavigationPrefixes?: string[];
  readinessFile?: string;
  identity?: { instanceId: string; sha: string; bootId: string };
  internalApiToken?: string;
  trustedTailscaleServeOrigin?: string;
  /** Plain validated projection: no parser or live registry crosses serialization. */
  hostedTenantAuthorities?: Record<string, string>;
}

/**
 * Request handler for the static UI server. Serves built assets, injects the
 * API base into index.html (only when an explicit override was configured —
 * see `buildUiServerScript`), reverse-proxies backend calls to the sibling
 * server process (HTTP + SSE, unbuffered), and applies a *navigation-only*
 * SPA fallback.
 *
 * For any request with no matching static file: (a) a non-GET/HEAD method is
 * always proxied (the UI server never originates a non-idempotent response);
 * (b) a GET/HEAD whose `Accept` header (default the wildcard "any content
 * type" media range when absent — matches curl's and `fetch()`'s real
 * defaults) does not prefer `text/html` is a
 * same-origin backend call (`fetch('/api/...')`, an SSE `EventSource`, etc.)
 * — proxied only if it matches the backend-prefix allowlist, otherwise a
 * genuinely missing asset (e.g. a stale `.png`) 404s without an upstream
 * round-trip; (c) otherwise (`Accept` prefers `text/html`, i.e. a real
 * browser navigation/hard-refresh/deep-link, including to `/`, `/agents`,
 * `/settings`, etc.) falls back to `index.html` — this is what lets a client
 * route collide with a same-named bare backend prefix (`/agents` is both)
 * without either one shadowing the other.
 *
 * Defined as a standalone function so the same logic powers both the spawned
 * `node -e` UI process (via `Function.prototype.toString` serialization) and
 * the unit test — no drift between the two.
 */
export function uiRequestHandler(deps: UiServerDeps) {
  const {
    http,
    crypto,
    fs,
    path,
    dir,
    mime,
    inject,
    upstreamPort,
    backendPrefixes,
    backendNavigationPrefixes = [],
    readinessFile,
    identity,
    internalApiToken,
    trustedTailscaleServeOrigin,
    hostedTenantAuthorities,
  } = deps;
  const canonicalRoot = fs.realpathSync(dir);
  const containedAsset = (rawUrl: string) => {
    const rawPath = rawUrl.split('?')[0].split('#')[0];
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      return { rejected: true as const };
    }
    if (decoded.includes('\0') || decoded.includes('\\')) {
      return { rejected: true as const };
    }
    const segments = decoded.split('/');
    if (segments.some((segment) => segment === '.' || segment === '..')) {
      return { rejected: true as const };
    }
    const candidate = path.resolve(canonicalRoot, decoded.replace(/^\/+/, ''));
    const relation = path.relative(canonicalRoot, candidate);
    if (
      relation === '..' ||
      relation.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relation)
    ) {
      return { rejected: true as const };
    }
    if (fs.existsSync(candidate)) {
      const real = fs.realpathSync(candidate);
      const realRelation = path.relative(canonicalRoot, real);
      if (
        realRelation === '..' ||
        realRelation.startsWith(`..${path.sep}`) ||
        path.isAbsolute(realRelation)
      ) {
        return { rejected: true as const };
      }
      return { rejected: false as const, candidate: real };
    }
    return { rejected: false as const, candidate };
  };

  // Declared *inside* this function (not at module scope) so they are
  // carried along by `uiRequestHandler.toString()`'s serialization into the
  // spawned standalone `node -e` process (see `buildUiServerScript`) — a
  // module-scope `const` referenced by this closure would otherwise be
  // undefined there and crash the UI server on the first proxied request,
  // the same failure class as the `__name` bug this file already works
  // around (verified empirically: a module-scope declaration here does NOT
  // survive re-serialization the way a same-function local does).
  //
  // Hop-by-hop headers (RFC 7230 §6.1) that must not be forwarded verbatim
  // to the upstream — they describe *this* client-proxy hop, not the
  // proxy-upstream one, and forwarding `Connection`/`Transfer-Encoding` in
  // particular can desync framing between the two independent connections.
  const HOP_BY_HOP_HEADERS = [
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ];
  const INTERNAL_TOKEN_HEADER = 'x-station-internal-token';
  const INTERNAL_CALLER_HEADER = 'x-station-proxy-caller';
  const INTERNAL_INGRESS_IDENTITY_HEADER = 'x-station-ingress-identity';
  const INTERNAL_PROXY_PEER_HEADER = 'x-station-proxy-peer';
  // station#3752: the browser-visible Host, preserved across the rewrite
  // below. A URL this backend mints FOR THE BROWSER (the consent review URL)
  // must name the host the browser is talking to, or the cookie that
  // authorizes it — scoped by host, not origin — is never sent.
  const INTERNAL_PROXY_FORWARDED_HOST_HEADER = 'x-station-proxy-forwarded-host';
  const INTERNAL_TENANT_HEADER = 'x-station-internal-tenant';
  const TAILSCALE_HEADERS_INFO_URL = 'https://tailscale.com/s/serve-headers';
  const isLoopbackAddress = (value: string | undefined) => {
    const normalized = (value ?? '').trim().toLowerCase();
    return (
      normalized === '::1' ||
      normalized === '0:0:0:0:0:0:0:1' ||
      normalized.startsWith('127.') ||
      normalized.startsWith('::ffff:127.')
    );
  };
  const canonicalHostedAuthority = (value: string) => {
    if (
      !value ||
      value !== value.trim() ||
      value.length > 320 ||
      /[/?#@[\]\\,\s*]/.test(value) ||
      value.includes('://')
    )
      return undefined;
    const colon = value.indexOf(':');
    if (colon !== value.lastIndexOf(':')) return undefined;
    const host = (colon < 0 ? value : value.slice(0, colon)).toLowerCase();
    const port = colon < 0 ? undefined : value.slice(colon + 1);
    const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
    if (
      !host ||
      host.length > 253 ||
      host.endsWith('.') ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
      !host.split('.').every((part) => label.test(part))
    )
      return undefined;
    if (
      port !== undefined &&
      !/^(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/.test(
        port,
      )
    )
      return undefined;
    return port === undefined ? host : `${host}:${port}`;
  };
  const resolvedHostedTenant = (req: import('node:http').IncomingMessage) => {
    if (!hostedTenantAuthorities) return { enabled: false as const };
    const hosts: string[] = [];
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      if (req.rawHeaders[index]?.toLowerCase() === 'host') {
        hosts.push(req.rawHeaders[index + 1] ?? '');
      }
    }
    if (hosts.length !== 1)
      return {
        enabled: true as const,
        error: 'tenant_authority_invalid' as const,
      };
    const authority = canonicalHostedAuthority(hosts[0]!);
    if (!authority)
      return {
        enabled: true as const,
        error: 'tenant_authority_invalid' as const,
      };
    const tenantId = Object.hasOwn(hostedTenantAuthorities, authority)
      ? hostedTenantAuthorities[authority]
      : undefined;
    return typeof tenantId === 'string' && tenantId.length > 0
      ? { enabled: true as const, tenantId }
      : { enabled: true as const, error: 'tenant_authority_unknown' as const };
  };
  const trustedTailscaleIdentity = (
    req: import('node:http').IncomingMessage,
  ) => {
    if (
      !trustedTailscaleServeOrigin ||
      !isLoopbackAddress(req.socket.remoteAddress)
    ) {
      return undefined;
    }
    let trustedOrigin: URL;
    let requestAuthority: URL;
    try {
      trustedOrigin = new URL(trustedTailscaleServeOrigin);
      requestAuthority = new URL(`https://${req.headers.host ?? ''}`);
    } catch {
      return undefined;
    }
    if (
      trustedOrigin.protocol !== 'https:' ||
      trustedOrigin.username ||
      trustedOrigin.password ||
      trustedOrigin.pathname !== '/' ||
      trustedOrigin.search ||
      trustedOrigin.hash ||
      requestAuthority.host !== trustedOrigin.host
    ) {
      return undefined;
    }
    if (req.headers['tailscale-funnel-request'] !== undefined) {
      return { rejected: true as const };
    }
    if (req.headers['tailscale-headers-info'] !== TAILSCALE_HEADERS_INFO_URL) {
      return undefined;
    }
    const login = req.headers['tailscale-user-login'];
    const displayName = req.headers['tailscale-user-name'];
    const safeText = (value: unknown, maxLength: number) =>
      typeof value === 'string' &&
      value === value.trim() &&
      value.length > 0 &&
      value.length <= maxLength &&
      !Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
      });
    if (!safeText(login, 254)) return undefined;
    if (displayName !== undefined && !safeText(displayName, 128)) {
      return undefined;
    }
    return {
      rejected: false as const,
      identity: {
        provider: 'tailscale-serve' as const,
        login,
        ...(typeof displayName === 'string' ? { displayName } : {}),
      },
    };
  };

  // A wedged/unresponsive upstream would otherwise hang the client-facing
  // request indefinitely; surface a 504 instead once this much idle time
  // has elapsed on the upstream socket. This must apply ONLY to the
  // connection/response-header phase, not for the lifetime of a streaming
  // response: it is numerically equal to SSE_KEEPALIVE_INTERVAL_MS
  // (src-server/constants.ts) — the only source of socket activity an idle
  // SSE stream has — and an idle-socket timeout resets on activity in
  // *either* direction, so once headers arrive the timeout is deterministically
  // racing the backend's own heartbeat and wins every time (verified
  // empirically in code-review iteration 2's NEW HIGH: the timeout fires a
  // few ms before the first heartbeat can reset it). See the
  // `Content-Type`-based `proxyReq.setTimeout(0)` below, which disables the
  // timeout once a streaming SSE response is confirmed, while still
  // protecting non-SSE responses that hang mid-body.
  const PROXY_UPSTREAM_TIMEOUT_MS = 30_000;
  const securityHeaders = (nonce: string) => ({
    'Content-Security-Policy': [
      "default-src 'none'",
      `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
      // Fonts are self-hosted (#2648) — no external font origins.
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self' http: https: ws: wss:",
      "frame-src 'self' blob: http: https:",
      "worker-src 'self' blob:",
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });

  // Deliberately a `const` arrow (not a `function` declaration) — NOT
  // because that avoids esbuild/tsx's dev-mode `__name(...)` helper
  // injection (it doesn't: `keepNames`, which tsx hard-codes on, wraps a
  // `const`-bound arrow function exactly the same way it wraps a `function`
  // declaration, confirmed by inspecting the real
  // `uiRequestHandler.toString()` output). The actual protection is the
  // `globalThis.__name = globalThis.__name || ((fn) => fn)` shim installed
  // in `buildUiServerScript`, ahead of this handler's serialized source, in
  // the spawned standalone `node -e` process (see `buildUiServerScript`)
  // where esbuild's own `__name` runtime helper does not exist. Do not
  // remove that shim under the assumption that avoiding named bindings here
  // is sufficient on its own — it is not.
  const proxyToBackend = (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    tenantId?: string,
  ) => {
    if (!internalApiToken) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready: false, status: 'unavailable' }));
      return;
    }
    const tailscaleIngress = trustedTailscaleIdentity(req);
    if (tailscaleIngress?.rejected) {
      res.writeHead(403, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(
        JSON.stringify({ error: { code: 'tailscale_funnel_forbidden' } }),
      );
      return;
    }
    const ingressIdentity = tailscaleIngress?.identity;
    const browserVisibleHost = req.headers.host;
    const headers: Record<string, string | string[] | undefined> = {
      ...req.headers,
      host: `127.0.0.1:${upstreamPort}`,
    };
    for (const name of HOP_BY_HOP_HEADERS) {
      delete headers[name];
    }
    // Never relay caller-supplied Station attestation. This proxy is the only
    // component allowed to classify its directly connected client.
    delete headers[INTERNAL_TOKEN_HEADER];
    delete headers[INTERNAL_CALLER_HEADER];
    delete headers[INTERNAL_INGRESS_IDENTITY_HEADER];
    delete headers[INTERNAL_PROXY_PEER_HEADER];
    delete headers[INTERNAL_PROXY_FORWARDED_HOST_HEADER];
    delete headers[INTERNAL_TENANT_HEADER];
    for (const name of Object.keys(headers)) {
      if (name.startsWith('tailscale-')) delete headers[name];
    }
    headers[INTERNAL_TOKEN_HEADER] = internalApiToken;
    // The UI listener proxies ordinary browser traffic, never an internal
    // caller. Its client socket and Host describe network shape, not
    // authority: SSH -L can make a remote client satisfy both predicates.
    // Preserve an explicit remote marker so the backend treats every browser
    // proxy hop as requiring its own device-session or bearer credential.
    // Only a genuine direct internal consumer that already possesses the
    // per-boot token may present the separate `local` attestation.
    headers[INTERNAL_CALLER_HEADER] = 'remote';
    if (tenantId) headers[INTERNAL_TENANT_HEADER] = tenantId;
    // station#1490: the upstream cannot see this proxy's client, and pairing
    // approval turns on where that client was. The proxy caller marker is
    // deliberately always `remote`, so report the raw address and let the
    // upstream's own off-box predicate judge it.
    if (req.socket.remoteAddress) {
      headers[INTERNAL_PROXY_PEER_HEADER] = req.socket.remoteAddress;
    }
    // Set only after the client-supplied copy was deleted above, so this is
    // always this proxy's own observation of its client's Host.
    if (browserVisibleHost) {
      headers[INTERNAL_PROXY_FORWARDED_HOST_HEADER] = browserVisibleHost;
    }
    if (ingressIdentity) {
      headers[INTERNAL_INGRESS_IDENTITY_HEADER] = Buffer.from(
        JSON.stringify(ingressIdentity),
      ).toString('base64url');
    }
    let timedOut = false;
    const proxyReq = http.request(
      {
        host: '127.0.0.1',
        port: upstreamPort,
        path: req.url,
        method: req.method,
        headers,
        timeout: PROXY_UPSTREAM_TIMEOUT_MS,
      },
      (proxyRes) => {
        // The idle timeout above exists to bound the connection/header
        // phase against a wedged upstream — it must not keep running once a
        // genuine streaming response is underway, or it will always lose
        // the race against a periodic heartbeat exactly as long as itself
        // (see the comment on PROXY_UPSTREAM_TIMEOUT_MS above). Disable it
        // now, the moment headers confirm this is an SSE stream; a non-SSE
        // response that hangs mid-body still keeps the timeout's
        // protection, since SSE is the only response shape here designed to
        // idle for tens of seconds at a time.
        const contentType = proxyRes.headers['content-type'];
        if (
          typeof contentType === 'string' &&
          contentType.startsWith('text/event-stream')
        ) {
          proxyReq.setTimeout(0);
        }
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        // Pipe without buffering so SSE chunks stream through as they
        // arrive instead of waiting for the upstream stream to end.
        proxyRes.pipe(res);
        // An upstream error arriving *after* headers are already flushed
        // (mid-stream, e.g. the backend process dies mid-SSE) can't be
        // turned into a fresh status code — just tear the client-facing
        // response down instead of leaving it hanging open.
        proxyRes.on('error', () => {
          if (!res.writableEnded) res.destroy();
        });
      },
    );
    proxyReq.on('timeout', () => {
      timedOut = true;
      proxyReq.destroy(new Error('Upstream request timed out'));
    });
    proxyReq.on('error', () => {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      if (timedOut) {
        res.writeHead(504, { 'Content-Type': 'text/plain' });
        res.end('Gateway Timeout');
        return;
      }
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready: false, status: 'unavailable' }));
    });
    // Propagate a client-initiated disconnect upstream. `stream.pipe()`
    // only forwards data one direction — it never tears down the *source*
    // when the destination closes without erroring, so without this, every
    // routine client disconnect (tab close, navigation, an SSE
    // `EventSource`'s own periodic reconnect cycle — all normal on every
    // one of this proxy's SSE endpoints: `/events`, `/scheduler/events`,
    // `/monitoring/events`, `/api/orchestration/events`) leaves the
    // upstream connection (and whatever backend work/timers it's driving)
    // open indefinitely.
    //
    // Deliberately `res.on('close', ...)` ONLY — not `req.on('close'/
    // 'aborted', ...)`. Verified empirically (a standalone repro, not just
    // reasoned about): once `req.pipe(proxyReq)` below starts consuming a
    // body-less GET/HEAD request (every SSE endpoint), the *request*'s
    // `'close'` fires almost immediately — as soon as its (empty) readable
    // side is drained — regardless of whether the client is still
    // connected; wiring an unconditional abort to it broke every proxied
    // request, aborting the upstream call before the real response ever
    // arrived. `'aborted'` doesn't fire at all for a genuine mid-stream
    // client-destroy in the same repro. `res`'s `'close'` is the reliable
    // signal: it reflects the underlying socket's actual lifecycle (fires
    // with `writableEnded === false` only on a real premature disconnect —
    // before headers, mid-stream, or otherwise — and with `writableEnded
    // === true`, a no-op below, on every normal completion).
    res.on('close', () => {
      if (!res.writableEnded && !proxyReq.destroyed) proxyReq.destroy();
    });
    req.pipe(proxyReq);
  };

  const serve = (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    tenantId?: string,
  ) => {
    const u = (req.url ?? '/').split('?')[0];
    const resolved = containedAsset(u === '/' ? '/index.html' : u);
    if (resolved.rejected) {
      res.writeHead(400, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store',
      });
      res.end('Bad request');
      return;
    }
    let p = resolved.candidate;
    const exists = fs.existsSync(p) && !fs.statSync(p).isDirectory();
    if (!exists) {
      const method = (req.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        proxyToBackend(req, res, tenantId);
        return;
      }
      const accept = req.headers.accept || '*/*';
      const prefersHtml = accept.startsWith('text/html');
      if (
        prefersHtml &&
        backendNavigationPrefixes.some(
          (prefix: string) => u === prefix || u.startsWith(`${prefix}/`),
        )
      ) {
        proxyToBackend(req, res, tenantId);
        return;
      }
      if (!prefersHtml) {
        const isBackendPath = backendPrefixes.some(
          (prefix: string) => u === prefix || u.startsWith(`${prefix}/`),
        );
        if (isBackendPath) {
          proxyToBackend(req, res, tenantId);
          return;
        }
        res.writeHead(404, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-cache',
        });
        res.end('Not found');
        return;
      }
      const fallback = containedAsset('/index.html');
      if (
        fallback.rejected ||
        !fs.existsSync(fallback.candidate) ||
        !fs.statSync(fallback.candidate).isFile()
      ) {
        res.writeHead(404, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-store',
        });
        res.end('Not found');
        return;
      }
      p = fallback.candidate;
    }
    const ext = path.extname(p);
    const nonce = crypto.randomBytes(16).toString('base64');
    if (ext === '.html') {
      let html = fs.readFileSync(p, 'utf-8');
      const nonceInject = inject.replace(
        '<script>',
        `<script nonce="${nonce}">`,
      );
      html = html.replace('<head>', `<head>${nonceInject}`);
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-cache',
        ...securityHeaders(nonce),
      });
      res.end(html);
    } else {
      res.writeHead(200, {
        'Content-Type': mime[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        ...securityHeaders(nonce),
      });
      fs.createReadStream(p).pipe(res);
    }
  };

  const declaredReady = () => {
    if (!readinessFile || !identity) return true;
    let fd: number | undefined;
    try {
      fd = fs.openSync(
        readinessFile,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
      const info = fs.fstatSync(fd);
      if (
        !info.isFile() ||
        (typeof process.getuid === 'function' &&
          info.uid !== process.getuid()) ||
        (info.mode & 0o077) !== 0
      ) {
        return false;
      }
      const state = JSON.parse(fs.readFileSync(fd, 'utf8'));
      return (
        state?.health?.status === 'ready' && state?.health?.sha === identity.sha
      );
    } catch {
      return false;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };
  const checkLiveReady = (
    tenantId: string | undefined,
    callback: (ready: boolean) => void,
  ) => {
    if (!declaredReady()) {
      callback(false);
      return;
    }
    if (!internalApiToken) {
      callback(false);
      return;
    }
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      callback(ready);
    };
    const request = http.request(
      {
        host: '127.0.0.1',
        port: upstreamPort,
        path: '/api/system/identity',
        method: 'GET',
        timeout: 750,
        // This connection is made only to the sibling loopback backend. Use
        // the per-boot internal credential instead of treating loopback as
        // authority: it recreates this UI process's own internal token and, in
        // hosted mode, its already-resolved tenant attestation. Ordinary local
        // mode still authenticates explicitly, and no browser caller headers
        // are ever forwarded.
        headers: {
          [INTERNAL_TOKEN_HEADER]: internalApiToken,
          [INTERNAL_CALLER_HEADER]: 'local',
          ...(tenantId ? { [INTERNAL_TENANT_HEADER]: tenantId } : {}),
        },
      },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (raw += chunk));
        response.on('end', () => {
          try {
            const upstreamIdentity = JSON.parse(raw);
            finish(
              response.statusCode === 200 &&
                (upstreamIdentity?.sha ?? upstreamIdentity?.fullSha) ===
                  identity?.sha &&
                upstreamIdentity?.bootId === identity?.bootId &&
                upstreamIdentity?.instanceId === identity?.instanceId,
            );
          } catch {
            finish(false);
          }
        });
      },
    );
    request.once('timeout', () => request.destroy());
    request.once('error', () => finish(false));
    request.end();
  };
  const unavailable = (
    res: import('node:http').ServerResponse,
    html: boolean,
  ) => {
    res.writeHead(503, {
      'Content-Type': html ? 'text/html; charset=utf-8' : 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(
      html
        ? '<!doctype html><title>Station recovering</title><main><h1>Station is recovering</h1><p>Please retry shortly.</p></main>'
        : JSON.stringify({ ready: false, status: 'unavailable' }),
    );
  };
  return (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => {
    const hostedTenant = resolvedHostedTenant(req);
    let tenantId: string | undefined;
    if (hostedTenant.enabled) {
      if ('error' in hostedTenant) {
        res.writeHead(421, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ error: { code: hostedTenant.error } }));
        return;
      }
      tenantId = hostedTenant.tenantId;
    }
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname === '/__station/identity') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(identity ?? null));
      return;
    }
    if (pathname === '/api/system/readiness') {
      checkLiveReady(tenantId, (ready) => {
        if (!ready) unavailable(res, false);
        else {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ ready: true, status: 'ready' }));
        }
      });
      return;
    }
    const isNavigation =
      (req.method === 'GET' || req.method === 'HEAD') &&
      (req.headers.accept ?? '').startsWith('text/html');
    if (readinessFile && isNavigation) {
      checkLiveReady(tenantId, (ready) =>
        ready ? serve(req, res, tenantId) : unavailable(res, true),
      );
      return;
    }
    serve(req, res, tenantId);
  };
}

/**
 * The inline bootstrap injected into every HTML response the UI shell serves,
 * or `''` when there is nothing for it to set.
 *
 * It deliberately does NOT publish the response's CSP nonce to page code
 * (station#4287). It used to — `window.__STATION_CSP_NONCE__` — so that the
 * plugin registry could fetch a bundle's bytes and run them as an inline
 * `<script>` carrying the shell's nonce. A global holding the nonce is
 * readable by EVERY script in the document, plugin bundles included, and a
 * script holding a nonce can mint further nonce'd scripts, remote ones
 * included: the one thing `script-src` is here to refuse. The registry now
 * loads same-origin bundles by URL (`'self'` admits them on its own), so
 * nothing in the page needs the nonce and the shell stops handing it out.
 *
 * The bootstrap also removes its own element, because the nonce survives on
 * that element's `nonce` IDL property after nonce hiding blanks the content
 * attribute — leaving the element in the document would publish the same
 * value one `document.scripts` walk away.
 *
 * Consequence, deliberately fail-closed: with `STATION_API_BASE` pointed at a
 * DIFFERENT loopback origin than the shell, the registry's cross-origin path
 * can no longer find a nonce, so an in-process plugin bundle does not execute
 * under this CSP. Plugins report as degraded rather than running with the
 * shell's nonce in hand.
 */
export function buildUiBootstrapScript(opts: {
  apiBaseOverride?: string;
}): string {
  if (!opts.apiBaseOverride) return '';
  const statements = [
    `window.__API_BASE__=${JSON.stringify(opts.apiBaseOverride)}`,
    'document.currentScript.remove()',
  ].join(';');
  return `<script>${statements}</script>`;
}

/**
 * Build the `node -e` source string for the spawned UI server, serializing the
 * shared {@link uiRequestHandler} so the live server and tests share one
 * implementation.
 *
 * HTML responses carry {@link buildUiBootstrapScript}'s inline bootstrap, which
 * is emitted only when an explicit `window.__API_BASE__` override
 * (`STATION_API_BASE`) is configured; otherwise the client keeps its
 * same-origin default (`window.location.origin`) and no inline script is
 * served at all. `upstreamPort` is always the sibling server process's port and
 * is used by the reverse proxy regardless of whether an override is set.
 */
export function buildUiServerScript(opts: {
  uiDir: string;
  apiBaseOverride?: string;
  upstreamPort: number;
  uiPort: number;
  host?: string;
  readinessFile?: string;
  identity?: { instanceId: string; sha: string; bootId: string };
  hostedTenantAuthorities?: Record<string, string>;
}): string {
  const inject = buildUiBootstrapScript(
    opts.apiBaseOverride !== undefined
      ? { apiBaseOverride: opts.apiBaseOverride }
      : {},
  );
  // esbuild/tsx's dev transpilation of this source file injects a helper
  // call (commonly named __name) around named or name-inferred functions
  // (e.g. a const bound to an arrow function) so the function's name
  // property survives bundling. That helper is normally provided by
  // esbuild's own runtime, which does not exist in the standalone node -e
  // process this script is handed to, so it is shimmed as a no-op below,
  // ahead of uiRequestHandler.toString() (which carries any injected calls
  // along with it), so it runs unmodified there too.
  const nameHelperShim =
    'globalThis.__name = globalThis.__name || ((fn) => fn);';
  return `
    ${nameHelperShim}
    const http=require('http'),crypto=require('crypto'),fs=require('fs'),path=require('path');
    const dir=${JSON.stringify(opts.uiDir)};
    const mime=${JSON.stringify(UI_MIME_TYPES)};
    const inject=${JSON.stringify(inject)};
    const upstreamPort=${JSON.stringify(opts.upstreamPort)};
    const backendPrefixes=${JSON.stringify(UI_PROXY_BACKEND_PREFIXES)};
    const backendNavigationPrefixes=${JSON.stringify(UI_PROXY_BACKEND_NAVIGATION_PREFIXES)};
    const readinessFile=${JSON.stringify(opts.readinessFile)};
    const identity=${JSON.stringify(opts.identity)};
    const internalApiToken=process.env.STATION_INTERNAL_API_TOKEN;
    const trustedTailscaleServeOrigin=process.env.STATION_TRUSTED_TAILSCALE_SERVE_ORIGIN;
    const hostedTenantAuthorities=${JSON.stringify(opts.hostedTenantAuthorities)};
    const uiRequestHandler=${uiRequestHandler.toString()};
    http.createServer(uiRequestHandler({http,crypto,fs,path,dir,mime,inject,upstreamPort,backendPrefixes,backendNavigationPrefixes,readinessFile,identity,internalApiToken,trustedTailscaleServeOrigin,hostedTenantAuthorities})).listen(${opts.uiPort},${JSON.stringify(opts.host ?? '0.0.0.0')});
  `;
}

export interface BuildManifest {
  branch: string;
  builtAt: string;
  sha: string;
}

interface PackagedReleaseManifest {
  schemaVersion: 2;
  sha: string;
  ref: string;
  createdAt: string;
  channel: 'stable' | 'beta';
  releaseChannel: 'stable' | 'preview';
  prerelease: boolean;
}

export interface InstanceStateRecord {
  baseDir: string;
  bootId?: string;
  build: BuildManifest | null;
  cwd: string;
  host: string;
  homeSource: LifecycleHomeSource;
  instanceId: string;
  lifecycleJournal?: string;
  priorPidFile?: boolean;
  logFile?: string;
  serverPid: number | null;
  serverFingerprint?: ProcessFingerprint;
  serverPort: number;
  /**
   * The consent listener's port (station#3677). Optional because records
   * written by earlier builds predate it; readers default it to
   * `serverPort + 3`, the same derivation the runtime uses.
   */
  consentPort?: number;
  startedAt: string;
  statePath: string;
  stateIdentity?: { dev: number; ino: number };
  stateContent?: string;
  uiPid: number | null;
  uiFingerprint?: ProcessFingerprint;
  uiPort: number;
  readinessFile?: string;
  hostedProbeAuthority?: string;
}

/**
 * One identity probe's outcome. `identity-mismatch` means a process answered
 * the HTTP exchange but reported a different boot identity — positive evidence
 * that something other than the supervised child owns the port. `unreachable`
 * covers everything else (timeout, connection error, non-2xx, bad body) and is
 * deliberately NOT death evidence on its own: a busy host can stall an HTTP
 * round-trip long past any fixed budget while the child stays healthy
 * (station#1846).
 */
export type IdentityProbeOutcome =
  | 'ok'
  | 'identity-mismatch'
  | 'http-auth-refused'
  | 'unreachable';

export interface CollectedChildStatus {
  /**
   * Whether the child's port accepted (or at least did not refuse) a raw TCP
   * connection. Only a definitive refusal reports false; see
   * probeTcpListenerOnce. Always true when the identity probe succeeded.
   */
  listening: boolean;
  pid: number | null;
  probe: IdentityProbeOutcome;
  reachable: boolean;
}

export interface CollectedInstanceStatus {
  bootId?: string;
  found: boolean;
  healthy: boolean;
  instanceId: string;
  server: CollectedChildStatus;
  sha?: string;
  ui: CollectedChildStatus;
}

interface InstanceSelector {
  baseDir?: string;
  instanceId?: string;
  instanceName?: string;
  serverPort?: number;
  uiPort?: number;
}

export interface StartOptions extends InstanceSelector {
  /** Extra pairing-trust origins merged into ALLOWED_ORIGINS (#1672). */
  allowedOrigins?: string[];
  build?: boolean;
  /**
   * Explicit consent-listener port (station#3677). Default: serverPort + 3,
   * the same derivation the runtime uses — validated and collision-checked
   * either way.
   */
  consentPort?: number;
  features?: string;
  // Force a restart of an already-running instance (stop + start, reusing the
  // existing build). Distinct from `build`, which forces a rebuild.
  force?: boolean;
  // Proceed even when another live instance already owns this home. The
  // default is to REFUSE a genuinely-new start on a shared home: the stores
  // are not multi-writer safe (station#2252, by decision), so same-home is
  // silent data loss, and #2955's warning proved warnings get scrolled past.
  allowSharedHome?: boolean;
  intent?: StopIntent;
  rotateLogOnRestart?: boolean;
  homeSource?: LifecycleHomeSource;
  host?: string;
  logFile?: string;
  lifecycleJournal?: string;
  readinessFile?: string;
  /** Present only for `station service run`, never ordinary `station start`. */
  supervisorPid?: number;
}

export interface BuildOptions extends InstanceSelector {}

export interface StopOptions extends InstanceSelector {
  intent?: StopIntent;
}

export interface CleanOptions extends InstanceSelector {
  actionLabel?: string;
  allowDefaultHomeClean?: boolean;
  force?: boolean;
  homeSource?: LifecycleHomeSource;
  projectHome?: string;
}

/** station#1913: `station home reset --confirm`. */
export interface HomeResetOptions extends InstanceSelector {
  /**
   * Explicit acknowledgement, following the `--allow-default-home-clean` /
   * `--force` confirmation precedent this file already establishes for
   * `clean`: no interactive prompt, an all-or-nothing flag the caller must
   * pass on purpose. Required before any archive: `homeReset` throws when
   * this is unset and it is actually about to move `projectHome` aside.
   * The one exception is the `ifIncompatible` no-op path -- when the home
   * already satisfies the current schema gate, `homeReset` returns early
   * (nothing archived) before ever checking `confirm`, so a scripted caller
   * that always passes `--if-incompatible` does not need `--confirm` on the
   * common, already-compatible runs; it is only required on the run that
   * actually archives.
   */
  confirm?: boolean;
  homeSource?: LifecycleHomeSource;
  /**
   * Skip archiving (and report a no-op) when the home already satisfies the
   * current schema gate. Lets a deploy call this on every run without
   * destroying an already-migrated home's plugins/history.
   */
  ifIncompatible?: boolean;
  projectHome?: string;
}

export interface HomeResetResult {
  archived: boolean;
  archivePath?: string;
  projectHome: string;
}

export interface HomeBackupOptions extends InstanceSelector {
  homeSource?: LifecycleHomeSource;
  outputDir?: string;
  projectHome?: string;
}

export interface HomeRestoreOptions extends InstanceSelector {
  backupDir: string;
  confirm?: boolean;
  homeSource?: LifecycleHomeSource;
  projectHome?: string;
}

function parsePidList(raw: string): Array<number | null> {
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((value) => {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : null;
    });
}

/**
 * Checks whether a PID still represents an executing process. `kill(pid, 0)`
 * intentionally succeeds for an unreaped zombie, so POSIX hosts need the
 * process state check as a second step before using that result for a drain.
 */
export function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  if (process.platform === 'win32') return true;
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    return !state.startsWith('Z');
  } catch {
    // Keep signal-0 behavior when ps is absent or its process lookup fails.
    return true;
  }
}

function getInstanceServicePorts(
  record: Pick<InstanceStateRecord, 'serverPort' | 'uiPort' | 'consentPort'>,
): number[] {
  return [
    record.serverPort,
    record.serverPort + 1,
    record.serverPort + 2,
    record.consentPort ?? record.serverPort + 3,
    record.uiPort,
  ];
}

function isInstanceRunning(record: InstanceStateRecord): boolean {
  if (record.priorPidFile) {
    return isProcessAlive(record.serverPid) || isProcessAlive(record.uiPid);
  }
  return (
    isProcessAlive(record.serverPid) ||
    isProcessAlive(record.uiPid) ||
    findListeningPidsForPorts(getInstanceServicePorts(record)).length > 0
  );
}

function notifyBuildUpdated(serverPort: number): void {
  try {
    execSync(
      `curl -s -X POST http://localhost:${serverPort}/api/system/build-updated`,
      { stdio: 'ignore', timeout: 3000, windowsHide: true },
    );
  } catch {}
}

function removeStateRecord(record: InstanceStateRecord): void {
  if (record.priorPidFile) {
    rmSync(record.statePath, { force: true });
    return;
  }
  if (!record.stateIdentity || record.stateContent === undefined) {
    throw new Error(
      `Refusing to remove unverified instance state: ${record.statePath}`,
    );
  }

  const release = acquireFileMutationLock(`${record.statePath}.mutation`);
  let fd: number | undefined;
  let quarantine: string | undefined;
  try {
    const currentRecord = readInstanceStateFile(record.statePath);
    const currentIdentity = currentRecord.stateIdentity;
    if (
      !currentIdentity ||
      currentIdentity.dev !== record.stateIdentity.dev ||
      currentIdentity.ino !== record.stateIdentity.ino ||
      currentRecord.stateContent !== record.stateContent
    ) {
      throw new Error(
        `Instance state changed before removal: ${record.statePath}`,
      );
    }
    quarantine = `${record.statePath}.quarantine-${process.pid}-${randomUUID()}`;
    renameSync(record.statePath, quarantine);
    fd = openSync(
      quarantine,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const moved = fstatSync(fd);
    if (
      moved.dev !== record.stateIdentity.dev ||
      moved.ino !== record.stateIdentity.ino ||
      readFileSync(fd, 'utf8') !== record.stateContent
    ) {
      throw new Error(
        `Instance state was replaced during removal: ${record.statePath}`,
      );
    }
    unlinkSync(quarantine);
    quarantine = undefined;
    syncInstanceStateDirectory();
  } catch (error) {
    if (quarantine && !existsSync(record.statePath) && existsSync(quarantine)) {
      renameSync(quarantine, record.statePath);
      syncInstanceStateDirectory();
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
    release();
  }
}

function readPriorPidInstanceState(): InstanceStateRecord | null {
  if (!existsSync(PIDFILE)) return null;

  const [serverPid, uiPid] = parsePidList(readFileSync(PIDFILE, 'utf-8'));
  const record: InstanceStateRecord = {
    instanceId: DEFAULT_INSTANCE_ID,
    serverPid,
    uiPid,
    serverPort: DEFAULT_SERVER_PORT,
    consentPort: DEFAULT_SERVER_PORT + 3,
    uiPort: DEFAULT_UI_PORT,
    baseDir: DEFAULT_PROJECT_HOME,
    build: null,
    homeSource: 'default',
    host: '0.0.0.0',
    startedAt: new Date(0).toISOString(),
    cwd: CWD,
    statePath: PIDFILE,
    priorPidFile: true,
  };

  if (!isInstanceRunning(record)) {
    removeStateRecord(record);
    return null;
  }

  return record;
}

function validateInstanceStateDirectory(): void {
  const info = lstatSync(INSTANCE_STATE_DIR);
  // POSIX permission bits are meaningless on Windows: `mkdirSync({mode:0o700})`
  // does not set them and `lstat().mode` is synthetic, so this check would
  // always throw and `station start` could never run on Windows. Windows ACLs
  // (owner-scoped user profile) are the real gate there. The uid clause above
  // is already win32-guarded (no `process.getuid`); mirror that for the mode.
  const enforcePosixMode = process.platform !== 'win32';
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
    (enforcePosixMode && (info.mode & 0o777) !== 0o700)
  ) {
    throw new Error(
      `Unsafe Station instance-state directory (expected owned mode 0700): ${INSTANCE_STATE_DIR}`,
    );
  }
}

function ensureInstanceStateDirectory(): void {
  mkdirSync(INSTANCE_STATE_DIR, { mode: 0o700, recursive: true });
  validateInstanceStateDirectory();
}

function syncInstanceStateDirectory(): void {
  // Windows does not permit fsync on a directory handle (throws EPERM) and does
  // not need this POSIX directory-entry durability flush. Skip it there.
  if (process.platform === 'win32') return;
  const fd = openSync(INSTANCE_STATE_DIR, fsConstants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readInstanceStateFile(path: string): InstanceStateRecord {
  validateInstanceStateDirectory();
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
      // POSIX-only: Windows mode bits are synthetic (see validateInstanceState-
      // Directory). ACLs on the owner-scoped profile are the real gate there.
      (process.platform !== 'win32' && (info.mode & 0o777) !== 0o600)
    ) {
      throw new Error(
        `Unsafe Station instance-state file (expected owned mode 0600): ${path}`,
      );
    }
    const stateContent = readFileSync(fd, 'utf-8');
    const parsed = JSON.parse(stateContent) as Partial<InstanceStateRecord>;
    const instanceId = parsed.instanceId;
    if (!instanceId || typeof instanceId !== 'string') {
      throw new Error(`Invalid Station instance-state record: ${path}`);
    }

    return {
      instanceId,
      bootId: parsed.bootId,
      serverPid: parsed.serverPid ?? null,
      serverFingerprint: parsed.serverFingerprint,
      uiPid: parsed.uiPid ?? null,
      uiFingerprint: parsed.uiFingerprint,
      serverPort: parsed.serverPort ?? DEFAULT_SERVER_PORT,
      consentPort:
        parsed.consentPort ?? (parsed.serverPort ?? DEFAULT_SERVER_PORT) + 3,
      uiPort: parsed.uiPort ?? DEFAULT_UI_PORT,
      baseDir: normalizeHomePath(parsed.baseDir || DEFAULT_PROJECT_HOME),
      build: validateBuildManifest(parsed.build),
      homeSource: parsed.homeSource || 'default',
      host: normalizeLifecycleHost(parsed.host),
      startedAt: parsed.startedAt || new Date(0).toISOString(),
      cwd: parsed.cwd || CWD,
      lifecycleJournal: parsed.lifecycleJournal,
      logFile: parsed.logFile,
      readinessFile: parsed.readinessFile,
      hostedProbeAuthority: readHostedProbeAuthority(
        parsed.hostedProbeAuthority,
        path,
      ),
      statePath: path,
      stateIdentity: { dev: info.dev, ino: info.ino },
      stateContent,
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readHostedProbeAuthority(
  value: unknown,
  statePath: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(
      `Invalid hosted probe authority in instance state: ${statePath}`,
    );
  }
  try {
    const canonical = canonicalTenantAuthority(value);
    if (canonical === value) return value;
  } catch {
    // Fall through to the uniform state-record error below.
  }
  throw new Error(
    `Invalid hosted probe authority in instance state: ${statePath}`,
  );
}

/**
 * Liveness for a record this process could not interpret, derived ONLY from
 * raw pids and ports. Nothing here may route through `normalizeHomePath`:
 * the whole point is to judge a record whose recorded home the current
 * admission guard rejects, which is exactly the record that cannot be
 * normalized. Liveness never needed the home in the first place --
 * `isInstanceRunning` reads pids and ports too -- so admitting the home
 * before establishing death was gratuitous ordering.
 *
 * Fails CLOSED: anything that leaves death unproven returns `false`, so an
 * ambiguous or concurrently-rewritten record is never reclaimed.
 */
function unreadableStateRecordIsDead(path: string): boolean {
  try {
    const parsed = JSON.parse(
      readFileSync(path, 'utf-8'),
    ) as Partial<InstanceStateRecord>;
    const serverPort = parsed.serverPort ?? DEFAULT_SERVER_PORT;
    return !(
      isProcessAlive(parsed.serverPid ?? null) ||
      isProcessAlive(parsed.uiPid ?? null) ||
      findListeningPidsForPorts([
        serverPort,
        serverPort + 1,
        serverPort + 2,
        parsed.consentPort ?? serverPort + 3,
        parsed.uiPort ?? DEFAULT_UI_PORT,
      ]).length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Reclaims a provably dead record that `readInstanceStateFile` refused. Takes
 * the same mutation lock as `removeStateRecord` and re-proves death under it,
 * so a record that comes back to life between the first check and the removal
 * is left alone.
 */
function discardUnreadableStateRecord(path: string): void {
  const release = acquireFileMutationLock(`${path}.mutation`);
  try {
    if (!unreadableStateRecordIsDead(path)) return;
    rmSync(path, { force: true });
  } finally {
    release();
  }
}

/**
 * Lists live instances, reclaiming the state records of dead ones.
 *
 * `reclaimStale: false` makes this a pure read (station#2745). Reclaiming a
 * record calls `removeStateRecord`, which takes a SYNCHRONOUS file-mutation
 * lock — once per stale record. That is correct for a lifecycle command, and
 * wrong for anything whose job is to report on the host: the diagnostics
 * bundle reaches this through `collectDoctorReport`, so hitting the endpoint
 * you use to investigate a freeze could block the event loop it is reporting
 * on. A reader still excludes stale records from its results; it just does not
 * delete them. The next lifecycle command reclaims them.
 */
function listRunningInstances(
  options: { reclaimStale?: boolean } = {},
): InstanceStateRecord[] {
  const reclaimStale = options.reclaimStale ?? true;
  const records: InstanceStateRecord[] = [];

  if (existsSync(INSTANCE_STATE_DIR)) {
    validateInstanceStateDirectory();
    for (const entry of readdirSync(INSTANCE_STATE_DIR)) {
      if (!entry.endsWith('.json')) continue;
      const path = join(INSTANCE_STATE_DIR, entry);
      let record: InstanceStateRecord;
      try {
        record = readInstanceStateFile(path);
      } catch (error) {
        // A record written by an older release can pin a path that a guard
        // has since tightened -- `baseDir` set to the shared root is the
        // known case. Reading it threw BEFORE the liveness check below, so
        // the reclaim that exists to clear exactly this record could never
        // run, and one dead file wedged `start`, `stop`, `status`, and
        // `service run` at once with no self-recovery. Prove death from the
        // raw pids and ports instead, then reclaim it. A live or unprovable
        // owner still surfaces the error rather than being deleted or
        // silently skipped.
        //
        // Scoped deliberately to the home-admission rejection. Every other
        // way this read fails -- permissive or symlinked state, a
        // non-canonical hosted probe authority, unparseable JSON -- is a
        // fail-closed refusal about the record's own integrity, and
        // reclaiming those would convert a deliberate refusal into a silent
        // delete.
        const admissionRejected =
          (error as NodeJS.ErrnoException | undefined)?.code ===
          'STATION_RUNTIME_HOME_REJECTED';
        if (
          admissionRejected &&
          reclaimStale &&
          unreadableStateRecordIsDead(path)
        ) {
          discardUnreadableStateRecord(path);
          continue;
        }
        throw error;
      }
      if (!isInstanceRunning(record)) {
        if (reclaimStale) removeStateRecord(record);
        continue;
      }
      records.push(record);
    }
  }

  const hasDefaultRecord = records.some(
    (record) => record.instanceId === DEFAULT_INSTANCE_ID,
  );
  const priorPidRecord = readPriorPidInstanceState();
  if (priorPidRecord && !hasDefaultRecord) {
    records.push(priorPidRecord);
  } else if (priorPidRecord && hasDefaultRecord && reclaimStale) {
    removeStateRecord(priorPidRecord);
  }

  return records.sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt),
  );
}

function normalizeSelector(
  selector: InstanceSelector = {},
): Required<Pick<InstanceSelector, never>> & InstanceSelector {
  return {
    ...selector,
    baseDir: selector.baseDir ? normalizeHomePath(selector.baseDir) : undefined,
    instanceId:
      selector.instanceId ||
      (selector.instanceName
        ? normalizeInstanceName(selector.instanceName)
        : undefined),
  };
}

function matchesSelector(
  record: InstanceStateRecord,
  selector: InstanceSelector,
): boolean {
  if (selector.instanceId && record.instanceId !== selector.instanceId) {
    return false;
  }
  if (selector.baseDir && record.baseDir !== selector.baseDir) {
    return false;
  }
  if (
    selector.serverPort !== undefined &&
    record.serverPort !== selector.serverPort
  ) {
    return false;
  }
  if (selector.uiPort !== undefined && record.uiPort !== selector.uiPort) {
    return false;
  }
  return true;
}

function describeInstance(record: InstanceStateRecord): string {
  return `${record.instanceId} — server ${record.serverPort}, ui ${record.uiPort}, home ${record.baseDir}`;
}

/** Resolve the PIDs currently owning one or more listening ports. */
export function findListeningPidsForPorts(ports: number[]): number[] {
  const results = new Set<number>();

  for (const port of ports) {
    try {
      const output = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf-8',
        windowsHide: true,
      });
      for (const line of output.split('\n')) {
        const value = Number.parseInt(line.trim(), 10);
        if (Number.isFinite(value)) {
          results.add(value);
        }
      }
    } catch {
      // No listener on this port, or lsof unavailable.
    }
  }

  return [...results];
}

export function isInstanceFullyStopped(record: InstanceStateRecord): boolean {
  const pids = [record.serverPid, record.uiPid].filter(
    (value): value is number => value != null,
  );
  const trackedProcessesAlive = pids.some((pid) => isProcessAlive(pid));
  if (trackedProcessesAlive) {
    return false;
  }

  return (
    findListeningPidsForPorts(getInstanceServicePorts(record)).length === 0
  );
}

function waitForInstanceShutdown(
  record: InstanceStateRecord,
  timeoutMs = 15_000,
): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isInstanceFullyStopped(record)) {
      return true;
    }
    sleepSync(200);
  }
  return isInstanceFullyStopped(record);
}

function stopRecord(
  record: InstanceStateRecord,
  announce = true,
  intent: StopIntent = 'operator_stop',
): void {
  const operationId = randomUUID();
  const operationStartedAt = new Date();
  const appendStopResult = (
    result: 'completed' | 'already_absent' | 'failed',
  ) => {
    if (
      record.lifecycleJournal &&
      record.bootId &&
      record.build?.sha &&
      record.serverPid
    ) {
      appendLifecycleEvent(record.lifecycleJournal, {
        instanceId: record.instanceId,
        sha: record.build.sha,
        bootId: record.bootId,
        pid: record.serverPid,
        type: 'stop_result',
        operationId,
        result,
        sender: 'unknown',
        timestamp: new Date().toISOString(),
      });
    }
  };
  if (
    record.lifecycleJournal &&
    record.bootId &&
    record.build?.sha &&
    record.serverPid
  ) {
    appendLifecycleEvent(record.lifecycleJournal, {
      instanceId: record.instanceId,
      sha: record.build.sha,
      bootId: record.bootId,
      pid: record.serverPid,
      type: 'stop_intent',
      intent,
      operationId,
      expiresAt: new Date(operationStartedAt.getTime() + 30_000).toISOString(),
      sender: 'unknown',
      timestamp: new Date().toISOString(),
    });
  }
  const pids = new Set(
    [record.serverPid, record.uiPid].filter(
      (value): value is number => value != null,
    ),
  );
  const managed = Boolean(record.lifecycleJournal);
  if (managed) {
    const identities = [
      [record.serverPid, record.serverFingerprint, 'server'],
      [record.uiPid, record.uiFingerprint, 'ui'],
    ] as const;
    let anyPresent = false;
    for (const [pid, expected, label] of identities) {
      if (!pid) continue;
      const actual = inspectProcessFingerprint(pid);
      if (!actual) continue;
      anyPresent = true;
      if (!expected || !fingerprintMatchesRecorded(actual, expected)) {
        appendStopResult('failed');
        throw new Error(
          `Refusing to signal ${label} PID ${pid}: process fingerprint mismatch`,
        );
      }
    }
    if (!anyPresent) {
      appendStopResult('already_absent');
      if (record.serverPid) {
        const activeApiBase = activeLocalApiBase(
          record.host,
          record.serverPort,
        );
        if (activeApiBase) {
          removeOwnedActiveLocalStation(
            { apiBase: activeApiBase, ownerPid: record.serverPid },
            record.baseDir,
          );
        }
      }
      removeStateRecord(record);
      // The process is already gone, but its registry entry may not be — a
      // crash or kill -9 never runs the success-path unregister, and nothing
      // else reaps these entries. The pid identity + ownership checks inside
      // make this safe against a newer same-id start (review HIGH: a leaked
      // entry plus pid reuse can permanently block `station home
      // backup|restore`, with no id in the refusal and no stop to clear it).
      unregisterStopFromHomeRegistry(
        record.instanceId,
        record.baseDir,
        record.serverPid,
      );
      return;
    }
  }
  for (const pid of pids) {
    if (managed) {
      const expected =
        pid === record.serverPid
          ? record.serverFingerprint
          : record.uiFingerprint;
      const actual = inspectProcessFingerprint(pid);
      if (!actual) continue;
      if (!expected || !fingerprintMatchesRecorded(actual, expected)) {
        appendStopResult('failed');
        throw new Error(
          `Refusing to signal PID ${pid}: process fingerprint changed before signal`,
        );
      }
    }
    killProcessTree(pid);
  }
  // A fully loaded runtime can need several seconds to unwind providers and
  // child processes. Give unmanaged instances a graceful 10s phase before
  // killing untracked port owners, then retain 5s for forced convergence.
  if (!managed && !waitForInstanceShutdown(record, 10_000)) {
    const fallbackPids = findListeningPidsForPorts(
      getInstanceServicePorts(record),
    );
    for (const pid of fallbackPids) {
      if (!pids.has(pid)) {
        killProcessTree(pid);
      }
    }
  }
  if (!waitForInstanceShutdown(record, managed ? 15_000 : 5_000)) {
    appendStopResult('failed');
    // Report what is actually still holding the instance open, not the full
    // configured port list — the old message named every port on every failed
    // stop, which hid the real blocker (station#1846).
    const alivePids = [...pids].filter((pid) => isProcessAlive(pid));
    const lingeringPorts = getInstanceServicePorts(record).filter(
      (port) => findListeningPidsForPorts([port]).length > 0,
    );
    throw new Error(
      [
        `Failed to stop Station instance ${record.instanceId}.`,
        alivePids.length > 0
          ? `Tracked processes still running: ${alivePids.join(', ')}`
          : undefined,
        lingeringPorts.length > 0
          ? `Lingering ports: ${lingeringPorts.join(', ')}`
          : undefined,
        // The re-check can race a shutdown that converged just after the
        // bounded wait expired; keep the failure explicit rather than
        // throwing a bare first line.
        alivePids.length === 0 && lingeringPorts.length === 0
          ? 'Shutdown did not converge within the wait window (processes and ports re-checked clean afterward — teardown race).'
          : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n'),
    );
  }
  appendStopResult('completed');
  if (record.serverPid) {
    const activeApiBase = activeLocalApiBase(record.host, record.serverPort);
    if (activeApiBase) {
      removeOwnedActiveLocalStation(
        { apiBase: activeApiBase, ownerPid: record.serverPid },
        record.baseDir,
      );
    }
  }
  removeStateRecord(record);
  unregisterStopFromHomeRegistry(
    record.instanceId,
    record.baseDir,
    record.serverPid,
  );
  // A --temp-home instance is ephemeral; drop its per-instance build dirs too
  // so they don't accumulate. Persistent instances keep theirs for fast restarts.
  if (record.homeSource === '--temp-home') {
    const buildPaths = resolveBuildPaths(record.instanceId);
    rmSync(join(CWD, buildPaths.server), { recursive: true, force: true });
    rmSync(join(CWD, buildPaths.ui), { recursive: true, force: true });
  }
  if (announce) {
    console.log('  ✓ Stopped');
  }
}

function ensureSingleMatch(
  matches: InstanceStateRecord[],
  action: string,
): InstanceStateRecord | null {
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  throw new Error(
    [
      `${action} matched multiple running Station instances in this checkout.`,
      'Use --instance, --base, --port, or --ui-port to disambiguate.',
      ...matches.map((record) => `  - ${describeInstance(record)}`),
    ].join('\n'),
  );
}

function writeInstanceState(record: InstanceStateRecord): void {
  ensureInstanceStateDirectory();
  const release = acquireFileMutationLock(`${record.statePath}.mutation`);
  const serialized = JSON.stringify(
    {
      instanceId: record.instanceId,
      bootId: record.bootId,
      serverPid: record.serverPid,
      serverFingerprint: record.serverFingerprint,
      uiPid: record.uiPid,
      uiFingerprint: record.uiFingerprint,
      serverPort: record.serverPort,
      uiPort: record.uiPort,
      baseDir: record.baseDir,
      build: record.build,
      homeSource: record.homeSource,
      host: record.host,
      startedAt: record.startedAt,
      cwd: record.cwd,
      lifecycleJournal: record.lifecycleJournal,
      logFile: record.logFile,
      readinessFile: record.readinessFile,
      hostedProbeAuthority: record.hostedProbeAuthority,
    },
    null,
    2,
  );
  const temporary = join(
    INSTANCE_STATE_DIR,
    `.instance-${process.pid}-${randomUUID()}.tmp`,
  );
  const backup = `${record.statePath}.prior-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  let publishedFd: number | undefined;
  let temporaryIdentity: { dev: number; ino: number } | undefined;
  let publishedTemporary = false;
  try {
    if (existsSync(record.statePath)) {
      readInstanceStateFile(record.statePath);
      linkSync(record.statePath, backup);
    }
    fd = openSync(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fchmodSync(fd, 0o600);
    writeFileSync(fd, serialized, 'utf8');
    fsyncSync(fd);
    const temporaryInfo = fstatSync(fd);
    temporaryIdentity = { dev: temporaryInfo.dev, ino: temporaryInfo.ino };
    renameSync(temporary, record.statePath);
    publishedTemporary = true;
    syncInstanceStateDirectory();
    publishedFd = openSync(
      record.statePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const publishedInfo = fstatSync(publishedFd);
    if (
      !publishedInfo.isFile() ||
      (typeof process.getuid === 'function' &&
        publishedInfo.uid !== process.getuid()) ||
      // POSIX-only: fchmod is a no-op on Windows and mode bits are synthetic.
      (process.platform !== 'win32' &&
        (publishedInfo.mode & 0o777) !== 0o600) ||
      publishedInfo.dev !== temporaryIdentity.dev ||
      publishedInfo.ino !== temporaryIdentity.ino ||
      readFileSync(publishedFd, 'utf8') !== serialized
    ) {
      throw new Error(
        `Failed to publish secure instance state: ${record.statePath}`,
      );
    }
    closeSync(publishedFd);
    publishedFd = undefined;
    closeSync(fd);
    fd = undefined;
    rmSync(backup, { force: true });
    syncInstanceStateDirectory();
    publishedTemporary = false;
  } catch (error) {
    if (publishedTemporary && temporaryIdentity) {
      try {
        const current = lstatSync(record.statePath);
        if (
          current.dev === temporaryIdentity.dev &&
          current.ino === temporaryIdentity.ino
        ) {
          rmSync(record.statePath, { force: true });
        }
      } catch {}
    }
    if (existsSync(backup)) renameSync(backup, record.statePath);
    syncInstanceStateDirectory();
    throw error;
  } finally {
    if (publishedFd !== undefined) closeSync(publishedFd);
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
    rmSync(backup, { force: true });
    release();
  }
  rmSync(PIDFILE, { force: true });
}

/**
 * How this home was chosen — the input that decided it, not a mood word.
 * `default` is the one that costs people data: it means nothing selected a
 * home, so the command is about to act on the operator's real `~/.station`
 * (station#4299).
 */
export function describeHomeSource(source: LifecycleHomeSource): string {
  switch (source) {
    case '--temp-home':
      return '--temp-home';
    case '--home':
      return '--home';
    case '--base':
      return '--base';
    case 'env':
      return 'STATION_HOME';
    case 'default':
      return 'default';
  }
}

/**
 * Name the home before acting on it. This used to fire only for
 * `--temp-home`, which announced the one case where the operator already knew
 * the home was disposable and stayed silent for the case that cost three
 * restarts against the real `~/.station` (station#4299).
 */
function announceHome(projectHome: string, source: LifecycleHomeSource): void {
  console.log(`Station home: ${projectHome} (${describeHomeSource(source)})`);
}

function resolveStartTarget(options: StartOptions) {
  const serverPort = options.serverPort ?? DEFAULT_SERVER_PORT;
  const uiPort = options.uiPort ?? DEFAULT_UI_PORT;
  const consentPort = options.consentPort ?? serverPort + 3;
  const homeTarget = resolveLifecycleHomeTarget({ baseDir: options.baseDir });
  const projectHome = homeTarget.projectHome;
  const homeSource = options.homeSource ?? homeTarget.source;
  const instanceId =
    options.instanceId ||
    resolveLifecycleInstanceId({
      instanceName: options.instanceName,
      projectHome,
      serverPort,
      uiPort,
    });

  return {
    serverPort,
    uiPort,
    consentPort,
    projectHome,
    homeSource,
    instanceId,
    statePath: getInstanceStatePath(instanceId),
  };
}

function resolveCleanTarget(options: CleanOptions) {
  const homeTarget = resolveLifecycleHomeTarget({
    baseDir: options.projectHome ?? options.baseDir,
  });
  const projectHome = homeTarget.projectHome;
  const homeSource = options.homeSource ?? homeTarget.source;
  const serverPort = options.serverPort ?? DEFAULT_SERVER_PORT;
  const uiPort = options.uiPort ?? DEFAULT_UI_PORT;
  const instanceId =
    options.instanceId ||
    resolveLifecycleInstanceId({
      instanceName: options.instanceName,
      projectHome,
      serverPort,
      uiPort,
    });

  return {
    projectHome,
    homeSource,
    isDefaultHome: homeTarget.isDefaultHome,
    serverPort,
    uiPort,
    instanceId,
  };
}

export function isRunning(selector: StopOptions = {}): boolean {
  const normalizedSelector = normalizeSelector(selector);
  return listRunningInstances().some((record) =>
    matchesSelector(record, normalizedSelector),
  );
}

interface BuildPaths {
  server: string;
  ui: string;
}

const BUILD_MANIFEST_FILENAME = 'station-build.json';
const PACKAGED_RELEASE_MANIFEST_FILENAME = '.station-release.json';

export function normalizeLifecycleHost(host?: string): string {
  if (host === undefined) return '0.0.0.0';
  const normalized = host.trim();
  if (isIP(normalized) === 0) {
    throw new Error(
      `Invalid --host value ${JSON.stringify(host)}. Expected an IPv4 or IPv6 address.`,
    );
  }
  return normalized;
}

function hostForUrl(host: string): string {
  const probeHost =
    host === '0.0.0.0' ? 'localhost' : host === '::' ? '::1' : host;
  return isIP(probeHost) === 6 ? `[${probeHost}]` : probeHost;
}

function activeLocalApiBase(
  host: string,
  serverPort: number,
): string | undefined {
  if (host === '0.0.0.0') return `http://127.0.0.1:${serverPort}`;
  if (host === '::') return `http://[::1]:${serverPort}`;
  if (host === '::1' || host.startsWith('127.')) {
    return `http://${hostForUrl(host)}:${serverPort}`;
  }
  return undefined;
}

function getReservedPorts(
  record: Pick<InstanceStateRecord, 'serverPort' | 'uiPort' | 'consentPort'>,
) {
  return getInstanceServicePorts(record);
}

export function validateLifecyclePorts(
  serverPort: number,
  uiPort: number,
  // Optional so callers that never customize the consent port keep the same
  // derivation the runtime uses (station#3677). An explicit --consent-port
  // flows through here and gets the same validation and distinctness check.
  consentPort: number = Number.isInteger(serverPort) ? serverPort + 3 : NaN,
): void {
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65_532) {
    throw new Error(
      `Invalid server port ${serverPort}. Expected an integer from 1 through 65532 so terminal, voice, and consent ports remain in range.`,
    );
  }
  if (!Number.isInteger(uiPort) || uiPort < 1 || uiPort > 65_535) {
    throw new Error(
      `Invalid UI port ${uiPort}. Expected an integer from 1 through 65535.`,
    );
  }
  if (
    !Number.isInteger(consentPort) ||
    consentPort < 1 ||
    consentPort > 65_535
  ) {
    throw new Error(
      `Invalid consent port ${consentPort}. Expected an integer from 1 through 65535.`,
    );
  }
  const ports = [
    serverPort,
    serverPort + 1,
    serverPort + 2,
    consentPort,
    uiPort,
  ];
  if (new Set(ports).size !== ports.length) {
    throw new Error(
      `Station listener ports must be distinct: server ${serverPort}, terminal ${serverPort + 1}, voice ${serverPort + 2}, consent ${consentPort}, UI ${uiPort}.`,
    );
  }
}

function formatReservedPorts(
  record: Pick<InstanceStateRecord, 'serverPort' | 'uiPort' | 'consentPort'>,
): string {
  return `${record.serverPort} (server), ${record.serverPort + 1} (terminal), ${record.serverPort + 2} (voice), ${record.consentPort ?? record.serverPort + 3} (consent), ${record.uiPort} (ui)`;
}

function assertNoPortConflicts(
  instanceId: string,
  serverPort: number,
  uiPort: number,
  consentPort: number = serverPort + 3,
): void {
  const requested = new Set(
    getInstanceServicePorts({ serverPort, uiPort, consentPort }),
  );
  const conflicts = listRunningInstances().filter((record) => {
    if (record.instanceId === instanceId) return false;
    return getReservedPorts(record).some((port) => requested.has(port));
  });

  if (conflicts.length === 0) return;

  throw new Error(
    [
      'start is blocked because the requested ports overlap another live Station instance.',
      `Requested: ${formatReservedPorts({ serverPort, uiPort, consentPort })}`,
      ...conflicts.map(
        (record) =>
          `  - ${record.instanceId} reserves ${formatReservedPorts(record)}`,
      ),
    ].join('\n'),
  );
}

/** One display line for a colliding instance. */
function describeSharedHomeInstance(entry: {
  id: string;
  port?: number;
  type?: string;
  checkout?: string;
}): string {
  const where = entry.checkout ? ` from ${entry.checkout}` : '';
  const port = entry.port ? ` on port ${entry.port}` : '';
  const kind = entry.type && entry.type !== entry.id ? ` (${entry.type})` : '';
  return `${entry.id}${kind}${port}${where}`;
}

export function findSharedHomeInstances(
  records: InstanceStateRecord[],
  instanceId: string,
  projectHome: string,
): InstanceStateRecord[] {
  const selector = normalizeSelector({ baseDir: projectHome });
  return records.filter(
    (record) =>
      record.instanceId !== instanceId && matchesSelector(record, selector),
  );
}

/**
 * Instances sharing one home, as far as each registry can see (station#2904).
 *
 * `assertNoPortConflicts` compares PORTS only, so two instances on different
 * ports quietly share one `~/.station`. They both construct
 * `FileMemoryAdapter` and write the same conversation transcripts, and #2252
 * serialized those mutations only WITHIN a process — an update lost between
 * two servers is lost with no error.
 *
 * TWO registries, and the distinction matters — `docs/design/instance-registry.md`
 * has a section explaining it so a reader who finds one does not assume it is
 * the other, and the first version of this code conflated them anyway:
 *
 * - `<STATION_HOME>/instances.json` answers "what runs under THIS HOME, across
 *   checkouts". The Desktop app publishes its sidecar here and nowhere else.
 * - `.station/instances/*.json` is CWD-anchored: "what did THIS CHECKOUT
 *   start". `station start` writes it and is not yet a producer for the
 *   home-scoped registry, so it is the only record of a sibling CLI instance
 *   from this same checkout.
 *
 * KNOWN BLIND SPOT: an installed service. `service.ts` upserts into the
 * home registry without a `pid`, and the liveness filter requires one, so a
 * live service on this home is not reported. Detecting it would mean trusting
 * a `status` field with nothing to verify it against, which is the kind of
 * unverified label this warning exists to avoid. Recorded on #2904.
 */
/**
 * `station start` as a home-registry producer (station#2904, slice 2).
 *
 * Until now the CLI only wrote the CWD-anchored `.station/instances/*` state,
 * so from `<STATION_HOME>/instances.json`'s point of view a CLI-started
 * server did not exist — the Desktop sidecar and service installs publish
 * there, `lazy-start`/`doctor` read there, and #2955's warning had to keep a
 * checkout-scoped fallback to see its own siblings. The registry's
 * `InstanceType` union reserved `'inline' | 'worktree'` for exactly this
 * producer; nothing wrote them before.
 *
 * Ordering follows service.ts's #1983 rule: persist only AFTER the fallible
 * start has succeeded, so a failed start never durably registers.
 *
 * Best-effort by the same reasoning as the shared-home warning: the registry
 * read/write throws on a corrupt or loosely-permissioned file, and `start`
 * predates this feature — it must not begin failing because of it. Degrades
 * with one stderr note, never silently.
 *
 * `birth` pairs the pid with a process-birth fingerprint so a pid-reused
 * stale entry reads as dead, not alive — closing, for these entries, the
 * aliasing blind spot the #2955 review named.
 */
export function instanceTypeForCheckout(
  root: string = CWD,
): 'inline' | 'worktree' {
  try {
    // In a linked git worktree `.git` is a FILE ("gitdir: ..."); in the
    // primary checkout it is a directory. Non-git roots (an installed CLI
    // running from a resource dir) are plain 'inline'.
    return statSync(join(root, '.git')).isFile() ? 'worktree' : 'inline';
  } catch {
    return 'inline';
  }
}

export function registerStartInHomeRegistry(
  instanceId: string,
  projectHome: string,
  serverPort: number,
  uiPort: number,
  serverPid: number,
  consentPort?: number,
): void {
  try {
    // OWNERSHIP GUARDS, now inside the shared module's mutation lock
    // (station#3047 closed the read-then-write TOCTOU that #2904's review
    // accepted here):
    // - 'protected-type': service installs and the Desktop sidecar publish
    //   into this registry under the SAME id grammar, and a service entry is
    //   durable origin-policy authority (#1983) — never adopt or displace
    //   one, even when no process is running.
    // - 'live-owner': the DEFAULT×DEFAULT path — two checkouts both running
    //   `station start` on one home. Overwriting would erase the sibling
    //   from every home-wide reader, and the warning's id-keyed
    //   self-exclusion would then hide the very entry we clobbered.
    const claim = claimInstanceEntry(
      instanceId,
      {
        port: serverPort,
        uiPort,
        consentPort: consentPort ?? serverPort + 3,
        type: instanceTypeForCheckout(),
        status: 'running',
        pid: serverPid,
        birth: lookupProcessBirthFingerprint(serverPid) ?? undefined,
        startedAt: new Date().toISOString(),
        checkout: CWD,
      },
      { home: projectHome, protectedTypes: ['service', 'sidecar'] },
    );
    if (!claim.written) {
      const { existing } = claim;
      process.stderr.write(
        claim.reason === 'protected-type'
          ? `\nWarning: instance id '${instanceId}' is registered as type '${existing.type}' in this home's registry; not overwriting it. Choose a different --instance name to make this start visible home-wide.\n`
          : `\nWarning: instance id '${instanceId}' is already registered by a live instance (pid ${existing.pid}${existing.checkout ? ` from ${existing.checkout}` : ''}); not overwriting it. This start will not be visible home-wide — use a distinct --instance name.\n`,
      );
      return;
    }
  } catch (error) {
    process.stderr.write(
      `\nWarning: could not record this instance in the home registry (${(error as Error).message}); lazy-start and the shared-home check will not see it.\n`,
    );
  }
}

/**
 * Remove this instance's registry entry on stop — identity-checked: only
 * when the entry's pid matches the record we are stopping, so a stop racing
 * a newer start of the same instance id cannot remove the newer entry.
 */
export function unregisterStopFromHomeRegistry(
  instanceId: string,
  projectHome: string,
  serverPid: number | null,
): void {
  try {
    // Same ownership guard as registration — never delete an entry another
    // surface owns, even on id collision — with identity and type checks
    // inside the shared module's lock (station#3047).
    removeOwnedInstance(instanceId, {
      home: projectHome,
      pid: serverPid,
      ownTypes: ['inline', 'worktree'],
    });
  } catch {
    // A corrupt registry must not block a stop. The stale entry degrades
    // gracefully anyway: its pid dies with the process, and every reader
    // filters on liveness.
  }
}

export function collectSharedHomeInstances(
  instanceId: string,
  projectHome: string,
  checkoutRecords: InstanceStateRecord[],
): string[] {
  const portsSeen = new Set<number>();
  const others: string[] = [];

  // Home-scoped first: spans checkouts, and where the Desktop sidecar
  // publishes. Read via `readInstanceRegistry` rather than `findRunning`
  // because that helper returns `Object.values(...)` and DISCARDS the registry
  // key — which is the only identity a home-scoped entry has. Without it the
  // Desktop app renders as its own type ("sidecar (sidecar)"), naming an
  // instance the user cannot find or stop.
  //
  // Self-exclusion is LOAD-BEARING since slice 2: `station start` now
  // publishes its own entry BEFORE the success-path warning runs, so without
  // the id check every start on a shared home warns about ITSELF. (An earlier
  // revision removed this check reasoning "start is not a producer here" —
  // true when written, silently falsified by the producer slice, and caught
  // live: instance B's warning listed r2904b.)
  //
  // Best-effort by construction: `readInstanceRegistry` THROWS on a corrupt or
  // loosely-permissioned registry, and this is a warning — it must not be the
  // thing that stops a start that would otherwise succeed.
  try {
    // `readInstanceRegistry` also throws when the HOME directory itself has
    // loose permissions — before it even checks whether a registry file
    // exists. A home with no registry has nothing to report and must not end
    // every start with a scary note, so absence is checked first.
    const registryExists = existsSync(resolveInstanceRegistryPath(projectHome));
    for (const [id, instance] of Object.entries(
      registryExists ? readInstanceRegistry(projectHome).instances : {},
    )) {
      if (id === instanceId) continue;
      if (typeof instance.pid !== 'number' || !isProcessAlive(instance.pid))
        continue;
      // Birth-fingerprint pid-reuse rejection, mirroring findRunning; the
      // shared predicate is fail-open on probe failure.
      if (birthProvesReuse(instance.birth, instance.pid)) continue;
      if (instance.port) portsSeen.add(instance.port);
      others.push(
        describeSharedHomeInstance({
          id,
          port: instance.port,
          type: instance.type,
          checkout: instance.checkout,
        }),
      );
    }
  } catch (error) {
    // Silence here would be indistinguishable from "nothing else is running",
    // on a feature whose whole thesis is that silence must mean something.
    process.stderr.write(
      `\nWarning: could not read the instance registry for ${projectHome}; the shared-home check was skipped (${(error as Error).message}).\n`,
    );
  }

  // Checkout-scoped: a sibling CLI instance from THIS checkout, which `start`
  // records here and not (yet) in the home registry. Deduped on PORT, because
  // two LIVE processes cannot share one port — so same-port records must
  // describe the same instance. Residual: a stale record whose pid or port
  // was reused can alias a real second instance out of the list; accepted,
  // since both liveness heuristics here predate this change.
  for (const record of findSharedHomeInstances(
    checkoutRecords,
    instanceId,
    projectHome,
  )) {
    if (portsSeen.has(record.serverPort)) continue;
    others.push(
      describeSharedHomeInstance({
        id: record.instanceId,
        port: record.serverPort,
        type: 'cli',
        checkout: record.cwd,
      }),
    );
  }

  return others;
}

/**
 * Refuse a genuinely-new start on a home another live instance owns
 * (station#2904 slice 2b — the warn→refuse graduation the product review
 * called for: "the ossification risk is not that the supervisor never
 * happens; it is that the warn never graduates to refuse").
 *
 * Scope, deliberately narrow: only a NEW start (no running match for this
 * instance in this checkout) refuses. A restart or promotion of an instance
 * that already coexists on the home is not a new writer — refusing it would
 * break workflows that predate the rule. The stores are not multi-writer
 * safe by decision (#2252), so a second writer is silent data loss, never a
 * supported configuration; `--allow-shared-home` exists for whoever needs
 * to override that judgment and owns the consequence.
 *
 * Best-effort like every registry read on this path: a corrupt registry
 * must not turn the refusal into a crash — the collector already degrades,
 * and an empty collision set proceeds.
 */
export function assertNoSharedHome(
  instanceId: string,
  projectHome: string,
  checkoutRecords: InstanceStateRecord[],
  allowSharedHome: boolean,
): void {
  const others = collectSharedHomeInstances(
    instanceId,
    projectHome,
    checkoutRecords,
  );
  if (others.length === 0) return;
  if (allowSharedHome) return; // the exit-path warning still fires

  throw new Error(
    [
      `start is blocked: another Station instance is already running on this home (${projectHome}).`,
      ...others.map((line) => `  - ${line}`),
      '',
      'Both instances would write the same conversation transcripts, and',
      'nothing coordinates writes BETWEEN processes — a concurrent update is',
      'lost with no error (station#2252, station#2904).',
      '',
      'Give this instance its own home:',
      '  station start --instance=<name> --base=<path> --port=<port> --ui-port=<ui-port>',
      '',
      'Or proceed anyway, owning the risk:  --allow-shared-home',
    ].join('\n'),
  );
}

/**
 * Emit the shared-home warning, sampled fresh at the call site.
 *
 * Called at BOTH start exits — the `Already running` early return and the
 * success report. An earlier revision sampled once before the build and
 * printed after it, which silently dropped the warning on the early-return
 * path: the most common, idempotent `station start`, and exactly the case
 * where two servers are already writing the same transcripts. Sampling at
 * each call site also keeps the present tense honest across a long build.
 */
function warnOnSharedHome(instanceId: string, projectHome: string): void {
  // NOTHING in here may throw past this frame. The success-path call site sits
  // inside start()'s try, whose catch STOPS the instance and reports a failed
  // start — so an exception here (listRunningInstances validates dir modes,
  // reclaims stale records under a lock, and races concurrent stops) would
  // tear down a healthy, fully-started instance over a warning. Caught by the
  // final pre-merge review after the previous round introduced exactly that.
  let others: string[];
  try {
    others = collectSharedHomeInstances(
      instanceId,
      projectHome,
      listRunningInstances(),
    );
  } catch (error) {
    process.stderr.write(
      `\nWarning: the shared-home check was skipped (${(error as Error).message}).\n`,
    );
    return;
  }
  if (others.length === 0) return;

  process.stderr.write(
    [
      '',
      `Warning: another Station instance is already running on this home (${projectHome}).`,
      ...others.map((line) => `  - ${line}`),
      '',
      'Both instances write the same conversation transcripts, and nothing',
      'coordinates writes BETWEEN processes — a concurrent update can be lost',
      'with no error (station#2252, station#2904).',
      '',
      'Give the second instance its own home:',
      '  station start --instance=<name> --base=<path> --port=<port> --ui-port=<ui-port>',
      '',
      '(--temp-home also works, but its home is discarded on every start, and',
      'service commands reject it.)',
      '',
    ].join('\n'),
  );
}

export function resolveBuildPaths(instanceId: string): BuildPaths {
  if (instanceId === DEFAULT_INSTANCE_ID) {
    return { server: 'dist-server', ui: 'dist-ui' };
  }
  return {
    server: `dist-server-${instanceId}`,
    ui: `dist-ui-${instanceId}`,
  };
}

function getBuildManifestPath(buildPaths: BuildPaths): string {
  return join(CWD, buildPaths.server, BUILD_MANIFEST_FILENAME);
}

function createCandidateBuildPaths(instanceId: string): {
  buildPaths: BuildPaths;
  root: string;
} {
  const parent = join(CWD, '.station', 'build-candidates');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, `${instanceId}-`));
  const relativeRoot = join('.station', 'build-candidates', basename(root));
  return {
    root,
    buildPaths: {
      server: join(relativeRoot, 'server'),
      ui: join(relativeRoot, 'ui'),
    },
  };
}

/**
 * station#1869: best-effort sweep of orphaned candidate dirs left by a
 * supervisor killed mid-build (launchd/systemd KeepAlive). Each candidate
 * dir name starts with its `<instanceId>-`, so only same-instance orphans
 * are removed — a sibling INSTANCE's in-flight build is never touched.
 *
 * It does NOT protect a concurrent build of the SAME instance: on POSIX
 * `rmSync` succeeds against a directory another process is actively writing
 * (there is no Windows-style share lock to fail on), so a same-instance
 * concurrent build would lose its candidate here. Nothing serializes that
 * today — `buildApplication` takes no lock — so this is an accepted, narrow
 * hazard: two builds of the SAME instance from the same checkout are already
 * unsupported (they also race on the promotion `renameSync`). The `catch`
 * below is for permission/ENOENT races, NOT for in-use protection
 * (station#1867 review round).
 */
export function pruneStaleBuildCandidates(instanceId: string): void {
  const parent = join(CWD, '.station', 'build-candidates');
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return;
  }
  const prefix = `${instanceId}-`;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    try {
      rmSync(join(parent, entry.name), { recursive: true, force: true });
    } catch {
      // A locked/busy directory belongs to an in-flight build — leave it.
    }
  }
}

function assertCandidateBuild(buildPaths: BuildPaths): BuildManifest {
  if (!hasCompleteBuildOutputs(buildPaths)) {
    throw new Error(
      'Candidate build did not produce complete server and UI artifacts.',
    );
  }
  const manifest = (() => {
    try {
      return validateBuildManifest(
        JSON.parse(readFileSync(getBuildManifestPath(buildPaths), 'utf-8')),
      );
    } catch {
      return null;
    }
  })();
  if (!manifest) {
    throw new Error(
      'Candidate build provenance manifest is missing or invalid.',
    );
  }
  return manifest;
}

class CandidatePromotionError extends Error {
  constructor(
    message: string,
    readonly preserveCandidateRoot: boolean,
  ) {
    super(message);
    this.name = 'CandidatePromotionError';
  }
}

function promoteCandidateBuild(
  candidateRoot: string,
  candidate: BuildPaths,
  active: BuildPaths,
): void {
  // Both candidates and both backups live on the checkout filesystem, so
  // each rename is atomic. The pair cannot be one filesystem transaction;
  // explicit rollback restores both prior directories if any rename fails.
  const activeServer = join(CWD, active.server);
  const activeUi = join(CWD, active.ui);
  const candidateServer = join(CWD, candidate.server);
  const candidateUi = join(CWD, candidate.ui);
  const previousServer = join(candidateRoot, 'previous-server');
  const previousUi = join(candidateRoot, 'previous-ui');
  let serverBackedUp = false;
  let uiBackedUp = false;
  let serverPromoted = false;
  let uiPromoted = false;

  try {
    if (existsSync(activeServer)) {
      renameSync(activeServer, previousServer);
      serverBackedUp = true;
    }
    if (existsSync(activeUi)) {
      renameSync(activeUi, previousUi);
      uiBackedUp = true;
    }
    renameSync(candidateServer, activeServer);
    serverPromoted = true;
    renameSync(candidateUi, activeUi);
    uiPromoted = true;
  } catch (promotionError) {
    const rollbackErrors: string[] = [];
    const rollback = (action: () => void) => {
      try {
        action();
      } catch (error) {
        rollbackErrors.push(
          error instanceof Error ? error.message : String(error),
        );
      }
    };
    if (uiPromoted)
      rollback(() => rmSync(activeUi, { recursive: true, force: true }));
    if (serverPromoted) {
      rollback(() => rmSync(activeServer, { recursive: true, force: true }));
    }
    if (uiBackedUp) rollback(() => renameSync(previousUi, activeUi));
    if (serverBackedUp)
      rollback(() => renameSync(previousServer, activeServer));

    const reason =
      promotionError instanceof Error
        ? promotionError.message
        : String(promotionError);
    throw new CandidatePromotionError(
      rollbackErrors.length === 0
        ? `Failed to promote candidate build; previous build restored. ${reason}`
        : `Failed to promote candidate build and restore the previous build. ${reason} Rollback errors: ${rollbackErrors.join('; ')} Recovery artifacts preserved at ${candidateRoot}.`,
      rollbackErrors.length > 0,
    );
  }
}

function validateBuildManifest(value: unknown): BuildManifest | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<BuildManifest>;
  if (
    typeof candidate.sha !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(candidate.sha) ||
    typeof candidate.branch !== 'string' ||
    candidate.branch.trim().length === 0 ||
    typeof candidate.builtAt !== 'string' ||
    !Number.isFinite(Date.parse(candidate.builtAt))
  ) {
    return null;
  }
  return {
    sha: candidate.sha,
    branch: candidate.branch,
    builtAt: candidate.builtAt,
  };
}

export function validatePackagedReleaseManifest(
  value: unknown,
): PackagedReleaseManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<PackagedReleaseManifest>;
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    'channel',
    'createdAt',
    'prerelease',
    'ref',
    'releaseChannel',
    'schemaVersion',
    'sha',
  ];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    candidate.schemaVersion !== 2 ||
    typeof candidate.sha !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(candidate.sha) ||
    typeof candidate.ref !== 'string' ||
    !/^[A-Za-z0-9._/-]{1,128}$/.test(candidate.ref) ||
    typeof candidate.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(candidate.createdAt)) ||
    new Date(Date.parse(candidate.createdAt)).toISOString() !==
      candidate.createdAt ||
    (candidate.channel !== 'stable' && candidate.channel !== 'beta') ||
    (candidate.releaseChannel !== 'stable' &&
      candidate.releaseChannel !== 'preview') ||
    candidate.channel !==
      (candidate.releaseChannel === 'preview' ? 'beta' : 'stable') ||
    candidate.prerelease !== (candidate.releaseChannel === 'preview') ||
    (candidate.releaseChannel === 'stable'
      ? !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(candidate.ref)
      : !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-preview\.(?:[1-9]\d*)$/.test(
          candidate.ref,
        ))
  ) {
    return null;
  }
  return {
    schemaVersion: 2,
    sha: candidate.sha,
    ref: candidate.ref,
    createdAt: candidate.createdAt,
    channel: candidate.channel,
    releaseChannel: candidate.releaseChannel,
    prerelease: candidate.prerelease,
  };
}

function resolveSourceBuildManifest(): BuildManifest {
  if (existsSync(join(CWD, '.git'))) {
    const git = resolveGitInfo(CWD);
    const sha = execSync('git rev-parse HEAD', {
      cwd: git.gitRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    const manifest = validateBuildManifest({
      sha,
      // Detached release checkouts report `HEAD`; the promotion runner can
      // retain the verified source branch explicitly without weakening the
      // immutable SHA derived from the checkout itself.
      branch: process.env.STATION_BUILD_BRANCH || git.branch,
      builtAt: new Date().toISOString(),
    });
    if (manifest) return manifest;
    throw new Error('Cannot write build provenance: git identity is invalid.');
  }

  const gitMetadataPath = join(CWD, '.git');
  const releaseManifestPath = join(CWD, PACKAGED_RELEASE_MANIFEST_FILENAME);
  const releaseManifest = (() => {
    try {
      return validatePackagedReleaseManifest(
        JSON.parse(readFileSync(releaseManifestPath, 'utf-8')),
      );
    } catch {
      return null;
    }
  })();
  if (!releaseManifest) {
    const manifestCondition = existsSync(releaseManifestPath)
      ? 'is invalid'
      : 'is missing';
    throw new Error(
      `Cannot write build provenance: Git metadata is absent at ${gitMetadataPath}; packaged release manifest ${manifestCondition} at ${releaseManifestPath}.`,
    );
  }
  return {
    sha: releaseManifest.sha,
    branch: releaseManifest.ref,
    builtAt: new Date().toISOString(),
  };
}

export function readBuildManifest(
  instanceId = DEFAULT_INSTANCE_ID,
): BuildManifest | null {
  try {
    return validateBuildManifest(
      JSON.parse(
        readFileSync(
          getBuildManifestPath(resolveBuildPaths(instanceId)),
          'utf-8',
        ),
      ),
    );
  } catch {
    return null;
  }
}

function resolveBuildTarget(options: BuildOptions = {}) {
  const serverPort = options.serverPort ?? DEFAULT_SERVER_PORT;
  const uiPort = options.uiPort ?? DEFAULT_UI_PORT;
  validateLifecyclePorts(serverPort, uiPort);
  const projectHome = resolveLifecycleHomeTarget({
    baseDir: options.baseDir,
  }).projectHome;
  const instanceId =
    options.instanceId ||
    resolveLifecycleInstanceId({
      instanceName: options.instanceName,
      projectHome,
      serverPort,
      uiPort,
    });
  return { instanceId, buildPaths: resolveBuildPaths(instanceId) };
}

export async function buildApplication(
  options: BuildOptions = {},
): Promise<BuildManifest> {
  const { instanceId, buildPaths: activeBuildPaths } =
    resolveBuildTarget(options);
  // station#1869: a supervisor (launchd/systemd KeepAlive) killed mid-build
  // leaves orphan candidate dirs under `.station/build-candidates/`. They do
  // not collide with a fresh `mkdtempSync`, but they accumulate, and a
  // promotion that preserved its candidate root (rollback errors) can leave a
  // `previous-*` dir that a later `renameSync` target may not be able to
  // overwrite — surfacing as ENOTEMPTY. Sweep stale siblings before creating
  // this build's candidate. Best-effort: a sweep failure does not block the
  // build, which creates its own unique candidate dir regardless.
  pruneStaleBuildCandidates(instanceId);
  const candidate = createCandidateBuildPaths(instanceId);
  console.log(`Building application for instance ${instanceId}...`);
  const buildEnv = {
    ...process.env,
    STATION_BUILD_SERVER_DIR: candidate.buildPaths.server,
    STATION_BUILD_UI_DIR: candidate.buildPaths.ui,
  };
  let preserveCandidateRoot = false;
  /**
   * station#3669: a failed build step must READ as a failed start. `execSync`
   * throws `Command failed: npm run build:ui`, which names the command but not
   * what it was for or what it cost — the reader is left to infer whether
   * anything was promoted or served. It was not: the candidate is discarded in
   * the `finally` below and `promoteCandidateBuild` is never reached, so the
   * previously active build stays exactly as it was and nothing is started.
   * Say that, on the first line of the failure, next to the step that failed.
   */
  const runBuildStep = (label: string, command: string) => {
    try {
      execSync(command, {
        cwd: CWD,
        stdio: 'inherit',
        env: buildEnv,
        windowsHide: true,
      });
    } catch (error) {
      // The step's OWN message stays in the text, not just in `cause`: it is
      // the only part that says what actually went wrong, and a wrapper that
      // replaces it makes the report shorter and less useful at once.
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${label} build failed (${command}): ${detail}\nThe start was ` +
          'refused — nothing was promoted and no server was started; the ' +
          'previous build is untouched.',
        { cause: error },
      );
    }
  };

  try {
    runBuildStep('Server', 'npm run build:server');
    runBuildStep('UI', 'npm run build:ui');

    const manifest = resolveSourceBuildManifest();
    writeFileSync(
      getBuildManifestPath(candidate.buildPaths),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const validatedManifest = assertCandidateBuild(candidate.buildPaths);
    promoteCandidateBuild(
      candidate.root,
      candidate.buildPaths,
      activeBuildPaths,
    );
    console.log(
      `  ✓ Built ${validatedManifest.sha} (${validatedManifest.branch})`,
    );
    return validatedManifest;
  } catch (error) {
    preserveCandidateRoot =
      error instanceof CandidatePromotionError && error.preserveCandidateRoot;
    throw error;
  } finally {
    if (!preserveCandidateRoot) {
      rmSync(candidate.root, { recursive: true, force: true });
    }
  }
}

export function isInstalled(instanceId = DEFAULT_INSTANCE_ID): boolean {
  return hasCompleteBuildOutputs(resolveBuildPaths(instanceId));
}

/** A complete build has the two regular files the supervised process serves. */
function hasCompleteBuildOutputs(buildPaths: BuildPaths): boolean {
  try {
    return (
      statSync(join(CWD, buildPaths.server, SERVER_ENTRY_FILENAME)).isFile() &&
      statSync(join(CWD, buildPaths.ui, 'index.html')).isFile()
    );
  } catch {
    return false;
  }
}

const SOURCE_EXTS = ['.ts', '.tsx', '.css', '.mjs'];
const SOURCE_SCAN_SKIP = new Set([
  'node_modules',
  'dist',
  '__tests__',
  'coverage',
  '.turbo',
  'build',
]);

function newestSourceMtimeMs(dir: string): number {
  const entries = (() => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  })();
  let newest = 0;
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SOURCE_SCAN_SKIP.has(entry.name))
      continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtimeMs(full));
    } else if (SOURCE_EXTS.some((ext) => entry.name.endsWith(ext))) {
      try {
        newest = Math.max(newest, statSync(full).mtimeMs);
      } catch {
        // Unreadable file; ignore.
      }
    }
  }
  return newest;
}

/**
 * True when the instance's built server bundle is not current — either its
 * entry is absent, or source files are newer than it (a `start` without
 * `--build` would run stale bytecode). Cheap heuristic: newest source mtime vs
 * the complete build's server entry mtime. Exported so the service supervisor
 * (`service-run.ts`) can decide to BUILD rather than warn — a stale build
 * under a launchd/systemd KeepAlive supervisor crashes on boot, the supervisor
 * restarts, and the loop repeats (station#1869). The absent-entry case is the
 * same loop by a different route (station#2271). The supervisor's stale-build
 * decision is its early defense; `start()` is the second defense, rebuilding
 * whenever `isInstalled()` rejects incomplete artifacts.
 */
export function isBuildStale(buildPaths: BuildPaths): boolean {
  if (!hasCompleteBuildOutputs(buildPaths)) return true;
  let buildMs: number;
  try {
    buildMs = statSync(
      join(CWD, buildPaths.server, SERVER_ENTRY_FILENAME),
    ).mtimeMs;
  } catch {
    // A failed stat is not current; fail closed so the supervisor rebuilds.
    return true;
  }
  const sourceMs = Math.max(
    newestSourceMtimeMs(join(CWD, 'src-server')),
    newestSourceMtimeMs(join(CWD, 'src-ui')),
    newestSourceMtimeMs(join(CWD, 'packages')),
  );
  return sourceMs > buildMs;
}

/**
 * Prints the sha this build serves against the current source's sha, and
 * warns when they differ, so reusing an existing build (no `--build`) never
 * looks silently truthful (station#3669b). Reuses `resolveSourceBuildManifest`
 * — the exact derivation `buildApplication` stamps into a build's own
 * manifest — rather than adding a second sha resolver; the mtime-based
 * `isBuildStale` check above answers a different question ("did source files
 * change since the build's mtime") and cannot detect a checkout that moved to
 * a different commit without touching file mtimes.
 */
function warnIfBuildStale(buildPaths: BuildPaths): void {
  if (isBuildStale(buildPaths)) {
    console.log(
      '⚠️  Source has changed since the last build — re-run with --build to pick up changes.',
    );
  }
  const servedManifest = validateBuildManifest(
    (() => {
      try {
        return JSON.parse(
          readFileSync(getBuildManifestPath(buildPaths), 'utf-8'),
        );
      } catch {
        return null;
      }
    })(),
  );
  if (!servedManifest) return;
  let headSha: string;
  try {
    headSha = resolveSourceBuildManifest().sha;
  } catch {
    // No git checkout and no packaged release manifest to compare against
    // (should not occur for a build that itself required one to be written);
    // nothing to report.
    return;
  }
  console.log(`  Serving build ${servedManifest.sha} (HEAD ${headSha})`);
  if (servedManifest.sha !== headSha) {
    console.log(
      `⚠️  Served build ${servedManifest.sha} does not match HEAD ${headSha} — re-run with --build to pick up changes.`,
    );
  }
}

// Measured cold starts are roughly 5.5s unloaded, but provider discovery on a
// busy development host can exceed 60s. One shared 90s budget remains bounded
// while preventing the durable service supervisor from killing a healthy boot
// before the outer service-install readiness gate can observe it. Under real
// host load even that budget can miss a healthy boot (#2646): when the caller
// supplies `childAlive`, the deadline extends — bounded, logged, and only for
// failure kinds consistent with a slow boot — see waitForIdentity.
const STARTUP_READINESS_TIMEOUT_MS = 90_000;
const IDENTITY_WAIT_EXTENSION_MS = 45_000;
const IDENTITY_WAIT_MAX_EXTENSIONS = 2;
/**
 * The WORST-CASE readiness budget, exported so the supervisors that bound this
 * wait state the relationship by computing it instead of restating a number
 * that silently drifts (#2646).
 *
 * `STARTUP_READINESS_TIMEOUT_MS` is a BASE, not a total: only a caller that
 * supplies `childAlive` can extend it, and today that is exactly `start()`'s
 * two waits. Every other budget in the tree that once matched 90s is now an
 * INDEPENDENT supervisor, not a mirror.
 */
export const STARTUP_READINESS_MAX_TIMEOUT_MS =
  STARTUP_READINESS_TIMEOUT_MS +
  IDENTITY_WAIT_EXTENSION_MS * IDENTITY_WAIT_MAX_EXTENSIONS;
const IDENTITY_REQUEST_TIMEOUT_MESSAGE = 'Identity readiness request timed out';
const INTERNAL_API_TOKEN_HEADER = 'x-station-internal-token';
const INTERNAL_PROXY_CALLER_HEADER = 'x-station-proxy-caller';

/**
 * Classification of one identity-wait attempt's failure (#2646). The kinds
 * that matter to the deadline policy:
 * - 'no-listener': the request failed at the network level — on this
 *   localhost boot path that means the child has not bound its TCP port yet
 *   (refused/reset/aborted connects dominate). Consistent with a slow boot.
 * - 'request-timeout': our own per-attempt deadline sentinel fired — a
 *   listener may exist but the HTTP round-trip stalled (load). Consistent
 *   with a slow boot.
 * - 'identity-mismatch': a process ANSWERED with the wrong boot triple —
 *   positive evidence something else owns the port (lost port race or a
 *   draining previous boot). Never grounds for extending the deadline.
 * - 'http-error': a listener answered non-2xx.
 */
export type IdentityWaitFailureKind =
  | 'no-listener'
  | 'request-timeout'
  | 'gateway-unavailable'
  | 'http-error'
  | 'identity-mismatch';

/**
 * The failure kinds consistent with a child that is still booting, and so the
 * only ones that may extend the readiness deadline.
 *
 * `gateway-unavailable` is here because of the HOSTED boot path: `start()`
 * probes the SERVER's identity through the UI port when a hosted probe
 * authority is in play, so "UI already up, server still booting" surfaces as
 * the proxy's own 502/503/504 rather than a refused connect. Treating that as
 * a hard error made the flagship slow-boot case the one case that could not
 * extend. It is deliberately narrow: 500 (a real server error), and every 4xx
 * (auth/config — more time cannot fix it), stay non-extendable `http-error`.
 */
const SLOW_BOOT_FAILURE_KINDS: ReadonlySet<IdentityWaitFailureKind> = new Set([
  'no-listener',
  'request-timeout',
  'gateway-unavailable',
]);

/** Proxy/upstream codes meaning "the thing behind me has not answered yet". */
const GATEWAY_UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([
  502, 503, 504,
]);

export function classifyIdentityWaitStatus(
  status: number,
): Extract<IdentityWaitFailureKind, 'gateway-unavailable' | 'http-error'> {
  return GATEWAY_UNAVAILABLE_STATUSES.has(status)
    ? 'gateway-unavailable'
    : 'http-error';
}

export function classifyIdentityWaitError(
  error: unknown,
): Extract<IdentityWaitFailureKind, 'no-listener' | 'request-timeout'> {
  const message = error instanceof Error ? error.message : String(error);
  return message === IDENTITY_REQUEST_TIMEOUT_MESSAGE
    ? 'request-timeout'
    : 'no-listener';
}

export interface IdentityWaitOptions {
  /**
   * Liveness probe for the supervised child whose readiness is being awaited.
   * Providing it opts into bounded deadline extension: when the base deadline
   * expires while the child is alive and the most recent failure is
   * 'no-listener' or 'request-timeout' (slow boot under load, #2646), the
   * wait extends by `extensionMs`, at most `maxExtensions` times, logging
   * each extension distinctly. An 'identity-mismatch' or 'http-error' at the
   * deadline never extends — those are positive evidence the port answers
   * and is not this child. A genuinely wedged boot is still killed at the
   * bounded cap (default 90s + 2×45s).
   */
  childAlive?: () => boolean;
  extensionMs?: number;
  maxExtensions?: number;
  log?: (line: string) => void;
}

export async function waitForIdentity(
  url: string,
  expected: { instanceId: string; sha: string; bootId: string },
  timeoutMs = STARTUP_READINESS_TIMEOUT_MS,
  headers?: Readonly<Record<string, string>>,
  options?: IdentityWaitOptions,
): Promise<void> {
  const extensionMs = options?.extensionMs ?? IDENTITY_WAIT_EXTENSION_MS;
  const maxExtensions = options?.maxExtensions ?? IDENTITY_WAIT_MAX_EXTENSIONS;
  const log = options?.log ?? console.log;
  let deadline = Date.now() + timeoutMs;
  let extensionsUsed = 0;
  let lastFailure = 'No response received';
  let lastKind: IdentityWaitFailureKind | null = null;
  while (true) {
    if (Date.now() >= deadline) {
      // Last-attempt-only by design: a mismatch followed by a refused connect
      // re-enables extension. That is correct (the port owner went away, so
      // this child may yet win it) and stays bounded by maxExtensions.
      const extendable =
        lastKind !== null && SLOW_BOOT_FAILURE_KINDS.has(lastKind);
      if (
        !options?.childAlive ||
        !extendable ||
        extensionsUsed >= maxExtensions ||
        !options.childAlive()
      ) {
        break;
      }
      extensionsUsed += 1;
      deadline = Date.now() + extensionMs;
      log(
        `⏳ Startup readiness deadline extended (+${Math.round(extensionMs / 1000)}s, ${extensionsUsed}/${maxExtensions}) for ${url}: child process alive, last failure "${lastFailure}" (${lastKind}) — slow boot under load, not a lost port race`,
      );
    }
    const remainingMs = deadline - Date.now();
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadlineExceeded = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(IDENTITY_REQUEST_TIMEOUT_MESSAGE));
          controller.abort();
        }, remainingMs);
      });
      const response = await Promise.race([
        requestIdentity(url, controller.signal, headers),
        deadlineExceeded,
      ]);
      if (response.ok) {
        const actual = (await Promise.race([
          response.json(),
          deadlineExceeded,
        ])) as Partial<typeof expected>;
        if (
          actual.instanceId === expected.instanceId &&
          actual.sha === expected.sha &&
          actual.bootId === expected.bootId
        ) {
          return;
        }
        lastFailure = 'managed boot identity mismatch';
        lastKind = 'identity-mismatch';
      } else {
        lastFailure = `${response.status} ${response.statusText}`.trim();
        lastKind = classifyIdentityWaitStatus(response.status);
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      lastKind = classifyIdentityWaitError(error);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    const retryDelayMs = Math.min(200, Math.max(0, deadline - Date.now()));
    if (retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw new Error(`Timed out waiting for ${url} (${lastFailure})`);
}

async function probeIdentityOnce(
  url: string,
  expected: { instanceId: string; sha: string; bootId: string },
  timeoutMs = 3_000,
  headers?: Readonly<Record<string, string>>,
): Promise<IdentityProbeOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1, Math.floor(timeoutMs)),
  );
  try {
    const response = await requestIdentity(url, controller.signal, headers);
    if (response.status === 401 || response.status === 403)
      return 'http-auth-refused';
    if (!response.ok) return 'unreachable';
    const actual = (await response.json()) as Partial<typeof expected>;
    return actual.instanceId === expected.instanceId &&
      actual.sha === expected.sha &&
      actual.bootId === expected.bootId
      ? 'ok'
      : 'identity-mismatch';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Ask the UI child to attest that its exact sibling backend is ready. The UI
 * owns the per-boot credential and compares the backend boot triple before it
 * returns `ready`, so service/status callers do not need to persist or recover
 * that credential from process state.
 */
async function probeBackendReadinessOnce(
  url: string,
  timeoutMs = 3_000,
  headers?: Readonly<Record<string, string>>,
): Promise<IdentityProbeOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1, Math.floor(timeoutMs)),
  );
  try {
    const response = await requestIdentity(url, controller.signal, headers);
    if (response.status === 401 || response.status === 403)
      return 'http-auth-refused';
    if (!response.ok) return 'unreachable';
    const readiness = (await response.json()) as {
      ready?: unknown;
      status?: unknown;
    };
    return readiness.ready === true && readiness.status === 'ready'
      ? 'ok'
      : 'unreachable';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Single-shot listener probe for slow-vs-dead discrimination (station#1846).
 * Returns false ONLY on a definitive refusal (ECONNREFUSED — nothing is bound
 * to the port — or ECONNRESET during the handshake). Every other failure
 * reports true: a connect timeout means the kernel never rejected the SYN (a
 * bound socket is answered by the kernel even when the owning process is
 * starved), and errors like EADDRNOTAVAIL/EADDRINUSE (local ephemeral-port
 * exhaustion — a busy-host symptom, exactly the #1846 regime) or
 * EHOSTUNREACH/ENETDOWN (route flap to an explicit non-loopback host) say
 * nothing about the child at all. Ambiguity must stay on the
 * tolerate/escalate path; only refusal is death evidence.
 */
function probeTcpListenerOnce(
  host: string,
  port: number,
  timeoutMs = 2_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (listening: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(Math.max(1, Math.floor(timeoutMs)));
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(true));
    socket.once('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(code !== 'ECONNREFUSED' && code !== 'ECONNRESET');
    });
  });
}

/**
 * Node's fetch may append its own Host field to a caller-supplied Host. The
 * hosted ingress deliberately rejects duplicate Host fields, so use the node
 * HTTP client only for these internal exact-host probes. Local mode keeps its
 * existing fetch path byte-for-byte.
 */
function requestIdentity(
  url: string,
  signal: AbortSignal,
  headers?: Readonly<Record<string, string>>,
): Promise<Response> {
  if (!headers?.Host) {
    return fetch(url, {
      headers: { Accept: 'application/json', ...headers },
      signal,
    });
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        headers: { Accept: 'application/json', ...headers },
        signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value))
              responseHeaders.set(name, value.join(', '));
            else if (value !== undefined) responseHeaders.set(name, value);
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              headers: responseHeaders,
              status: response.statusCode ?? 502,
            }),
          );
        });
      },
    );
    request.once('error', reject);
    request.end();
  });
}

/**
 * Read-only process and boot-identity status for one named lifecycle instance.
 *
 * `reclaimStale: false` keeps that description literally true (station#2745).
 * The default still reclaims, because a lifecycle command asking for status is
 * about to act on it; a reporting caller must pass `false` so reading status
 * cannot take a synchronous file-mutation lock.
 */
export async function collectInstanceStatus(
  instanceName: string,
  options: { probeTimeoutMs?: number; reclaimStale?: boolean } = {},
): Promise<CollectedInstanceStatus> {
  const instanceId = normalizeInstanceName(instanceName);
  const record = listRunningInstances({
    reclaimStale: options.reclaimStale,
  }).find((candidate) => candidate.instanceId === instanceId);
  if (!record) {
    return {
      found: false,
      healthy: false,
      instanceId,
      server: {
        listening: false,
        pid: null,
        probe: 'unreachable',
        reachable: false,
      },
      ui: {
        listening: false,
        pid: null,
        probe: 'unreachable',
        reachable: false,
      },
    };
  }
  const sha = record.build?.sha;
  const bootId = record.bootId;
  if (!sha || !bootId) {
    return {
      bootId,
      found: true,
      healthy: false,
      instanceId,
      server: {
        listening: false,
        pid: record.serverPid,
        probe: 'unreachable',
        reachable: false,
      },
      sha,
      ui: {
        listening: false,
        pid: record.uiPid,
        probe: 'unreachable',
        reachable: false,
      },
    };
  }
  const expected = { instanceId, sha, bootId };
  const probeHost =
    record.host === '0.0.0.0' || record.host === '::'
      ? '127.0.0.1'
      : record.host;
  const host = probeHost.includes(':') ? `[${probeHost}]` : probeHost;
  const hostedProbeHeaders = record.hostedProbeAuthority
    ? { Host: record.hostedProbeAuthority }
    : undefined;
  const [serverProbe, uiProbe] = await Promise.all([
    probeBackendReadinessOnce(
      `http://${host}:${record.uiPort}/api/system/readiness`,
      options.probeTimeoutMs,
      hostedProbeHeaders,
    ),
    probeIdentityOnce(
      `http://${host}:${record.uiPort}/__station/identity`,
      expected,
      options.probeTimeoutMs,
      hostedProbeHeaders,
    ),
  ]);
  // The socket check runs only when the HTTP probe failed, so the healthy
  // path stays as cheap as before. It always targets the local child ports
  // directly (never the hosted ingress authority) — the question it answers
  // is whether the local child still holds its listener.
  // Bounded by the caller's probe budget so tightly budgeted callers (the
  // service install readiness poll) are not overrun by the socket check.
  const tcpProbeTimeoutMs = Math.min(2_000, options.probeTimeoutMs ?? 2_000);
  const [serverListening, uiListening] = await Promise.all([
    serverProbe === 'ok'
      ? true
      : probeTcpListenerOnce(probeHost, record.serverPort, tcpProbeTimeoutMs),
    uiProbe === 'ok'
      ? true
      : probeTcpListenerOnce(probeHost, record.uiPort, tcpProbeTimeoutMs),
  ]);
  return {
    bootId,
    found: true,
    healthy: serverProbe === 'ok' && uiProbe === 'ok',
    instanceId,
    server: {
      listening: serverListening,
      pid: record.serverPid,
      probe: serverProbe,
      reachable: serverProbe === 'ok',
    },
    sha,
    ui: {
      listening: uiListening,
      pid: record.uiPid,
      probe: uiProbe,
      reachable: uiProbe === 'ok',
    },
  };
}

/**
 * The runtime's own consent-listener availability, from the server's
 * `/api/system/instance` self-report (station#3677 review MED 4). Returns
 * the unavailable shape on any transport/parse failure — the consent line
 * must FAIL CLOSED, never read green off an unverifiable answer.
 */
async function fetchConsentAvailability(
  instanceUrl: string,
  headers: Record<string, string>,
): Promise<{ status: 'listening'; port: number } | { status: 'unavailable' }> {
  try {
    const response = await fetch(instanceUrl, {
      headers: { ...headers, Accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { status: 'unavailable' };
    const body = (await response.json()) as {
      consent?: { status?: unknown; port?: unknown };
    };
    if (
      body.consent?.status === 'listening' &&
      typeof body.consent.port === 'number'
    ) {
      return { status: 'listening', port: body.consent.port };
    }
    return { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

async function waitForTcpOk(
  host: string,
  port: number,
  timeoutMs = STARTUP_READINESS_TIMEOUT_MS,
): Promise<void> {
  const probeHost =
    host === '0.0.0.0' ? 'localhost' : host === '::' ? '::1' : host;
  const deadline = Date.now() + timeoutMs;
  let lastFailure = 'No connection established';

  while (Date.now() < deadline) {
    const outcome = await new Promise<{ ok: boolean; failure?: string }>(
      (resolve) => {
        const socket = createConnection({ host: probeHost, port });
        let settled = false;
        const finish = (result: { ok: boolean; failure?: string }) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve(result);
        };
        socket.setTimeout(Math.min(1_000, Math.max(1, deadline - Date.now())));
        socket.once('connect', () => finish({ ok: true }));
        socket.once('timeout', () => finish({ ok: false, failure: 'timeout' }));
        socket.once('error', (error) =>
          finish({ ok: false, failure: error.message }),
        );
      },
    );
    if (outcome.ok) return;
    lastFailure = outcome.failure ?? lastFailure;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(
    `Timed out waiting for TCP listener ${probeHost}:${port} (${lastFailure})`,
  );
}

export async function start(opts: StartOptions = {}): Promise<void> {
  const { build, features, force } = opts;
  const host = normalizeLifecycleHost(opts.host);
  const {
    serverPort,
    uiPort,
    consentPort,
    projectHome,
    homeSource,
    instanceId,
    statePath,
  } = resolveStartTarget(opts);
  const hasExplicitLogFile = opts.logFile !== undefined;
  if (hasExplicitLogFile && !isAbsolute(opts.logFile!)) {
    throw new Error('Explicit log path must be absolute');
  }
  let logFile = resolve(
    opts.logFile ?? join(projectHome, 'logs', `station-${instanceId}.log`),
  );
  validateLifecyclePorts(serverPort, uiPort, consentPort);
  for (const [label, file] of [
    ['lifecycle journal', opts.lifecycleJournal],
    ['readiness file', opts.readinessFile],
  ] as const) {
    if (!file) continue;
    if (!isAbsolute(file)) throw new Error(`${label} path must be absolute`);
    const relation = relative(resolve(projectHome), resolve(file));
    if (
      relation === '' ||
      (!relation.startsWith('..') && !isAbsolute(relation))
    ) {
      throw new Error(`${label} must remain outside STATION_HOME`);
    }
  }
  const normalizedSelector = normalizeSelector({ instanceId });
  // Deployment configuration is parsed before either child process starts.
  const hostedTenantRegistry = loadHostedTenantRegistryForLifecycle();
  const hostedProbeAuthority = hostedTenantRegistry?.tenants[0]?.authority;
  const hostedProbeHeaders = hostedProbeAuthority
    ? { Host: hostedProbeAuthority }
    : undefined;
  const runningMatch = ensureSingleMatch(
    listRunningInstances().filter((record) =>
      matchesSelector(record, normalizedSelector),
    ),
    'start',
  );
  // The home schema gate runs in the logDirectoryIsInsideHome block below —
  // after the recursive mkdir, because the gate requires the home's parent to
  // exist and a custom --base path may have a multi-level missing ancestor
  // chain (#1570 review; supersedes the earlier pre-mkdir call from #1567).
  const buildPaths = resolveBuildPaths(instanceId);
  const needsBuild = Boolean(build) || !isInstalled(instanceId);

  assertNoPortConflicts(instanceId, serverPort, uiPort, consentPort);
  // Refuse a NEW start on a shared home (see assertNoSharedHome). Placed
  // before the build so a refused start costs seconds, not minutes; sampled
  // fresh at the exits regardless, so the warning covers anything that
  // changes during a long build. `runningMatch` scopes it to genuinely-new
  // starts — restarts and promotions of an already-coexisting instance are
  // not new writers.
  if (!runningMatch) {
    assertNoSharedHome(
      instanceId,
      projectHome,
      listRunningInstances(),
      opts.allowSharedHome ?? false,
    );
  }

  if (needsBuild) {
    await buildApplication(opts);
    if (runningMatch) {
      notifyBuildUpdated(runningMatch.serverPort);
      stopRecord(runningMatch, false, 'promotion');
    }
  } else if (runningMatch) {
    if (!force) {
      warnIfBuildStale(buildPaths);
      console.log(
        `✓ Already running\n  UI:   http://localhost:${runningMatch.uiPort}\n  Stop: station stop --instance=${runningMatch.instanceId}`,
      );
      if (typeof runningMatch.serverPid === 'number') {
        // Idempotent refresh: heals an instance started before the CLI was a
        // registry producer, and one whose original write failed. Same-pid
        // re-upsert of our own entry; anything foreign is declined by the
        // ownership guards inside.
        registerStartInHomeRegistry(
          runningMatch.instanceId,
          projectHome,
          runningMatch.serverPort,
          runningMatch.uiPort,
          runningMatch.serverPid,
          runningMatch.consentPort,
        );
      }
      warnOnSharedHome(instanceId, projectHome);
      return;
    }
    console.log('Restarting instance (reusing existing build)...');
    warnIfBuildStale(buildPaths);
    stopRecord(runningMatch, false, opts.intent ?? 'operator_stop');
    if (opts.rotateLogOnRestart && logFile && existsSync(logFile)) {
      const previousLog = `${logFile}.previous`;
      if (existsSync(previousLog)) unlinkSync(previousLog);
      renameSync(logFile, previousLog);
    }
  } else {
    warnIfBuildStale(buildPaths);
  }

  announceHome(projectHome, homeSource);

  let serverStdio: any = 'ignore';
  let logDescriptor: number | null = null;
  const requestedLogDirectory = dirname(logFile);
  const homeRelation = relative(resolve(projectHome), requestedLogDirectory);
  const logDirectoryIsInsideHome =
    homeRelation === '' ||
    (!homeRelation.startsWith('..') && !isAbsolute(homeRelation));
  const logDirectoryExisted = existsSync(requestedLogDirectory);
  if (hasExplicitLogFile && !logDirectoryExisted && !logDirectoryIsInsideHome) {
    throw new Error(
      'Explicit log directory outside STATION_HOME must already exist',
    );
  }

  let logDirectory = requestedLogDirectory;
  if (logDirectoryIsInsideHome) {
    // An empty home directory is gate-safe scaffolding, and the recursive
    // mkdir must come first: the gate requires the home's parent to exist,
    // and a custom --base path may have a multi-level missing ancestor chain.
    mkdirSync(projectHome, { recursive: true, mode: 0o700 });
    // Writing logs/ into a home the server has not gated yet would make a
    // brand-new home fail the #1560 schema gate on first boot (#1570). The
    // CLI ships in lockstep with the server, so running the same gate here
    // either bootstraps the marker or fails closed with the server's exact
    // error — before anything is written or spawned.
    ensureStationHomeSchemaSync(projectHome);
    let current = resolve(projectHome);
    for (const segment of homeRelation.split(/[\\/]+/).filter(Boolean)) {
      current = join(current, segment);
      if (existsSync(current)) {
        const info = lstatSync(current);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new Error(
            `Log directory ancestor must be a directory: ${current}`,
          );
        }
      } else {
        mkdirSync(current, { mode: 0o700 });
      }
    }
    logDirectory = current;
  } else {
    const requestedInfo = lstatSync(requestedLogDirectory);
    if (!requestedInfo.isDirectory() || requestedInfo.isSymbolicLink()) {
      throw new Error(
        `Log directory must be a directory: ${requestedLogDirectory}`,
      );
    }
    logDirectory = realpathSync(requestedLogDirectory);
    logFile = join(logDirectory, basename(logFile));
  }

  const directoryInfo = lstatSync(logDirectory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error(`Log directory must be a directory: ${logDirectory}`);
  }
  if (
    typeof process.getuid === 'function' &&
    directoryInfo.uid !== process.getuid()
  ) {
    throw new Error(
      `Log directory must be owned by the current user: ${logDirectory}`,
    );
  }
  if (!hasExplicitLogFile || !logDirectoryExisted) {
    chmodSync(logDirectory, 0o700);
  }
  {
    if (existsSync(logFile)) {
      const info = lstatSync(logFile);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`Log path must be a regular file: ${logFile}`);
      }
      if (
        typeof process.getuid === 'function' &&
        info.uid !== process.getuid()
      ) {
        throw new Error(
          `Log path must be owned by the current user: ${logFile}`,
        );
      }
    }
    logDescriptor = openSync(
      logFile,
      fsConstants.O_APPEND |
        fsConstants.O_CREAT |
        fsConstants.O_WRONLY |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const openedInfo = fstatSync(logDescriptor);
    if (!openedInfo.isFile()) {
      closeSync(logDescriptor);
      logDescriptor = null;
      throw new Error(`Log path must be a regular file: ${logFile}`);
    }
    if (
      typeof process.getuid === 'function' &&
      openedInfo.uid !== process.getuid()
    ) {
      closeSync(logDescriptor);
      logDescriptor = null;
      throw new Error(`Log path must be owned by the current user: ${logFile}`);
    }
    fchmodSync(logDescriptor, 0o600);
    serverStdio = ['ignore', logDescriptor, logDescriptor];
  }

  const serverEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PORT: String(serverPort),
    // Root the child at the home this spawn actually chose. A bare
    // `resolveStationRoot()` reads only ambient env, and `--home`, `--base`
    // and `--temp-home` never write to `process.env` — so it returned
    // `~/.station` while STATION_HOME below named an isolated directory,
    // handing the child an explicit root it does not own.
    //
    // `spawnedStationRoot` returns undefined for a self-rooted home, and the
    // key is then dropped rather than spelled out: the child's admission guard
    // reads an explicit `STATION_ROOT` equal to `STATION_HOME` as a home
    // swallowing a foreign root and refuses to boot. The child derives the
    // identical root from STATION_HOME alone.
    STATION_HOME: projectHome,
    // Resolved from the CLI flag/default decision, never inherited. Runtime
    // test seams may trust `--temp-home` only through this spawn-owned fact.
    STATION_HOME_SOURCE: homeSource,
    STATION_INSTANCE_ID: instanceId,
    STATION_INSTANCE_STATE_PATH: statePath,
    STATION_HOST: host,
    // The sibling UI listener's port. The server never binds it, but a
    // `tailscale serve` mapping published for this Station usually targets
    // the UI proxy rather than the API, so the API needs it to recognise
    // that mapping as its own when resolving a pairing endpoint
    // (station#3379 follow-up).
    STATION_UI_PORT: String(uiPort),
    // The consent listener's port (station#3677). The runtime defaults to
    // PORT + 3 when unset; the CLI always passes the resolved value so an
    // explicit --consent-port survives to the process that binds it.
    STATION_CONSENT_PORT: String(consentPort),
  };
  // Set or removed, never left to the inherited value: an ambient
  // `STATION_ROOT` that this spawn's home does not belong under would
  // otherwise survive the spread.
  const spawnRoot = spawnedStationRoot(projectHome, process.env);
  if (spawnRoot) serverEnv.STATION_ROOT = spawnRoot;
  else delete serverEnv.STATION_ROOT;
  // This marker is a capability for precisely the server spawn governed by
  // service-run. Never inherit it through a server-initiated lifecycle call.
  delete serverEnv.STATION_SUPERVISOR_PID;
  const internalApiToken = randomBytes(32).toString('base64url');
  const uiBootstrapToken = randomBytes(32).toString('base64url');
  serverEnv.STATION_INTERNAL_API_TOKEN = internalApiToken;
  serverEnv.STATION_UI_BOOTSTRAP_TOKEN = uiBootstrapToken;
  serverEnv.ALLOWED_ORIGINS = [
    ...new Set([
      ...(serverEnv.ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
      // Persisted service-manifest origins arrive here as start options via
      // the generated unit's --allowed-origin args (#1672).
      ...(opts.allowedOrigins ?? []),
      `http://localhost:${uiPort}`,
      `http://127.0.0.1:${uiPort}`,
      `http://[::1]:${uiPort}`,
      ...(host && host !== '0.0.0.0' && host !== '::'
        ? [`http://${host}:${uiPort}`, `https://${host}:${uiPort}`]
        : []),
    ]),
  ].join(',');
  const buildManifest = readBuildManifest(instanceId);
  const bootId = randomUUID();
  serverEnv.STATION_BUILD_SHA = buildManifest?.sha ?? 'unknown';
  serverEnv.STATION_BUILD_BRANCH = buildManifest?.branch ?? 'unknown';
  serverEnv.STATION_BUILD_BUILT_AT = buildManifest?.builtAt ?? 'unknown';
  serverEnv.STATION_BOOT_ID = bootId;
  if (opts.supervisorPid !== undefined) {
    serverEnv.STATION_SUPERVISOR_PID = String(opts.supervisorPid);
  }
  if (opts.lifecycleJournal) {
    serverEnv.STATION_LIFECYCLE_JOURNAL = opts.lifecycleJournal;
  }
  if (features) serverEnv.STATION_FEATURES = features;
  serverEnv.STATION_LOG_FILE = logFile;

  let serverProc: ReturnType<typeof spawn>;
  try {
    serverProc = spawn(
      process.execPath,
      [`${buildPaths.server}/${SERVER_ENTRY_FILENAME}`],
      {
        cwd: CWD,
        stdio: serverStdio,
        detached: true,
        windowsHide: true,
        env: serverEnv,
      },
    );
    if (logDescriptor !== null) {
      writeSync(
        logDescriptor,
        `\n--- ${new Date().toISOString()} station lifecycle start instance=${instanceId} build=${serverEnv.STATION_BUILD_SHA} pid=${serverProc.pid ?? 'unknown'} ---\n`,
      );
    }
  } finally {
    if (logDescriptor !== null) closeSync(logDescriptor);
  }
  let uiProc: ReturnType<typeof spawn> | undefined;
  try {
    serverProc.unref();
    if (opts.lifecycleJournal && serverProc.pid) {
      appendLifecycleEvent(opts.lifecycleJournal, {
        instanceId,
        sha: buildManifest?.sha ?? 'unknown',
        bootId,
        pid: serverProc.pid,
        type: 'started',
        sender: 'unknown',
        timestamp: new Date().toISOString(),
      });
    }

    // Only inject an absolute API base into index.html when explicitly
    // overridden — with no override, the client's own same-origin fallback
    // (`window.location.origin`) resolves correctly for localhost, a LAN/
    // tailnet host, or a single-origin HTTPS reverse proxy. `upstreamPort` is
    // always passed so the UI server's reverse proxy (see `uiRequestHandler`)
    // knows where to forward backend calls regardless of the override.
    const apiBaseOverride = process.env.STATION_API_BASE || undefined;
    uiProc = spawn(
      process.execPath,
      [
        '-e',
        buildUiServerScript({
          uiDir: join(CWD, buildPaths.ui),
          apiBaseOverride,
          upstreamPort: serverPort,
          uiPort,
          host,
          readinessFile: opts.readinessFile,
          identity: {
            instanceId,
            sha: buildManifest?.sha ?? 'unknown',
            bootId,
          },
          hostedTenantAuthorities: hostedTenantRegistry
            ? { ...hostedTenantRegistry.authorityToTenant }
            : undefined,
        }),
      ],
      {
        cwd: CWD,
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
        env: (() => {
          const uiEnv: Record<string, string> = {
            ...(process.env as Record<string, string>),
            STATION_INTERNAL_API_TOKEN: internalApiToken,
          };
          // The UI child is never supervised by the server's parent watchdog.
          delete uiEnv.STATION_SUPERVISOR_PID;
          return uiEnv;
        })(),
      },
    );
    uiProc.unref();

    const serverFingerprint = serverProc.pid
      ? captureStableProcessFingerprint(serverProc.pid)
      : null;
    const uiFingerprint = uiProc.pid
      ? captureStableProcessFingerprint(uiProc.pid)
      : null;
    if (opts.lifecycleJournal && (!serverFingerprint || !uiFingerprint)) {
      throw new Error(
        'Managed start could not capture authenticated process fingerprints',
      );
    }

    writeInstanceState({
      instanceId,
      bootId,
      serverPid: serverProc.pid ?? null,
      serverFingerprint: serverFingerprint ?? undefined,
      uiPid: uiProc.pid ?? null,
      uiFingerprint: uiFingerprint ?? undefined,
      serverPort,
      consentPort,
      uiPort,
      baseDir: projectHome,
      build: buildManifest,
      homeSource,
      host,
      startedAt: new Date().toISOString(),
      cwd: CWD,
      statePath,
      lifecycleJournal: opts.lifecycleJournal,
      logFile,
      readinessFile: opts.readinessFile,
      hostedProbeAuthority,
    });
  } catch (error) {
    for (const child of [uiProc, serverProc]) {
      try {
        child?.kill('SIGTERM');
      } catch {
        // Best-effort rollback before the instance record is available.
      }
    }
    throw error;
  }

  try {
    process.kill(serverProc.pid!, 0);
    process.kill(uiProc.pid!, 0);
    const healthHost = hostForUrl(host);
    const readinessHeaders = {
      ...hostedProbeHeaders,
      [INTERNAL_API_TOKEN_HEADER]: internalApiToken,
      [INTERNAL_PROXY_CALLER_HEADER]: 'local',
    };
    // #2646: the readiness waits pass `childAlive` so a slow boot on a loaded
    // host extends the deadline (bounded, logged) instead of killing a healthy
    // child — while an identity mismatch (lost port race) still fails at the
    // base deadline.
    const childAliveProbe = (pid: number | undefined) => () => {
      if (!pid) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
      }
    };
    await Promise.all([
      waitForIdentity(
        hostedProbeAuthority
          ? `http://${healthHost}:${uiPort}/api/system/identity`
          : `http://${healthHost}:${serverPort}/api/system/identity`,
        { instanceId, sha: serverEnv.STATION_BUILD_SHA, bootId },
        STARTUP_READINESS_TIMEOUT_MS,
        readinessHeaders,
        { childAlive: childAliveProbe(serverProc.pid) },
      ),
      waitForTcpOk(host, serverPort + 1),
      waitForTcpOk(host, serverPort + 2),
      // station#1177 (review MED): the UI wait must validate the SAME boot
      // identity as the server wait — a competing instance's UI answering
      // 200 here let a lost port race look like a successful start. The
      // expected sha mirrors EXACTLY what buildUiServerScript was handed
      // above (`buildManifest?.sha ?? 'unknown'`), not the server env —
      // the two can legitimately differ in harness boots.
      waitForIdentity(
        `http://${healthHost}:${uiPort}/__station/identity`,
        {
          instanceId,
          sha: buildManifest?.sha ?? 'unknown',
          bootId,
        },
        STARTUP_READINESS_TIMEOUT_MS,
        hostedProbeHeaders,
        { childAlive: childAliveProbe(uiProc.pid) },
      ),
    ]);
    const activeApiBase = activeLocalApiBase(host, serverPort);
    if (activeApiBase) {
      publishActiveLocalStation(
        { apiBase: activeApiBase, ownerPid: serverProc.pid! },
        projectHome,
      );
    }
    // A SUPERVISED start does not produce here (station#3064): the service
    // supervisor publishes its own liveness onto the service-typed entry it
    // owns, keeping `env.ALLOWED_ORIGINS` intact. Registering the server
    // child under this id would be refused by the protected-type guard
    // anyway — and would print a "choose a different --instance name"
    // warning at every supervised boot, advice that is wrong for a unit
    // whose id was chosen at install.
    if (opts.supervisorPid === undefined) {
      registerStartInHomeRegistry(
        instanceId,
        projectHome,
        serverPort,
        uiPort,
        serverProc.pid!,
        consentPort,
      );
    }
    console.log(`\n  ✓ Server: http://${healthHost}:${serverPort}`);
    console.log(
      `  ✓ UI:     http://${healthHost}:${uiPort}/#station-ui-bootstrap=${uiBootstrapToken}`,
    );
    // station#3677 (owner decision 3): the consent listener fails CLOSED but
    // never fails the START. Review MED 4: the report derives from the
    // RUNTIME'S OWN availability state (`/api/system/instance`, served by
    // the identity-verified server above) — a TCP probe of the consent port
    // proves only that SOMETHING accepted a socket, so an unrelated process
    // squatting the port read as a healthy consent surface while Station had
    // actually failed closed. The hosted-tenant runtime intentionally never
    // binds the listener, so it is not queried there.
    const consentState = hostedProbeAuthority
      ? null
      : await fetchConsentAvailability(
          `http://${healthHost}:${serverPort}/api/system/instance`,
          readinessHeaders,
        );
    if (consentState?.status === 'listening') {
      console.log(`  ✓ Consent: http://${healthHost}:${consentState.port}`);
    } else {
      // Truthful, never degrade-open: Station is up, approvals are not.
      console.log(
        `  ✗ Consent listener unavailable (expected port ${consentPort}) — approvals are unavailable until it binds.`,
      );
    }
    // Unconditional: the home is the one fact a start banner can carry that
    // tells an operator whether this instance is isolated, and it was printed
    // only for `--temp-home` — so the boot that silently used the real
    // `~/.station` looked exactly like an isolated one (station#4299).
    console.log(
      `  ✓ Home:   ${projectHome} (${describeHomeSource(homeSource)})`,
    );
    console.log(`  ✓ Instance: ${instanceId}`);
    console.log(`\n  Stop with: station stop --instance=${instanceId}`);
    // Last thing the user sees: emitted after the start report so a
    // multi-minute build cannot bury it, and sampled here so the present
    // tense is true when it prints.
    warnOnSharedHome(instanceId, projectHome);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      stop({ instanceId });
    } catch (cleanupError) {
      const cleanupMessage =
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError);
      throw new Error(
        `Failed to start instance ${instanceId}. ${message}\nCleanup also failed: ${cleanupMessage}`,
        { cause: new AggregateError([error, cleanupError]) },
      );
    }
    throw new Error(`Failed to start instance ${instanceId}. ${message}`, {
      cause: error,
    });
  }
}

function loadHostedTenantRegistryForLifecycle():
  | HostedTenantRegistry
  | undefined {
  const file = process.env.STATION_HOSTED_TENANT_REGISTRY_FILE;
  if (file === undefined) return undefined;
  if (!file || file !== file.trim() || !isAbsolute(file)) {
    throw new Error(
      'STATION_HOSTED_TENANT_REGISTRY_FILE must name a regular file',
    );
  }
  let raw: string;
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('not regular');
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      'STATION_HOSTED_TENANT_REGISTRY_FILE must name a readable regular file',
    );
  }
  try {
    return parseHostedTenantRegistry(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `Invalid hosted tenant registry: ${error instanceof Error ? error.message : 'invalid JSON'}`,
    );
  }
}

export function stop(opts: StopOptions = {}): void {
  const normalizedSelector = normalizeSelector(opts);
  const matches = listRunningInstances().filter((record) =>
    matchesSelector(record, normalizedSelector),
  );
  const match = ensureSingleMatch(matches, 'stop');
  if (!match) {
    // `station stop` normally resolves the CWD-scoped lifecycle record, but a
    // desktop sidecar belongs to the HOME-scoped registry and a force-killed
    // desktop has no local record to find. For an explicit home + instance
    // target, converge only that exact stale registry entry. This never
    // signals a PID: a reused PID is merely proven not to own the record and
    // a live owner remains untouched for its real supervisor to manage.
    if (normalizedSelector.instanceId && normalizedSelector.baseDir) {
      const result = reconcileStaleInstance(
        normalizedSelector.instanceId,
        normalizedSelector.baseDir,
      );
      if (result.kind === 'removed' || result.kind === 'absent') return;
      if (result.kind === 'live-owner') {
        throw new Error(
          `Refusing to remove '${normalizedSelector.instanceId}': its registry owner is live (pid ${result.entry.pid}). No process was signalled.`,
        );
      }
      if (result.kind === 'durable-service') {
        throw new Error(
          `Refusing to remove '${normalizedSelector.instanceId}': it is a durable service record. Use station service stop --instance=${normalizedSelector.instanceId} instead.`,
        );
      }
      throw new Error(
        `Refusing to remove '${normalizedSelector.instanceId}': its registry record is not provably stale. No process was signalled.`,
      );
    }
    return;
  }
  stopRecord(match, true, opts.intent ?? 'operator_stop');
}

export {
  collectDoctorReport,
  doctor,
  doctorJson,
  parseTsxVersion,
} from './lifecycle-doctor.js';

export function link(): void {
  createPathLink(CWD);
}

export function shortcut(): void {
  createAppShortcut(CWD);
}

export async function clean(
  forceOrOptions: boolean | CleanOptions = false,
): Promise<void> {
  const options =
    typeof forceOrOptions === 'boolean'
      ? { force: forceOrOptions }
      : forceOrOptions;
  const {
    projectHome,
    homeSource,
    isDefaultHome,
    instanceId,
    serverPort,
    uiPort,
  } = resolveCleanTarget(options);

  if (isDefaultHome && !options.allowDefaultHomeClean) {
    throw new Error(
      'Refusing to clean the default Station home. Use --temp-home for hermetic runs, or pass --allow-default-home-clean when you truly intend to delete ~/.station.',
    );
  }

  announceHome(projectHome, homeSource);

  if (!options.force) {
    console.log(`\n⚠️  This will delete ${projectHome} which includes:`);
    console.log('   - All installed plugins');
    console.log('   - Conversation history');
    console.log('   - Tool configurations\n');

    const confirmed = await promptYN('Continue?');
    console.log('');
    if (!confirmed) {
      console.log('Cancelled.');
      process.exit(0);
    }
  }

  stop({ instanceId, serverPort, uiPort, baseDir: projectHome });
  rmSync(projectHome, { recursive: true, force: true });
  const buildPaths = resolveBuildPaths(instanceId);
  rmSync(join(CWD, buildPaths.server), { recursive: true, force: true });
  rmSync(join(CWD, buildPaths.ui), { recursive: true, force: true });
  console.log('  ✓ Cleaned');
}

/**
 * station#1913: archives (never deletes) an existing Station home so it can
 * be recreated fresh, then reports the archive path. This is the supported
 * command the `STATION_HOME_RESET_REQUIRED` error names -- previously an
 * operator had to improvise `mv $STATION_HOME $STATION_HOME.bak` over SSH,
 * racing whatever restarts the process (a systemd rollback recreated the
 * marker-less home before the next attempt landed).
 *
 * Unlike `clean`, this never removes the shared build output and never stops
 * a running instance on the caller's behalf -- it refuses outright, because
 * archiving the home out from under a live instance would corrupt whatever
 * that instance is doing mid-write.
 */
export function homeReset(options: HomeResetOptions = {}): HomeResetResult {
  const { projectHome, homeSource } = resolveCleanTarget(options);
  announceHome(projectHome, homeSource);

  if (options.ifIncompatible && !stationHomeSchemaNeedsReset(projectHome)) {
    return { archived: false, projectHome };
  }

  if (!options.confirm) {
    throw new Error(
      `Refusing to reset Station home '${projectHome}' without confirmation. Data is archived, never deleted, but re-run with --confirm to proceed.`,
    );
  }

  assertStationHomeInactive(projectHome, 'reset');

  if (!existsSync(projectHome)) {
    return { archived: false, projectHome };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let archivePath = `${projectHome}.pre-schema-reset.${stamp}`;
  for (let suffix = 1; existsSync(archivePath); suffix += 1) {
    archivePath = `${projectHome}.pre-schema-reset.${stamp}-${suffix}`;
  }
  renameSync(projectHome, archivePath);
  return { archived: true, archivePath, projectHome };
}

function assertStationHomeInactive(
  projectHome: string,
  operation: 'backup' | 'reset' | 'restore',
): void {
  const normalizedSelector = normalizeSelector({ baseDir: projectHome });
  const runningMatches = listRunningInstances().filter((record) =>
    matchesSelector(record, normalizedSelector),
  );
  // Read the registry KEYS too, not just findRunning's values: the id is the
  // only handle a reader has for stopping the thing, and findRunning discards
  // it (station#3064 made this population include supervised services, whose
  // remedy is a different command).
  const registryPathExists =
    operation !== 'reset' &&
    existsSync(resolveInstanceRegistryPath(projectHome));
  const homeInstances = registryPathExists
    ? findRunningHomeInstances(projectHome)
    : [];
  const idByPort = new Map<number, string>();
  if (registryPathExists) {
    for (const [id, entry] of Object.entries(
      readInstanceRegistry(projectHome).instances,
    )) {
      idByPort.set(entry.port, id);
    }
  }
  if (runningMatches.length === 0 && homeInstances.length === 0) return;
  throw new Error(
    [
      `Refusing to ${operation} '${projectHome}' while a Station instance is running:`,
      ...runningMatches.map((record) => `  - ${describeInstance(record)}`),
      ...homeInstances.map((instance) => {
        const id = idByPort.get(instance.port);
        const target = id ? ` --instance=${id}` : '';
        // A supervised service is not stoppable with `station stop` — that
        // path signals a CLI-started process. Name the command that works.
        const remedy =
          instance.type === 'service'
            ? `station service stop${target}`
            : `station stop${target}`;
        return `  - ${id ? `${id} (${instance.type})` : instance.type} pid=${String(instance.pid)} port=${String(instance.port)} — stop with '${remedy}'`;
      }),
      'Stop the instances above, then re-run.',
    ].join('\n'),
  );
}

export interface HomeVerifyResult extends StoreIntegrityReport {
  homeDir: string;
  /** Process exit code the verdicts imply — see `STORE_INTEGRITY_EXIT_CODE`. */
  exitCode: number;
}

/**
 * Verifies the SQLite stores a Station home owns, without stopping it.
 *
 * Deliberately does NOT call `assertStationHomeInactive`: the check opens a
 * read-only connection, which blocks no writer in WAL, and an operator asking
 * "is my history intact?" while Station is running is the case this exists
 * for. Every other `home` action mutates the home and refuses for that reason.
 *
 * Reports each store separately, and reports "could not look" as its own
 * verdict rather than as damage — a missing scheduler ledger on a home that
 * has never scheduled anything is not a corrupt database.
 */
export function homeVerify(options: CleanOptions = {}): HomeVerifyResult {
  const { projectHome, homeSource } = resolveCleanTarget(options);
  announceHome(projectHome, homeSource);
  // A mistyped `--base` must not read as good news. Without this, verifying a
  // home that does not exist reports every store `absent` — which is true of
  // an empty directory and true of a path with a typo in it, and an operator
  // asking "is my data OK?" would take it for yes (station#3218 review).
  if (!existsSync(projectHome)) {
    // `code` is what lets the CLI map this to exit 3 ("nothing was
    // verified") instead of the generic catch's exit 1 — which the exit
    // table reserves for "the bytes are bad". A monitoring script keying
    // corruption alerts on exit 1 must not page for a typo'd path.
    throw Object.assign(
      new Error(
        `No Station home at ${projectHome}. Check the path, or start Station to create one.`,
      ),
      { code: 'STATION_HOME_MISSING' },
    );
  }
  const results: StoreIntegrityResult[] = stationHomeStorePaths(
    projectHome,
  ).map((databasePath) => verifySqliteStore(databasePath));
  return {
    homeDir: projectHome,
    checkedAt: new Date().toISOString(),
    results,
    exitCode: storeIntegrityExitCode(results),
  };
}

/** Explicit target only: no default-home resolution, announcement or bootstrap. */
export function homeRecoveryPlan(projectHome: string) {
  return inspectStationHomeRecovery({ homeDir: projectHome });
}

export function homeBackup(
  options: HomeBackupOptions = {},
): StationHomeBackupResult {
  const { projectHome, homeSource } = resolveCleanTarget(options);
  announceHome(projectHome, homeSource);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = resolve(
    options.outputDir ?? `${projectHome}.backup.${stamp}`,
  );
  assertStationHomeInactive(projectHome, 'backup');
  return createStationHomeBackup({
    homeDir: projectHome,
    outputDir,
    assertInactive: () => assertStationHomeInactive(projectHome, 'backup'),
  });
}

export function homeRestore(
  options: HomeRestoreOptions,
): StationHomeRestoreResult {
  const { projectHome, homeSource } = resolveCleanTarget(options);
  announceHome(projectHome, homeSource);
  assertStationHomeInactive(projectHome, 'restore');
  return restoreStationHomeBackup({
    backupDir: resolve(options.backupDir),
    homeDir: projectHome,
    confirm: options.confirm === true,
    assertInactive: () => assertStationHomeInactive(projectHome, 'restore'),
  });
}

interface PackagedInstallState {
  schemaVersion: 3;
  channel: 'stable' | 'beta';
  releaseChannel: 'stable' | 'preview';
  installRoot: string;
  stationHome: string;
  stationRoot: string;
}

function readSafePackagedFile(
  path: string,
  description: string,
  requirePrivate = false,
): string {
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
    (info.mode & (requirePrivate ? 0o077 : 0o022)) !== 0
  ) {
    throw new Error(
      `${description} must be a same-user regular file with safe permissions`,
    );
  }
  return readFileSync(path, 'utf8');
}

function readSafePackagedInstallState(path: string): PackagedInstallState {
  const value = JSON.parse(
    readSafePackagedFile(path, 'packaged install state', true),
  ) as Partial<PackagedInstallState> & { prerelease?: unknown };
  if (
    typeof value.installRoot !== 'string' ||
    typeof value.stationHome !== 'string' ||
    typeof value.stationRoot !== 'string'
  ) {
    throw new Error('packaged install state is malformed');
  }
  if (
    value.schemaVersion !== 3 ||
    !(
      (value.channel === 'stable' && value.releaseChannel === 'stable') ||
      (value.channel === 'beta' && value.releaseChannel === 'preview')
    )
  ) {
    throw new Error('packaged install state is malformed');
  }
  return value as PackagedInstallState;
}

function assertSafePackagedDirectory(path: string, description: string): void {
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
    (info.mode & 0o022) !== 0
  ) {
    throw new Error(
      `${description} must be a same-user directory that is not group/world writable`,
    );
  }
}

/**
 * A release without `.git` is never a source checkout. It must prove the
 * installer-owned state before it may touch the network; falling through to
 * Git would turn old or copied release files into an unsigned update path.
 */
function delegatePackagedUpgradeIfPresent(): string | null {
  if (existsSync(join(CWD, '.git'))) return null;
  const releasesRoot = resolve(CWD, '..');
  const installRoot = resolve(releasesRoot, '..');
  assertSafePackagedDirectory(installRoot, 'packaged install root');
  assertSafePackagedDirectory(releasesRoot, 'packaged releases root');
  assertSafePackagedDirectory(CWD, 'packaged active release');
  const manifestPath = join(CWD, PACKAGED_RELEASE_MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    throw new Error(
      'Cannot upgrade a non-Git checkout without signed packaged release provenance.',
    );
  }
  const manifest = validatePackagedReleaseManifest(
    JSON.parse(
      readSafePackagedFile(manifestPath, 'packaged release provenance'),
    ),
  );
  if (!manifest) throw new Error('packaged release provenance is invalid');

  const state = readSafePackagedInstallState(
    join(installRoot, '.station-release-state.json'),
  );
  // The manifest's `channel` is the runtime channel (stable|beta); the
  // persisted ring is a release channel, so compare releaseChannel to
  // releaseChannel.
  if (manifest.releaseChannel !== state.releaseChannel) {
    throw new Error(
      'packaged release provenance does not match the persisted release ring',
    );
  }
  if (realpathSync(state.installRoot) !== realpathSync(installRoot)) {
    throw new Error('packaged install state does not contain this release');
  }
  const marker = join(installRoot, '.station-portable-install-root');
  if (
    readSafePackagedFile(marker, 'packaged install ownership marker') !==
    'station-portable-install-root-v1\n'
  ) {
    throw new Error('packaged install ownership marker is invalid');
  }
  const current = join(installRoot, 'current');
  if (
    !lstatSync(current).isSymbolicLink() ||
    realpathSync(current) !== realpathSync(CWD)
  ) {
    throw new Error('packaged current link does not resolve to this release');
  }
  const installer = join(CWD, 'install.sh');
  readSafePackagedFile(installer, 'packaged release installer');

  execFileSync('sh', ['./install.sh', 'install'], {
    cwd: CWD,
    env: {
      ...process.env,
      STATION_CHANNEL: state.channel,
      STATION_ROOT: state.stationRoot,
      STATION_HOME: state.stationHome,
      STATION_INSTALL_ROOT: state.installRoot,
    },
    stdio: 'inherit',
    windowsHide: true,
  });
  return state.stationHome;
}

function reportSchedulingPolicyUpgradeGuidance(stationHome?: string): void {
  const serviceDirectory = join(
    stationHome ?? resolveLifecycleHomeTarget().projectHome,
    'service',
  );
  let entries: Array<{ isFile(): boolean; name: string }>;
  try {
    entries = readdirSync(serviceDirectory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const manifest = JSON.parse(
        readFileSync(join(serviceDirectory, entry.name), 'utf8'),
      ) as {
        instanceId?: unknown;
        allowedOrigins?: unknown;
        baseDir?: unknown;
        features?: unknown;
        host?: unknown;
        platform?: unknown;
        serverPort?: unknown;
        taskName?: unknown;
        uiPort?: unknown;
        unitPath?: unknown;
      };
      if (
        (manifest.platform !== 'darwin' &&
          manifest.platform !== 'linux' &&
          manifest.platform !== 'win32') ||
        manifest.platform !== process.platform ||
        typeof manifest.instanceId !== 'string' ||
        typeof manifest.unitPath !== 'string' ||
        (manifest.platform === 'win32' && typeof manifest.taskName !== 'string')
      ) {
        continue;
      }
      const scheduling = inspectServiceSchedulingPolicy(
        {
          platform: manifest.platform,
          ...(typeof manifest.taskName === 'string'
            ? { taskName: manifest.taskName }
            : {}),
          unitPath: manifest.unitPath,
        },
        {
          run: (command, args) => {
            const result = spawnSync(command, args, {
              encoding: 'utf8',
              windowsHide: true,
            });
            return {
              error: result.error,
              status: result.status,
              stderr:
                typeof result.stderr === 'string' ? result.stderr : undefined,
              stdout:
                typeof result.stdout === 'string' ? result.stdout : undefined,
            };
          },
        },
      );
      if (scheduling.status === 'stale') {
        console.log(
          `\nService scheduling is stale for ${manifest.instanceId} (${scheduling.observed}, expected ${scheduling.expected}).`,
        );
        const remedy = renderServiceInstallRemedy(manifest, stationHome);
        console.log(
          remedy
            ? `Run "${remedy}" to update the registration; upgrade does not reinstall services automatically.`
            : 'The installed registration does not record every setting, so Station will not suggest a reinstall command. Inspect its manifest before reinstalling; upgrade does not reinstall services automatically.',
        );
      } else if (scheduling.status === 'unknown') {
        console.log(
          `\nService scheduling could not be verified for ${manifest.instanceId} (${scheduling.reason ?? 'policy could not be read'}).`,
        );
        const statusCommand = renderServiceStatusCommand(manifest, stationHome);
        console.log(
          statusCommand
            ? `Run "${statusCommand}" for details; upgrade does not reinstall services automatically.`
            : 'The installed registration does not record its Station home, so Station will not suggest a status command. Inspect its manifest for details; upgrade does not reinstall services automatically.',
        );
      } else if (scheduling.status === 'operator-override') {
        console.log(
          `\nService scheduling has an operator override for ${manifest.instanceId} (${scheduling.observed}). No Station action is required.`,
        );
      }
    } catch {
      // Upgrade guidance is advisory. An unreadable or malformed manifest is
      // intentionally not guessed to be either current or stale.
    }
  }
}

export async function upgrade(options: BuildOptions = {}): Promise<void> {
  const packagedStationHome = delegatePackagedUpgradeIfPresent();
  if (packagedStationHome !== null) {
    reportSchedulingPolicyUpgradeGuidance(packagedStationHome);
    return;
  }
  const liveInstances = listRunningInstances();
  if (liveInstances.length > 1) {
    throw new Error(
      [
        'station upgrade is blocked because this checkout has multiple live Station instances sharing build artifacts.',
        'Stop the sibling instances first or rerun from a different checkout.',
        ...liveInstances.map((record) => `  - ${describeInstance(record)}`),
      ].join('\n'),
    );
  }
  if (liveInstances.length === 1) {
    stopRecord(liveInstances[0], false);
  }

  const { gitRoot, branch } = resolveGitInfo(CWD);

  try {
    execSync(`git rev-parse --abbrev-ref ${branch}@{u}`, {
      cwd: gitRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch {
    try {
      execSync('git remote get-url origin', {
        cwd: gitRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      console.log('Configuring upstream tracking...');
      execSync(`git fetch origin ${branch} --quiet`, {
        cwd: gitRoot,
        timeout: 15000,
        windowsHide: true,
      });
      execSync(`git branch --set-upstream-to=origin/${branch} ${branch}`, {
        cwd: gitRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      console.error(
        'No upstream configured and no origin remote found. Cannot upgrade.',
      );
      process.exit(1);
    }
  }

  console.log('Pulling latest...');
  execSync('git pull', { cwd: gitRoot, stdio: 'inherit', windowsHide: true });

  console.log('\nInstalling dependencies...');
  execSync('npm install', {
    cwd: gitRoot,
    stdio: 'inherit',
    windowsHide: true,
  });

  console.log('\nRebuilding...');
  // station#2671: build through buildApplication(), never raw `npm run
  // build:*`. The raw builds skip the candidate/promotion pipeline and so
  // never refresh dist-server/station-build.json — the supervisor then pins
  // STATION_BUILD_SHA to the stale manifest sha while the rebuilt bundle
  // reports its baked banner sha, and `waitForIdentity` kill-loops every boot
  // with "managed boot identity mismatch" until someone runs `station build`.
  // buildApplication() resolves the default instance's build paths
  // (dist-server/dist-ui), writes the manifest, and validates+promotes
  // atomically, keeping the manifest sha and the baked sha in lockstep.
  await buildApplication(options);

  console.log('\n  ✓ Upgraded');
  console.log('  Plugins unchanged. Run "station start" to launch.');
  reportSchedulingPolicyUpgradeGuidance(
    resolveLifecycleHomeTarget({ baseDir: options.baseDir }).projectHome,
  );
}
