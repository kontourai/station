import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { listStationTempEntries } from '@kontourai/station-shared/temp-dir';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { execGitSync } from '../../../utils/git-exec.js';
import { JsonManifestRegistryProvider } from '../json-manifest-registry.js';

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
    execGitSync(['clone', '--bare', sourceRepo, bareRepo], {
      cwd: projectHome,
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

  test('cleans staged registry plugin sources when git materialization fails', async () => {
    const projectHome = await makeProjectHome();
    const manifestPath = resolve(projectHome, 'registry.json');
    // Scan the Station-owned temp root, not the system temp directory: the
    // latter is O(everything on the machine) and took 3.1s per call once
    // unrelated processes had filled it with ~790k entries.
    const before = new Set(await listStationTempEntries('registry-plugin'));
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

  test('browses no agents for a catalog that declares only plugins', async () => {
    const manifest = JSON.parse(readFileSync(fixtureManifestPath, 'utf-8'));
    const provider = new JsonManifestRegistryProvider(
      fixtureManifestPath,
      await makeProjectHome(),
    );

    // The shipped catalog's real bytes: every entry is a plugin, none declares
    // an agent kind. An empty Agents tab is the honest reading of that.
    expect(
      manifest.plugins.some((entry: { type?: string }) => entry.type),
    ).toBe(false);
    expect(await provider.agentRegistry().listAvailable()).toEqual([]);
    expect((await provider.listAvailable()).length).toBe(
      manifest.plugins.length,
    );
  });
});
