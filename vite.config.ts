import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
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
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:preview|nightly)\.[1-9]\d*)?$/.test(
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
      alias: {
        '@': path.resolve(__dirname, './src-ui/src'),
        '@shared': path.resolve(__dirname, './src-shared'),
        // SDK subpath aliases must precede the exact package alias so Vite
        // never rewrites a subpath as `<root-entrypoint>/<subpath>`.
        '@kontourai/station-sdk/core-update-restart-status': path.resolve(
          __dirname,
          './packages/sdk/src/core-update-restart-status.ts',
        ),
        '@kontourai/station-sdk/voice': path.resolve(
          __dirname,
          './packages/sdk/src/voice/session.ts',
        ),
        '@kontourai/station-sdk/client': path.resolve(
          __dirname,
          './packages/sdk/src/client/index.ts',
        ),
        '@kontourai/station-sdk/setup-imports': path.resolve(
          __dirname,
          './packages/sdk/src/client/setup-imports.ts',
        ),
        '@kontourai/station-sdk/setup-imports-query': path.resolve(
          __dirname,
          './packages/sdk/src/query-domains/setupImports.ts',
        ),
        '@kontourai/station-sdk/secret-bindings-query': path.resolve(
          __dirname,
          './packages/sdk/src/query-domains/secret-bindings.ts',
        ),
        '@kontourai/station-sdk/client-origin': path.resolve(
          __dirname,
          './packages/sdk/src/client-origin.ts',
        ),
        '@kontourai/station-sdk/app-config': path.resolve(
          __dirname,
          './packages/sdk/src/app-config.ts',
        ),
        '@kontourai/station-sdk/developer-runtime': path.resolve(
          __dirname,
          './packages/sdk/src/query-domains/developerRuntime.ts',
        ),
        '@kontourai/station-sdk/project-task-rooms': path.resolve(
          __dirname,
          './packages/sdk/src/query-domains/projectTaskRooms.ts',
        ),
        '@kontourai/station-sdk/task-outputs': path.resolve(
          __dirname,
          './packages/sdk/src/task-outputs.ts',
        ),
        '@kontourai/station-sdk/session-outputs': path.resolve(
          __dirname,
          './packages/sdk/src/session-outputs.ts',
        ),
        '@kontourai/station-sdk/session-inventory': path.resolve(
          __dirname,
          './packages/sdk/src/session-inventory.ts',
        ),
        '@kontourai/station-sdk/session-output-actions': path.resolve(
          __dirname,
          './packages/sdk/src/session-output-actions.ts',
        ),
        '@kontourai/station-sdk/task-user-input-references': path.resolve(
          __dirname,
          './packages/sdk/src/task-user-input-references.ts',
        ),
        '@kontourai/station-sdk/live-activity': path.resolve(
          __dirname,
          './packages/sdk/src/live-activity.ts',
        ),
        '@kontourai/station-sdk/action-operations': path.resolve(
          __dirname,
          './packages/sdk/src/action-operations.ts',
        ),
        '@kontourai/station-sdk/resource-posture': path.resolve(
          __dirname,
          './packages/sdk/src/query-domains/resourcePosture.ts',
        ),
        '@kontourai/station-sdk/workspace-pane': path.resolve(
          __dirname,
          './packages/sdk/src/workspace-pane.ts',
        ),
        '@kontourai/station-sdk/workspace-file-preview': path.resolve(
          __dirname,
          './packages/sdk/src/workspace-file-preview.ts',
        ),
        '@kontourai/station-sdk/workspace-browser-preview': path.resolve(
          __dirname,
          './packages/sdk/src/workspace-browser-preview.ts',
        ),
        '@kontourai/station-sdk/spatial-board': path.resolve(
          __dirname,
          './packages/sdk/src/spatial-board.ts',
        ),
        '@kontourai/station-sdk/error-state': path.resolve(
          __dirname,
          './packages/sdk/src/components/ErrorState.tsx',
        ),
        '@kontourai/station-sdk/answer-basis': path.resolve(
          __dirname,
          './packages/sdk/src/answer-basis.ts',
        ),
        '@kontourai/station-sdk/answer-assessment-events': path.resolve(
          __dirname,
          './packages/sdk/src/answer-assessment-events.ts',
        ),
        '@kontourai/station-sdk/answer-narrative-events': path.resolve(
          __dirname,
          './packages/sdk/src/answer-narrative-events.ts',
        ),
        '@kontourai/station-sdk/task-basis': path.resolve(
          __dirname,
          './packages/sdk/src/task-basis.ts',
        ),
        '@kontourai/station-sdk/task-tool-results': path.resolve(
          __dirname,
          './packages/sdk/src/task-tool-results.ts',
        ),
        '@kontourai/station-sdk/flow-gate-evaluations': path.resolve(
          __dirname,
          './packages/sdk/src/flow-gate-evaluations.ts',
        ),
        '@kontourai/station-sdk': path.resolve(
          __dirname,
          './packages/sdk/src/index.ts',
        ),
        // Subpath aliases must precede the package alias so the longer key wins.
        '@kontourai/station-connect/health-probe': path.resolve(
          __dirname,
          './packages/connect/src/core/healthProbe.ts',
        ),
        '@kontourai/station-connect/known-environment': path.resolve(
          __dirname,
          './packages/connect/src/core/knownEnvironmentRegistry.ts',
        ),
        '@kontourai/station-connect': path.resolve(
          __dirname,
          './packages/connect/src/index.ts',
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
      },
    },
    build: {
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
