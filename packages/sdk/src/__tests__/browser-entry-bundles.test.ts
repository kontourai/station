import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { describe, expect, test } from 'vitest';

/**
 * Each opt-in SDK entry must bundle for a browser without Node built-ins.
 * esbuild's browser platform refuses to resolve a Node built-in import
 * such as `node:util`, so a successful build is the import check; the
 * bundle text is not scanned for `node:` because the Pane bundle legitimately
 * contains the object key `node: {`. `Buffer` is a global, not an import, so
 * it is matched as a whole word: the Basis bundle uses
 * `response.arrayBuffer()`, a browser API (station#4292).
 */
describe.each([
  { entry: '../answer-basis.ts', mustContain: [] as string[] },
  { entry: '../workspace-browser-preview.ts', mustContain: [] },
  { entry: '../workspace-file-preview.ts', mustContain: [] },
  {
    entry: '../workspace-pane.ts',
    mustContain: ['parseWorkspaceCompositionSpec'],
  },
])('$entry browser bundle', ({ entry, mustContain }) => {
  test('bundles for a browser without a Buffer or Node built-in dependency', async () => {
    const result = await esbuild.build({
      bundle: true,
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
      format: 'esm',
      logLevel: 'silent',
      platform: 'browser',
      write: false,
    });

    expect(result.outputFiles).toHaveLength(1);
    const bundle = result.outputFiles[0]?.text ?? '';
    expect(bundle).not.toMatch(/\bBuffer\b/);
    for (const text of mustContain) expect(bundle).toContain(text);
  });
});
