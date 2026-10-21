/**
 * The public agent registry through the real ACP routes: the real built-in
 * catalogue provider, a real registry source whose only network is an
 * injected fetch serving the 2026-10-21 index, and a real config home.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { BuiltinACPConnectionRegistryProvider } from '../../../providers/llm/defaults.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { PublicAgentRegistrySource } from '../../../services/acp/public-agent-registry.js';

let providerEntries: Array<{
  builtin?: boolean;
  source: string;
  provider: any;
}> = [];

vi.mock('../../../telemetry/metrics.js', () => ({
  acpOps: { add: vi.fn() },
}));
vi.mock('../../../providers/registries/registry.js', () => ({
  listProviders: (type: string) =>
    providerEntries.filter((entry) => entry.source.startsWith(type)),
}));

const { createACPRoutes } = await import('../acp.js');

const FIXTURE = readFileSync(
  join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    'services',
    'acp',
    '__tests__',
    'fixtures',
    'public-agent-registry-20261021.json',
  ),
  'utf8',
);
const makeTempDir = trackTempDirs();

/** stakpak and amp-acp have builds for every host CI and developers use. */
const STAKPAK_CONFIRM = { command: 'stakpak', args: ['acp'] };

function asOperator(routes: Hono): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
      credential: 'operator-credential',
      authority: 'operator-credential',
      source: 'bearer',
    });
    await next();
  });
  app.route('/', routes);
  return app;
}

async function fixture(
  options: {
    body?: string;
    connections?: Array<Record<string, unknown>>;
    fetchImpl?: ReturnType<typeof vi.fn>;
    prefetch?: boolean;
  } = {},
) {
  const store = { connections: [...(options.connections ?? [])] };
  const saveACPConfig = vi.fn(async (config: { connections: unknown[] }) => {
    store.connections = structuredClone(config.connections) as never;
  });
  const fetchImpl =
    options.fetchImpl ??
    vi.fn(async () => new Response(options.body ?? FIXTURE));
  const source = new PublicAgentRegistrySource({
    cacheDir: makeTempDir('public-registry-routes-'),
    fetch: fetchImpl as unknown as typeof fetch,
    limits: { minRefreshIntervalMs: 0 },
    commandExists: (command) => command === 'stakpak',
  });
  if (options.prefetch !== false) await source.refresh();
  const ctx = {
    acpBridge: {
      getStatus: vi.fn().mockReturnValue({ connected: false, connections: [] }),
      addConnection: vi.fn().mockResolvedValue(true),
      removeConnection: vi.fn(),
    },
    configLoader: {
      loadACPConfig: vi.fn(async () => structuredClone(store)),
      saveACPConfig,
    },
    applyAgentConfigurationMutation: vi.fn(
      async <T>(operation: (begin: () => void) => Promise<T>) =>
        operation(() => undefined),
    ),
  };
  const app = asOperator(
    createACPRoutes(ctx as never, { publicAgentRegistry: source }),
  );
  return { app, ctx, source, store, saveACPConfig, fetchImpl };
}

function install(app: Hono, id: string, confirmCommand?: unknown) {
  return app.request(`/registry/${id}/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(confirmCommand === undefined
      ? {}
      : { body: JSON.stringify({ confirmCommand }) }),
  });
}

describe('public agent registry in the engine catalogue', () => {
  beforeEach(() => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: new BuiltinACPConnectionRegistryProvider(
          () => false,
          () => false,
        ),
      },
    ];
  });

  test('GET /registry lists registry entries beside the built-ins, which keep their own command and environment', async () => {
    const { app } = await fixture();
    const body = await json(await app.request('/registry'));
    const byId = new Map(
      (body.data as Array<Record<string, any>>).map((entry) => [
        entry.id,
        entry,
      ]),
    );

    expect(byId.get('stakpak')).toMatchObject({
      source: 'registry',
      command: 'stakpak',
      args: ['acp'],
      detected: true,
      installed: false,
    });
    // Goose and Factory Droid are built-ins the registry also lists: the
    // built-in command, arguments, launch environment and install recipe
    // stand, and the listing adds only its display facts.
    const goose = byId.get('goose');
    expect(goose).toMatchObject({
      source: 'core',
      command: 'goose',
      args: ['acp'],
      launchEnv: { GOOSE_DISABLE_KEYRING: '1' },
      publicRegistry: { id: 'goose', version: '1.55.0' },
    });
    expect(goose?.publicRegistry).not.toHaveProperty('hostLaunch');
    const droid = byId.get('factory-droid');
    expect(droid).toMatchObject({
      source: 'core',
      command: 'droid',
      args: ['exec', '--output-format', 'acp-daemon'],
      publicRegistry: { id: 'factory-droid', version: '0.245.1' },
    });
    expect(droid?.launchEnv).toEqual(
      providerEntries[0].provider
        .listAvailable({ detect: false })
        .find((entry: { id: string }) => entry.id === 'factory-droid')
        .launchEnv,
    );
    // Listed once, under the built-in.
    expect(
      (body.data as Array<{ id: string }>).filter((entry) =>
        ['goose', 'github-copilot-cli', 'pi-acp'].includes(entry.id),
      ),
    ).toHaveLength(1);
  });

  test('a plugin entry cannot claim to be from the public registry', async () => {
    providerEntries.push({
      source: 'acpConnectionRegistry:plugin-x',
      provider: {
        listAvailable: () => [
          {
            id: 'plugin-engine',
            name: 'Plugin Engine',
            command: 'plugin-engine',
            source: 'registry',
            publicRegistry: {
              id: 'x',
              version: '1',
              publishers: ['Someone'],
              distributions: ['binary'],
              binaryPlatforms: [],
              hostLaunch: { command: 'sh', args: ['-c', 'x'] },
            },
          },
        ],
      },
    });
    const { app } = await fixture();
    const body = await json(await app.request('/registry'));
    const entry = (body.data as Array<Record<string, any>>).find(
      (candidate) => candidate.id === 'plugin-engine',
    );
    expect(entry?.source).toBe('plugin');
    expect(entry?.publicRegistry).toBeUndefined();
  });

  test('works from the saved copy with the network absent', async () => {
    const online = await fixture();
    const cacheDir = (online.source as any).cacheFile.replace(
      /\/registry\.json$/,
      '',
    );
    const offlineFetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const source = new PublicAgentRegistrySource({
      cacheDir,
      fetch: offlineFetch as unknown as typeof fetch,
      // A day later, so the saved copy is due a refresh.
      now: () => Date.now() + 25 * 60 * 60 * 1000,
      commandExists: () => false,
    });
    const app = asOperator(
      createACPRoutes(
        {
          configLoader: {
            loadACPConfig: async () => ({ connections: [] }),
          },
        } as never,
        { publicAgentRegistry: source },
      ),
    );

    const body = await json(await app.request('/registry'));
    expect(
      (body.data as Array<{ id: string }>).some(
        (entry) => entry.id === 'stakpak',
      ),
    ).toBe(true);
    // The read started the background check, which failed: the copy stands.
    await vi.waitFor(() => expect(offlineFetch).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(source.status().refreshing).toBe(false));
    const status = await json(await app.request('/registry/source'));
    expect(status.data).toMatchObject({
      enabled: true,
      origin: 'cache',
      lastError: 'The registry could not be reached.',
    });
  });

  test('GET /registry/source reports a refused index and POST refresh downloads now', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"version":"1.0.0"}'));
    const { app, source } = await fixture({ fetchImpl, prefetch: false });

    // Nothing downloaded yet: reading the status starts the download.
    const before = await json(await app.request('/registry/source'));
    expect(before.data.origin).toBe('none');
    await vi.waitFor(() => expect(source.status().refreshing).toBe(false));
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const refreshed = await json(
      await app.request('/registry/source/refresh', { method: 'POST' }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(refreshed.data).toMatchObject({
      origin: 'none',
      lastError: 'The registry index has no list of agents.',
    });
    expect(refreshed.data.checkedAt).toEqual(expect.any(String));
  });

  test('a station that does not read the registry reports it disabled', async () => {
    const app = asOperator(
      createACPRoutes({
        configLoader: { loadACPConfig: async () => ({ connections: [] }) },
      } as never),
    );
    const status = await json(await app.request('/registry/source'));
    expect(status.data).toEqual({
      enabled: false,
      origin: 'none',
      fetchedAt: null,
      checkedAt: null,
      lastError: null,
      refreshing: false,
      refused: [],
    });
    const body = await json(await app.request('/registry'));
    expect(
      (body.data as Array<{ source: string }>).some(
        (entry) => entry.source === 'registry',
      ),
    ).toBe(false);
  });

  test('adding a registry entry saves the confirmed command and the listing it came from', async () => {
    const { app, store, ctx } = await fixture();

    const response = await install(app, 'stakpak', STAKPAK_CONFIRM);

    expect(response.status).toBe(200);
    expect(store.connections).toEqual([
      {
        id: 'stakpak',
        name: 'Stakpak',
        command: 'stakpak',
        args: ['acp'],
        icon: '🔌',
        enabled: true,
        publicRegistry: { id: 'stakpak', version: '0.3.88' },
      },
    ]);
    // The same readiness probe as any engine.
    expect(ctx.acpBridge.addConnection).toHaveBeenCalledWith(
      store.connections[0],
    );
  });

  test.each([
    ['no confirmation', undefined],
    ['another command', { command: 'sh', args: ['acp'] }],
    ['other arguments', { command: 'stakpak', args: ['acp', '--yolo'] }],
  ])(
    'adding a registry entry with %s is refused and saves nothing',
    async (_, confirm) => {
      const { app, saveACPConfig, ctx } = await fixture();
      const response = await install(app, 'stakpak', confirm);
      expect(response.status).toBe(409);
      expect((await json(response)).code).toBe(
        'registry-listing-not-confirmed',
      );
      expect(saveACPConfig).not.toHaveBeenCalled();
      expect(ctx.acpBridge.addConnection).not.toHaveBeenCalled();
    },
  );

  test('a package-runner or natively connected listing cannot be added', async () => {
    const { app, saveACPConfig } = await fixture();
    for (const id of ['gemini', 'claude-acp']) {
      const response = await install(app, id, { command: 'npx', args: [] });
      expect(response.status).toBe(400);
    }
    const gemini = await json(
      await install(app, 'gemini', { command: '', args: [] }),
    );
    expect(gemini.error).toContain('Station does not do that');
    expect(saveACPConfig).not.toHaveBeenCalled();
  });

  test('a changed listing is reported on the added engine and never applied', async () => {
    const saved = {
      id: 'stakpak',
      name: 'Stakpak',
      command: 'stakpak',
      args: ['serve'],
      icon: '🔌',
      enabled: true,
      publicRegistry: { id: 'stakpak', version: '0.3.80' },
    };
    const { app, saveACPConfig, store } = await fixture({
      connections: [saved],
    });

    const body = await json(await app.request('/registry'));
    const entry = (body.data as Array<Record<string, any>>).find(
      (candidate) => candidate.id === 'stakpak',
    );
    expect(entry?.installed).toBe(true);
    expect(entry?.publicRegistry?.update).toEqual({
      version: '0.3.88',
      command: 'stakpak',
      args: ['acp'],
    });
    expect(saveACPConfig).not.toHaveBeenCalled();
    expect(store.connections).toEqual([saved]);

    // Re-adding does not overwrite the saved connection either.
    const again = await install(app, 'stakpak', STAKPAK_CONFIRM);
    expect(again.status).toBe(409);
    expect(store.connections).toEqual([saved]);
  });

  test('an added engine that still matches its listing reports no update', async () => {
    const { app } = await fixture({
      connections: [
        {
          id: 'stakpak',
          name: 'Stakpak',
          command: 'stakpak',
          args: ['acp'],
          icon: '🔌',
          enabled: true,
          publicRegistry: { id: 'stakpak', version: '0.3.88' },
        },
      ],
    });
    const body = await json(await app.request('/registry'));
    const entry = (body.data as Array<Record<string, any>>).find(
      (candidate) => candidate.id === 'stakpak',
    );
    expect(entry?.publicRegistry).not.toHaveProperty('update');
  });
});
