import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import type { Plugin } from 'vite';

/** Both Vite graphs import the same immutable grammar modules. */
export function sharedShikiGrammars(): Plugin {
  let base = '/';
  let grammarDir = '';
  let version = '';
  const sources = new Map<string, string>();
  const emitted = new Set<string>();
  return {
    name: 'station-shared-shiki-grammars',
    apply: 'build',
    enforce: 'pre',
    configResolved(config) {
      base = config.base;
    },
    async resolveId(source, importer) {
      if (!source.startsWith('@shikijs/langs')) return null;
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      if (!resolved?.id.endsWith('.mjs')) return null;
      if (!grammarDir) {
        grammarDir = path.dirname(resolved.id);
        const hash = createHash('sha256');
        for (const name of readdirSync(grammarDir)
          .filter((file) => file.endsWith('.mjs'))
          .sort()) {
          const content = readFileSync(path.join(grammarDir, name), 'utf8');
          sources.set(name, content);
          hash.update(name).update('\0').update(content).update('\0');
        }
        version = hash.digest('hex').slice(0, 16);
      }
      const filename = (name: string) =>
        `assets/shiki/${name.slice(0, -4)}-${version}.js`;
      const emit = (name: string) => {
        if (emitted.has(name)) return;
        emitted.add(name);
        const content = sources.get(name);
        if (content === undefined)
          throw new Error(`Missing Shiki grammar ${name}`);
        const rewritten = content.replace(
          /(['"])\.\/([\w-]+\.mjs)\1/g,
          (_match, quote: string, dependency: string) => {
            emit(dependency);
            return `${quote}./${path.posix.basename(filename(dependency))}${quote}`;
          },
        );
        this.emitFile({
          type: 'asset',
          fileName: filename(name),
          source: rewritten,
        });
      };
      const name = path.basename(resolved.id);
      emit(name);
      return { id: `${base}${filename(name)}`, external: true };
    },
  };
}

export function uiAssetDelivery({ precompress = true } = {}): Plugin {
  let base = '/';
  return {
    name: 'station-ui-asset-delivery',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        const entry = html.match(
          /<meta\s+name="station-eager-entry"\s+content="([^"]+)"\s*\/?\s*>/,
        )?.[1];
        if (!entry) return html;
        const main = Object.values(context.bundle ?? {}).find(
          (output) => output.type === 'chunk' && output.name === entry,
        );
        if (!main) throw new Error(`Missing eager UI chunk: ${entry}`);
        return {
          html,
          tags: [
            {
              tag: 'link',
              attrs: {
                rel: 'modulepreload',
                crossorigin: '',
                href: `${base}${main.fileName}`,
              },
              injectTo: 'head',
            },
          ],
        };
      },
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        if (!precompress) return;
        for (const output of Object.values(bundle)) {
          if (!/\.(?:js|css|json|svg)$/.test(output.fileName)) continue;
          const bytes = Buffer.from(
            output.type === 'chunk' ? output.code : output.source,
          );
          if (bytes.length < 1024) continue;
          for (const [extension, compressed] of [
            [
              'br',
              brotliCompressSync(bytes, {
                params: { [constants.BROTLI_PARAM_QUALITY]: 9 },
              }),
            ],
            ['gz', gzipSync(bytes, { level: 9 })],
          ] as const) {
            if (compressed.length < bytes.length)
              this.emitFile({
                type: 'asset',
                fileName: `${output.fileName}.${extension}`,
                source: compressed,
              });
          }
        }
      },
    },
  };
}
