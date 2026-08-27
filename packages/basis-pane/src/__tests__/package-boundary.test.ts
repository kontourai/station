import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { describe, expect, test } from 'vitest';

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
    const root = join(import.meta.dirname, '..', '..');
    const result = await build({
      entryPoints: [join(root, 'src', 'index.ts')],
      bundle: true,
      minify: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      write: false,
      external: [
        'react',
        'react/jsx-runtime',
        '@tanstack/react-query',
        '@kontourai/*',
      ],
      loader: { '.css': 'empty' },
    });
    expect(
      gzipSync(result.outputFiles[0]!.contents, { level: 9 }).byteLength,
      // Exact result action slots, retained result chrome and subject-scoped
      // disclosure/focus continuity and the Surface 3 policy outcome add 1,197
      // bytes over origin/main's same-worktree 4,315-byte baseline. Effectful
      // SDK/host controls and owner libraries remain outside this package.
    ).toBeLessThanOrEqual(5_512);
    const css = await readFile(join(root, 'src', 'station-basis-pane.css'));
    // Wrapping, inert text, 44px actions and semantic group reset add 156 bytes.
    expect(gzipSync(css, { level: 9 }).byteLength).toBeLessThanOrEqual(629);
  });
});
