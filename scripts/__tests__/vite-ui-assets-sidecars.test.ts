/**
 * Color theme stylesheets are copied verbatim from `public/`, outside the
 * bundle `generateBundle` sees, so `writeBundle` gives them the Brotli and
 * gzip sidecars bundled CSS gets. Every file here is one the test writes.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs';
import { uiAssetDelivery } from '../vite-ui-assets';

const makeTempDir = trackTempDirs();

/** A built UI whose `public/` copy holds the given color theme files. */
function builtUi(themes: Record<string, string>) {
  const root = makeTempDir('station-ui-assets-');
  const directory = path.join(root, 'dist', 'color-themes');
  mkdirSync(directory, { recursive: true });
  for (const [name, text] of Object.entries(themes))
    writeFileSync(path.join(directory, name), text);
  return { root, directory };
}

function writeBundle(root: string, options?: { precompress?: boolean }) {
  const plugin = uiAssetDelivery(options) as any;
  plugin.configResolved({ base: '/', root, build: { outDir: 'dist' } });
  plugin.writeBundle();
}

const THEME = `:root[data-color-theme="dawn"] {\n${Array.from(
  { length: 80 },
  (_, index) => `  --color-${index}: oklch(0.7 0.1 ${index});`,
).join('\n')}\n}\n`;

describe('uiAssetDelivery color theme sidecars', () => {
  it('writes brotli and gzip copies of each theme stylesheet that decode to it', () => {
    const { root, directory } = builtUi({ 'dawn.css': THEME });
    writeBundle(root);
    expect(readdirSync(directory).sort()).toEqual([
      'dawn.css',
      'dawn.css.br',
      'dawn.css.gz',
    ]);
    const br = readFileSync(path.join(directory, 'dawn.css.br'));
    const gz = readFileSync(path.join(directory, 'dawn.css.gz'));
    expect(brotliDecompressSync(br).toString()).toBe(THEME);
    expect(gunzipSync(gz).toString()).toBe(THEME);
    expect(br.length).toBeLessThan(THEME.length);
  });

  it('leaves small files, other files and an unprecompressed build alone', () => {
    const { root, directory } = builtUi({
      'tiny.css': ':root{--a:1}',
      'catalog.json': THEME,
    });
    writeBundle(root);
    expect(readdirSync(directory).sort()).toEqual(['catalog.json', 'tiny.css']);

    const plain = builtUi({ 'dawn.css': THEME });
    writeBundle(plain.root, { precompress: false });
    expect(readdirSync(plain.directory)).toEqual(['dawn.css']);
  });

  it('a build with no color themes is not an error', () => {
    const root = makeTempDir('station-ui-assets-');
    expect(() => writeBundle(root)).not.toThrow();
  });
});
