import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { type Alias, defineConfig } from 'vite';
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
      headers: devNonce
        ? { 'Content-Security-Policy': serializeCsp(desktopCsp, devNonce) }
        : undefined,
    },
    clearScreen: false,
    envPrefix: ['VITE_', 'TAURI_'],
  };
});
