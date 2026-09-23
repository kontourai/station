import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import {
  PLUGIN_VALIDATE_MANIFEST_MAX_BYTES,
  registerPluginValidateRoutes,
} from '../plugin-validate-routes.js';

// Every git process Station starts goes through `execGit`, and the preview's
// fetcher is `fetchPluginSource`. Both are spied so a remote source can be
// shown to reach neither: no clone, no network attempt.
const execGit = vi.hoisted(() => vi.fn());
const fetchPluginSource = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/git-exec.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../utils/git-exec.js')>();
  execGit.mockImplementation(actual.execGit);
  return { ...actual, execGit };
});
vi.mock(
  '../../../services/plugins/plugin-source.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../services/plugins/plugin-source.js')
      >();
    fetchPluginSource.mockImplementation(actual.fetchPluginSource);
    return { ...actual, fetchPluginSource };
  },
);

// The filesystem calls that could open a network connection (a stat of a UNC
// or automount path) or re-read plugin.json. Delegating spies: behaviour is
// the real module's, and each call is recorded.
const fsSpies = vi.hoisted(() => ({
  statSync: vi.fn(),
  lstatSync: vi.fn(),
  openSync: vi.fn(),
  readFileSync: vi.fn(),
  realpathSync: vi.fn(),
  existsSync: vi.fn(),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  for (const [name, spy] of Object.entries(fsSpies)) {
    spy.mockImplementation((actual as Record<string, any>)[name]);
  }
  return { ...actual, ...fsSpies };
});

beforeEach(() => {
  execGit.mockClear();
  fetchPluginSource.mockClear();
  for (const spy of Object.values(fsSpies)) spy.mockClear();
});

function fsCalls(): unknown[] {
  return Object.entries(fsSpies).flatMap(([name, spy]) =>
    spy.mock.calls.map((args) => [name, args[0]]),
  );
}

/**
 * #2323 S1. `POST /validate` is an authoring check: the diagnostics must be
 * the ones an install would hit, and the call must leave nothing behind and
 * hand back nothing an install could consume as a consent decision.
 */

const cleanupDirs: string[] = [];

afterEach(async () => {
  for (const dir of cleanupDirs) {
    // A test may have made the plugins directory read-only; restore write
    // permission so cleanup can remove it.
    try {
      chmodSync(join(dir, 'home', 'plugins'), 0o755);
    } catch {}
  }
  await Promise.all(
    cleanupDirs
      .splice(0, cleanupDirs.length)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function makeHome() {
  const root = mkdtempSync(join(tmpdir(), 'station-plugin-validate-test-'));
  cleanupDirs.push(root);
  const home = join(root, 'home');
  const pluginsDir = join(home, 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  return { root, home, pluginsDir };
}

function createApp(home: string) {
  const app = new Hono();
  registerPluginValidateRoutes(app, {
    agentsDir: join(home, 'agents'),
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    } as any,
    pluginsDir: join(home, 'plugins'),
    projectHomeDir: home,
  });
  return app;
}

function paneDescriptor(pluginName: string, paneId: string) {
  return {
    version: '1.0',
    id: paneId,
    name: 'Pulse',
    rendererId: `renderer:plugin%3A${pluginName}:plugin-component:pulse`,
    renderer: { kind: 'plugin-component', name: `${pluginName}-pulse` },
    placement: { supportedRegions: ['primary'], preferredRegion: 'primary' },
    modes: [{ id: 'default', contextRequirement: { project: true } }],
    provenance: { origin: 'plugin', pluginId: pluginName },
    lifecycle: { stage: 'stable' },
  };
}

function agentPluginManifest(
  name: string,
  station: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name,
    version: '1.0.0',
    description: 'A plugin under test.',
    extensions: {
      'io.kontourai.station': {
        schemaVersion: '1.0',
        title: 'Pulse',
        entrypoint: './src/index.tsx',
        capabilities: ['chat'],
        permissions: ['navigation.dock'],
        workspacePanes: [
          paneDescriptor(name, `pane:plugin%3A${name}:pulse:workspace`),
        ],
        ...station,
      },
    },
  };
}

function writePlugin(
  dir: string,
  manifest: Record<string, unknown>,
  { entrypoint = true }: { entrypoint?: boolean } = {},
) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2));
  if (entrypoint) {
    writeFileSync(
      join(dir, 'src', 'index.tsx'),
      'export const components = {};\n',
    );
  }
  return dir;
}

async function validateSource(app: Hono, source: string) {
  const response = await app.request('/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  });
  return { status: response.status, body: await readJson<any>(response) };
}

/** Every path under `dir`, so a before/after comparison sees nested writes. */
function tree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: false })
    .map(String)
    .sort();
}

describe('POST /api/plugins/validate', () => {
  test('a valid Agent Plugin reports its contributions and returns no consent basis', async () => {
    const { root, home } = makeHome();
    const source = writePlugin(
      join(root, 'author', 'my-pulse'),
      agentPluginManifest('my-pulse'),
    );

    const { status, body } = await validateSource(createApp(home), source);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      valid: true,
      format: 'agent-plugin-1.0',
      plugin: { name: 'my-pulse', version: '1.0.0', displayName: 'Pulse' },
      components: [
        expect.objectContaining({
          type: 'pane',
          id: 'pane:plugin%3Amy-pulse:pulse:workspace',
        }),
      ],
      conflicts: [],
      permissions: { required: ['navigation.dock'] },
      entrypoint: { path: 'src/index.tsx', present: true },
      bundle: { checked: false },
    });
    expect(body.diagnostics).toEqual([]);
    // `/install` refuses a decision without these. None may appear anywhere
    // in the response, nested or not, or an agent could echo them back.
    const serialized = JSON.stringify(body);
    for (const field of [
      'contentDigest',
      'grantRevision',
      'registryTrustRevision',
      'installationRevision',
      'consent',
      'pendingConsent',
      'autoGranted',
      'dependencyApprovals',
      'existingDataScope',
    ]) {
      expect(serialized, `response carries '${field}'`).not.toContain(
        `"${field}"`,
      );
    }
    expect(serialized).not.toMatch(/sha256:[0-9a-f]{64}/);
  });

  test('writes nothing under the plugins directory or into the author folder', async () => {
    const { root, home, pluginsDir } = makeHome();
    writePlugin(join(pluginsDir, 'already-installed'), {
      name: 'already-installed',
      version: '1.0.0',
    });
    const before = tree(pluginsDir);
    // Read-only: staging or building inside the plugins directory (what
    // `/preview` does) fails here instead of being cleaned up unseen.
    chmodSync(pluginsDir, 0o555);
    const source = writePlugin(
      join(root, 'author', 'my-pulse'),
      agentPluginManifest('my-pulse'),
    );

    const { body } = await validateSource(createApp(home), source);

    expect(body.diagnostics).toEqual([]);
    expect(body.valid).toBe(true);
    chmodSync(pluginsDir, 0o755);
    expect(tree(pluginsDir)).toEqual(before);
    // The author's folder is read in place and not built in either.
    expect(readdirSync(source).sort()).toEqual(['plugin.json', 'src']);
  });

  test('an invalid Station extension is an error, with the failing location', async () => {
    const { root, home } = makeHome();
    const source = writePlugin(
      join(root, 'author', 'shouty'),
      agentPluginManifest('shouty', { permissions: ['Navigation.Dock'] }),
    );

    const { status, body } = await validateSource(createApp(home), source);

    expect(status).toBe(200);
    expect(body.valid).toBe(false);
    // `/preview` answers `valid: true` for this manifest while Station drops
    // every pane it declares; validation must not.
    const disabled = body.diagnostics.find(
      (entry: any) => entry.code === 'station-extension-disabled',
    );
    expect(disabled).toMatchObject({ level: 'error' });
    expect(disabled.message).toContain('/permissions/0');
    expect(body.components).toEqual([]);
  });

  test('a manifest the loader rejects is reported with its code, and no source path leaks', async () => {
    const { root, home } = makeHome();
    const source = writePlugin(join(root, 'author', 'bad-name'), {
      name: 'Bad Name',
      version: '1.0.0',
    });

    const { body } = await validateSource(createApp(home), source);

    expect(body.valid).toBe(false);
    expect(body.diagnostics).toEqual([
      expect.objectContaining({
        level: 'error',
        code: 'invalid-plugin-name',
        component: 'plugin.json',
      }),
    ]);
    expect(JSON.stringify(body.diagnostics)).not.toContain(source);
    // One diagnostic for one failure: the thrown loader error and the
    // parser's report are the same problem.
    expect(body.diagnostics).toHaveLength(1);
  });

  test('a missing entrypoint is an error the install build would hit', async () => {
    const { root, home } = makeHome();
    const source = writePlugin(
      join(root, 'author', 'no-entry'),
      agentPluginManifest('no-entry'),
      { entrypoint: false },
    );

    const { body } = await validateSource(createApp(home), source);

    expect(body.valid).toBe(false);
    expect(body.entrypoint).toEqual({
      path: 'src/index.tsx',
      present: false,
    });
    expect(body.diagnostics).toEqual([
      expect.objectContaining({ level: 'error', code: 'entrypoint-missing' }),
    ]);
  });

  test('a plugin-component pane with no entrypoint and no prebuilt bundle is an error', async () => {
    const { root, home } = makeHome();
    const station = agentPluginManifest('bundleless');
    const extension = (station.extensions as Record<string, any>)[
      'io.kontourai.station'
    ];
    delete extension.entrypoint;
    const source = writePlugin(join(root, 'author', 'bundleless'), station, {
      entrypoint: false,
    });

    const { body } = await validateSource(createApp(home), source);

    expect(body.valid).toBe(false);
    expect(body.diagnostics).toEqual([
      expect.objectContaining({ level: 'error', code: 'entrypoint-required' }),
    ]);

    // A package that ships its own bundle needs no entrypoint.
    mkdirSync(join(source, 'dist'));
    writeFileSync(join(source, 'dist', 'bundle.js'), '');
    const prebuilt = await validateSource(createApp(home), source);
    expect(prebuilt.body.diagnostics).toEqual([]);
  });

  test('a pane id another installed plugin owns is an error, as install would refuse it', async () => {
    const { root, home, pluginsDir } = makeHome();
    const paneId = 'pane:plugin%3Ashared:pulse:workspace';
    writePlugin(join(pluginsDir, 'owner-plugin'), {
      name: 'owner-plugin',
      version: '1.0.0',
      workspacePanes: [paneDescriptor('owner-plugin', paneId)],
    });
    const manifest = agentPluginManifest('newcomer', {
      workspacePanes: [paneDescriptor('newcomer', paneId)],
    });
    const source = writePlugin(join(root, 'author', 'newcomer'), manifest);

    const { body } = await validateSource(createApp(home), source);

    expect(body.valid).toBe(false);
    expect(body.conflicts).toEqual([
      expect.objectContaining({
        type: 'pane',
        id: paneId,
        existingSource: 'owner-plugin',
      }),
    ]);
    expect(body.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'error', code: 'pane-conflict' }),
      ]),
    );
  });

  test('a reused rendererId is a warning, not a refusal', async () => {
    const { root, home } = makeHome();
    const first = paneDescriptor('twins', 'pane:plugin%3Atwins:a:workspace');
    const second = {
      ...paneDescriptor('twins', 'pane:plugin%3Atwins:b:workspace'),
      rendererId: first.rendererId,
    };
    const source = writePlugin(
      join(root, 'author', 'twins'),
      agentPluginManifest('twins', { workspacePanes: [first, second] }),
    );

    const { body } = await validateSource(createApp(home), source);

    expect(body.valid).toBe(true);
    expect(body.diagnostics).toEqual([
      expect.objectContaining({
        level: 'warning',
        code: 'duplicate-renderer-id',
      }),
    ]);
  });

  test('a source that does not exist is an error, not a server failure', async () => {
    const { root, home } = makeHome();

    const { status, body } = await validateSource(
      createApp(home),
      join(root, 'nowhere'),
    );

    expect(status).toBe(200);
    expect(body.valid).toBe(false);
    expect(body.diagnostics).toEqual([
      expect.objectContaining({ level: 'error', code: 'source-unavailable' }),
    ]);
  });

  test('refuses a body with install fields rather than ignoring them', async () => {
    const { home } = makeHome();
    const response = await createApp(home).request('/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: '/tmp/x',
        consent: { permissions: [], contentDigest: 'sha256:x' },
      }),
    });
    expect(response.status).toBe(400);
  });
  test.each([
    ['https git URL', 'https://example.invalid/owner/plugin.git'],
    [
      'https git URL with a branch',
      'https://example.invalid/owner/plugin.git#main',
    ],
    ['ssh URL', 'ssh://git@example.invalid/owner/plugin.git'],
    ['scp-style git remote', 'git@example.invalid:owner/plugin.git'],
    ['file URL', 'file:///tmp/plugin'],
  ])(
    'a remote source (%s) is refused before any fetch or git process',
    async (_label, source) => {
      const { home } = makeHome();
      const { status, body } = await validateSource(createApp(home), source);

      expect(status).toBe(200);
      expect(body.valid).toBe(false);
      expect(body.diagnostics).toEqual([
        expect.objectContaining({
          level: 'error',
          code: 'remote-source-refused',
          message: expect.stringContaining('validate checks local folders'),
        }),
      ]);
      expect(fetchPluginSource).not.toHaveBeenCalled();
      expect(execGit).not.toHaveBeenCalled();
    },
  );

  test('a relative path is refused rather than resolved against the server', async () => {
    const { home } = makeHome();
    const { body } = await validateSource(createApp(home), '.');
    expect(body.diagnostics).toEqual([
      expect.objectContaining({ code: 'source-not-absolute' }),
    ]);
    expect(fetchPluginSource).not.toHaveBeenCalled();
  });

  test('the spies are live: the preview fetcher really does reach git for a URL', async () => {
    // Control for the refusal test above. If the mocks were not wired, a
    // "not called" assertion would pass for any implementation.
    const { root } = makeHome();
    execGit.mockRejectedValueOnce(new Error('no network in tests'));
    execGit.mockRejectedValueOnce(new Error('no network in tests'));
    const { fetchPluginSource: fetchThroughModule } = await import(
      '../../../services/plugins/plugin-source.js'
    );
    await fetchThroughModule(
      'https://example.invalid/owner/plugin.git',
      join(root, 'staging-control'),
      { debug: vi.fn() } as any,
    );
    expect(execGit).toHaveBeenCalled();
  });

  describe('a plugin.json that is not a plain file is refused, promptly, without echoing anything', () => {
    const SECRET = 'AKIA-TEST-SECRET-9f3c';

    async function refusedWithin(source: string, home: string) {
      const outcome = await Promise.race([
        validateSource(createApp(home), source),
        new Promise<'timed out'>((resolve) =>
          setTimeout(() => resolve('timed out'), 3_000),
        ),
      ]);
      expect(outcome, 'validation blocked on plugin.json').not.toBe(
        'timed out',
      );
      const { body } = outcome as Awaited<ReturnType<typeof validateSource>>;
      expect(body.valid).toBe(false);
      expect(body.diagnostics).toEqual([
        expect.objectContaining({
          level: 'error',
          code: 'manifest-not-regular-file',
        }),
      ]);
      expect(JSON.stringify(body)).not.toContain(SECRET);
      return body;
    }

    test('a symlink to a text file', async () => {
      const { root, home } = makeHome();
      writeFileSync(join(root, 'secret.txt'), `${SECRET} not json`);
      const dir = join(root, 'author', 'sym-text');
      mkdirSync(dir, { recursive: true });
      symlinkSync(join(root, 'secret.txt'), join(dir, 'plugin.json'));
      await refusedWithin(dir, home);
    });

    test('a symlink to a JSON file', async () => {
      const { root, home } = makeHome();
      writeFileSync(
        join(root, 'secret.json'),
        JSON.stringify({ name: 'leak', version: '1.0.0', token: SECRET }),
      );
      const dir = join(root, 'author', 'sym-json');
      mkdirSync(dir, { recursive: true });
      symlinkSync(join(root, 'secret.json'), join(dir, 'plugin.json'));
      const body = await refusedWithin(dir, home);
      expect(body.plugin).toBeUndefined();
    });

    test('a symlink to a FIFO', async () => {
      const { root, home } = makeHome();
      const fifo = join(root, 'fifo');
      execFileSync('mkfifo', [fifo]);
      const dir = join(root, 'author', 'sym-fifo');
      mkdirSync(dir, { recursive: true });
      symlinkSync(fifo, join(dir, 'plugin.json'));
      await refusedWithin(dir, home);
    });

    test('a FIFO in place of the file', async () => {
      const { root, home } = makeHome();
      const dir = join(root, 'author', 'fifo');
      mkdirSync(dir, { recursive: true });
      execFileSync('mkfifo', [join(dir, 'plugin.json')]);
      await refusedWithin(dir, home);
    });
  });

  test('a plugin.json over the byte cap is refused without being parsed', async () => {
    const { root, home } = makeHome();
    const dir = join(root, 'author', 'huge');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'plugin.json'),
      `{"name":"huge","version":"1.0.0","pad":"${'x'.repeat(PLUGIN_VALIDATE_MANIFEST_MAX_BYTES)}"}`,
    );
    const { body } = await validateSource(createApp(home), dir);
    expect(body.diagnostics).toEqual([
      expect.objectContaining({ code: 'manifest-too-large' }),
    ]);
    expect(body.plugin).toBeUndefined();
  });

  test('declared dependencies are reported as not checked', async () => {
    const { root, home } = makeHome();
    const source = writePlugin(
      join(root, 'author', 'with-deps'),
      agentPluginManifest('with-deps', {
        dependencies: [{ name: 'some-other-plugin', version: '1.0.0' }],
      }),
    );
    const { body } = await validateSource(createApp(home), source);
    expect(body.valid).toBe(true);
    expect(body.diagnostics).toEqual([
      expect.objectContaining({
        level: 'warning',
        code: 'dependencies-not-checked',
        message: expect.stringContaining('some-other-plugin'),
      }),
    ]);
  });

  test('an entrypoint symlinked to a file outside the plugin is not present', async () => {
    const { root, home } = makeHome();
    writeFileSync(join(root, 'outside.tsx'), 'export const components = {};\n');
    const source = writePlugin(
      join(root, 'author', 'escape'),
      agentPluginManifest('escape'),
      { entrypoint: false },
    );
    symlinkSync(join(root, 'outside.tsx'), join(source, 'src', 'index.tsx'));
    const { body } = await validateSource(createApp(home), source);
    expect(body.entrypoint).toEqual({ path: 'src/index.tsx', present: false });
    expect(body.diagnostics).toEqual([
      expect.objectContaining({ level: 'error', code: 'entrypoint-missing' }),
    ]);
  });

  test('an Agent Plugins manifest failure is reported once, with its location', async () => {
    const { root, home } = makeHome();
    const manifest = agentPluginManifest('a--b');
    const source = writePlugin(join(root, 'author', 'double-hyphen'), manifest);
    const { body } = await validateSource(createApp(home), source);
    expect(body.valid).toBe(false);
    expect(body.diagnostics).toEqual([
      expect.objectContaining({
        level: 'error',
        code: 'manifest-invalid',
        message: expect.stringContaining('/name'),
      }),
    ]);
  });
  test.each([
    ['a UNC path', '\\\\attacker\\share\\plugin'],
    ['a forward-slash UNC path', '//attacker/share/plugin'],
    ['a \\\\?\\UNC\\ device path', '\\\\?\\UNC\\attacker\\share\\plugin'],
    ['a \\\\.\\ device path', '\\\\.\\pipe\\plugin'],
    ['a macOS /net automount path', '/net/attacker/plugin'],
    ['a macOS /Network automount path', '/Network/Servers/attacker/plugin'],
  ])('%s is refused before any filesystem call', async (_label, source) => {
    const { home } = makeHome();
    const app = createApp(home);
    for (const spy of Object.values(fsSpies)) spy.mockClear();

    const { body } = await validateSource(app, source);

    expect(body.valid).toBe(false);
    expect(body.diagnostics).toEqual([
      expect.objectContaining({
        level: 'error',
        code: 'network-path-refused',
      }),
    ]);
    expect(fsCalls()).toEqual([]);
    expect(fetchPluginSource).not.toHaveBeenCalled();
  });

  test('the filesystem spies are live: a local folder is stat-ed', async () => {
    // Control for the refusal test above, so "no call" cannot pass vacuously.
    const { root, home } = makeHome();
    const source = writePlugin(
      join(root, 'author', 'local-control'),
      agentPluginManifest('local-control'),
    );
    for (const spy of Object.values(fsSpies)) spy.mockClear();
    await validateSource(createApp(home), source);
    expect(fsSpies.statSync).toHaveBeenCalledWith(source);
  });

  test('plugin.json is opened once, through the bounded read, and never re-read by the prompt scan', async () => {
    const { root, home } = makeHome();
    const source = writePlugin(
      join(root, 'author', 'one-read'),
      agentPluginManifest('one-read'),
    );
    for (const spy of Object.values(fsSpies)) spy.mockClear();

    const { body } = await validateSource(createApp(home), source);

    expect(body.valid).toBe(true);
    const manifestPath = join(source, 'plugin.json');
    const reads = [
      ...fsSpies.readFileSync.mock.calls,
      ...fsSpies.openSync.mock.calls,
    ].filter(([path]) => path === manifestPath);
    expect(reads).toHaveLength(1);
    expect(fsSpies.readFileSync.mock.calls.map(([path]) => path)).not.toContain(
      manifestPath,
    );
  });
});
