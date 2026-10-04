import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { type Alias, defineConfig, type ProxyOptions } from 'vite';
import { UI_PROXY_BACKEND_PREFIXES } from './packages/cli/src/commands/ui-proxy-prefixes';
import tauriConfig from './src-desktop/tauri.conf.json';

// Build identity is injected into index.html rather than the JavaScript module
// graph. A commit-only change must not rename the entry chunk and every chunk
// that imports it, or the gzip budget reads hash entropy as product growth.
// Wall-clock build time remains out-of-bundle in the build manifest
// (`buildApplication` in packages/cli/src/commands/lifecycle.ts) and is surfaced
// by Settings → Deployed Build via `STATION_BUILD_BUILT_AT`.
function gitShortSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: __dirname,
      windowsHide: true,
    })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'),
) as { version?: string };

const TAURI_NONCE_TOKEN = '__TAURI_SCRIPT_NONCE__';

export interface StationBuildIdentity {
  version: string;
  commit: string;
}

/**
 * Native release overlays use this explicit input so web metadata reports the
 * same immutable tag/nightly identity as the Tauri bundle. Ordinary builds use
 * the root package version, which remains the only checked-in authority.
 */
export function buildVersion(
  packageVersion: string | undefined,
  override = process.env.STATION_BUILD_VERSION,
): string {
  const effective = override?.trim() || packageVersion || '0.0.0';
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:preview|nightly)\.[1-9]\d*(?:\.[1-9]\d*)?)?$/.test(
      effective,
    )
  ) {
    throw new Error(`Invalid Station build version: ${effective}`);
  }
  return effective;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function injectBuildIdentity(
  html: string,
  identity: StationBuildIdentity,
): string {
  if (!/<\/head>/i.test(html)) {
    throw new Error(
      'Vite index.html is missing </head>; cannot inject build identity',
    );
  }
  const version = escapeHtmlAttribute(identity.version);
  const commit = escapeHtmlAttribute(identity.commit);
  return html.replace(
    /<\/head>/i,
    `  <meta name="station-build-version" content="${version}">\n  <meta name="station-build-commit" content="${commit}">\n</head>`,
  );
}

function serializeCsp(
  directives: Record<string, string>,
  scriptNonce?: string,
): string {
  return Object.entries(directives)
    .map(([directive, sources]) => {
      const effectiveSources =
        directive === 'script-src' && scriptNonce
          ? `${sources} 'nonce-${scriptNonce}'`
          : sources;
      return `${directive} ${effectiveSources}`;
    })
    .join('; ');
}

/**
 * `station start --watch` runs this Vite server as the instance's UI listener
 * and tells it which API to front through these variables. Unset, Vite is the
 * plain `npm run dev:ui` server with no proxy.
 */
const DEV_API_PORT_ENV = 'STATION_DEV_API_PORT';
const DEV_POLL_ENV = 'STATION_DEV_WATCH_POLL';

// The header contract the production UI listener (`uiRequestHandler` in
// packages/cli/src/commands/lifecycle.ts) speaks to the server. Mirrored, not
// imported: that module spawns processes. A test pins these to the server's
// own constants.
const INTERNAL_TOKEN_HEADER = 'x-station-internal-token';
const INTERNAL_CALLER_HEADER = 'x-station-proxy-caller';
const INTERNAL_INGRESS_IDENTITY_HEADER = 'x-station-ingress-identity';
const INTERNAL_PROXY_PEER_HEADER = 'x-station-proxy-peer';
const INTERNAL_PROXY_FORWARDED_HOST_HEADER = 'x-station-proxy-forwarded-host';
const INTERNAL_TENANT_HEADER = 'x-station-internal-tenant';
const INTERNAL_ORCHESTRATION_THREAD_HEADER = 'x-station-orchestration-thread';
export const DEV_PROXY_ATTESTATION_HEADERS = [
  INTERNAL_TOKEN_HEADER,
  INTERNAL_CALLER_HEADER,
  INTERNAL_INGRESS_IDENTITY_HEADER,
  INTERNAL_PROXY_PEER_HEADER,
  INTERNAL_PROXY_FORWARDED_HOST_HEADER,
  INTERNAL_TENANT_HEADER,
  INTERNAL_ORCHESTRATION_THREAD_HEADER,
] as const;

interface DevProxyRequest {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  url?: string;
  socket?: { remoteAddress?: string };
}
interface DevProxyOutgoing {
  removeHeader(name: string): void;
  setHeader(name: string, value: string): void;
}

/**
 * Make an outgoing proxied request look exactly like one the production UI
 * listener would forward: every client-supplied attestation is removed first,
 * then this hop's own are set. The caller stays `remote`, so the server
 * demands the browser's device session, which is what lets the dev UI pass
 * its session gate without any weaker local-trust path.
 */
export function attestDevProxyRequest(
  outgoing: DevProxyOutgoing,
  incoming: DevProxyRequest,
  internalToken: string | undefined,
): void {
  for (const name of DEV_PROXY_ATTESTATION_HEADERS) outgoing.removeHeader(name);
  for (const name of Object.keys(incoming.headers)) {
    if (name.startsWith('tailscale-')) outgoing.removeHeader(name);
  }
  if (internalToken) outgoing.setHeader(INTERNAL_TOKEN_HEADER, internalToken);
  outgoing.setHeader(INTERNAL_CALLER_HEADER, 'remote');
  const peer = incoming.socket?.remoteAddress;
  if (peer) outgoing.setHeader(INTERNAL_PROXY_PEER_HEADER, peer);
  const host = incoming.headers.host;
  if (typeof host === 'string') {
    outgoing.setHeader(INTERNAL_PROXY_FORWARDED_HOST_HEADER, host);
  }
}

export function stationDevWatchOptions(
  env: NodeJS.ProcessEnv = process.env,
): { usePolling: true; interval: number } | undefined {
  return env[DEV_POLL_ENV] === '1'
    ? { usePolling: true, interval: 300 }
    : undefined;
}

/**
 * What the dev server may serve to a browser. Vite's defaults answer
 * `/@fs/<path>` for any file under the workspace root, to any localhost
 * origin (its CORS default), so a page on another localhost port could read
 * repo files such as CLAUDE.md. CORS is off (the UI is same-origin with this
 * server, including in the Tauri shell), and the filesystem is narrowed to
 * what the UI imports: its own tree, shared sources, the workspace packages'
 * sources the aliases point at, and installed dependencies.
 */
export function stationDevServerAccess(root: string = __dirname): {
  cors: false;
  fs: { strict: true; allow: string[] };
} {
  const packagesDir = path.resolve(root, 'packages');
  const packageSources = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packagesDir, entry.name, 'src'));
  return {
    cors: false,
    fs: {
      strict: true,
      allow: [
        path.resolve(root, 'src-ui'),
        path.resolve(root, 'src-shared'),
        ...packageSources,
        path.resolve(root, 'node_modules'),
      ],
    },
  };
}

/**
 * The Vite dev server's proxy to one Station instance's API. It covers the
 * same prefixes the production UI listener forwards, so the dev UI is
 * same-origin with its API: no CORS, and no allowed-origin widening. A
 * browser navigation (`Accept: text/html`) to a prefix that is also a client
 * route stays with the SPA, as it does in production.
 */
export function stationDevProxy(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, ProxyOptions> | undefined {
  const raw = env[DEV_API_PORT_ENV];
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    throw new Error(`${DEV_API_PORT_ENV} must be a TCP port; received ${raw}`);
  }
  const target = `http://127.0.0.1:${raw}`;
  const internalToken = env.STATION_INTERNAL_API_TOKEN;
  const entry: ProxyOptions = {
    target,
    // Rewrites Host to the target, as the production listener does.
    changeOrigin: true,
    ws: true,
    bypass(req) {
      const method = (req.method ?? 'GET').toUpperCase();
      const accept = String(req.headers.accept ?? '');
      if (
        (method === 'GET' || method === 'HEAD') &&
        accept.startsWith('text/html')
      ) {
        return req.url;
      }
      return undefined;
    },
    configure(proxy) {
      proxy.on('proxyReq', (outgoing, incoming) =>
        attestDevProxyRequest(outgoing, incoming, internalToken),
      );
      proxy.on('proxyReqWs', (outgoing, incoming) =>
        attestDevProxyRequest(outgoing, incoming, internalToken),
      );
    },
  };
  return Object.fromEntries(
    UI_PROXY_BACKEND_PREFIXES.map((prefix) => [prefix, entry]),
  );
}

/**
 * Answers `/__station/identity` for a Vite-served instance: the lifecycle
 * readiness wait asks the UI listener for the boot identity it launched.
 */
export function stationDevIdentity(
  env: NodeJS.ProcessEnv = process.env,
): { instanceId: string; sha: string; bootId: string } | undefined {
  if (!env[DEV_API_PORT_ENV]) return undefined;
  return {
    instanceId: env.STATION_INSTANCE_ID ?? '',
    sha: env.STATION_BUILD_SHA ?? 'unknown',
    bootId: env.STATION_BOOT_ID ?? '',
  };
}

export default defineConfig(({ command }) => {
  const devNonce =
    command === 'serve' ? randomBytes(16).toString('base64') : undefined;
  const desktopCsp = tauriConfig.app.security.csp as Record<string, string>;
  const buildIdentity: StationBuildIdentity = {
    version: buildVersion(pkg.version),
    commit: gitShortSha(),
  };
  const performanceReferenceBuild =
    process.env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE === '1';

  return {
    plugins: [
      tailwindcss(),
      react(),
      {
        name: 'station-interactive-workspace-performance-reference',
        transformIndexHtml: {
          order: 'pre',
          handler(html) {
            return performanceReferenceBuild
              ? {
                  html,
                  tags: [
                    {
                      tag: 'script',
                      attrs: {
                        type: 'module',
                        src: '/src/performance/interactive-workspace-performance-entry.ts',
                      },
                      injectTo: 'body',
                    },
                  ],
                }
              : html;
          },
        },
      },
      {
        name: 'station-build-identity',
        transformIndexHtml(html) {
          return injectBuildIdentity(html, buildIdentity);
        },
      },
      {
        name: 'station-dev-identity',
        apply: 'serve',
        configureServer(server) {
          const identity = stationDevIdentity();
          if (!identity) return;
          server.middlewares.use('/__station/identity', (_req, res) => {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify(identity));
          });
        },
      },
      {
        name: 'station-desktop-dev-csp',
        apply: 'serve',
        transformIndexHtml: {
          order: 'post',
          handler(html) {
            if (!devNonce) return html;
            return html
              .replace(TAURI_NONCE_TOKEN, devNonce)
              .replace(
                /<script(?![^>]*\bnonce=)([^>]*)>/g,
                `<script nonce="${devNonce}"$1>`,
              );
          },
        },
      },
    ],
    // ES-module workers so code-splitting workers (e.g. @pierre/diffs, which
    // lazy-loads Shiki languages) can bundle — Vite's default `iife` rejects them.
    worker: { format: 'es' },
    root: './src-ui',
    resolve: {
      // Vite accepts either an object of aliases (string keys only, matched as
      // prefixes) or an array (whose `find` may also be a RegExp). The object
      // below keeps the plain prefix aliases; the array tail carries the
      // entries that must match EXACTLY.
      alias: Object.entries({
        '@': path.resolve(__dirname, './src-ui/src'),
        '@shared': path.resolve(__dirname, './src-shared'),
        // The one connect subpath that would need an alias if the UI imported
        // it. Every other SUBPATH in `packages/connect`'s `exports` map
        // points straight at a `src/*.ts` file Vite resolves on its own;
        // `./health-probe` is the exception, pointing — like the root `.`
        // below — at `dist/`, which `build:ui` does not build. Nothing in
        // src-ui imports it today; the alias test is what pins this entry.
        '@kontourai/station-connect/health-probe': path.resolve(
          __dirname,
          './packages/connect/src/core/healthProbe.ts',
        ),
        '@kontourai/station-contracts/orchestration': path.resolve(
          __dirname,
          './packages/contracts/src/orchestration.ts',
        ),
        '@kontourai/station-contracts/provider': path.resolve(
          __dirname,
          './packages/contracts/src/provider.ts',
        ),
        '@kontourai/station-contracts/runtime-events': path.resolve(
          __dirname,
          './packages/contracts/src/runtime-events.ts',
        ),
      })
        .map(([find, replacement]): Alias => ({ find, replacement }))
        .concat([
          // #1748: package ROOTS match EXACTLY, never as prefixes. As string
          // keys these two also matched `<package>/<anything>` and rewrote it
          // to `<the root's entry file>/<anything>`, which fails `build:ui`
          // with ENOTDIR. Anchored, a subpath with no alias of its own falls
          // through to Node resolution and the package's own `exports` map.
          // They come last because an alias array is matched in order and an
          // exact match cannot shadow anything above it.
          {
            // `vitest.config.ts` already anchors this one, for the same
            // reason it exists at all: connect's `exports["."]` names
            // `dist/`, which `build:ui` does not build.
            find: /^@kontourai\/station-connect$/,
            replacement: path.resolve(
              __dirname,
              './packages/connect/src/index.ts',
            ),
          },
          {
            // The SDK needed no root alias at all — its `exports["."]`
            // already names this file — but as an unanchored string key it
            // was the shield the ~30 SDK subpath aliases stood behind, and
            // every one of them named exactly the file its own `exports`
            // entry names. Anchoring the root is what made deleting those 30
            // safe; the entry stays as the explicit pin to source for a
            // package that is published and may one day ship a `dist/`.
            find: /^@kontourai\/station-sdk$/,
            replacement: path.resolve(__dirname, './packages/sdk/src/index.ts'),
          },
        ]),
    },
    build: {
      sourcemap: process.env.STATION_JOURNEY_PROFILE_DIR ? 'hidden' : false,
      outDir: `../${process.env.STATION_BUILD_UI_DIR || 'dist-ui'}`,
      emptyOutDir: true,
      rollupOptions: {
        onwarn(warning, warn) {
          if (warning.message.includes('will end up in different chunks')) {
            throw new Error(
              `UI build contains a cross-chunk cycle: ${warning.message}`,
            );
          }
          warn(warning);
        },
      },
    },
    server: {
      port: 5173,
      strictPort: true,
      host: '127.0.0.1',
      ...stationDevServerAccess(),
      proxy: stationDevProxy(),
      // Native file watching does not fire on every host (some bind mounts,
      // network and virtualized filesystems); polling is the opt-in fallback.
      watch: stationDevWatchOptions(),
      headers: devNonce
        ? { 'Content-Security-Policy': serializeCsp(desktopCsp, devNonce) }
        : undefined,
    },
    clearScreen: false,
    envPrefix: ['VITE_', 'TAURI_'],
  };
});
