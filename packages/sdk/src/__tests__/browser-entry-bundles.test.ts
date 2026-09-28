import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { describe, expect, test } from 'vitest';

/**
 * Each opt-in SDK entry must bundle for a browser without Node built-ins.
 * Built-ins are detected by import specifier in the esbuild metafile, not by
 * scanning bundle text: the Pane bundle legitimately contains the object key
 * `node: {`. `Buffer` is matched as a whole word because the Basis bundle
 * uses `response.arrayBuffer()`, a browser API (station#4292).
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
      metafile: true,
      platform: 'browser',
      write: false,
    });

    expect(result.outputFiles).toHaveLength(1);
    const builtinImports = Object.entries(result.metafile.inputs).flatMap(
      ([input, { imports }]) =>
        imports
          .filter(({ path }) => isBuiltin(path))
          .map(({ path }) => `${input} -> ${path}`),
    );
    expect(builtinImports).toEqual([]);
    const bundle = result.outputFiles[0]?.text ?? '';
    expect(bundle).not.toMatch(/\bBuffer\b/);
    for (const text of mustContain) expect(bundle).toContain(text);
  });
});
