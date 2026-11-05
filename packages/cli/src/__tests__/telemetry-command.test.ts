import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { bindOperatorPrincipal } from '../../../../src-server/__test-utils__/operator-principal.js';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../../src-server/domain/config-loader.js';
import { saveAppConfigFile } from '../../../../src-server/domain/config-loader-app.js';
import { ensureStationHomeSchemaSync } from '../../../../src-server/domain/home-schema-gate.js';
import { createConfigRoutes } from '../../../../src-server/routes/system/config.js';
import { createLogger } from '../../../../src-server/utils/logger.js';

const makeTempDir = trackTempDirs();
const PLUGIN = 'publisher:writer';
const NAMESPACED_PLUGIN = `publisher:${'a'.repeat(24)}/writer`;
const STATUS = {
  publishers: {
    kontour: { tier: 'lite', reason: 'user' },
    operator: { tier: 'lite', reason: 'user' },
    [PLUGIN]: { tier: 'lite', reason: 'user' },
    [NAMESPACED_PLUGIN]: { tier: 'lite', reason: 'user' },
  },
  liteInventoryRevision: 'fixture-revision',
};
let home: string;
let server: Server;
let loader: ConfigLoader;
let base: string;

beforeEach(async () => {
  home = makeTempDir('station-cli-telemetry-');
  ensureStationHomeSchemaSync(home);
  await saveAppConfigFile(home, {
    defaultModel: '',
    invokeModel: '',
    structureModel: '',
    telemetryTier: { kontour: 'off', operator: 'off' },
  });
  loader = new ConfigLoader({ projectHomeDir: home, watchFiles: false });
  const app = new Hono();
  bindOperatorPrincipal(app);
  app.route(
    '/config',
    createConfigRoutes(
      loader,
      createLogger({ name: 'cli-telemetry', level: 'error' }),
    ),
  );
  // Status presentation is a CLI contract; persistence uses the real config route.
  app.get('/api/usage-telemetry/status', (c) =>
    c.json({ success: true, data: STATUS }),
  );
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>((done) => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  loader.dispose();
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
});

function run(args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (done, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx/esm',
          resolve(__dirname, '../bin.ts'),
          'telemetry',
          ...args,
          `--api-base=${base}`,
          '--credential=operator-credential',
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            STATION_HOME: home,
            STATION_ROOT: home,
            STATION_API_CREDENTIAL: '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (status) => done({ status, stdout, stderr }));
    },
  );
}

test.each(['kontour', 'operator'])(
  'anonymous and lite both persist lite for %s through the published CLI',
  async (publisher) => {
    for (const input of ['anonymous', 'lite']) {
      await loader.updateAppConfig({ telemetryTier: { [publisher]: 'off' } });
      const result = await run(['set', publisher, input]);
      expect(result.status, result.stderr).toBe(0);
      const saved = JSON.parse(
        readFileSync(join(home, 'config/app.json'), 'utf8'),
      );
      expect(saved.telemetryTier[publisher]).toBe('lite');
    }
  },
  60_000,
);

test('plugin anonymous is refused and plugin lite remains accepted', async () => {
  for (const publisher of [PLUGIN, NAMESPACED_PLUGIN]) {
    const refused = await run(['set', publisher, 'anonymous']);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('Usage: station telemetry set');
    expect(
      (await loader.loadAppConfig()).telemetryTier?.[publisher],
    ).toBeUndefined();
  }
  const accepted = await run(['set', PLUGIN, 'lite']);
  expect(accepted.status, accepted.stderr).toBe(0);
  const saved = JSON.parse(readFileSync(join(home, 'config/app.json'), 'utf8'));
  expect(saved.telemetryTier[PLUGIN]).toBe('lite');
}, 60_000);

test.each([
  { label: 'station telemetry', args: [] as string[] },
  { label: 'station telemetry status', args: ['status'] },
])(
  'human status ($label) labels only built-in lite anonymous',
  async ({ args }) => {
    const result = await run(args);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'Kontour: Anonymous usage counts (anonymous)',
    );
    expect(result.stdout).toContain(
      'Additional destination: Anonymous usage counts (anonymous)',
    );
    for (const publisher of [PLUGIN, NAMESPACED_PLUGIN]) {
      const label = publisher.slice('publisher:'.length);
      const pluginLine = result.stdout
        .split('\n')
        .find((line) => line.startsWith(`${label}:`));
      expect(pluginLine).toBe(`${label}: Plugin usage counts (lite)`);
      expect(pluginLine?.toLowerCase()).not.toContain('anonymous');
    }
  },
  60_000,
);

test('JSON status preserves the complete server object and lite values', async () => {
  const result = await run(['--json']);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(`${JSON.stringify(STATUS)}\n`);
}, 60_000);

test('help explains the built-in alias and plugin boundary', async () => {
  const result = await run(['--help']);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(
    '<kontour|operator> <off|anonymous|lite|full>',
  );
  expect(result.stdout).toContain(
    'station telemetry set publisher:<id> <off|lite|full>',
  );
  expect(result.stdout).toContain(
    'anonymous is an alias for lite only for kontour and operator',
  );
}, 60_000);
