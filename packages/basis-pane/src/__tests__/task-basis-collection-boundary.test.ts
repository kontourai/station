import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, test } from 'vitest';

describe('Whole Task collection public browser boundary', () => {
  test('bundles the real headless export without React, MCP clients, or private Station code', async () => {
    const root = join(import.meta.dirname, '..', '..');
    const manifest = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    );
    expect(manifest.exports['./task-basis-collection-view']).toBe(
      './src/task-basis-collection-view.ts',
    );
    const result = await build({
      entryPoints: [
        join(root, manifest.exports['./task-basis-collection-view']),
      ],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      metafile: true,
      write: false,
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile!.inputs);
    expect(inputs.some((path) => /surface\/.*\/basis\/view/u.test(path))).toBe(
      true,
    );
    expect(inputs.some((path) => path.endsWith('/task-basis-mcp.ts'))).toBe(
      true,
    );
    expect(inputs.join('\n')).not.toMatch(
      /node_modules\/(?:react(?:-dom)?|@modelcontextprotocol)\/|src-server\/|src-ui\//u,
    );
    expect(result.outputFiles).toHaveLength(1);
    expect(result.outputFiles[0]!.text).not.toMatch(/\bBuffer\b|node:/u);
  });
});
