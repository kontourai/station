import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { describe, expect, test } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const source = join(root, 'src');
const external = [
  'react',
  'react/jsx-runtime',
  '@tanstack/react-query',
  '@kontourai/*',
];

async function bundledGzipBytes(entry: string) {
  const result = await build({
    entryPoints: [join(source, entry)],
    bundle: true,
    minify: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    write: false,
    external,
    loader: { '.css': 'empty' },
  });
  return gzipSync(result.outputFiles[0]!.contents, { level: 9 }).byteLength;
}

async function combinedSessionInventoryGzipBytes() {
  const result = await build({
    stdin: {
      contents:
        "export { SessionInventory } from './SessionInventory';\nexport * from './session-inventory-view';\n",
      resolveDir: source,
      sourcefile: 'session-inventory-combined.ts',
      loader: 'ts',
    },
    bundle: true,
    minify: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    write: false,
    external,
    loader: { '.css': 'empty' },
  });
  return gzipSync(result.outputFiles[0]!.contents, { level: 9 }).byteLength;
}

describe('@kontourai/station-basis-pane package boundary', () => {
  test('uses published contracts and keeps the optional Surface MCP client out', async () => {
    const files = (await readdir(join(import.meta.dirname, '..'))).filter(
      (name) => /\.(ts|tsx)$/u.test(name),
    );
    const source = (
      await Promise.all(
        files.map((name) =>
          readFile(join(import.meta.dirname, '..', name), 'utf8'),
        ),
      )
    ).join('\n');
    expect(source).not.toMatch(
      /src-ui|src-server|@kontourai\/surface\/basis\/mcp/u,
    );
    expect(source).not.toMatch(/from ['"]@kontourai\/surface['"]/u);
    expect(source).toContain('@kontourai/surface/basis/view');
    expect(source).not.toContain('StationBasisPaneHost');
  });

  test('keeps the package-owned JS and CSS within explicit budgets', async () => {
    expect(await bundledGzipBytes('StationBasisPane.tsx')).toBeLessThanOrEqual(
      5_512,
    );
    expect(await bundledGzipBytes('index.ts')).toBeLessThanOrEqual(6_800);
    expect(
      await bundledGzipBytes('workspace-basis-pane.ts'),
    ).toBeLessThanOrEqual(1_536);
    expect(await combinedSessionInventoryGzipBytes()).toBeLessThanOrEqual(
      2_944,
    );

    const css = await readFile(join(source, 'station-basis-pane.css'));
    const minified = await build({
      stdin: {
        contents: css,
        sourcefile: 'station-basis-pane.css',
        loader: 'css',
      },
      minify: true,
      write: false,
    });
    expect(
      gzipSync(minified.outputFiles[0]!.contents, { level: 9 }).byteLength,
    ).toBeLessThanOrEqual(640);
  });
});
