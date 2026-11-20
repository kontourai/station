import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
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

type Resolve = () => ReturnType<
  typeof import('../../providers/adapters/claude-station-docs.js').resolveClaudeStationDocs
>;

async function bundleSession(
  folder: string,
  bytes: Buffer,
  alias?: esbuild.BuildOptions['alias'],
) {
  const output = join(folder, 'station-docs-binding-test.mjs');
  await esbuild.build({
    ...STATION_SERVER_BUILD_OPTIONS,
    alias,
    stdin: {
      resolveDir: toolsDir,
      contents: `
        import { resolveClaudeStationDocs } from '../providers/adapters/claude-station-docs.ts';
        import { markRuntimeStationDocs, markCanonicalStationDocsDelivery } from './station-docs-binding.ts';
        import { stationDocsRuntimeIdentity } from '../runtime/bootstrap/station-control-runtime-env.ts';
        export function resolve() {
          const id = 'station-docs';
          const stored = { id, kind: 'mcp', transport: 'stdio' };
          const docs = { ...stored, ...stationDocsRuntimeIdentity() };
          const agent = { slug: 'station', toolServers: [docs] };
          markRuntimeStationDocs(docs, stored);
          markCanonicalStationDocsDelivery(agent, docs, null);
          return resolveClaudeStationDocs({ agent, provider: 'claude', threadId: 'docs' });
        }
      `,
    },
    outfile: output,
    define: {
      __STATION_DOCS_EXECUTABLE__: JSON.stringify({
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }),
    },
  });
  return (label: string) =>
    import(`${pathToFileURL(output).href}?${label}`) as Promise<{
      resolve: Resolve;
    }>;
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

  test.skipIf(process.platform !== 'darwin')(
    'lazy sessions search the same verified stdio bytes after the discovery file changes',
    async () => {
      const entry = join(outdir, 'station-docs.js');
      await esbuild.build({
        ...STATION_SERVER_BUILD_OPTIONS,
        banner: undefined,
        entryPoints: [join(toolsDir, 'station-docs-server.ts')],
        outfile: entry,
      });
      const bytes = await readFile(entry);
      const load = await bundleSession(outdir, bytes);
      const changed = Buffer.from(bytes);
      changed[0] = 0;
      await writeFile(entry, changed);
      const unverified = await load('unverified');
      expect(await unverified.resolve()).toBeUndefined();

      await writeFile(entry, bytes);
      const verified = await load('verified');
      const first = await verified.resolve();
      if (!first) throw new Error('Verified docs snapshot was unavailable');
      await writeFile(entry, changed);
      const second = await verified.resolve();
      if (!second) throw new Error('The host lost its verified docs snapshot');
      try {
        for (const session of [first, second]) {
          const client = new Client({ name: 'docs-test', version: '1' });
          const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
          const server: ReturnType<
            typeof import('../station-docs-tools.js').createStationDocsToolServer
          > = session.config.instance;
          await server.connect(serverSide);
          try {
            await client.connect(clientSide);
            const result = await client.callTool({
              name: 'search_station_docs',
              arguments: { query: 'cron job', limit: 1 },
            });
            expect(result.content[0]).toMatchObject({
              type: 'text',
              text: expect.stringContaining('"id": "scheduled-jobs"'),
            });
          } finally {
            await client.close();
            await server.close();
            await session.close();
          }
        }
      } finally {
        await Promise.all([first.close(), second.close()]);
      }
    },
    20_000,
  );

  test.skipIf(process.platform !== 'darwin')(
    'session close waits for owned child exit during initialization',
    async () => {
      const folder = makeTempDir('station-docs-exit-');
      const bytes = Buffer.from('export {};');
      await writeFile(join(folder, 'station-docs.js'), bytes);
      const child = Object.assign(new EventEmitter(), {
        exitCode: null,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stdio: [null, null, null, new PassThrough()],
        kill: vi.fn(() => true),
      });
      const initialize = new Promise<string>((resolve) => {
        child.stdin.once('data', (data: Buffer) => resolve(data.toString()));
      });
      const spawn = vi.fn(() => {
        queueMicrotask(() => child.emit('spawn'));
        return child;
      });
      vi.stubGlobal('stationDocsTestSpawn', spawn);
      const spawnShim = join(folder, 'controlled-spawn.mjs');
      await writeFile(
        spawnShim,
        'export default globalThis.stationDocsTestSpawn;',
      );
      const load = await bundleSession(folder, bytes, {
        'cross-spawn': spawnShim,
      });
      const session = await (await load('partial')).resolve();
      if (!session) throw new Error('Verified docs snapshot was unavailable');
      const client = new Client({ name: 'docs-test', version: '1' });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const server: ReturnType<
        typeof import('../station-docs-tools.js').createStationDocsToolServer
      > = session.config.instance;
      await server.connect(serverSide);
      await client.connect(clientSide);

      let closed = false;
      let pending: Promise<unknown> | undefined;
      let closing: Promise<void> | undefined;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        pending = client
          .callTool({
            name: 'search_station_docs',
            arguments: { query: 'cron job', limit: 1 },
          })
          .catch((error: unknown) => error);
        expect(JSON.parse(await initialize)).toMatchObject({
          method: 'initialize',
        });
        closing = session.close().then(() => {
          closed = true;
        });
        // Let the SDK exhaust its grace periods while the child has yet to exit.
        await vi.advanceTimersToNextTimerAsync();
        await vi.advanceTimersToNextTimerAsync();
        expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
        expect(
          closed,
          'session close returned before its owned child exited',
        ).toBe(false);
      } finally {
        child.emit('exit', null, 'SIGKILL');
        child.emit('close', null, 'SIGKILL');
        vi.useRealTimers();
        await (closing ?? session.close());
        await pending;
        await client.close();
        await server.close();
        child.stdin.destroy();
        child.stdout.destroy();
        child.stdio[3]?.destroy();
      }
      expect(closed).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );

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
