import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import {
  computePluginContentDigest,
  withPluginContentLock,
} from '../../../services/plugins/plugin-content-integrity.js';
import { createPluginGrantReconciliationService } from '../../../services/plugins/plugin-grant-reconciliation.js';
import {
  grantPermissions,
  readPluginGrantRecord,
} from '../../../services/plugins/plugin-permissions.js';
import { registerPluginPublicRoutes } from '../plugin-public-routes.js';
import {
  acquirePluginPublicServerModule,
  quiescePluginPublicServerModule,
} from '../plugin-public-server.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  pluginGrantsStoreCorruption: { add: vi.fn() },
  pluginServerRequestDuration: { record: vi.fn() },
  pluginServerRequests: { add: vi.fn() },
  routingDecision: { add: vi.fn() },
}));

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs
      .splice(0, cleanupDirs.length)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
  delete (globalThis as any).__pluginServerEvents;
});

function writePlugin(root: string, relativePath: string, content: string) {
  const fullPath = join(root, relativePath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content);
}

function createApp(
  projectHomeDir: string,
  emit = vi.fn(),
  grantReconciliation?: {
    reconcile(input: {
      pluginName: string;
      permissions: readonly string[];
    }): Promise<any>;
  },
) {
  const app = new Hono();
  registerPluginPublicRoutes(app, {
    eventBus: { emit } as any,
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    } as any,
    pluginsDir: join(projectHomeDir, 'plugins'),
    projectHomeDir,
    grantReconciliation: grantReconciliation as any,
  });
  return app;
}

// Async since archive#2646: a non-async helper would DISCARD the grant promise, so
// callers could not await it and the route below raced the durable write.
async function seedGrant(
  projectHomeDir: string,
  pluginName: string,
  permission: string,
): Promise<void> {
  await grantPermissions(projectHomeDir, pluginName, [permission]);
}

describe('plugin-public-routes', () => {
  test('announces a durable grant change after the write commits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    const pluginDir = join(root, 'plugins', 'plain-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writePlugin(
      pluginDir,
      'plugin.json',
      JSON.stringify({
        name: 'plain-plugin',
        version: '1.0.0',
        permissions: ['network.fetch'],
      }),
    );
    const emit = vi.fn();
    const response = await createApp(root, emit).request(
      '/plain-plugin/grant',
      {
        body: JSON.stringify({ permissions: ['network.fetch'] }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      },
    );

    expect(response.status).toBe(200);
    expect(emit).toHaveBeenCalledWith('plugins:grants-changed', {
      name: 'plain-plugin',
    });
  });

  test('station#3815: DELETE /grant withdraws a permission, announces the change, and reports what remains', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    const pluginDir = join(root, 'plugins', 'plain-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writePlugin(
      pluginDir,
      'plugin.json',
      JSON.stringify({
        name: 'plain-plugin',
        version: '1.0.0',
        permissions: ['network.fetch', 'navigation.dock'],
      }),
    );
    await grantPermissions(root, 'plain-plugin', [
      'network.fetch',
      'navigation.dock',
    ]);

    const emit = vi.fn();
    const response = await createApp(root, emit).request(
      '/plain-plugin/grant',
      {
        body: JSON.stringify({ permissions: ['network.fetch'] }),
        headers: { 'content-type': 'application/json' },
        method: 'DELETE',
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      revoked: string[];
      granted: string[];
    };
    expect(body.revoked).toEqual(['network.fetch']);
    // What the plugin still holds, so the caller never has to re-read to
    // find out what its own request left behind.
    expect(body.granted).toEqual(['navigation.dock']);
    // Enforcement reads this store, so a stale consumer would keep honouring
    // a withdrawn grant until it noticed.
    expect(emit).toHaveBeenCalledWith('plugins:grants-changed', {
      name: 'plain-plugin',
    });
  });

  test('retires runtime capability only after the provider grant is durably absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    const pluginDir = join(root, 'plugins', 'provider-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writePlugin(
      pluginDir,
      'plugin.json',
      JSON.stringify({
        name: 'provider-plugin',
        version: '1.0.0',
        providers: [{ type: 'providerAdapter', module: './provider.js' }],
      }),
    );
    await grantPermissions(root, 'provider-plugin', ['providers.register']);
    const reconcile = vi.fn(async () => {
      expect(
        readPluginGrantRecord(root, 'provider-plugin').permissions,
      ).toEqual([]);
      return {
        status: 'completed' as const,
        operationId: 'operation-1',
        generation: 1,
        installationGeneration: 'sha256:generation',
        effects: ['provider-retirement'],
      };
    });

    const response = await createApp(root, vi.fn(), { reconcile }).request(
      '/provider-plugin/grant',
      {
        body: JSON.stringify({ permissions: ['providers.register'] }),
        headers: { 'content-type': 'application/json' },
        method: 'DELETE',
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      granted: [],
      reconciliation: {
        status: 'completed',
        operationId: 'operation-1',
        effects: ['provider-retirement'],
      },
    });
    expect(reconcile).toHaveBeenCalledWith({
      pluginName: 'provider-plugin',
      permissions: ['providers.register'],
    });
  });

  test('reports 202 while a durable server grant revocation is still draining work', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    writePlugin(
      root,
      'plugins/server-plugin/plugin.json',
      JSON.stringify({
        name: 'server-plugin',
        version: '1.0.0',
        serverModule: './server.js',
      }),
    );
    await grantPermissions(root, 'server-plugin', ['plugin.server']);
    const reconcile = vi.fn(async () => ({
      status: 'winding-down' as const,
      operationId: 'operation-slow',
      generation: 1,
    }));

    const response = await createApp(root, vi.fn(), { reconcile }).request(
      '/server-plugin/grant',
      {
        body: JSON.stringify({ permissions: ['plugin.server'] }),
        headers: { 'content-type': 'application/json' },
        method: 'DELETE',
      },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      success: true,
      granted: [],
      reconciliation: {
        status: 'winding-down',
        operationId: 'operation-slow',
      },
    });
    expect(readPluginGrantRecord(root, 'server-plugin').permissions).toEqual(
      [],
    );
  });

  test('clean-home revocation fences and drains a real acquired server module before completing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    const pluginsDir = join(root, 'plugins');
    const manifest = {
      name: 'server-plugin',
      version: '1.0.0',
      serverModule: 'server.mjs',
    };
    writePlugin(
      root,
      'plugins/server-plugin/plugin.json',
      JSON.stringify(manifest),
    );
    writePlugin(
      root,
      'plugins/server-plugin/server.mjs',
      'export function register() {}\nexport function dispose() {}\n',
    );
    await grantPermissions(root, 'server-plugin', ['plugin.server']);
    const active = await acquirePluginPublicServerModule(
      pluginsDir,
      'server-plugin',
      manifest,
      { warn: vi.fn() } as any,
    );
    expect(active).not.toBeNull();
    const reconciliation = createPluginGrantReconciliationService(
      {
        snapshot: async () => ({
          installed: true,
          installationGeneration: computePluginContentDigest(
            pluginsDir,
            'server-plugin',
          ),
          providerGeneration: 0,
          grants: readPluginGrantRecord(root, 'server-plugin').permissions,
        }),
        quiesceModule: () =>
          quiescePluginPublicServerModule(pluginsDir, 'server-plugin'),
        quiesceSubscriptions: async () => ({ release: vi.fn() }),
        retireProviders: async () => 'retired',
        activateProviders: async () => {},
        settleProviderAdapters: async () => {},
        removeEngineConnections: async () => 'removed',
        reconcileEngineConnections: async () => {},
        reconcileSubscriptions: async () => ({ kind: 'applied' }),
      },
      { responseDeadlineMs: 5 },
    );

    const response = await createApp(root, vi.fn(), reconciliation).request(
      '/server-plugin/grant',
      {
        body: JSON.stringify({ permissions: ['plugin.server'] }),
        headers: { 'content-type': 'application/json' },
        method: 'DELETE',
      },
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      reconciliation: { operationId: string; generation: number };
    };
    expect(active?.isCurrent()).toBe(false);
    active?.release();
    await vi.waitFor(() =>
      expect(reconciliation.inspect('server-plugin')).toMatchObject({
        status: 'completed',
        operationId: body.reconciliation.operationId,
        generation: body.reconciliation.generation,
        effects: expect.arrayContaining(['module-quiescence']),
      }),
    );
  });

  test('station#4288: GET /permissions reports the content binding and what it withheld', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    writePlugin(
      root,
      'plugins/drifting/plugin.json',
      JSON.stringify({
        name: 'drifting',
        version: '1.0.0',
        permissions: ['network.fetch', 'navigation.dock'],
      }),
    );
    await grantPermissions(root, 'drifting', [
      'network.fetch',
      'navigation.dock',
    ]);

    const beforeChange = await readJson(
      await createApp(root).request('/drifting/permissions'),
    );
    expect(beforeChange).toMatchObject({
      contentBinding: 'bound',
      withheld: [],
    });
    expect((beforeChange as { granted: string[] }).granted.sort()).toEqual([
      'navigation.dock',
      'network.fetch',
    ]);

    // The code is replaced under the grant, through the same per-plugin
    // content lock the update route holds.
    await withPluginContentLock(join(root, 'plugins'), 'drifting', async () => {
      writePlugin(root, 'plugins/drifting/server.mjs', 'export const x = 1;');
    });

    const afterChange = await readJson(
      await createApp(root).request('/drifting/permissions'),
    );
    // Nothing survives a `changed` binding — the passive `navigation.dock`
    // included, because a changed tree is positive evidence that the bytes
    // every recorded name was given for are gone.
    expect(afterChange).toMatchObject({
      contentBinding: 'changed',
      granted: [],
    });
    expect((afterChange as { withheld: string[] }).withheld.sort()).toEqual([
      'navigation.dock',
      'network.fetch',
    ]);
  });

  /**
   * archive#4288, review HIGH 1. `POST /:name/grant` refuses `trusted`
   * permissions outright — they need the isolated host-approval channel. The
   * first draft's `grantPermissions` unioned the whole stored record with the
   * new permissions and re-stamped it with the current digest, so approving
   * ONE ordinary permission here silently handed back every trusted grant the
   * changed tree had withheld. The route's own ceremony was bypassed for
   * anything already recorded.
   */
  test('station#4288: approving an ordinary permission does not hand back a trusted grant the changed tree withheld', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    writePlugin(
      root,
      'plugins/relaunder/plugin.json',
      JSON.stringify({
        name: 'relaunder',
        version: '1.0.0',
        permissions: ['ui.confirm'],
        serverModule: 'server.mjs',
      }),
    );
    await grantPermissions(root, 'relaunder', ['plugin.server', 'ui.confirm']);

    // The tree is replaced. Every non-passive grant stops applying.
    await withPluginContentLock(
      join(root, 'plugins'),
      'relaunder',
      async () => {
        writePlugin(
          root,
          'plugins/relaunder/server.mjs',
          'export const x = 2;',
        );
      },
    );
    const app = createApp(root);
    expect(
      await readJson(await app.request('/relaunder/permissions')),
    ).toMatchObject({ contentBinding: 'changed', granted: [] });

    // The route will not grant `plugin.server` directly...
    const direct = await app.request('/relaunder/grant', {
      body: JSON.stringify({ permissions: ['plugin.server'] }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(direct.status).toBe(403);

    // ...and it must not grant it as a side effect of granting something else.
    const indirect = await app.request('/relaunder/grant', {
      body: JSON.stringify({ permissions: ['ui.confirm'] }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(indirect.status).toBe(200);

    // archive#4288, delta review MEDIUM 2. The withdrawal is correct; the
    // silence was the defect. This request DELETED a trusted grant that is
    // re-acquirable only through the isolated host-approval channel, so the
    // response says so rather than echoing the request back as `granted`.
    const indirectBody = (await indirect.json()) as {
      granted: string[];
      withdrawn: string[];
    };
    expect(indirectBody.withdrawn).toEqual(['plugin.server']);
    expect(indirectBody.granted).toEqual(['ui.confirm']);

    const after = await readJson(await app.request('/relaunder/permissions'));
    expect(after).toMatchObject({
      contentBinding: 'bound',
      granted: ['ui.confirm'],
    });
    expect((after as { granted: string[] }).granted).not.toContain(
      'plugin.server',
    );
  });

  /**
   * archive#4288, delta review MEDIUM 2. `granted` used to be the REQUEST
   * echoed back, which is the same answer whether the store already held ten
   * permissions or the write had just destroyed nine of them. `DELETE
   * /:name/grant` already answered with derived state; this pins that POST
   * agrees, on the ordinary `bound` path where nothing is withdrawn at all.
   */
  test('station#4288: POST /grant answers with the DERIVED effective set, not the request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    writePlugin(
      root,
      'plugins/plain-plugin/plugin.json',
      JSON.stringify({
        name: 'plain-plugin',
        version: '1.0.0',
        permissions: ['network.fetch', 'navigation.dock'],
      }),
    );
    await grantPermissions(root, 'plain-plugin', ['navigation.dock']);

    const response = await createApp(root).request('/plain-plugin/grant', {
      body: JSON.stringify({ permissions: ['network.fetch'] }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      granted: string[];
      withdrawn: string[];
    };
    // The request named one permission; the plugin now holds two.
    expect(body.granted.sort()).toEqual(['navigation.dock', 'network.fetch']);
    expect(body.withdrawn).toEqual([]);
  });

  test('station#4288: the enforcement gate refuses a permission whose tree changed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    writePlugin(
      root,
      'plugins/drifting/plugin.json',
      JSON.stringify({
        name: 'drifting',
        version: '1.0.0',
        permissions: ['network.fetch'],
      }),
    );
    await grantPermissions(root, 'drifting', ['network.fetch']);
    await withPluginContentLock(join(root, 'plugins'), 'drifting', async () => {
      writePlugin(root, 'plugins/drifting/server.mjs', 'export const x = 1;');
    });

    const response = await createApp(root).request('/drifting/fetch', {
      body: JSON.stringify({ url: 'https://example.invalid' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(403);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: "Plugin 'drifting' does not have network.fetch permission",
    });
  });

  test('station#3815: a plugin whose manifest is gone can still have its grants withdrawn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    // The grant is recorded while the plugin exists (archive#4288 binds a
    // grant to the bytes it was given for, so it cannot be recorded for a
    // tree that is not there) and the tree is then removed underneath it.
    // The files are gone; the grant record remains. Being unable to withdraw
    // authority because the thing holding it is broken would be exactly
    // backwards.
    writePlugin(
      root,
      'plugins/ghost-plugin/plugin.json',
      JSON.stringify({ name: 'ghost-plugin', version: '1.0.0' }),
    );
    await grantPermissions(root, 'ghost-plugin', [
      'network.fetch',
      'tools.invoke',
    ]);
    await rm(join(root, 'plugins', 'ghost-plugin'), {
      recursive: true,
      force: true,
    });

    const response = await createApp(root).request('/ghost-plugin/grant', {
      body: JSON.stringify({ permissions: ['network.fetch'] }),
      headers: { 'content-type': 'application/json' },
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as { revoked: string[] }).toMatchObject({
      revoked: ['network.fetch'],
    });
    // Asserting `granted: []` here would prove nothing: a missing tree reads
    // as `changed`, which withholds everything whether or not the withdrawal
    // happened (archive#4288, review LOW). The RECORD is what this test is
    // about — it is the thing withdrawal writes to.
    const record = readPluginGrantRecord(root, 'ghost-plugin');
    expect(record.permissions).toEqual(['tools.invoke']);
    expect(record.permissions).not.toContain('network.fetch');
  });

  test('rejects encoded plugin names that escape public route roots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    const app = createApp(root);

    const permissions = await app.request('/..%2Fvictim/permissions');
    const serverRoute = await app.request('/..%2Fvictim/anything');

    expect(permissions.status).toBe(400);
    expect(serverRoute.status).toBe(400);
  });

  test('dispatches plugin serverModule routes with a correlation id and merged settings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    const projectHomeDir = root;
    const pluginDir = join(projectHomeDir, 'plugins', 'demo-plugin');
    mkdirSync(pluginDir, { recursive: true });

    writePlugin(
      pluginDir,
      'plugin.json',
      JSON.stringify(
        {
          name: 'demo-plugin',
          version: '1.0.0',
          serverModule: 'plugin.mjs',
          settings: [
            {
              key: 'accentColor',
              label: 'Accent Color',
              type: 'string',
              default: '#1d4ed8',
            },
          ],
        },
        null,
        2,
      ),
    );
    writePlugin(
      pluginDir,
      'plugin.mjs',
      `globalThis.__pluginServerEvents = globalThis.__pluginServerEvents || [];
export const hooks = {
  onRequest(context) {
    globalThis.__pluginServerEvents.push(['request', context.correlationId]);
  },
  onResponse(context) {
    globalThis.__pluginServerEvents.push(['response', context.correlationId, context.status]);
  },
};

export default function register(app, { config }) {
  app.get('/ping', (c) =>
    c.json({
      ok: true,
      accentColor: config.get('accentColor'),
    }),
  );
}
`,
    );

    const app = createApp(projectHomeDir);
    await seedGrant(projectHomeDir, 'demo-plugin', 'plugin.server');
    const response = await app.request('/demo-plugin/ping');
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-station-correlation-id')).toBeTruthy();
    expect(body).toEqual({ ok: true, accentColor: '#1d4ed8' });
    expect((globalThis as any).__pluginServerEvents).toHaveLength(2);
    expect((globalThis as any).__pluginServerEvents[0][0]).toBe('request');
    expect((globalThis as any).__pluginServerEvents[1][0]).toBe('response');
    expect((globalThis as any).__pluginServerEvents[0][1]).toBe(
      (globalThis as any).__pluginServerEvents[1][1],
    );
  });

  test('rejects plugin serverModule dispatch before trusted grant', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    const pluginDir = join(root, 'plugins', 'demo-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writePlugin(
      pluginDir,
      'plugin.json',
      JSON.stringify({
        name: 'demo-plugin',
        version: '1.0.0',
        serverModule: 'plugin.mjs',
      }),
    );
    writePlugin(
      pluginDir,
      'plugin.mjs',
      `globalThis.__pluginServerEvents = ['imported']; export default function register(app) { app.get('/ping', (c) => c.json({ ok: true })); }`,
    );

    const response = await createApp(root).request('/demo-plugin/ping');

    expect(response.status).toBe(403);
    expect((globalThis as any).__pluginServerEvents).toBeUndefined();
  });

  test('returns generic plugin server failures with only a correlation id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    const pluginDir = join(root, 'plugins', 'throw-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writePlugin(
      pluginDir,
      'plugin.json',
      JSON.stringify({
        name: 'throw-plugin',
        serverModule: 'plugin.mjs',
        version: '1.0.0',
      }),
    );
    writePlugin(
      pluginDir,
      'plugin.mjs',
      `export default function register(app) {
  app.get('/secret', () => { throw new Error('secret path /Users/brian/.aws/credentials'); });
}`,
    );

    const app = createApp(root);
    await seedGrant(root, 'throw-plugin', 'plugin.server');

    const response = await app.request('/throw-plugin/secret');
    const body = await readJson(response);

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      error: 'Plugin server route failed',
      success: false,
    });
    expect(body.correlationId).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('/Users/brian/.aws');
  });

  test('returns generic plugin server failures when module import throws', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    const pluginDir = join(root, 'plugins', 'import-throw-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writePlugin(
      pluginDir,
      'plugin.json',
      JSON.stringify({
        name: 'import-throw-plugin',
        serverModule: 'plugin.mjs',
        version: '1.0.0',
      }),
    );
    writePlugin(
      pluginDir,
      'plugin.mjs',
      `throw new Error('secret import path /Users/brian/.aws/credentials');`,
    );

    const app = createApp(root);
    await seedGrant(root, 'import-throw-plugin', 'plugin.server');

    const response = await app.request('/import-throw-plugin/secret');
    const body = await readJson(response);

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      error: 'Plugin server route failed',
      success: false,
    });
    expect(body.correlationId).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('/Users/brian/.aws');
  });

  test('keeps the generic failure response when a plugin error hook throws', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    const pluginDir = join(root, 'plugins', 'error-hook-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writePlugin(
      pluginDir,
      'plugin.json',
      JSON.stringify({
        name: 'error-hook-plugin',
        serverModule: 'plugin.mjs',
        version: '1.0.0',
      }),
    );
    writePlugin(
      pluginDir,
      'plugin.mjs',
      `export const hooks = {
  onError() { throw new Error('secret hook path /Users/brian/.aws/credentials'); },
};
export default function register(app) {
  app.get('/secret', () => { throw new Error('secret route path /Users/brian/.aws/credentials'); });
}`,
    );

    const app = createApp(root);
    await seedGrant(root, 'error-hook-plugin', 'plugin.server');

    const response = await app.request('/error-hook-plugin/secret');
    const body = await readJson(response);

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      error: 'Plugin server route failed',
      success: false,
    });
    expect(body.correlationId).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('/Users/brian/.aws');
  });

  test('rejects unscoped compatibility fetch route', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    const response = await createApp(root).request('/fetch', {
      body: JSON.stringify({ url: 'http://127.0.0.1/' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(403);
  });

  test('rejects named fetch route even when network.fetch is granted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    const pluginDir = join(root, 'plugins', 'fetch-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writePlugin(
      pluginDir,
      'plugin.json',
      JSON.stringify({
        name: 'fetch-plugin',
        permissions: ['network.fetch'],
        version: '1.0.0',
      }),
    );
    const app = createApp(root);
    const grantResponse = await app.request('/fetch-plugin/grant', {
      body: JSON.stringify({ permissions: ['network.fetch'] }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(grantResponse.status).toBe(200);

    const response = await app.request('/fetch-plugin/fetch', {
      body: JSON.stringify({ url: 'http://127.0.0.1/' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(403);
    await expect(readJson(response)).resolves.toMatchObject({
      error: expect.stringContaining('disabled'),
    });
  });

  test('rejects grants not declared or required by the installed plugin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    const pluginDir = join(root, 'plugins', 'plain-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writePlugin(
      pluginDir,
      'plugin.json',
      JSON.stringify({ name: 'plain-plugin', version: '1.0.0' }),
    );

    const response = await createApp(root).request('/plain-plugin/grant', {
      body: JSON.stringify({ permissions: ['network.fetch'] }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(400);
  });

  test('rejects trusted grants from the public same-origin plugin route', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    const pluginDir = join(root, 'plugins', 'server-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writePlugin(
      pluginDir,
      'plugin.json',
      JSON.stringify({
        name: 'server-plugin',
        serverModule: 'plugin.mjs',
        version: '1.0.0',
      }),
    );

    const response = await createApp(root).request('/server-plugin/grant', {
      body: JSON.stringify({ permissions: ['plugin.server'] }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const body = await readJson(response);

    expect(response.status).toBe(403);
    expect(body.error).toContain('isolated host approval');
  });

  test('does not serve bundle assets through symlinks outside the plugin root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    const pluginDir = join(root, 'plugins', 'bundle-plugin');
    const outsideDir = join(root, 'outside');
    mkdirSync(join(pluginDir, 'dist'), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writePlugin(
      pluginDir,
      'plugin.json',
      JSON.stringify({
        name: 'bundle-plugin',
        version: '1.0.0',
      }),
    );
    writeFileSync(join(outsideDir, 'secret.js'), 'secret-token');
    symlinkSync(
      join(outsideDir, 'secret.js'),
      join(pluginDir, 'dist', 'bundle.js'),
    );

    const response = await createApp(root).request('/bundle-plugin/bundle.js');
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).not.toContain('secret-token');
  });

  test('does not serve bundle assets through symlinked plugin roots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    const pluginsDir = join(root, 'plugins');
    const outsideDir = join(root, 'outside-plugin');
    mkdirSync(join(outsideDir, 'dist'), { recursive: true });
    mkdirSync(pluginsDir, { recursive: true });
    writePlugin(
      outsideDir,
      'plugin.json',
      JSON.stringify({
        name: 'root-link-plugin',
        version: '1.0.0',
      }),
    );
    writeFileSync(join(outsideDir, 'dist', 'bundle.js'), 'secret-token');
    symlinkSync(outsideDir, join(pluginsDir, 'root-link-plugin'), 'dir');

    const response = await createApp(root).request(
      '/root-link-plugin/bundle.js',
    );
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).not.toContain('secret-token');
  });

  test('does not serve non-regular bundle assets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    const pluginDir = join(root, 'plugins', 'directory-bundle-plugin');
    mkdirSync(join(pluginDir, 'dist', 'bundle.js'), { recursive: true });
    writePlugin(
      pluginDir,
      'plugin.json',
      JSON.stringify({
        name: 'directory-bundle-plugin',
        version: '1.0.0',
      }),
    );

    const response = await createApp(root).request(
      '/directory-bundle-plugin/bundle.js',
    );

    expect(response.status).toBe(404);
  });

  test('returns 404 when the plugin has no serverModule', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    const pluginDir = join(root, 'plugins', 'plain-plugin');
    mkdirSync(pluginDir, { recursive: true });

    writePlugin(
      pluginDir,
      'plugin.json',
      JSON.stringify(
        {
          name: 'plain-plugin',
          version: '1.0.0',
        },
        null,
        2,
      ),
    );

    const app = createApp(root);
    const response = await app.request('/plain-plugin/ping');
    expect(response.status).toBe(404);
  });

  test('rejects plugin manifests that contain hidden unicode channels', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    const pluginDir = join(root, 'plugins', 'unsafe-plugin');
    mkdirSync(pluginDir, { recursive: true });

    writePlugin(
      pluginDir,
      'plugin.json',
      JSON.stringify(
        {
          name: 'unsafe-plugin',
          version: '1.0.0',
          description: 'safe\u200Btext',
        },
        null,
        2,
      ),
    );

    const app = createApp(root);
    const response = await app.request('/unsafe-plugin/permissions');
    const body = await readJson(response);

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Plugin manifest failed safety validation');
    expect(body.correlationId).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain(root);
  });

  test('does not leak manifest paths when wildcard dispatch rejects unsafe manifests', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    const pluginDir = join(root, 'plugins', 'unsafe-server-plugin');
    mkdirSync(pluginDir, { recursive: true });

    writePlugin(
      pluginDir,
      'plugin.json',
      JSON.stringify(
        {
          name: 'unsafe-server-plugin',
          version: '1.0.0',
          description: 'safe\u200Btext',
          serverModule: 'plugin.mjs',
        },
        null,
        2,
      ),
    );

    const app = createApp(root);
    const response = await app.request('/unsafe-server-plugin/ping');
    const body = await readJson(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: 'Plugin manifest failed safety validation',
      success: false,
    });
    expect(body.correlationId).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain(root);
  });
});

describe('plugin-public-routes grants-unavailable contract (#1835)', () => {
  test('a corrupt grants store surfaces as a path-free 503 on consent and display routes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-public-'));
    cleanupDirs.push(root);
    const pluginDir = join(root, 'plugins', 'demo-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writePlugin(
      pluginDir,
      'plugin.json',
      JSON.stringify({
        name: 'demo-plugin',
        version: '1.0.0',
        permissions: ['network.fetch'],
      }),
    );
    writeFileSync(join(root, 'plugin-grants.json'), 'not json');
    const app = createApp(root);

    const grant = await app.request('/demo-plugin/grant', {
      body: JSON.stringify({ permissions: ['network.fetch'] }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(grant.status).toBe(503);
    const grantBody = await readJson(grant);
    expect(grantBody.grantsUnavailable).toBe(true);
    // Client-visible message never names the operator's filesystem layout.
    expect(String(grantBody.error)).not.toContain(root);
    expect(String(grantBody.error)).not.toContain('plugin-grants.json');

    const permissions = await app.request('/demo-plugin/permissions');
    expect(permissions.status).toBe(503);
    const permissionsBody = await readJson(permissions);
    expect(permissionsBody.grantsUnavailable).toBe(true);
    expect(String(permissionsBody.error)).not.toContain(root);
  });
});
