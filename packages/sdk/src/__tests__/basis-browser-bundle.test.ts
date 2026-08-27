import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { describe, expect, test } from 'vitest';

describe('Basis SDK browser bundle', () => {
  test('contains no Buffer or Node built-in dependency', async () => {
    const result = await esbuild.build({
      bundle: true,
      entryPoints: [
        fileURLToPath(new URL('../answer-basis.ts', import.meta.url)),
      ],
      format: 'esm',
      logLevel: 'silent',
      platform: 'browser',
      write: false,
    });
    expect(result.outputFiles).toHaveLength(1);
    const bundle = result.outputFiles[0]?.text ?? '';
    // Word-boundary, not substring: `toContain('Buffer')` also matches
    // `arrayBuffer`, a standard browser Response method, so this guard went
    // red the moment the bundle touched `response.arrayBuffer()` — reporting
    // a Node global that was never there (station#4292). The subject is
    // Node's `Buffer` global, so match it as a whole word: this still
    // catches `Buffer.from(...)` and `globalThis.Buffer`.
    expect(bundle).not.toMatch(/\bBuffer\b/);
    expect(bundle).not.toContain('node:');
  });
});
