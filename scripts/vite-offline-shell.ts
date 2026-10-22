import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/** A credential-free shell, before the listener injects its per-request bootstrap. */
export function offlineShell(): Plugin {
  return {
    name: 'station-offline-shell',
    apply: 'build',
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
          '/offline-shell.json',
          '/startup-theme.js',
          '/favicon.png',
          '/fonts/dm-sans-latin.woff2',
        ]);
        const visit = (name: string) => {
          if (files.has(`/${name}`)) return;
          const output = bundle[name];
          if (!output) return;
          files.add(`/${name}`);
          if (output.type === 'chunk') {
            for (const dependency of output.imports) visit(dependency);
          }
        };
        // boot imports main; main starts voice registration without a mounted consumer.
        // Other lazy features are cached when opened online.
        for (const output of Object.values(bundle)) {
          if (
            output.type === 'chunk' &&
            (output.isEntry ||
              output.name === 'main' ||
              output.moduleIds.some((id) =>
                id.endsWith('/src-ui/src/providers/voice/index.ts'),
              ))
          )
            visit(output.fileName);
        }
        for (const output of Object.values(bundle)) {
          if (output.fileName.endsWith('.css')) visit(output.fileName);
        }
        for (const match of html.matchAll(/(?:href|src)="(\/assets\/[^"]+)"/g))
          visit(match[1].slice(1));
        const precache = [...files].sort();
        const version = createHash('sha256')
          .update(html)
          .update(JSON.stringify(precache))
          .digest('hex')
          .slice(0, 20);
        const worker = readFileSync(
          path.resolve(import.meta.dirname, '../src-ui/public/sw.js'),
          'utf8',
        );
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
            JSON.stringify({ version, precache }),
          ),
        });
      },
    },
  };
}
