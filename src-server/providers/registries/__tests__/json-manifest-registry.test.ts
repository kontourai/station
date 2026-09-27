import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { listStationTempEntries } from '@kontourai/station-shared/temp-dir';
import { afterEach, describe, expect, test, vi } from 'vitest';

// Test seam: runs just before the provider creates its staging directory,
// i.e. after source resolution and before the copy, to model a race.
const stageHook = vi.hoisted(() => ({
  before: undefined as (() => void) | undefined,
}));
vi.mock('@kontourai/station-shared/temp-dir', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@kontourai/station-shared/temp-dir')>();
  return {
    ...original,
    createStationTempDirSync: ((...args: unknown[]) => {
      stageHook.before?.();
      return (original.createStationTempDirSync as (...a: unknown[]) => string)(
        ...args,
      );
    }) as typeof original.createStationTempDirSync,
  };
});

import { fetchPluginSource } from '../../../services/plugins/plugin-source.js';
import { execGitSync } from '../../../utils/git-exec.js';
import {
  JsonManifestRegistryProvider,
  RegistrySourceConfinementError,
} from '../json-manifest-registry.js';

const repoRoot = process.cwd();
const fixtureManifestPath = resolve(
  repoRoot,
  'examples/registry/manifest.json',
);
let server: Server | undefined;
const cleanupDirs: string[] = [];

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolveClose, rejectClose) => {
      server?.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      });
    });
    server = undefined;
  }

  await Promise.all(
    cleanupDirs
      .splice(0, cleanupDirs.length)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeProjectHome(): Promise<string> {
  const projectHome = await mkdtemp(
    resolve(tmpdir(), 'station-registry-provider-'),
  );
  cleanupDirs.push(projectHome);
  mkdirSync(projectHome, { recursive: true });
  return projectHome;
}

async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolveListen) => {
    server?.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function registryInstallRecord(manifestPath: string, pluginName: string) {
  return { pluginName, registryKey: manifestPath };
}

describe('JsonManifestRegistryProvider registry manifest proof', () => {
  test('resolves source and untrusted claim from one fresh observation despite catalog cache', async () => {
    const home = await makeProjectHome();
    const path = join(home, 'catalog.json');
    const write = (version: string) =>
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          plugins: [
            { id: 'fresh', source: `./${version}`, claim: { version } },
          ],
        }),
      );
    write('one');
    const provider = new JsonManifestRegistryProvider(path, home);
    expect((await provider.listAvailable())[0]?.source).toBe(join(home, 'one'));
    write('two');
    const resolved = await provider.resolvePackage('fresh');
    expect(resolved).toEqual({
      source: join(home, 'two'),
      claim: { version: 'two' },
    });
    (resolved!.claim as { version: string }).version = 'caller-change';
    expect(await provider.resolvePackage('fresh')).toEqual({
      source: join(home, 'two'),
      claim: { version: 'two' },
    });
    writeFileSync(path, JSON.stringify({ version: 1, plugins: [] }));
    expect(await provider.resolvePackage('fresh')).toBeNull();
  });
  test('recognizes the canonical shared lifecycle registry alias', async () => {
    const projectHome = await makeProjectHome();
    const registrySource = resolve(projectHome, 'registry-demo-source');
    const pluginsDir = resolve(projectHome, 'plugins');
    const configDir = resolve(projectHome, 'config');
    const manifestPath = resolve(projectHome, 'registry.json');
    mkdirSync(registrySource, { recursive: true });
    mkdirSync(pluginsDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'registry-demo',
            displayName: 'Registry Demo',
            description: 'Shared lifecycle fixture',
            version: '1.0.0',
            source: './registry-demo-source',
          },
        ],
      }),
    );
    const installedPluginDir = resolve(pluginsDir, 'actual-plugin');
    mkdirSync(installedPluginDir, { recursive: true });
    writeFileSync(
      resolve(installedPluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'actual-plugin',
        version: '1.2.3',
        displayName: 'Actual Plugin',
      }),
    );
    writeFileSync(
      resolve(configDir, 'registry-installs.json'),
      JSON.stringify({
        'registry-demo': registryInstallRecord(manifestPath, 'actual-plugin'),
      }),
    );

    const provider = new JsonManifestRegistryProvider(
      manifestPath,
      projectHome,
    );

    await expect(provider.listInstalled()).resolves.toEqual([
      expect.objectContaining({
        id: 'registry-demo',
        installed: true,
        installedPluginName: 'actual-plugin',
        version: '1.2.3',
      }),
    ]);
  });

  test('warns through the logger when an aliased installed manifest is rejected', async () => {
    const projectHome = await makeProjectHome();
    const pluginsDir = resolve(projectHome, 'plugins');
    const configDir = resolve(projectHome, 'config');
    const manifestPath = resolve(projectHome, 'registry.json');
    mkdirSync(resolve(pluginsDir, 'legacy-plugin'), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      resolve(pluginsDir, 'legacy-plugin', 'plugin.json'),
      '{"name":"legacy-plugin","version":',
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'registry-demo',
            displayName: 'Registry Demo',
            description: 'Rejected install fixture',
            version: '1.0.0',
            source: './source',
          },
        ],
      }),
    );
    writeFileSync(
      resolve(configDir, 'registry-installs.json'),
      JSON.stringify({
        'registry-demo': registryInstallRecord(manifestPath, 'legacy-plugin'),
      }),
    );
    const warn = vi.fn();
    const provider = new JsonManifestRegistryProvider(
      manifestPath,
      projectHome,
      undefined,
      { warn },
    );

    await expect(provider.listInstalled()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'Installed plugin manifest rejected',
      expect.objectContaining({
        pluginDirectory: 'legacy-plugin',
        code: 'malformed-json',
      }),
    );
  });

  test('reads source-preserving canonical registry aliases without rewriting them', async () => {
    const projectHome = await makeProjectHome();
    const registrySource = resolve(projectHome, 'registry-demo-source');
    const pluginsDir = resolve(projectHome, 'plugins');
    const configDir = resolve(projectHome, 'config');
    const manifestPath = resolve(projectHome, 'registry.json');
    const aliasesPath = resolve(configDir, 'registry-installs.json');
    mkdirSync(registrySource, { recursive: true });
    mkdirSync(resolve(pluginsDir, 'actual-plugin'), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      resolve(pluginsDir, 'actual-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'actual-plugin',
        displayName: 'Actual Plugin',
        version: '1.0.0',
      }),
    );
    writeFileSync(
      aliasesPath,
      JSON.stringify({
        'registry-demo': {
          pluginName: 'actual-plugin',
          registryKey: manifestPath,
        },
      }),
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'registry-demo',
            displayName: 'Registry Demo',
            description: 'Migration fixture',
            version: '1.0.0',
            source: './registry-demo-source',
          },
        ],
      }),
    );

    const provider = new JsonManifestRegistryProvider(
      manifestPath,
      projectHome,
    );

    await expect(provider.listInstalled()).resolves.toHaveLength(1);
    expect(JSON.parse(readFileSync(aliasesPath, 'utf8'))).toEqual({
      'registry-demo': {
        pluginName: 'actual-plugin',
        registryKey: manifestPath,
      },
    });
  });

  test('loads the checked-in local registry fixture and resolves every source to an example plugin', async () => {
    const manifest = JSON.parse(readFileSync(fixtureManifestPath, 'utf-8'));
    const provider = new JsonManifestRegistryProvider(
      fixtureManifestPath,
      await makeProjectHome(),
    );

    const plugins = await provider.listAvailable();

    expect(plugins.map((plugin) => plugin.id)).toEqual(
      manifest.plugins.map((plugin: { id: string }) => plugin.id),
    );
    for (const plugin of plugins) {
      expect(typeof plugin.source).toBe('string');
      expect(existsSync(plugin.source!)).toBe(true);
      const pluginManifest = JSON.parse(
        readFileSync(resolve(plugin.source!, 'plugin.json'), 'utf-8'),
      );
      expect(pluginManifest.name).toBe(plugin.id);
      expect(pluginManifest.version).toBe(plugin.version);
    }
  });

  test('resolves relative plugin sources against a hosted manifest URL', async () => {
    const baseUrl = await serve((request, response) => {
      if (request.url !== '/registry/manifest.json') {
        response.writeHead(404).end();
        return;
      }

      response.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          version: 1,
          plugins: [
            {
              id: 'hosted-demo',
              displayName: 'Hosted Demo',
              description: 'Hosted-compatible fixture entry',
              version: '1.0.0',
              source: './plugins/demo-layout',
            },
          ],
          tools: [],
        }),
      );
    });
    const manifestUrl = `${baseUrl}/registry/manifest.json`;
    const provider = new JsonManifestRegistryProvider(
      manifestUrl,
      await makeProjectHome(),
    );

    await expect(provider.listAvailable()).resolves.toMatchObject([
      {
        id: 'hosted-demo',
        source: `${baseUrl}/registry/plugins/demo-layout`,
      },
    ]);
  });

  test('reports installed plugin versions from installed manifests, not refreshed registry manifests', async () => {
    const projectHome = await makeProjectHome();
    const registrySource = resolve(projectHome, 'registry-demo-source');
    const configDir = resolve(projectHome, 'config');
    const pluginsDir = resolve(projectHome, 'plugins');
    const installedPluginDir = resolve(pluginsDir, 'actual-plugin');
    const manifestPath = resolve(projectHome, 'registry.json');
    mkdirSync(registrySource, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    mkdirSync(installedPluginDir, { recursive: true });
    writeFileSync(
      resolve(registrySource, 'plugin.json'),
      JSON.stringify({
        name: 'actual-plugin',
        displayName: 'Registry Demo',
        version: '2.0.0',
      }),
    );
    writeFileSync(
      join(installedPluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'actual-plugin',
        displayName: 'Registry Demo',
        description: 'Installed local copy',
        version: '1.0.0',
      }),
    );
    writeFileSync(
      resolve(configDir, 'registry-installs.json'),
      JSON.stringify({
        'registry-demo': registryInstallRecord(manifestPath, 'actual-plugin'),
      }),
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'registry-demo',
            displayName: 'Registry Demo',
            description: 'Registry copy',
            version: '2.0.0',
            source: './registry-demo-source',
          },
        ],
        tools: [],
      }),
    );
    const provider = new JsonManifestRegistryProvider(
      manifestPath,
      projectHome,
    );

    await expect(provider.listAvailable()).resolves.toMatchObject([
      { id: 'registry-demo', version: '2.0.0' },
    ]);
    await expect(provider.listInstalled()).resolves.toMatchObject([
      {
        id: 'registry-demo',
        installedPluginName: 'actual-plugin',
        version: '1.0.0',
      },
    ]);
  });

  test('keeps same-id installs isolated to their owning registry source', async () => {
    const projectHome = await makeProjectHome();
    const originalSource = resolve(projectHome, 'original-registry-source');
    const replacementSource = resolve(
      projectHome,
      'replacement-registry-source',
    );
    const configDir = resolve(projectHome, 'config');
    const pluginsDir = resolve(projectHome, 'plugins');
    const installedPluginDir = resolve(pluginsDir, 'actual-plugin');
    const originalManifestPath = resolve(projectHome, 'original-registry.json');
    const replacementManifestPath = resolve(
      projectHome,
      'replacement-registry.json',
    );
    mkdirSync(originalSource, { recursive: true });
    mkdirSync(replacementSource, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    mkdirSync(installedPluginDir, { recursive: true });
    writeFileSync(
      resolve(originalSource, 'plugin.json'),
      JSON.stringify({
        name: 'actual-plugin',
        displayName: 'Registry Demo',
        version: '1.0.0',
      }),
    );
    writeFileSync(
      resolve(replacementSource, 'plugin.json'),
      JSON.stringify({
        name: 'actual-plugin',
        displayName: 'Replacement Registry Demo',
        version: '2.0.0',
      }),
    );
    writeFileSync(
      join(installedPluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'actual-plugin',
        displayName: 'Registry Demo',
        version: '1.0.0',
      }),
    );
    writeFileSync(
      resolve(configDir, 'registry-installs.json'),
      JSON.stringify({
        'registry-demo': {
          pluginName: 'actual-plugin',
          registryKey: originalManifestPath,
        },
      }),
    );
    writeFileSync(
      originalManifestPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'registry-demo',
            displayName: 'Registry Demo',
            description: 'Original registry copy',
            version: '1.0.0',
            source: './original-registry-source',
          },
        ],
        tools: [],
      }),
    );
    writeFileSync(
      replacementManifestPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'registry-demo',
            displayName: 'Registry Demo',
            description: 'Replacement registry copy',
            version: '2.0.0',
            source: './replacement-registry-source',
          },
        ],
        tools: [],
      }),
    );
    const originalProvider = new JsonManifestRegistryProvider(
      originalManifestPath,
      projectHome,
    );
    const replacementProvider = new JsonManifestRegistryProvider(
      replacementManifestPath,
      projectHome,
    );

    await expect(originalProvider.listInstalled()).resolves.toHaveLength(1);
    await expect(replacementProvider.listInstalled()).resolves.toEqual([]);
    expect(
      JSON.parse(
        readFileSync(resolve(installedPluginDir, 'plugin.json'), 'utf8'),
      ).version,
    ).toBe('1.0.0');
  });

  test('does not treat same-name manual plugins as registry-installed without an alias', async () => {
    const projectHome = await makeProjectHome();
    const registrySource = resolve(projectHome, 'registry-demo-source');
    const pluginsDir = resolve(projectHome, 'plugins');
    const installedPluginDir = resolve(pluginsDir, 'registry-demo');
    const manifestPath = resolve(projectHome, 'registry.json');
    mkdirSync(registrySource, { recursive: true });
    mkdirSync(installedPluginDir, { recursive: true });
    writeFileSync(
      resolve(registrySource, 'plugin.json'),
      JSON.stringify({
        name: 'registry-demo',
        displayName: 'Registry Demo',
        version: '2.0.0',
      }),
    );
    writeFileSync(
      join(installedPluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'registry-demo',
        displayName: 'Manual Plugin',
        description: 'Installed outside the registry',
        version: '1.0.0',
      }),
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'registry-demo',
            displayName: 'Registry Demo',
            description: 'Registry copy',
            version: '2.0.0',
            source: './registry-demo-source',
          },
        ],
        tools: [],
      }),
    );
    const provider = new JsonManifestRegistryProvider(
      manifestPath,
      projectHome,
    );

    await expect(provider.listInstalled()).resolves.toEqual([]);
    await expect(provider.update('registry-demo')).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining('not installed from this registry'),
    });
    expect(
      JSON.parse(
        readFileSync(resolve(installedPluginDir, 'plugin.json'), 'utf8'),
      ).version,
    ).toBe('1.0.0');
  });

  test('updates aliased registry plugins into the installed manifest-name directory', async () => {
    const projectHome = await makeProjectHome();
    const registrySource = resolve(projectHome, 'registry-demo-source');
    const configDir = resolve(projectHome, 'config');
    const pluginsDir = resolve(projectHome, 'plugins');
    const installedPluginDir = resolve(pluginsDir, 'actual-plugin');
    const registryIdDir = resolve(pluginsDir, 'registry-demo');
    const manifestPath = resolve(projectHome, 'registry.json');
    mkdirSync(registrySource, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    mkdirSync(installedPluginDir, { recursive: true });
    writeFileSync(
      resolve(registrySource, 'plugin.json'),
      JSON.stringify({
        name: 'actual-plugin',
        displayName: 'Registry Demo',
        version: '2.0.0',
      }),
    );
    writeFileSync(
      join(installedPluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'actual-plugin',
        displayName: 'Registry Demo',
        version: '1.0.0',
      }),
    );
    writeFileSync(
      resolve(configDir, 'registry-installs.json'),
      JSON.stringify({
        'registry-demo': registryInstallRecord(manifestPath, 'actual-plugin'),
      }),
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'registry-demo',
            displayName: 'Registry Demo',
            description: 'Registry copy',
            version: '2.0.0',
            source: './registry-demo-source',
          },
        ],
        tools: [],
      }),
    );
    const provider = new JsonManifestRegistryProvider(
      manifestPath,
      projectHome,
    );

    await expect(provider.update('registry-demo')).resolves.toMatchObject({
      success: true,
    });

    expect(existsSync(resolve(installedPluginDir, 'plugin.json'))).toBe(true);
    expect(existsSync(resolve(registryIdDir, 'plugin.json'))).toBe(false);
    expect(
      JSON.parse(
        readFileSync(resolve(installedPluginDir, 'plugin.json'), 'utf8'),
      ).version,
    ).toBe('2.0.0');
    expect(
      JSON.parse(
        readFileSync(
          resolve(projectHome, 'config', 'registry-installs.json'),
          'utf8',
        ),
      ),
    ).toEqual({
      'registry-demo': registryInstallRecord(manifestPath, 'actual-plugin'),
    });
  });

  test('updates git-backed aliased registry plugins into the installed manifest-name directory', async () => {
    const projectHome = await makeProjectHome();
    const sourceRepo = resolve(projectHome, 'registry-demo-work');
    const bareRepo = resolve(projectHome, 'registry-demo.git');
    const configDir = resolve(projectHome, 'config');
    const pluginsDir = resolve(projectHome, 'plugins');
    const installedPluginDir = resolve(pluginsDir, 'actual-plugin');
    const registryIdDir = resolve(pluginsDir, 'registry-demo');
    const manifestPath = resolve(projectHome, 'registry.json');
    mkdirSync(sourceRepo, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    mkdirSync(installedPluginDir, { recursive: true });
    writeFileSync(
      resolve(sourceRepo, 'plugin.json'),
      JSON.stringify({
        name: 'actual-plugin',
        displayName: 'Registry Demo',
        version: '2.0.0',
      }),
    );
    execGitSync(['init'], { cwd: sourceRepo });
    execGitSync(['config', 'user.email', 'station@example.com'], {
      cwd: sourceRepo,
    });
    execGitSync(['config', 'user.name', 'Station Test'], { cwd: sourceRepo });
    execGitSync(['add', 'plugin.json'], { cwd: sourceRepo });
    execGitSync(['commit', '-m', 'initial plugin'], { cwd: sourceRepo });
    // Fixture setup: a local-path clone needs the `file` transport opt-in
    // (#2363). The provider's own clone of `./registry-demo.git` below opts
    // in by itself, because the source is a local path.
    execGitSync(['clone', '--bare', sourceRepo, bareRepo], {
      cwd: projectHome,
      hardening: { allowFileProtocol: true },
    });
    writeFileSync(
      join(installedPluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'actual-plugin',
        displayName: 'Registry Demo',
        version: '1.0.0',
      }),
    );
    writeFileSync(
      resolve(configDir, 'registry-installs.json'),
      JSON.stringify({
        'registry-demo': registryInstallRecord(manifestPath, 'actual-plugin'),
      }),
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'registry-demo',
            displayName: 'Registry Demo',
            description: 'Registry copy',
            version: '2.0.0',
            source: './registry-demo.git',
          },
        ],
        tools: [],
      }),
    );
    const provider = new JsonManifestRegistryProvider(
      manifestPath,
      projectHome,
    );

    await expect(provider.update('registry-demo')).resolves.toMatchObject({
      success: true,
    });

    expect(existsSync(resolve(installedPluginDir, 'plugin.json'))).toBe(true);
    expect(existsSync(resolve(registryIdDir, 'plugin.json'))).toBe(false);
    expect(
      JSON.parse(
        readFileSync(resolve(installedPluginDir, 'plugin.json'), 'utf8'),
      ).version,
    ).toBe('2.0.0');
    expect(
      JSON.parse(
        readFileSync(
          resolve(projectHome, 'config', 'registry-installs.json'),
          'utf8',
        ),
      ),
    ).toEqual({
      'registry-demo': registryInstallRecord(manifestPath, 'actual-plugin'),
    });
  });

  test('rejects aliased updates that resolve to a different manifest name', async () => {
    const projectHome = await makeProjectHome();
    const registrySource = resolve(projectHome, 'registry-demo-source');
    const configDir = resolve(projectHome, 'config');
    const pluginsDir = resolve(projectHome, 'plugins');
    const installedPluginDir = resolve(pluginsDir, 'actual-plugin');
    const victimPluginDir = resolve(pluginsDir, 'victim-plugin');
    const manifestPath = resolve(projectHome, 'registry.json');
    mkdirSync(registrySource, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    mkdirSync(installedPluginDir, { recursive: true });
    mkdirSync(victimPluginDir, { recursive: true });
    writeFileSync(
      resolve(registrySource, 'plugin.json'),
      JSON.stringify({
        name: 'victim-plugin',
        displayName: 'Registry Demo',
        version: '2.0.0',
      }),
    );
    writeFileSync(
      join(installedPluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'actual-plugin',
        displayName: 'Registry Demo',
        version: '1.0.0',
      }),
    );
    writeFileSync(
      join(victimPluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'victim-plugin',
        displayName: 'Victim Plugin',
        version: '1.0.0',
      }),
    );
    writeFileSync(
      resolve(configDir, 'registry-installs.json'),
      JSON.stringify({
        'registry-demo': registryInstallRecord(manifestPath, 'actual-plugin'),
      }),
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'registry-demo',
            displayName: 'Registry Demo',
            description: 'Registry copy',
            version: '2.0.0',
            source: './registry-demo-source',
          },
        ],
        tools: [],
      }),
    );
    const provider = new JsonManifestRegistryProvider(
      manifestPath,
      projectHome,
    );

    await expect(provider.update('registry-demo')).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining("expected 'actual-plugin'"),
    });
    expect(
      JSON.parse(readFileSync(resolve(victimPluginDir, 'plugin.json'), 'utf8'))
        .version,
    ).toBe('1.0.0');
  });

  test('rejects registry installs that would overwrite an unrelated installed plugin', async () => {
    const projectHome = await makeProjectHome();
    const registrySource = resolve(projectHome, 'registry-demo-source');
    const pluginsDir = resolve(projectHome, 'plugins');
    const victimPluginDir = resolve(pluginsDir, 'victim-plugin');
    const manifestPath = resolve(projectHome, 'registry.json');
    const victimManifest = {
      name: 'victim-plugin',
      displayName: 'Victim Plugin',
      version: '1.0.0',
    };
    mkdirSync(registrySource, { recursive: true });
    mkdirSync(victimPluginDir, { recursive: true });
    writeFileSync(
      resolve(registrySource, 'plugin.json'),
      JSON.stringify({
        name: 'victim-plugin',
        displayName: 'Registry Demo',
        version: '2.0.0',
      }),
    );
    writeFileSync(
      join(victimPluginDir, 'plugin.json'),
      JSON.stringify(victimManifest),
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'registry-demo',
            displayName: 'Registry Demo',
            description: 'Registry copy',
            version: '2.0.0',
            source: './registry-demo-source',
          },
        ],
        tools: [],
      }),
    );
    const provider = new JsonManifestRegistryProvider(
      manifestPath,
      projectHome,
    );

    await expect(provider.install('registry-demo')).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining(
        "cannot overwrite installed plugin 'victim-plugin'",
      ),
    });

    expect(
      JSON.parse(readFileSync(resolve(victimPluginDir, 'plugin.json'), 'utf8')),
    ).toEqual(victimManifest);
  });

  test('refuses a plain http:// git source by name, before git runs (#2363)', async () => {
    const projectHome = await makeProjectHome();
    const manifestPath = resolve(projectHome, 'registry.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'registry-demo',
            displayName: 'Registry Demo',
            description: 'Registry copy',
            version: '1.0.0',
            source: 'http://git.example.test/acme/plugin.git',
          },
        ],
        tools: [],
      }),
    );
    const provider = new JsonManifestRegistryProvider(
      manifestPath,
      projectHome,
    );

    await expect(provider.install('registry-demo')).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining('Use an https:// address'),
    });
  });

  test('rejects same-id registry installs without prior registry ownership', async () => {
    const projectHome = await makeProjectHome();
    const registrySource = resolve(projectHome, 'registry-demo-source');
    const pluginsDir = resolve(projectHome, 'plugins');
    const existingPluginDir = resolve(pluginsDir, 'registry-demo');
    const manifestPath = resolve(projectHome, 'registry.json');
    const existingManifest = {
      name: 'registry-demo',
      displayName: 'Manual Plugin',
      version: '1.0.0',
    };
    mkdirSync(registrySource, { recursive: true });
    mkdirSync(existingPluginDir, { recursive: true });
    writeFileSync(
      resolve(registrySource, 'plugin.json'),
      JSON.stringify({
        name: 'registry-demo',
        displayName: 'Registry Demo',
        version: '2.0.0',
      }),
    );
    writeFileSync(
      join(existingPluginDir, 'plugin.json'),
      JSON.stringify(existingManifest),
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'registry-demo',
            displayName: 'Registry Demo',
            description: 'Registry copy',
            version: '2.0.0',
            source: './registry-demo-source',
          },
        ],
        tools: [],
      }),
    );
    const provider = new JsonManifestRegistryProvider(
      manifestPath,
      projectHome,
    );

    await expect(provider.install('registry-demo')).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining(
        "cannot overwrite installed plugin 'registry-demo'",
      ),
    });
    expect(
      JSON.parse(
        readFileSync(resolve(existingPluginDir, 'plugin.json'), 'utf8'),
      ),
    ).toEqual(existingManifest);
  });

  test('rejects occupied registry targets even when plugin.json is absent', async () => {
    const projectHome = await makeProjectHome();
    const registrySource = resolve(projectHome, 'registry-demo-source');
    const pluginsDir = resolve(projectHome, 'plugins');
    const existingPluginDir = resolve(pluginsDir, 'registry-demo');
    const manifestPath = resolve(projectHome, 'registry.json');
    mkdirSync(registrySource, { recursive: true });
    mkdirSync(existingPluginDir, { recursive: true });
    writeFileSync(resolve(existingPluginDir, 'scratch.txt'), 'keep me');
    writeFileSync(
      resolve(registrySource, 'plugin.json'),
      JSON.stringify({
        name: 'registry-demo',
        displayName: 'Registry Demo',
        version: '2.0.0',
      }),
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'registry-demo',
            displayName: 'Registry Demo',
            description: 'Registry copy',
            version: '2.0.0',
            source: './registry-demo-source',
          },
        ],
        tools: [],
      }),
    );
    const provider = new JsonManifestRegistryProvider(
      manifestPath,
      projectHome,
    );

    await expect(provider.install('registry-demo')).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining(
        "cannot overwrite installed plugin 'registry-demo'",
      ),
    });
    expect(
      readFileSync(resolve(existingPluginDir, 'scratch.txt'), 'utf8'),
    ).toBe('keep me');
  });

  test('rejects dependency-style alias retargeting before mutation', async () => {
    const projectHome = await makeProjectHome();
    const registrySource = resolve(projectHome, 'registry-demo-source');
    const configDir = resolve(projectHome, 'config');
    const manifestPath = resolve(projectHome, 'registry.json');
    mkdirSync(registrySource, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      resolve(configDir, 'registry-installs.json'),
      JSON.stringify({
        'registry-demo': registryInstallRecord(manifestPath, 'actual-plugin'),
      }),
    );
    writeFileSync(
      resolve(registrySource, 'plugin.json'),
      JSON.stringify({
        name: 'registry-demo',
        displayName: 'Registry Demo',
        version: '2.0.0',
      }),
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'registry-demo',
            displayName: 'Registry Demo',
            description: 'Registry copy',
            version: '2.0.0',
            source: './registry-demo-source',
          },
        ],
        tools: [],
      }),
    );
    const provider = new JsonManifestRegistryProvider(
      manifestPath,
      projectHome,
    );

    await expect(provider.install('registry-demo')).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining(
        'is already owned by another registry source or plugin target',
      ),
    });
    expect(
      JSON.parse(
        readFileSync(resolve(configDir, 'registry-installs.json'), 'utf8'),
      ),
    ).toEqual({
      'registry-demo': registryInstallRecord(manifestPath, 'actual-plugin'),
    });
  });

  test('rejects duplicate registry ownership even when the existing target is missing', async () => {
    const projectHome = await makeProjectHome();
    const registrySource = resolve(projectHome, 'registry-demo-source');
    const configDir = resolve(projectHome, 'config');
    const manifestPath = resolve(projectHome, 'registry.json');
    mkdirSync(registrySource, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      resolve(configDir, 'registry-installs.json'),
      JSON.stringify({
        'old-registry-demo': registryInstallRecord(
          manifestPath,
          'shared-plugin',
        ),
      }),
    );
    writeFileSync(
      resolve(registrySource, 'plugin.json'),
      JSON.stringify({
        name: 'shared-plugin',
        displayName: 'Registry Demo',
        version: '2.0.0',
      }),
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'registry-demo',
            displayName: 'Registry Demo',
            description: 'Registry copy',
            version: '2.0.0',
            source: './registry-demo-source',
          },
        ],
        tools: [],
      }),
    );
    const provider = new JsonManifestRegistryProvider(
      manifestPath,
      projectHome,
    );

    await expect(provider.install('registry-demo')).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining(
        "already owned by registry plugin 'old-registry-demo'",
      ),
    });
    expect(
      JSON.parse(
        readFileSync(resolve(configDir, 'registry-installs.json'), 'utf8'),
      ),
    ).toEqual({
      'old-registry-demo': registryInstallRecord(manifestPath, 'shared-plugin'),
    });
  });

  test('rejects registry uninstall without explicit registry ownership', async () => {
    const projectHome = await makeProjectHome();
    const pluginsDir = resolve(projectHome, 'plugins');
    const existingPluginDir = resolve(pluginsDir, 'registry-demo');
    mkdirSync(existingPluginDir, { recursive: true });
    writeFileSync(
      join(existingPluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'registry-demo',
        displayName: 'Manual Plugin',
        version: '1.0.0',
      }),
    );
    const provider = new JsonManifestRegistryProvider(
      fixtureManifestPath,
      projectHome,
    );

    await expect(provider.uninstall('registry-demo')).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining('not installed from this registry'),
    });
    expect(existsSync(resolve(existingPluginDir, 'plugin.json'))).toBe(true);
  });

  test('rejects unsafe registry uninstall ids before resolving a target', async () => {
    const projectHome = await makeProjectHome();
    const victimDir = resolve(projectHome, 'victim-plugin');
    const provider = new JsonManifestRegistryProvider(
      fixtureManifestPath,
      projectHome,
    );
    mkdirSync(victimDir, { recursive: true });
    writeFileSync(resolve(victimDir, 'keep.txt'), 'keep me');

    await expect(provider.uninstall('../victim-plugin')).resolves.toMatchObject(
      {
        success: false,
        message: expect.stringContaining('safe path segment'),
      },
    );
    expect(readFileSync(resolve(victimDir, 'keep.txt'), 'utf8')).toBe(
      'keep me',
    );
  });

  function registryFor(projectHome: string, source: string) {
    const manifestPath = resolve(projectHome, 'registry.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'registry-demo',
            displayName: 'Registry Demo',
            description: 'Registry copy',
            version: '2.0.0',
            source,
          },
        ],
        tools: [],
      }),
    );
    return new JsonManifestRegistryProvider(manifestPath, projectHome);
  }

  test('refuses a registry source whose plugin.json is a symlink (#2342 review)', async () => {
    const projectHome = await makeProjectHome();
    const registrySource = resolve(projectHome, 'registry-demo-source');
    mkdirSync(registrySource, { recursive: true });
    writeFileSync(
      resolve(projectHome, 'outside.json'),
      JSON.stringify({
        name: 'leaked-name',
        version: '9.9.9',
        description: 'AKIASECRET0123456789',
      }),
    );
    symlinkSync(
      resolve(projectHome, 'outside.json'),
      resolve(registrySource, 'plugin.json'),
    );
    const before = new Set(await listStationTempEntries('registry-plugin'));

    const result = await registryFor(
      projectHome,
      './registry-demo-source',
    ).install('registry-demo');

    expect(result).toMatchObject({
      success: false,
      message: expect.stringContaining('plugin.json is a symlink'),
    });
    expect(JSON.stringify(result)).not.toContain('AKIASECRET');
    expect(existsSync(resolve(projectHome, 'plugins', 'leaked-name'))).toBe(
      false,
    );
    const after = await listStationTempEntries('registry-plugin');
    expect(after.filter((entry) => !before.has(entry))).toEqual([]);
  });

  test.skipIf(process.getuid?.() === 0)(
    'refuses a registry source with an unreadable directory without aborting the process (#2342 review)',
    async () => {
      const projectHome = await makeProjectHome();
      const registrySource = resolve(projectHome, 'registry-demo-source');
      mkdirSync(resolve(registrySource, 'locked'), { recursive: true });
      writeFileSync(
        resolve(registrySource, 'plugin.json'),
        JSON.stringify({ name: 'locked-plugin', version: '1.0.0' }),
      );
      chmodSync(resolve(registrySource, 'locked'), 0o000);
      try {
        const result = await registryFor(
          projectHome,
          './registry-demo-source',
        ).install('registry-demo');
        expect(result).toMatchObject({
          success: false,
          message: expect.stringContaining('EACCES'),
        });
      } finally {
        chmodSync(resolve(registrySource, 'locked'), 0o755);
      }
    },
  );

  test('cleans staged registry plugin sources when git materialization fails', async () => {
    const projectHome = await makeProjectHome();
    const manifestPath = resolve(projectHome, 'registry.json');
    // Scan the Station-owned temp root, not the system temp directory: the
    // latter is O(everything on the machine) and took 3.1s per call once
    // unrelated processes had filled it with ~790k entries.
    const before = new Set(await listStationTempEntries('registry-plugin'));
    // A contained directory that is not a repository: it passes source
    // confinement and fails inside `git clone`, after staging began.
    mkdirSync(resolve(projectHome, 'missing-source.git'));
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'registry-demo',
            displayName: 'Registry Demo',
            description: 'Registry copy',
            version: '2.0.0',
            source: './missing-source.git',
          },
        ],
        tools: [],
      }),
    );
    const provider = new JsonManifestRegistryProvider(
      manifestPath,
      projectHome,
    );

    await expect(provider.install('registry-demo')).resolves.toMatchObject({
      success: false,
    });

    const after = await listStationTempEntries('registry-plugin');
    expect(after.filter((entry) => !before.has(entry))).toEqual([]);
  });

  test('rejects unsafe registry plugin ids before provider-local installs touch disk', async () => {
    const projectHome = await makeProjectHome();
    const registrySource = resolve(projectHome, 'registry-demo-source');
    const manifestPath = resolve(projectHome, 'registry.json');
    mkdirSync(registrySource, { recursive: true });
    writeFileSync(
      resolve(registrySource, 'plugin.json'),
      JSON.stringify({
        name: 'actual-plugin',
        displayName: 'Registry Demo',
        version: '2.0.0',
      }),
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: '../registry-demo',
            displayName: 'Registry Demo',
            description: 'Registry copy',
            version: '2.0.0',
            source: './registry-demo-source',
          },
        ],
        tools: [],
      }),
    );
    const provider = new JsonManifestRegistryProvider(
      manifestPath,
      projectHome,
    );

    await expect(provider.install('../registry-demo')).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining('safe path segment'),
    });

    expect(existsSync(resolve(projectHome, 'plugins'))).toBe(false);
  });

  /**
   * archive#4300. This provider writes `<plugins>/<manifest.name>` itself
   * rather than delegating to `installPluginFromSource`, so the reserved-
   * identity refusal has to hold here independently. A registry entry is the
   * least inspected install there is — the operator picked a catalog row.
   */
  test('rejects a manifest name Station reserves for its own routes', async () => {
    const projectHome = await makeProjectHome();
    const registrySource = resolve(projectHome, 'registry-demo-source');
    const manifestPath = resolve(projectHome, 'registry.json');
    mkdirSync(registrySource, { recursive: true });
    writeFileSync(
      resolve(registrySource, 'plugin.json'),
      JSON.stringify({
        name: 'home-role',
        displayName: 'Registry Demo',
        version: '2.0.0',
      }),
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'registry-demo',
            displayName: 'Registry Demo',
            description: 'Registry copy',
            version: '2.0.0',
            source: './registry-demo-source',
          },
        ],
        tools: [],
      }),
    );
    const provider = new JsonManifestRegistryProvider(
      manifestPath,
      projectHome,
    );

    await expect(provider.install('registry-demo')).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining("Plugin name 'home-role' is reserved"),
    });

    expect(existsSync(resolve(projectHome, 'plugins', 'home-role'))).toBe(
      false,
    );
  });

  test('rejects unsafe registry manifest names before provider-local installs touch disk', async () => {
    const projectHome = await makeProjectHome();
    const registrySource = resolve(projectHome, 'registry-demo-source');
    const manifestPath = resolve(projectHome, 'registry.json');
    mkdirSync(registrySource, { recursive: true });
    writeFileSync(
      resolve(registrySource, 'plugin.json'),
      JSON.stringify({
        name: '../actual-plugin',
        displayName: 'Registry Demo',
        version: '2.0.0',
      }),
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'registry-demo',
            displayName: 'Registry Demo',
            description: 'Registry copy',
            version: '2.0.0',
            source: './registry-demo-source',
          },
        ],
        tools: [],
      }),
    );
    const provider = new JsonManifestRegistryProvider(
      manifestPath,
      projectHome,
    );

    // archive#4307 moved this rejection EARLIER: `manifest.name` is validated
    // as a canonical plugin id at manifest parse, so a traversal name is
    // refused before the "safe path segment" guard is consulted. The property
    // under test — refused, and nothing written outside the install root — is
    // unchanged.
    await expect(provider.install('registry-demo')).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining('is not a canonical plugin id'),
    });

    expect(existsSync(resolve(projectHome, 'actual-plugin'))).toBe(false);
  });

  test('surfaces unavailable hosted manifest failures', async () => {
    const baseUrl = await serve((_request, response) => {
      response
        .writeHead(503, { 'Content-Type': 'text/plain' })
        .end('registry unavailable');
    });
    const provider = new JsonManifestRegistryProvider(
      `${baseUrl}/registry/manifest.json`,
      await makeProjectHome(),
    );

    await expect(provider.listAvailable()).rejects.toThrow(
      'Failed to fetch manifest: 503 Service Unavailable',
    );
  });

  /**
   * archive#4309 follow-up review, MEDIUM 2. `install()` is called from inside
   * a plugin's content lock, and every consent decision, update and uninstall
   * for that plugin queues behind that span. An unbounded manifest fetch gives
   * the span no ceiling at all: a registry host that accepts the connection
   * and never answers holds the lock for the life of the process.
   */
  test('a registry host that never answers cannot hold the manifest fetch open', async () => {
    const stalled: ServerResponse[] = [];
    const baseUrl = await serve((_request, response) => {
      // Accepted, headers never written, never ended.
      stalled.push(response);
    });
    const provider = new JsonManifestRegistryProvider(
      `${baseUrl}/registry/manifest.json`,
      await makeProjectHome(),
      120,
    );

    const startedAt = Date.now();
    await expect(provider.listAvailable()).rejects.toThrow(/timed out|abort/i);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    for (const response of stalled) response.destroy();
  });

  test('rejects malformed hosted manifest payloads before registry entries are trusted', async () => {
    const baseUrl = await serve((_request, response) => {
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end('{"version":1');
    });
    const provider = new JsonManifestRegistryProvider(
      `${baseUrl}/registry/manifest.json`,
      await makeProjectHome(),
    );

    await expect(provider.listAvailable()).rejects.toThrow();
  });

  test('serves curated manifest tools through the integration registry view', async () => {
    const manifest = JSON.parse(readFileSync(fixtureManifestPath, 'utf-8'));
    const provider = new JsonManifestRegistryProvider(
      fixtureManifestPath,
      await makeProjectHome(),
    );
    const integrations = provider.integrationRegistry();

    // The curated Surface MCP entry is listed for one-click install …
    const available = await integrations.listAvailable();
    expect(available.map((item) => item.id)).toEqual(
      manifest.tools.map((tool: { id: string }) => tool.id),
    );
    const surfaceEntry = available.find((item) => item.id === 'surface-mcp');
    expect(surfaceEntry).toBeDefined();
    expect(existsSync(surfaceEntry!.source!)).toBe(true);

    // … but stays out of the plugin/agent browse list.
    const plugins = await provider.listAvailable();
    expect(plugins.map((plugin) => plugin.id)).not.toContain('surface-mcp');

    // Install resolves and the ToolDef points npx at the Surface MCP server.
    await expect(integrations.install('surface-mcp')).resolves.toMatchObject({
      success: true,
    });
    const toolDef = await integrations.getToolDef('surface-mcp');
    expect(toolDef).toMatchObject({
      id: 'surface-mcp',
      kind: 'mcp',
      transport: 'stdio',
      command: 'npx',
    });
    expect(toolDef?.args).toEqual([
      '-y',
      '@kontourai/surface@2.12.0',
      'mcp',
      '--adapter',
      'veritas',
      '--input',
      '<Veritas reportArtifactPath>',
    ]);
    // The exact Veritas output field is documented on the entry itself.
    expect(toolDef?.description).toContain('reportArtifactPath');

    await expect(integrations.install('does-not-exist')).resolves.toMatchObject(
      { success: false },
    );
    await expect(integrations.getToolDef('does-not-exist')).resolves.toBeNull();
  });

  test('partitions the catalog between the agent and plugin browse surfaces by declared kind', async () => {
    const projectHome = await makeProjectHome();
    const manifestPath = join(projectHome, 'manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'layout-plugin',
            displayName: 'Layout Plugin',
            description: 'Contributes a layout.',
            version: '1.0.0',
            source: './layout-plugin',
          },
          {
            id: 'reviewer-agent',
            displayName: 'Reviewer Agent',
            description: 'An agent definition.',
            version: '1.0.0',
            source: './reviewer-agent',
            type: 'agent',
          },
        ],
      }),
    );
    const provider = new JsonManifestRegistryProvider(
      manifestPath,
      projectHome,
    );

    // Each surface lists only its own kind: the agent browse list used to be
    // `manifest.plugins` whole (#1536 D2).
    expect((await provider.listAvailable()).map((item) => item.id)).toEqual([
      'layout-plugin',
    ]);
    expect(
      (await provider.agentRegistry().listAvailable()).map((item) => item.id),
    ).toEqual(['reviewer-agent']);
  });

  // Review L5: BOTH shipped catalogs. `default.json` is what a fresh install
  // reads (`runtime-initialize.ts` picks the bundled default source), so a
  // tripwire aimed only at `manifest.json` would miss an agent kind added to
  // the one that actually ships.
  test.each([
    ['examples/registry/manifest.json'],
    ['examples/registry/default.json'],
  ])(
    'browses no agents for %s, which declares only plugins',
    async (relativePath) => {
      const manifestPath = resolve(repoRoot, relativePath);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const provider = new JsonManifestRegistryProvider(
        manifestPath,
        await makeProjectHome(),
      );

      // The shipped catalog's real bytes: every entry is a plugin, none declares
      // an agent kind. An empty Agents tab is the honest reading of that.
      expect(manifest.plugins.length).toBeGreaterThan(0);
      expect(
        manifest.plugins.some((entry: { type?: string }) => entry.type),
      ).toBe(false);
      expect(await provider.agentRegistry().listAvailable()).toEqual([]);
      expect((await provider.listAvailable()).length).toBe(
        manifest.plugins.length,
      );
    },
  );
});

describe('JsonManifestRegistryProvider source confinement', () => {
  /**
   * `<base>/registry-root/catalog/manifest.json`: the registry root is
   * `<base>/registry-root` (the parent of the manifest directory, the root the
   * shipped `examples/registry` catalogs use). `<base>/outside` holds a real
   * plugin and integration the manifest must not be able to reach.
   */
  async function confinementLayout() {
    // Physical base: on macOS the temp dir sits under the `/var` symlink, which
    // would otherwise mask what the symlink cases are meant to prove.
    const base = realpathSync(await makeProjectHome());
    const root = resolve(base, 'registry-root');
    const catalogDir = resolve(root, 'catalog');
    const outside = resolve(base, 'outside');
    const projectHome = resolve(base, 'home');
    const writePlugin = (dir: string, name: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        resolve(dir, 'plugin.json'),
        JSON.stringify({ name, version: '1.0.0' }),
      );
    };
    const writeIntegration = (dir: string, id: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        resolve(dir, 'integration.json'),
        JSON.stringify({ id, kind: 'mcp', transport: 'stdio', command: id }),
      );
    };
    mkdirSync(catalogDir, { recursive: true });
    mkdirSync(projectHome, { recursive: true });
    writePlugin(resolve(outside, 'secret-plugin'), 'secret-plugin');
    writeIntegration(resolve(outside, 'secret-tool'), 'secret-tool');
    writePlugin(resolve(root, 'plugins', 'good-plugin'), 'good-plugin');
    writeIntegration(resolve(root, 'tools', 'good-tool'), 'good-tool');
    const manifestPath = resolve(catalogDir, 'manifest.json');
    const provider = (
      plugins: Array<{ id: string; source: string }>,
      tools: Array<{ id: string; source: string }> = [],
    ) => {
      const entry = (item: { id: string; source: string }) => ({
        ...item,
        displayName: item.id,
        description: item.id,
        version: '1.0.0',
      });
      writeFileSync(
        manifestPath,
        JSON.stringify({
          version: 1,
          plugins: plugins.map(entry),
          tools: tools.map(entry),
        }),
      );
      return new JsonManifestRegistryProvider(manifestPath, projectHome);
    };
    return { base, root, outside, projectHome, provider };
  }

  async function expectPluginRefused(
    provider: JsonManifestRegistryProvider,
    projectHome: string,
    id: string,
    reason: RegExp,
  ) {
    const result = await provider.install(id);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(reason);
    expect(existsSync(resolve(projectHome, 'plugins', 'secret-plugin'))).toBe(
      false,
    );
    const resolution = provider.resolvePackage(id);
    await expect(resolution).rejects.toBeInstanceOf(
      RegistrySourceConfinementError,
    );
    await expect(resolution).rejects.toThrow(reason);
    // The catalog still lists the entry, with no source to act on.
    const listed = (await provider.listAvailable()).find(
      (item) => item.id === id,
    );
    expect(listed).toBeDefined();
    expect(listed?.source).toBeUndefined();
  }

  test('refuses a relative source that escapes the registry root with ../', async () => {
    const { projectHome, provider } = await confinementLayout();
    await expectPluginRefused(
      provider([{ id: 'escape', source: '../../outside/secret-plugin' }]),
      projectHome,
      'escape',
      /resolves outside the registry root$/,
    );
  });

  test('refuses an absolute source outside the registry root', async () => {
    const { outside, projectHome, provider } = await confinementLayout();
    await expectPluginRefused(
      provider([{ id: 'absolute', source: resolve(outside, 'secret-plugin') }]),
      projectHome,
      'absolute',
      /resolves outside the registry root$/,
    );
  });

  test('refuses a symlink inside the registry root that points outside it', async () => {
    const { root, outside, projectHome, provider } = await confinementLayout();
    symlinkSync(outside, resolve(root, 'linked'));
    await expectPluginRefused(
      provider([{ id: 'linked', source: '../linked/secret-plugin' }]),
      projectHome,
      'linked',
      /outside the registry root through a symlink/,
    );
    // A leaf that does not exist under the link (a git `#branch` source) is
    // judged by its physical ancestor, not waved through.
    await expectPluginRefused(
      provider([{ id: 'linked-git', source: '../linked/repo.git#main' }]),
      projectHome,
      'linked-git',
      /outside the registry root through a symlink/,
    );
  });

  test('installs in-root relative and absolute sources (positive controls)', async () => {
    const { root, projectHome, provider } = await confinementLayout();
    const registry = provider([
      { id: 'relative-good', source: '../plugins/good-plugin' },
    ]);
    await expect(registry.resolvePackage('relative-good')).resolves.toEqual({
      source: resolve(root, 'plugins', 'good-plugin'),
    });
    await expect(registry.install('relative-good')).resolves.toMatchObject({
      success: true,
    });
    expect(
      existsSync(resolve(projectHome, 'plugins', 'good-plugin', 'plugin.json')),
    ).toBe(true);
    await expect(registry.uninstall('relative-good')).resolves.toMatchObject({
      success: true,
    });

    const absolute = provider([
      { id: 'absolute-good', source: resolve(root, 'plugins', 'good-plugin') },
    ]);
    await expect(absolute.install('absolute-good')).resolves.toMatchObject({
      success: true,
    });
  });

  test('refuses integration sources outside the registry root and reads in-root ones', async () => {
    const { root, outside, provider } = await confinementLayout();
    symlinkSync(outside, resolve(root, 'linked'));
    const integrations = provider(
      [],
      [
        { id: 'escape-tool', source: '../../outside/secret-tool' },
        { id: 'absolute-tool', source: resolve(outside, 'secret-tool') },
        { id: 'linked-tool', source: '../linked/secret-tool' },
        { id: 'good-tool', source: '../tools/good-tool' },
      ],
    ).integrationRegistry();

    for (const id of ['escape-tool', 'absolute-tool', 'linked-tool']) {
      const result = await integrations.install(id);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/outside the registry root/);
      await expect(integrations.getToolDef(id)).resolves.toBeNull();
    }
    const listed = await integrations.listAvailable();
    expect(
      listed.filter((item) => item.source === undefined).map((i) => i.id),
    ).toEqual(['escape-tool', 'absolute-tool', 'linked-tool']);

    await expect(integrations.install('good-tool')).resolves.toMatchObject({
      success: true,
    });
    await expect(integrations.getToolDef('good-tool')).resolves.toMatchObject({
      id: 'good-tool',
      command: 'good-tool',
    });
  });

  test('refuses local paths and file: URLs from a network manifest', async () => {
    const { outside } = await confinementLayout();
    const secretPlugin = resolve(outside, 'secret-plugin');
    const secretTool = resolve(outside, 'secret-tool');
    const baseUrl = await serve((request, response) => {
      if (request.url !== '/registry/manifest.json') {
        response.writeHead(404).end();
        return;
      }
      const entry = (id: string, source: string) => ({
        id,
        displayName: id,
        description: id,
        version: '1.0.0',
        source,
      });
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          version: 1,
          plugins: [
            entry('remote-absolute', secretPlugin),
            entry('remote-file-url', `file://${secretPlugin}.git`),
            entry('remote-relative', '../../outside/secret-plugin'),
            entry('remote-backslash', '\\\\evil.test/plugin.git'),
            entry('remote-slashes', '//evil.test/plugin.git'),
            entry('remote-tab-slashes', '\t//evil.test/plugin.git'),
          ],
          tools: [
            entry('remote-absolute-tool', secretTool),
            entry('remote-relative-tool', '../../outside/secret-tool'),
          ],
        }),
      );
    });
    const projectHome = await makeProjectHome();
    const provider = new JsonManifestRegistryProvider(
      `${baseUrl}/registry/manifest.json`,
      projectHome,
    );

    await expectPluginRefused(
      provider,
      projectHome,
      'remote-absolute',
      /network registry manifest cannot name a local path/,
    );
    await expectPluginRefused(
      provider,
      projectHome,
      'remote-file-url',
      /unsupported source protocol file:/,
    );
    // A relative source is a URL on the registry host, never a local path,
    // and a non-git URL is not copied as though it were a directory.
    await expect(provider.resolvePackage('remote-relative')).resolves.toEqual({
      source: `${baseUrl}/outside/secret-plugin`,
    });
    const relative = await provider.install('remote-relative');
    expect(relative.success).toBe(false);
    expect(relative.message).toMatch(
      /neither a git repository nor a local path/,
    );
    expect(existsSync(resolve(projectHome, 'plugins', 'secret-plugin'))).toBe(
      false,
    );

    await expectPluginRefused(
      provider,
      projectHome,
      'remote-backslash',
      /a relative source cannot contain a backslash$/,
    );
    // `//host` is already refused as an absolute local path.
    await expectPluginRefused(
      provider,
      projectHome,
      'remote-slashes',
      /network registry manifest cannot name a local path$/,
    );
    await expectPluginRefused(
      provider,
      projectHome,
      'remote-tab-slashes',
      /a relative source resolved to another host$/,
    );

    const integrations = provider.integrationRegistry();
    const absoluteTool = await integrations.install('remote-absolute-tool');
    expect(absoluteTool.success).toBe(false);
    expect(absoluteTool.message).toMatch(
      /network registry manifest cannot name a local path/,
    );
    await expect(
      integrations.getToolDef('remote-absolute-tool'),
    ).resolves.toBeNull();
    // Served 404 by the registry host: nothing local is read.
    await expect(
      integrations.getToolDef('remote-relative-tool'),
    ).resolves.toBeNull();
  });

  test.each([
    ['examples/registry/manifest.json'],
    ['examples/registry/default.json'],
  ])('resolves every entry of %s inside its registry root', async (path) => {
    const manifestPath = resolve(repoRoot, path);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const provider = new JsonManifestRegistryProvider(
      manifestPath,
      await makeProjectHome(),
    );
    const examplesRoot = resolve(repoRoot, 'examples');
    for (const plugin of manifest.plugins as Array<{ id: string }>) {
      const resolved = await provider.resolvePackage(plugin.id);
      expect(resolved?.source.startsWith(`${examplesRoot}/`)).toBe(true);
      expect(existsSync(resolve(resolved!.source, 'plugin.json'))).toBe(true);
    }
    const integrations = provider.integrationRegistry();
    for (const tool of (manifest.tools ?? []) as Array<{ id: string }>) {
      await expect(integrations.install(tool.id)).resolves.toMatchObject({
        success: true,
      });
    }
  });

  test('copies from the physical path it checked, not a symlink swapped in after the check', async () => {
    const { root, outside, projectHome, provider } = await confinementLayout();
    const swapped = resolve(outside, 'good-plugin');
    mkdirSync(swapped, { recursive: true });
    writeFileSync(
      resolve(swapped, 'plugin.json'),
      JSON.stringify({ name: 'swapped-plugin', version: '1.0.0' }),
    );
    const alias = resolve(root, 'alias');
    symlinkSync(resolve(root, 'plugins'), alias);
    const registry = provider([
      { id: 'aliased', source: '../alias/good-plugin' },
    ]);
    // The source identity stays the manifest's spelling.
    await expect(registry.resolvePackage('aliased')).resolves.toEqual({
      source: resolve(alias, 'good-plugin'),
    });
    // Between the containment check and the copy (staging starts with the
    // temp directory), the alias is repointed outside the root.
    stageHook.before = () => {
      rmSync(alias);
      symlinkSync(outside, alias);
    };
    try {
      await expect(registry.install('aliased')).resolves.toMatchObject({
        success: true,
      });
    } finally {
      stageHook.before = undefined;
    }
    expect(existsSync(resolve(projectHome, 'plugins', 'good-plugin'))).toBe(
      true,
    );
    expect(existsSync(resolve(projectHome, 'plugins', 'swapped-plugin'))).toBe(
      false,
    );
  });

  test.skipIf(!existsSync('/tmp'))(
    'confines sources correctly when the registry root is the filesystem root',
    async () => {
      const { root, projectHome } = await confinementLayout();
      // `/tmp/<file>.json`: the manifest directory is `/tmp`, so the root is
      // `/` and every absolute path is inside it.
      const manifestPath = `/tmp/station-root-registry-${process.pid}-${Date.now()}.json`;
      cleanupDirs.push(manifestPath);
      writeFileSync(
        manifestPath,
        JSON.stringify({
          version: 1,
          plugins: [
            {
              id: 'root-good',
              displayName: 'root-good',
              description: 'root-good',
              version: '1.0.0',
              source: resolve(root, 'plugins', 'good-plugin'),
            },
          ],
        }),
      );
      const provider = new JsonManifestRegistryProvider(
        manifestPath,
        projectHome,
      );
      await expect(provider.install('root-good')).resolves.toMatchObject({
        success: true,
      });
    },
  );

  test('refuses an integration.json that links outside the registry root', async () => {
    const { root, outside, provider } = await confinementLayout();
    const toolDir = resolve(root, 'tools', 'linked-file-tool');
    mkdirSync(toolDir, { recursive: true });
    symlinkSync(
      resolve(outside, 'secret-tool', 'integration.json'),
      resolve(toolDir, 'integration.json'),
    );
    const warn = vi.fn();
    const registry = provider(
      [],
      [{ id: 'linked-file-tool', source: '../tools/linked-file-tool' }],
    );
    (registry as unknown as { logger: { warn: typeof warn } }).logger = {
      warn,
    };
    const integrations = registry.integrationRegistry();
    await expect(
      integrations.getToolDef('linked-file-tool'),
    ).resolves.toBeNull();
    expect(JSON.stringify(warn.mock.calls)).toMatch(
      /outside the registry root through a symlink/,
    );
    await expect(
      integrations.install('linked-file-tool'),
    ).resolves.toMatchObject({ success: false });
  });

  function commitPluginRepo(dir: string, name: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'plugin.json'),
      JSON.stringify({ name, version: '1.0.0' }),
    );
    execGitSync(['init', '-b', 'main'], { cwd: dir });
    execGitSync(['config', 'user.email', 'station@example.com'], { cwd: dir });
    execGitSync(['config', 'user.name', 'Station Test'], { cwd: dir });
    execGitSync(['add', 'plugin.json'], { cwd: dir });
    execGitSync(['commit', '-m', 'plugin'], { cwd: dir });
  }

  test('refuses a local git source whose gitfile points outside the registry root', async () => {
    const { root, outside, projectHome, provider } = await confinementLayout();
    const outsideRepo = resolve(outside, 'secret-repo');
    commitPluginRepo(outsideRepo, 'secret-plugin');
    const gitfileRepo = resolve(root, 'plugins', 'gitfile.git');
    mkdirSync(gitfileRepo, { recursive: true });
    writeFileSync(
      resolve(gitfileRepo, '.git'),
      `gitdir: ${resolve(outsideRepo, '.git')}\n`,
    );
    const result = await provider([
      { id: 'gitfile', source: '../plugins/gitfile.git' },
    ]).install('gitfile');
    expect(result.success).toBe(false);
    expect(result.message).toMatch(
      /outside the registry root through a symlink$/,
    );
    expect(existsSync(resolve(projectHome, 'plugins', 'secret-plugin'))).toBe(
      false,
    );
  });

  test('refuses a local git source that borrows objects through alternates', async () => {
    const { root, outside, projectHome, provider } = await confinementLayout();
    const outsideRepo = resolve(outside, 'secret-repo');
    commitPluginRepo(outsideRepo, 'secret-plugin');
    const sharedRepo = resolve(root, 'plugins', 'shared.git');
    execGitSync(['clone', '--bare', '--shared', outsideRepo, sharedRepo], {
      hardening: { allowFileProtocol: true },
    });
    expect(existsSync(resolve(sharedRepo, 'objects/info/alternates'))).toBe(
      true,
    );
    const result = await provider([
      { id: 'shared', source: '../plugins/shared.git' },
    ]).install('shared');
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/git object alternates are not allowed/);
    expect(existsSync(resolve(projectHome, 'plugins', 'secret-plugin'))).toBe(
      false,
    );
  });

  test('installs a contained local git source (positive control)', async () => {
    const { root, projectHome, provider } = await confinementLayout();
    const work = resolve(root, 'work', 'good-repo');
    commitPluginRepo(work, 'good-git-plugin');
    const bare = resolve(root, 'plugins', 'good.git');
    execGitSync(['clone', '--bare', work, bare], {
      hardening: { allowFileProtocol: true },
    });
    const result = await provider([
      { id: 'good-git', source: '../plugins/good.git' },
    ]).install('good-git');
    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(existsSync(resolve(projectHome, 'plugins', 'good-git-plugin'))).toBe(
      true,
    );
  });

  /** An outside repository and bare clone whose plugin is `secret-plugin`. */
  function outsideRepos(outside: string) {
    const work = resolve(outside, 'secret-repo');
    commitPluginRepo(work, 'secret-plugin');
    const bare = resolve(outside, 'secret-bare.git');
    execGitSync(['clone', '--bare', work, bare], {
      hardening: { allowFileProtocol: true },
    });
    const bundle = resolve(outside, 'secret.bundle');
    execGitSync(['bundle', 'create', bundle, '--all'], { cwd: work });
    return { work, bare, bundle };
  }

  test.each([['file'], ['probe'], ['bundled']])(
    'refuses local git source %s.git: a gitfile, or missing with a probed suffix beside it',
    async (name) => {
      const { root, outside, projectHome, provider } =
        await confinementLayout();
      const repos = outsideRepos(outside);
      const plugins = resolve(root, 'plugins');
      // B1: the source path is itself a gitfile, with a relative pointer.
      writeFileSync(
        resolve(plugins, 'file.git'),
        `gitdir: ${relative(plugins, resolve(repos.work, '.git'))}\n`,
      );
      // B2: the named path is missing; git would probe these siblings.
      symlinkSync(repos.bare, resolve(plugins, 'probe.git.git'));
      symlinkSync(repos.bundle, resolve(plugins, 'bundled.git.bundle'));
      const registry = provider([
        { id: name, source: `../plugins/${name}.git` },
      ]);
      const result = await registry.install(name);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/a local git source must be a directory$/);
      await expect(registry.resolvePackage(name)).rejects.toBeInstanceOf(
        RegistrySourceConfinementError,
      );
      expect(existsSync(resolve(projectHome, 'plugins', 'secret-plugin'))).toBe(
        false,
      );
    },
  );

  /**
   * The install and preview routes take `resolvePackage`'s source and clone it
   * with the generic installer (`fetchPluginSource`), never this provider's
   * install. Refusal must therefore happen at resolution.
   */
  async function stageThroughInstaller(
    registry: JsonManifestRegistryProvider,
    id: string,
    pluginsDir: string,
  ): Promise<string> {
    const resolved = await registry.resolvePackage(id);
    const staged = await fetchPluginSource(resolved!.source, pluginsDir, {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    } as never);
    if ('error' in staged) throw new Error(staged.error);
    try {
      return JSON.parse(
        readFileSync(join(staged.tempDir, 'plugin.json'), 'utf8'),
      ).name;
    } finally {
      rmSync(staged.tempDir, { recursive: true, force: true });
    }
  }

  test('refuses git indirection at resolvePackage, before the generic installer clones', async () => {
    const { root, outside, projectHome, provider } = await confinementLayout();
    const repos = outsideRepos(outside);
    const plugins = resolve(root, 'plugins');
    const pluginsDir = resolve(projectHome, 'plugins');
    const gitfileRepo = resolve(plugins, 'gitfile.git');
    mkdirSync(gitfileRepo);
    writeFileSync(
      resolve(gitfileRepo, '.git'),
      `gitdir: ${resolve(repos.work, '.git')}\n`,
    );
    execGitSync(
      [
        'clone',
        '--bare',
        '--shared',
        repos.work,
        resolve(plugins, 'shared.git'),
      ],
      { hardening: { allowFileProtocol: true } },
    );
    for (const [id, reason] of [
      ['gitfile', /outside the registry root through a symlink$/],
      ['shared', /git object alternates are not allowed/],
    ] as const) {
      const registry = provider([{ id, source: `../plugins/${id}.git` }]);
      await expect(
        stageThroughInstaller(registry, id, pluginsDir),
      ).rejects.toThrow(reason);
    }

    // Positive control: a contained bare repository stages through the same
    // installer path.
    const work = resolve(root, 'work', 'good-repo');
    commitPluginRepo(work, 'good-git-plugin');
    execGitSync(['clone', '--bare', work, resolve(plugins, 'good.git')], {
      hardening: { allowFileProtocol: true },
    });
    await expect(
      stageThroughInstaller(
        provider([{ id: 'good', source: '../plugins/good.git' }]),
        'good',
        pluginsDir,
      ),
    ).resolves.toBe('good-git-plugin');
  });
});
