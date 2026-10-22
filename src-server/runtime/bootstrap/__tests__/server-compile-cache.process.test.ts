import {
  chmodSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { spawnSyncBounded } from '../../../../scripts/lib/bounded-capture.mjs';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

const tempDir = trackTempDirs();
const root = process.cwd();
const buildTempDir = trackTempDirs({ base: root });
const moduleUrl = (path: string) => pathToFileURL(resolve(root, path)).href;

// The executable proof below owns cache and descendant behavior. This small
// source-only composition guard owns the first import in the source entry.
test('source-only wiring: compile-cache isolation is the first server import', () => {
  expect(
    readFileSync(resolve(root, 'src-server/index.ts'), 'utf8').split('\n')[0],
  ).toBe("import './runtime/bootstrap/server-compile-cache.js';");
});

describe.skipIf(process.platform === 'win32')(
  'server compile cache process boundary',
  () => {
    test('the built server entry removes dotenv cache settings before child inheritance', () => {
      const directory = tempDir('station-dotenv-cache-');
      const build = buildTempDir('dist-server-cache-entry-');
      const env: NodeJS.ProcessEnv = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (
          key.startsWith('STATION_') ||
          key.startsWith('OTEL_') ||
          key.startsWith('DOTENV_')
        )
          continue;
        if (key === 'PORT' || key === 'NODE_COMPILE_CACHE') continue;
        env[key] = value;
      }
      const built = spawnSyncBounded('npm', ['run', 'build:server'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 120000,
        windowsHide: true,
        env: { ...env, STATION_BUILD_SERVER_DIR: build },
      });
      expect(built.error).toBeUndefined();
      expect(built.status, built.stderr).toBe(0);
      writeFileSync(
        join(directory, '.env'),
        `NODE_COMPILE_CACHE=${JSON.stringify(join(directory, 'dotenv-cache'))}\nENTRY_DOTENV_WITNESS=loaded\n`,
      );
      cpSync(join(root, 'schemas'), join(directory, 'schemas'), {
        recursive: true,
      });
      const observation = join(directory, 'observation.json');
      const preload = join(directory, 'observe-entry.mjs');
      writeFileSync(
        preload,
        `
        import childProcess from 'node:child_process';
        import { syncBuiltinESMExports, getCompileCacheDir } from 'node:module';
        import { writeFileSync } from 'node:fs';
        import { spawnSyncBounded } from ${JSON.stringify(moduleUrl('scripts/lib/bounded-capture.mjs'))};
        const originalSpawnSync = childProcess.spawnSync;
        const launches = [];
        for (const method of ['spawn', 'spawnSync', 'fork', 'exec', 'execSync', 'execFile', 'execFileSync']) {
          const original = childProcess[method];
          const wrapped = function(...args) {
            launches.push(method);
            return Reflect.apply(original, this, args);
          };
          Object.assign(wrapped, original);
          const custom = Symbol.for('nodejs.util.promisify.custom');
          if (original[custom]) wrapped[custom] = function(...args) {
            launches.push(method);
            return Reflect.apply(original[custom], this, args);
          };
          childProcess[method] = wrapped;
        }
        syncBuiltinESMExports();
        process.on('exit', code => {
          const dependencyLaunches = [...launches];
          const child = spawnSyncBounded(process.execPath,
            ['-e', 'process.stdout.write(JSON.stringify({ cache: process.env.NODE_COMPILE_CACHE ?? null }))'],
            { encoding: 'utf8', timeout: 10000, windowsHide: true },
            { run: originalSpawnSync });
          writeFileSync(${JSON.stringify(observation)}, JSON.stringify({
            code, dotenvWitness: process.env.ENTRY_DOTENV_WITNESS,
            cacheDir: getCompileCacheDir() ?? null, dependencyLaunches,
            childStatus: child.status, childError: child.error?.message ?? null,
            child: JSON.parse(child.stdout),
          }));
        });
      `,
      );
      // Fail at a deliberate runtime configuration boundary: every static
      // dependency and dotenv has evaluated, without starting server listeners.
      // The probe is a real child of that entry process, not another bootstrap
      // import or a simulated environment spread.
      for (const startupCache of [
        undefined,
        join(directory, 'startup-cache'),
      ]) {
        const launched = spawnSyncBounded(
          process.execPath,
          ['--import', preload, join(build, 'command-station.js')],
          {
            cwd: directory,
            encoding: 'utf8',
            timeout: 60000,
            windowsHide: true,
            env: {
              ...env,
              ...(startupCache ? { NODE_COMPILE_CACHE: startupCache } : {}),
              PORT: 'invalid',
              STATION_HOME: join(directory, 'home'),
              STATION_INSTANCE_ID: 'dotenv-cache-test',
              STATION_TEMP_ROOT: join(directory, 'temp'),
              STATION_OWNED_PROCESS_REGISTRY: join(
                directory,
                'owned-processes',
              ),
            },
          },
        );
        expect(launched.error).toBeUndefined();
        expect(launched.status, launched.stderr).toBe(1);
        expect(launched.stderr).toContain('PORT must be an integer');
        const observed = JSON.parse(readFileSync(observation, 'utf8'));
        expect(observed.dotenvWitness).toBe('loaded');
        expect(observed.childError).toBeNull();
        expect(observed.childStatus).toBe(0);
        expect(observed.child).toEqual({ cache: null });
        expect(observed.cacheDir?.startsWith(startupCache) ?? false).toBe(
          Boolean(startupCache),
        );
        // External ESM dependencies evaluate before bundled bootstrap code.
        // No child launch is observed in that dependency graph for this build.
        expect(observed.dependencyLaunches).toEqual([]);
      }
    }, 240000);

    test('keeps its active cache across two starts while every affected child path sees no setting', () => {
      const home = tempDir('station-server-cache-');
      const cache = join(home, 'cache');
      const mcp = join(home, 'mcp.cjs');
      writeFileSync(
        mcp,
        `
      const readline = require('node:readline');
      const tools = [{ name: process.env.NODE_COMPILE_CACHE ? 'cache_leaked' : 'cache_absent',
        description: 'Observed child environment', inputSchema: { type: 'object' } }];
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const message = JSON.parse(line);
        if (message.id === undefined) return;
        const result = message.method === 'initialize'
          ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'cache-fixture', version: '1' } }
          : { tools };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
      });
    `,
      );
      const flow = join(home, 'flow.cjs');
      writeFileSync(
        flow,
        'console.log(JSON.stringify({ cache: process.env.NODE_COMPILE_CACHE ?? null }));',
      );
      const shell = join(home, 'shell');
      writeFileSync(
        shell,
        `#!${process.execPath}\nconsole.log('__STATION_LOGIN_PATH_START_7f3a9c__' + (process.env.NODE_COMPILE_CACHE ?? 'cache_absent') + '__STATION_LOGIN_PATH_END_7f3a9c__');`,
      );
      chmodSync(shell, 0o700);
      mkdirSync(join(home, '.veritas'));
      mkdirSync(join(home, 'node_modules', '.bin'), { recursive: true });
      const veritas = join(home, 'node_modules', '.bin', 'veritas');
      const observation = join(home, 'veritas-env');
      writeFileSync(
        veritas,
        `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(observation)}, JSON.stringify({ cache: process.env.NODE_COMPILE_CACHE ?? null })); process.exit(2);`,
      );
      chmodSync(veritas, 0o700);

      const source = `
      import ${JSON.stringify(moduleUrl('src-server/runtime/bootstrap/server-compile-cache.ts'))};
      import assert from 'node:assert/strict';
      import { getCompileCacheDir, flushCompileCache } from 'node:module';
      import { readFileSync } from 'node:fs';
      assert.ok(getCompileCacheDir(), 'Node cache must remain enabled after deletion');
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { createMCPTransport, MCPLocalConnectionCustody } = await import('@kontourai/station-shared/mcp');
      const def = { id: 'cache-probe', kind: 'mcp', transport: 'stdio', command: process.execPath, args: [${JSON.stringify(mcp)}] };
      for (const transport of ['stdio', undefined]) {
        const client = new Client({ name: 'cache-test', version: '1' });
        try {
          await client.connect(createMCPTransport({ ...def, transport }));
          assert.equal((await client.listTools()).tools[0].name, 'cache_absent');
        } finally { await client.close(); }
      }
      const { loadStrandsTools } = await import(${JSON.stringify(moduleUrl('src-server/runtime/frameworks/strands-tool-loader.ts'))});
      const custody = new MCPLocalConnectionCustody();
      const state = { mcpClients: new Map(), agentMcpClients: new Map() };
      const opts = {
        serverPort: 43127, mcpCustody: custody,
        configLoader: { loadIntegration: async () => def },
        mcpConnectionStatus: new Map(), integrationMetadata: new Map(),
        toolNameMapping: new Map(), toolNameReverseMapping: new Map(),
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      };
      try {
        const tools = await loadStrandsTools({ slug: 'cache-test', spec: { tools: { mcpServers: [def.id], available: ['*'] } }, opts, state });
        assert.equal(tools.length, 1, 'Strands must reach the real MCP server');
        assert.match(tools[0].name, /cacheAbsent$/);
      } finally { await custody.reset(); }
      const { createDefaultFlowAgentsCliRunner } = await import(${JSON.stringify(moduleUrl('src-server/services/work-item-providers/flow-agents-work-item-provider.ts'))});
      const result = await createDefaultFlowAgentsCliRunner()(${JSON.stringify(flow)}, [], { cwd: ${JSON.stringify(home)}, timeoutMs: 10000 });
      assert.equal(result.exitCode, 0);
      assert.deepEqual(JSON.parse(result.stdout), { cache: null });
      const { VeritasReadinessService, VeritasCliError } = await import(${JSON.stringify(moduleUrl('src-server/services/evidence/veritas-readiness-service.ts'))});
      await assert.rejects(new VeritasReadinessService().getReadiness(${JSON.stringify(home)}), error => error instanceof VeritasCliError && error.exitCode === 2);
      assert.deepEqual(JSON.parse(readFileSync(${JSON.stringify(observation)}, 'utf8')), { cache: null });
      const { resolveLoginShellPath } = await import(${JSON.stringify(moduleUrl('src-server/providers/auth/cli-auth.ts'))});
      assert.equal(await resolveLoginShellPath(), 'cache_absent');
      flushCompileCache();
      console.log('all child paths isolated; active cache retained');
      console.log(JSON.stringify({ nodeCache: getCompileCacheDir() }));
    `;
      for (let start = 0; start < 2; start++) {
        const child = spawnSyncBounded(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', source],
          {
            cwd: root,
            encoding: 'utf8',
            timeout: 60000,
            windowsHide: true,
            env: {
              ...process.env,
              NODE_COMPILE_CACHE: cache,
              STATION_HOME: home,
              STATION_INSTANCE_ID: 'desktop-cache-test',
              STATION_PORT: '43127',
              SHELL: shell,
            },
          },
        );
        expect(child.error).toBeUndefined();
        expect(child.status, child.stderr).toBe(0);
        expect(child.stdout).toContain(
          'all child paths isolated; active cache retained',
        );
        const report = JSON.parse(child.stdout.trim().split('\n').at(-1)!);
        expect(report.nodeCache.startsWith(cache)).toBe(true);
        expect(readdirSync(report.nodeCache).length).toBeGreaterThan(0);
        // Empty the first start's output: the second must populate Node's own
        // cache again after the bootstrap has removed the environment setting.
        if (start === 0) rmSync(cache, { recursive: true, force: true });
      }
    }, 150000);
  },
);
