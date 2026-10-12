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
 * `response.arrayBuffer()`, a browser API (archive#4292).
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

// The public package specifier exercises the export map as well as the resolved
// dependency graph. Keep every export alive so tree shaking cannot hide a leak.
describe.each(['browser', 'node'] as const)('Agent SDK on %s', (platform) => {
  test('resolves the public entry without UI or Station application dependencies', async () => {
    const result = await esbuild.build({
      entryPoints: ['@kontourai/station-sdk/agent'],
      bundle: true,
      format: 'esm',
      platform,
      metafile: true,
      logLevel: 'silent',
      write: false,
    });
    expect(result.outputFiles).toHaveLength(1);
    const forbidden = Object.keys(result.metafile.inputs).filter((path) =>
      /(?:^|\/)(?:react|react-dom|@tanstack\/react-query|src-ui|src-server|src-desktop)\/|\.(?:tsx|css)$/.test(
        path,
      ),
    );
    expect(forbidden).toEqual([]);
  });
});

// #3209: first-paint UI code imports client/execution for ordinary sends. Only
// the static-default send wrapper may reach the canonical reader and its large
// generated validator; an entry build keeps every execution export alive.
describe('execution client graph', () => {
  const reader =
    /skill-experience-reader\.ts$|agent-plugin-validators\.generated\.mjs$/;
  const graph = async (entry: string) => {
    const result = await esbuild.build({
      bundle: true,
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
      format: 'esm',
      logLevel: 'silent',
      metafile: true,
      platform: 'browser',
      write: false,
    });
    return Object.keys(result.metafile.inputs).filter((path) =>
      reader.test(path),
    );
  };

  test('client/execution does not reach the skill-experience reader', async () => {
    expect(await graph('../client/execution.ts')).toEqual([]);
  });

  test('positive control: the static send wrapper does reach it', async () => {
    expect(await graph('../client/send-execution-message.ts')).toHaveLength(2);
  });
});
