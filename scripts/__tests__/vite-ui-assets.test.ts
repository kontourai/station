import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { build, type Rollup } from 'vite';
import { expect, it } from 'vitest';
import { sharedShikiGrammars, uiAssetDelivery } from '../vite-ui-assets';

it.each([true, false])(
  'builds shared grammars and preloads main with precompression=%s',
  async (precompress) => {
    mkdirSync(path.resolve('node_modules/.cache'), { recursive: true });
    const root = mkdtempSync(
      path.resolve('node_modules/.cache/station-ui-assets-'),
    );
    try {
      writeFileSync(
        path.join(root, 'index.html'),
        '<head><meta name="station-eager-entry" content="main"></head><body><script type="module" src="/boot.js"></script></body>',
      );
      writeFileSync(
        path.join(root, 'boot.js'),
        "import('./main.js').then(m => m.start());",
      );
      writeFileSync(
        path.join(root, 'main.js'),
        "import typescript from '@shikijs/langs/typescript'; export function start() { console.log(typescript); return new Worker(new URL('./highlight-worker.js', import.meta.url), { type: 'module' }); }",
      );
      writeFileSync(
        path.join(root, 'highlight-worker.js'),
        "import typescript from '@shikijs/langs/typescript'; import tsx from '@shikijs/langs/tsx'; self.onmessage = () => self.postMessage([typescript, tsx]);",
      );
      const result = await build({
        configFile: false,
        root,
        logLevel: 'silent',
        plugins: [sharedShikiGrammars(), uiAssetDelivery({ precompress })],
        worker: { format: 'es', plugins: () => [sharedShikiGrammars()] },
        build: { write: false, minify: false },
      });
      if (!('output' in result))
        throw new Error('Expected one Vite build output');
      const outputs = new Map(
        result.output.map((output) => [output.fileName, output]),
      );
      const bytes = (output: Rollup.OutputAsset | Rollup.OutputChunk) =>
        Buffer.from(output.type === 'chunk' ? output.code : output.source);
      const html = bytes(outputs.get('index.html')!).toString();
      const main = result.output.find(
        (output) => output.type === 'chunk' && output.name === 'main',
      );
      expect(main).toBeDefined();
      expect(html).toContain(
        `rel="modulepreload" crossorigin="" href="/${main!.fileName}"`,
      );
      const grammars = result.output.filter((output) =>
        /(?:^|\/)typescript-[\w-]+\.js$/.test(output.fileName),
      );
      expect(
        grammars,
        'page and worker must ship one TypeScript grammar',
      ).toHaveLength(1);
      const grammar = grammars[0]!;
      const worker = result.output.find((output) =>
        /highlight-worker-.*\.js$/.test(output.fileName),
      );
      expect(worker).toBeDefined();
      expect(bytes(worker!).toString()).toContain(`/${grammar.fileName}`);
      expect(bytes(main!).toString()).toContain(`/${grammar.fileName}`);
      // TSX imports another grammar: every relative module reference must survive publication.
      for (const output of result.output.filter(
        (file) =>
          file.fileName.startsWith('assets/shiki/') &&
          file.fileName.endsWith('.js'),
      )) {
        for (const match of bytes(output)
          .toString()
          .matchAll(/['"]\.\/([^'"]+\.js)['"]/g)) {
          expect(
            outputs.has(`assets/shiki/${match[1]}`),
            `${output.fileName} dependency ${match[1]}`,
          ).toBe(true);
        }
        const br = outputs.get(`${output.fileName}.br`);
        const gz = outputs.get(`${output.fileName}.gz`);
        if (precompress && bytes(output).length >= 1024) {
          expect(br, `${output.fileName} Brotli`).toBeDefined();
          expect(gz, `${output.fileName} gzip`).toBeDefined();
          expect(brotliDecompressSync(bytes(br!))).toEqual(bytes(output));
          expect(gunzipSync(bytes(gz!))).toEqual(bytes(output));
        }
      }
      if (!precompress)
        expect(
          result.output.some((output) => /\.(br|gz)$/.test(output.fileName)),
        ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
