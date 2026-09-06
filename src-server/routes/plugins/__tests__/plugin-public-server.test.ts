import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  acquirePluginPublicServerModule,
  buildPluginRequestContext,
  createScopedPluginRequest,
  disposeAllPluginPublicServerModules,
  disposePluginPublicServerModule,
  loadPluginPublicServerModule,
  quiesceAllPluginPublicServerModules,
  quiescePluginPublicServerModule,
  readPluginPublicManifest,
  readPluginServerSettings,
} from '../plugin-public-server.js';

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs
      .splice(0, cleanupDirs.length)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('plugin-public-server helpers', () => {
  test('createScopedPluginRequest strips the plugin prefix', async () => {
    const app = new Hono();
    app.get('/api/plugins/demo-plugin/ping', (c) => {
      const request = createScopedPluginRequest(c, 'demo-plugin');
      return c.json({ pathname: new URL(request.url).pathname });
    });

    const response = await app.request('/api/plugins/demo-plugin/ping');
    expect(await response.json()).toEqual({ pathname: '/ping' });
  });

  test('buildPluginRequestContext prefers incoming correlation ids', async () => {
    const app = new Hono();
    app.get('/demo-plugin/ping', (c) =>
      c.json(buildPluginRequestContext(c, 'demo-plugin')),
    );

    const response = await app.request('/demo-plugin/ping', {
      headers: { 'x-request-id': 'req-123' },
    });
    const body = await response.json();

    expect(body).toEqual(
      expect.objectContaining({
        correlationId: 'req-123',
        method: 'GET',
        pluginName: 'demo-plugin',
        path: '/demo-plugin/ping',
      }),
    );
  });

  test('rejects server modules that escape the plugin root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-server-'));
    cleanupDirs.push(root);
    const pluginsDir = join(root, 'plugins');
    mkdirSync(join(pluginsDir, 'demo-plugin'), { recursive: true });
    writeFileSync(join(root, 'outside.mjs'), 'export default {};');
    writeFileSync(
      join(pluginsDir, 'demo-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'demo-plugin',
        version: '1.0.0',
        serverModule: '../outside.mjs',
      }),
    );

    await expect(
      loadPluginPublicServerModule(
        pluginsDir,
        'demo-plugin',
        {
          name: 'demo-plugin',
          version: '1.0.0',
          serverModule: '../outside.mjs',
        },
        { warn: vi.fn() } as any,
      ),
    ).rejects.toThrow(/Plugin server module escapes root/);
  });

  test('disposes a loaded plugin server module before authority is removed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-dispose-'));
    cleanupDirs.push(root);
    const pluginsDir = join(root, 'plugins');
    const pluginDir = join(pluginsDir, 'demo-plugin');
    const disposedFile = join(root, 'disposed');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: basename(pluginDir),
        version: '1.0.0',
        serverModule: 'server.mjs',
      }),
    );
    writeFileSync(
      join(pluginDir, 'server.mjs'),
      [
        "import { writeFileSync } from 'node:fs';",
        'export function register() {}',
        `export function dispose() { writeFileSync(${JSON.stringify(disposedFile)}, 'disposed'); }`,
      ].join('\n'),
    );
    const manifest = {
      name: 'demo-plugin',
      version: '1.0.0',
      serverModule: 'server.mjs',
    };

    const first = await loadPluginPublicServerModule(
      pluginsDir,
      'demo-plugin',
      manifest,
      { warn: vi.fn() } as any,
    );
    const second = await loadPluginPublicServerModule(
      pluginsDir,
      'demo-plugin',
      manifest,
      { warn: vi.fn() } as any,
    );
    expect(second).toBe(first);

    await disposePluginPublicServerModule(pluginsDir, 'demo-plugin');
    expect(existsSync(disposedFile)).toBe(true);
  });

  test('loads the public operational event observer from the server module', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-events-'));
    cleanupDirs.push(root);
    const pluginsDir = join(root, 'plugins');
    const pluginDir = join(pluginsDir, 'demo-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: basename(pluginDir),
        version: '1.0.0',
        serverModule: 'server.mjs',
      }),
    );
    writeFileSync(
      join(pluginDir, 'server.mjs'),
      [
        'export function register() {}',
        "export const operationalEvents = { observe: async () => ({ kind: 'accepted' }) };",
      ].join('\n'),
    );
    const loaded = await loadPluginPublicServerModule(
      pluginsDir,
      'demo-plugin',
      {
        name: 'demo-plugin',
        version: '1.0.0',
        serverModule: 'server.mjs',
      },
      { warn: vi.fn() } as any,
    );

    await expect(
      loaded?.operationalEvents?.observe({
        subscriptionId: 'runtime-ready',
        projection: {
          kind: 'redacted',
          event: {
            schemaVersion: 'station.operational-event/v1',
            id: 'event-1',
            type: 'station.runtime.lifecycle/v1',
            producer: { id: 'station-server', version: '1' },
            occurredAt: '2026-08-17T00:00:00.000Z',
            privacy: 'private',
            delivery: 'durable',
          },
        },
        idempotencyKey: 'key',
        attempt: 1,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'accepted' });
  });

  test('quiescence drains active requests and rejects reacquisition until mutation completes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-quiesce-'));
    cleanupDirs.push(root);
    const pluginsDir = join(root, 'plugins');
    const pluginDir = join(pluginsDir, 'demo-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: basename(pluginDir),
        version: '1.0.0',
        serverModule: 'server.mjs',
      }),
    );
    writeFileSync(
      join(pluginDir, 'server.mjs'),
      'export function register() {}\nexport function dispose() {}',
    );
    const manifest = {
      name: 'demo-plugin',
      version: '1.0.0',
      serverModule: 'server.mjs',
    };
    const active = await acquirePluginPublicServerModule(
      pluginsDir,
      'demo-plugin',
      manifest,
      { warn: vi.fn() } as any,
    );
    expect(active).not.toBeNull();

    let quiesced = false;
    const pending = quiescePluginPublicServerModule(
      pluginsDir,
      'demo-plugin',
    ).then((guard) => {
      quiesced = true;
      return guard;
    });
    await Promise.resolve();
    expect(quiesced).toBe(false);

    active?.release();
    const guard = await pending;
    await expect(
      acquirePluginPublicServerModule(pluginsDir, 'demo-plugin', manifest, {
        warn: vi.fn(),
      } as any),
    ).rejects.toThrow(/quiescing/);

    guard.release();
    const reloaded = await acquirePluginPublicServerModule(
      pluginsDir,
      'demo-plugin',
      manifest,
      { warn: vi.fn() } as any,
    );
    expect(reloaded).not.toBeNull();
    reloaded?.release();
  });

  test('global quiescence rejects the first acquisition of an unloaded plugin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-global-quiesce-'));
    cleanupDirs.push(root);
    const pluginsDir = join(root, 'plugins');
    const pluginDir = join(pluginsDir, 'late-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: basename(pluginDir),
        version: '1.0.0',
        serverModule: 'server.mjs',
      }),
    );
    writeFileSync(
      join(pluginDir, 'server.mjs'),
      'export function register() {}',
    );
    const manifest = {
      name: 'late-plugin',
      version: '1.0.0',
      serverModule: 'server.mjs',
    };

    const guard = await quiesceAllPluginPublicServerModules();
    await expect(
      acquirePluginPublicServerModule(pluginsDir, 'late-plugin', manifest, {
        warn: vi.fn(),
      } as any),
    ).rejects.toThrow(/globally quiescing/);

    guard.release();
    const acquired = await acquirePluginPublicServerModule(
      pluginsDir,
      'late-plugin',
      manifest,
      { warn: vi.fn() } as any,
    );
    expect(acquired).not.toBeNull();
    acquired?.release();
  });

  test('global quiescence drains an uncached import already in progress', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-import-drain-'));
    cleanupDirs.push(root);
    const pluginsDir = join(root, 'plugins');
    const pluginDir = join(pluginsDir, 'slow-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: basename(pluginDir),
        version: '1.0.0',
        serverModule: 'server.mjs',
      }),
    );
    writeFileSync(
      join(pluginDir, 'server.mjs'),
      [
        'await new Promise((resolve) => setTimeout(resolve, 40));',
        'export function register() {}',
      ].join('\n'),
    );
    const manifest = {
      name: 'slow-plugin',
      version: '1.0.0',
      serverModule: 'server.mjs',
    };

    let acquiredAfterBarrier = false;
    const acquiring = acquirePluginPublicServerModule(
      pluginsDir,
      'slow-plugin',
      manifest,
      { warn: vi.fn() } as any,
    ).then((acquired) => {
      acquiredAfterBarrier = true;
      acquired?.release();
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const guard = await quiesceAllPluginPublicServerModules();
    expect(acquiredAfterBarrier).toBe(true);
    await acquiring;
    await expect(
      acquirePluginPublicServerModule(pluginsDir, 'slow-plugin', manifest, {
        warn: vi.fn(),
      } as any),
    ).rejects.toThrow(/globally quiescing/);
    guard.release();
  });

  test('shutdown permanently rejects a late first acquisition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-shutdown-'));
    cleanupDirs.push(root);
    const pluginsDir = join(root, 'plugins');
    const pluginDir = join(pluginsDir, 'late-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: basename(pluginDir),
        version: '1.0.0',
        serverModule: 'server.mjs',
      }),
    );
    writeFileSync(
      join(pluginDir, 'server.mjs'),
      'export function register() {}',
    );

    await disposeAllPluginPublicServerModules();

    await expect(
      acquirePluginPublicServerModule(
        pluginsDir,
        'late-plugin',
        {
          name: 'late-plugin',
          version: '1.0.0',
          serverModule: 'server.mjs',
        },
        { warn: vi.fn() } as any,
      ),
    ).rejects.toThrow(/globally quiescing/);
  });
});

/**
 * archive#4307 review. `readPluginServerSettings` builds the map handed to a
 * plugin's server module as `config.get`/`config.all`
 * (`plugin-public-routes.ts`), and it built that map on a PLAIN-prototype
 * accumulator through two loops that both write keys nobody on this side
 * chose: `field.key` is manifest-author-controlled, and the second loop copies
 * every persisted settings key verbatim.
 *
 * So a `__proto__` key — the exact shape the store now persists as an own key —
 * REPARENTED the accumulator instead of landing on it. Reproduced against this
 * function before the fix:
 *
 *   own __proto__ key present : false          (the value was dropped)
 *   prototype reparented      : { apiKey: 'attacker-supplied' }
 *   config.get('apiKey')      : attacker-supplied     (a key nobody set)
 *   config.all()              : { endpoint: 'https://x.test' }
 *
 * `get` and `all` disagreeing is the defect: the plugin reads a value that is
 * in no store and that no operator can see or remove.
 */
describe('readPluginServerSettings prototype pollution (station#4307 review)', () => {
  function seedStore(contents: string) {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-server-proto-'));
    cleanupDirs.push(root);
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', 'plugin-overrides.json'), contents);
    return root;
  }

  test('a persisted __proto__ settings key cannot reparent the map handed to a server module', async () => {
    // Written as JSON text, not an object literal: `{ __proto__: … }` in JS
    // SOURCE sets the prototype instead of creating an own key, so the fixture
    // would never reach the case.
    const root = seedStore(
      '{"demo":{"settings":{"__proto__":{"apiKey":"attacker-supplied"},"endpoint":"https://x.test"}}}',
    );

    const merged = await readPluginServerSettings(root, 'demo', {
      // `apiKey` is deliberately NOT declared: an injected key that collides
      // with a declared field lands on the accumulator as an own property in
      // the first loop and would mask the defect. The dangerous read is the
      // one for a key the manifest never mentions and no store holds.
      name: 'demo',
      settings: [{ key: 'endpoint', label: 'Endpoint', type: 'string' }],
      version: '1.0.0',
    } as never);

    expect(Object.getPrototypeOf(merged)).toBeNull();
    // Pre-fix this read `attacker-supplied` off the reparented prototype.
    expect(merged.apiKey).toBeUndefined();
    // The value is an own key instead — visible to an operator, removable.
    expect(Object.hasOwn(merged, '__proto__')).toBe(true);
    expect(merged.endpoint).toBe('https://x.test');
    // `config.get` and `config.all` read the same object, so they agree:
    // pre-fix `get('apiKey')` answered a value `all()` did not contain.
    expect(Object.keys(merged).sort()).toEqual(['__proto__', 'endpoint']);
    expect(({} as Record<string, unknown>).apiKey).toBeUndefined();
  });

  test('a manifest declaring a reserved settings key is refused at parse, before any store write exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-server-proto-'));
    cleanupDirs.push(root);
    const pluginDir = join(root, 'plugins', 'demo');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: basename(pluginDir),
        version: '1.0.0',
        serverModule: 'server.mjs',
      }),
    );
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'demo',
        settings: [
          { default: { apiKey: 'attacker-supplied' }, key: '__proto__' },
        ],
        version: '1.0.0',
      }),
    );

    // This is the path with no store write anywhere in the story: the
    // manifest's own declared key was what reparented the map, on the FIRST
    // loop iteration.
    await expect(
      readPluginPublicManifest(join(root, 'plugins'), 'demo'),
    ).rejects.toThrow(
      /settings\[0\]\.key '__proto__' is a reserved object key/,
    );
  });
});
