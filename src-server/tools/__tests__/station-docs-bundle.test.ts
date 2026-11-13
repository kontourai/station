import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { STATION_SERVER_EXTERNALS } from '../../../scripts/lib/server-build-config.mjs';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';

/**
 * #4831: the docs server now bundles Corpus search. The source guard in
 * station-docs-mcp-server.test.ts sees only Station's own files, so this
 * builds the server the way esbuild.config.mjs does and checks what actually
 * lands in it: only Corpus's offline search entry and its two modules, no
 * file, network, or process module imported by any of them, nothing left to
 * resolve at runtime, and a bundle that loads and searches from a directory
 * with no package.json beside it while fetch throws. Importing the root
 * `@kontourai/corpus` entry instead fails all of these; its modules read
 * package.json and site-client.js next to themselves when they load.
 */

// esbuild.config.mjs's `shared` options for every server bundle, minus the
// build-identity globals in its banner, which the docs server never reads.
const STATION_SERVER_BUILD_OPTIONS = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  minify: true,
  keepNames: true,
  external: STATION_SERVER_EXTERNALS,
  banner: {
    js: "import { createRequire as __stationCreateRequire } from 'node:module'; const require = __stationCreateRequire(import.meta.url);",
  },
} satisfies esbuild.BuildOptions;

const OFFLINE_SEARCH_MODULES = [
  'src/markdown.mjs',
  'src/search-entry.mjs',
  'src/search.mjs',
];
const FORBIDDEN_MODULE =
  /^(node:)?(fs|fs\/promises|child_process|http|https|http2|net|tls|dgram|dns|worker_threads|cluster)$/;

const toolsDir = fileURLToPath(new URL('..', import.meta.url));
const makeTempDir = trackTempDirs({ lifetime: 'file' });

let outdir = '';
let metafile: esbuild.Metafile;

beforeAll(async () => {
  outdir = makeTempDir('station-docs-bundle-');
  const result = await esbuild.build({
    ...STATION_SERVER_BUILD_OPTIONS,
    entryPoints: [
      join(toolsDir, 'station-docs-server.ts'),
      join(toolsDir, 'station-docs-mcp-server.ts'),
    ],
    outdir,
    metafile: true,
    logLevel: 'silent',
  });
  metafile = result.metafile;
}, 60_000);

afterEach(() => {
  vi.unstubAllGlobals();
});

function corpusModules(): Map<string, esbuild.Metafile['inputs'][string]> {
  const modules = new Map<string, esbuild.Metafile['inputs'][string]>();
  for (const [path, input] of Object.entries(metafile.inputs)) {
    const match = /@kontourai\/corpus\/(.+)$/.exec(path.replaceAll('\\', '/'));
    if (match) modules.set(match[1], input);
  }
  return modules;
}

describe('the built station-docs bundle', () => {
  test('takes only Corpus’s offline search entry and its modules', () => {
    expect([...corpusModules().keys()].sort()).toEqual(OFFLINE_SEARCH_MODULES);
  });

  test('no Corpus module it holds imports file, network, or process modules', () => {
    for (const [path, input] of corpusModules())
      for (const imported of input.imports)
        expect(
          FORBIDDEN_MODULE.test(imported.path),
          `${path} imports ${imported.path}`,
        ).toBe(false);
  });

  test('leaves nothing but Node built-ins to resolve at runtime', () => {
    const builtins = new Set(builtinModules);
    for (const [file, output] of Object.entries(metafile.outputs)) {
      if (!file.endsWith('.js')) continue;
      for (const imported of output.imports) {
        const name = imported.path.replace(/^node:/, '');
        expect(
          imported.external && builtins.has(name),
          `${file} leaves ${imported.path} to resolve at runtime`,
        ).toBe(true);
      }
    }
  });

  test('loads with no package.json beside it and searches while fetch throws', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network unavailable');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const bundled = (await import(
      pathToFileURL(join(outdir, 'station-docs-mcp-server.js')).href
    )) as typeof import('../station-docs-mcp-server.js');
    const [first] = bundled.searchStationDocs('set up a cron job');
    expect(first.id).toBe('scheduled-jobs');
    expect(bundled.findStationDocsTopic('fleet')?.body).toContain(
      'Fleet inference',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
