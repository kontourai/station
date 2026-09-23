import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { registerPluginValidateRoutes } from '../plugin-validate-routes.js';

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
  const stagingRoot = join(root, 'staging');
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(stagingRoot, { recursive: true });
  return { root, home, pluginsDir, stagingRoot };
}

function createApp(home: string, stagingRoot: string) {
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
    stagingRoot: () => stagingRoot,
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
    const { root, home, stagingRoot } = makeHome();
    const source = writePlugin(
      join(root, 'author', 'my-pulse'),
      agentPluginManifest('my-pulse'),
    );

    const { status, body } = await validateSource(
      createApp(home, stagingRoot),
      source,
    );

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

  test('writes nothing under the plugins directory and cleans its own staging', async () => {
    const { root, home, pluginsDir, stagingRoot } = makeHome();
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

    const { body } = await validateSource(createApp(home, stagingRoot), source);

    expect(body.diagnostics).toEqual([]);
    expect(body.valid).toBe(true);
    chmodSync(pluginsDir, 0o755);
    expect(tree(pluginsDir)).toEqual(before);
    expect(readdirSync(stagingRoot)).toEqual([]);
    // The author's folder is not built in place either.
    expect(readdirSync(source).sort()).toEqual(['plugin.json', 'src']);
  });

  test('an invalid Station extension is an error, with the failing location', async () => {
    const { root, home, stagingRoot } = makeHome();
    const source = writePlugin(
      join(root, 'author', 'shouty'),
      agentPluginManifest('shouty', { permissions: ['Navigation.Dock'] }),
    );

    const { status, body } = await validateSource(
      createApp(home, stagingRoot),
      source,
    );

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

  test('a manifest the loader rejects is reported with its code, and no staging path leaks', async () => {
    const { root, home, stagingRoot } = makeHome();
    const source = writePlugin(join(root, 'author', 'bad-name'), {
      name: 'Bad Name',
      version: '1.0.0',
    });

    const { body } = await validateSource(createApp(home, stagingRoot), source);

    expect(body.valid).toBe(false);
    expect(body.diagnostics).toEqual([
      expect.objectContaining({
        level: 'error',
        code: 'invalid-plugin-name',
        component: 'plugin.json',
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain(stagingRoot);
  });

  test('a missing entrypoint is an error the install build would hit', async () => {
    const { root, home, stagingRoot } = makeHome();
    const source = writePlugin(
      join(root, 'author', 'no-entry'),
      agentPluginManifest('no-entry'),
      { entrypoint: false },
    );

    const { body } = await validateSource(createApp(home, stagingRoot), source);

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
    const { root, home, stagingRoot } = makeHome();
    const station = agentPluginManifest('bundleless');
    const extension = (station.extensions as Record<string, any>)[
      'io.kontourai.station'
    ];
    delete extension.entrypoint;
    const source = writePlugin(join(root, 'author', 'bundleless'), station, {
      entrypoint: false,
    });

    const { body } = await validateSource(createApp(home, stagingRoot), source);

    expect(body.valid).toBe(false);
    expect(body.diagnostics).toEqual([
      expect.objectContaining({ level: 'error', code: 'entrypoint-required' }),
    ]);

    // A package that ships its own bundle needs no entrypoint.
    mkdirSync(join(source, 'dist'));
    writeFileSync(join(source, 'dist', 'bundle.js'), '');
    const prebuilt = await validateSource(createApp(home, stagingRoot), source);
    expect(prebuilt.body.diagnostics).toEqual([]);
  });

  test('a pane id another installed plugin owns is an error, as install would refuse it', async () => {
    const { root, home, pluginsDir, stagingRoot } = makeHome();
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

    const { body } = await validateSource(createApp(home, stagingRoot), source);

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
    const { root, home, stagingRoot } = makeHome();
    const first = paneDescriptor('twins', 'pane:plugin%3Atwins:a:workspace');
    const second = {
      ...paneDescriptor('twins', 'pane:plugin%3Atwins:b:workspace'),
      rendererId: first.rendererId,
    };
    const source = writePlugin(
      join(root, 'author', 'twins'),
      agentPluginManifest('twins', { workspacePanes: [first, second] }),
    );

    const { body } = await validateSource(createApp(home, stagingRoot), source);

    expect(body.valid).toBe(true);
    expect(body.diagnostics).toEqual([
      expect.objectContaining({
        level: 'warning',
        code: 'duplicate-renderer-id',
      }),
    ]);
  });

  test('a source that does not exist is an error, not a server failure', async () => {
    const { root, home, stagingRoot } = makeHome();

    const { status, body } = await validateSource(
      createApp(home, stagingRoot),
      join(root, 'nowhere'),
    );

    expect(status).toBe(200);
    expect(body.valid).toBe(false);
    expect(body.diagnostics).toEqual([
      expect.objectContaining({ level: 'error', code: 'source-unavailable' }),
    ]);
    expect(readdirSync(stagingRoot)).toEqual([]);
  });

  test('refuses a body with install fields rather than ignoring them', async () => {
    const { home, stagingRoot } = makeHome();
    const response = await createApp(home, stagingRoot).request('/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: '/tmp/x',
        consent: { permissions: [], contentDigest: 'sha256:x' },
      }),
    });
    expect(response.status).toBe(400);
  });
});
