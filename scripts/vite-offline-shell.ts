import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin, Rollup } from 'vite';
import {
  UI_IMMUTABLE_ASSET_PATTERN,
  uiDocumentContentSecurityPolicy,
} from '../packages/shared/src/ui-document-policy';

interface OfflineShellOptions {
  /**
   * Source modules (repository-relative) whose chunks, with their static
   * imports and stylesheets, the worker caches after install on a best-effort
   * basis. Their absence never fails the install; the worker skips them under
   * Save-Data.
   */
  warmModules?: readonly string[];
}

/**
 * The installable web app. Native shells and the dev server load the same
 * index.html under a policy without `manifest-src`, so only this web build
 * links it. `background_color` is Station's default (dark) `--k-bg` page
 * canvas, which the launch splash paints before the app; Station sets no
 * theme colour for its own theme (see startup-theme.js), so neither does this.
 */
const WEB_APP_MANIFEST = {
  id: '/',
  name: 'Station',
  short_name: 'Station',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#0a0e13',
  icons: [
    { src: '/favicon.png', sizes: '192x192', type: 'image/png' },
    { src: '/icons/station-512.png', sizes: '512x512', type: 'image/png' },
    {
      src: '/icons/station-maskable-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ],
};

/** A chunk's static import graph and the stylesheets each chunk loads. */
function collectChunkGraph(
  bundle: Rollup.OutputBundle,
  start: string,
  files: Set<string>,
): void {
  if (files.has(`/${start}`)) return;
  const output = bundle[start];
  if (!output) return;
  files.add(`/${start}`);
  if (output.type !== 'chunk') return;
  for (const css of output.viteMetadata?.importedCss ?? [])
    files.add(`/${css}`);
  for (const dependency of output.imports)
    collectChunkGraph(bundle, dependency, files);
}

/** A credential-free shell, before the listener injects its per-request bootstrap. */
export function offlineShell(options: OfflineShellOptions = {}): Plugin {
  return {
    name: 'station-offline-shell',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'link',
        attrs: { rel: 'manifest', href: '/manifest.webmanifest' },
        injectTo: 'head',
      },
      {
        // iOS fills transparency with black, so the home screen gets the
        // opaque square and applies its own mask.
        tag: 'link',
        attrs: {
          rel: 'apple-touch-icon',
          href: '/icons/station-maskable-512.png',
        },
        injectTo: 'head',
      },
    ],
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const index = bundle['index.html'];
        if (index?.type !== 'asset') return;
        const html = String(index.source)
          .replace(
            '<head>',
            '<head><meta name="station-offline-shell" content="1">',
          )
          .replace(/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/\snonce="[^"]*"/g, '');
        const files = new Set<string>([
          '/manifest.webmanifest',
          '/offline-shell.json',
          '/startup-theme.js',
          '/favicon.png',
          '/fonts/dm-sans-latin.woff2',
        ]);
        // boot imports main; main starts voice registration without a mounted consumer.
        // A lazy chunk's stylesheet travels with its chunk: the preload helper
        // refuses a dynamic import whose stylesheet cannot load.
        for (const output of Object.values(bundle)) {
          if (
            output.type === 'chunk' &&
            (output.isEntry ||
              output.name === 'main' ||
              output.moduleIds.some((id) =>
                id.endsWith('/src-ui/src/providers/voice/index.ts'),
              ))
          )
            collectChunkGraph(bundle, output.fileName, files);
        }
        for (const match of html.matchAll(/(?:href|src)="(\/assets\/[^"]+)"/g))
          collectChunkGraph(bundle, match[1].slice(1), files);
        // Other lazy features are cached when opened online; the warm set is
        // fetched ahead of that so a dropped connection can still open them.
        const warmFiles = new Set<string>();
        for (const module of options.warmModules ?? []) {
          const suffix = `/${module}`;
          const owner = Object.values(bundle).find(
            (output) =>
              output.type === 'chunk' &&
              output.moduleIds.some((id) => id.endsWith(suffix)),
          );
          if (!owner)
            throw new Error(`Offline warm module not in the bundle: ${module}`);
          collectChunkGraph(bundle, owner.fileName, warmFiles);
        }
        const precache = [...files].sort();
        const warm = [...warmFiles].filter((file) => !files.has(file)).sort();
        const immutable = UI_IMMUTABLE_ASSET_PATTERN.source;
        const csp = uiDocumentContentSecurityPolicy();
        const version = createHash('sha256')
          .update(html)
          .update(
            JSON.stringify({
              precache,
              warm,
              immutable,
              csp,
              manifest: WEB_APP_MANIFEST,
            }),
          )
          .digest('hex')
          .slice(0, 20);
        const worker = readFileSync(
          path.resolve(import.meta.dirname, '../src-ui/public/sw.js'),
          'utf8',
        );
        this.emitFile({
          type: 'asset',
          fileName: 'manifest.webmanifest',
          source: `${JSON.stringify(WEB_APP_MANIFEST, null, 2)}\n`,
        });
        this.emitFile({
          type: 'asset',
          fileName: 'offline-shell.json',
          source: JSON.stringify({ html }),
        });
        this.emitFile({
          type: 'asset',
          fileName: 'sw.js',
          source: worker.replace(
            '/* STATION_OFFLINE_BUILD */ null',
            JSON.stringify({ version, precache, warm, immutable, csp }),
          ),
        });
      },
    },
  };
}
