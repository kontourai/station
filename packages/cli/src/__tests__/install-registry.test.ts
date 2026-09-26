import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATION_HOME_SCHEMA_VERSION } from '@kontourai/station-shared/station-home-schema';
import { afterEach, describe, expect, test, vi } from 'vitest';

const cleanupDirs: string[] = [];

function createRegistryHome(): {
  root: string;
  home: string;
  aliasesPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'station-registry-cli-'));
  cleanupDirs.push(root);
  const home = join(root, 'home');
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(
    join(home, '.station-home-schema.json'),
    JSON.stringify({ version: STATION_HOME_SCHEMA_VERSION }),
  );
  return {
    root,
    home,
    aliasesPath: join(home, 'config', 'registry-installs.json'),
  };
}

function writeLocalRegistry(home: string, root: string): void {
  const registryDir = join(root, 'registry');
  const pluginDir = join(root, 'plugins', 'actual-plugin');
  mkdirSync(registryDir, { recursive: true });
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(registryDir, 'plugins.json'),
    JSON.stringify({
      version: 1,
      plugins: [{ id: 'curated-demo', source: '../plugins/actual-plugin' }],
      tools: [],
    }),
  );
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({ name: 'actual-plugin', version: '1.0.0' }),
  );
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ registryUrl: join(registryDir, 'plugins.json') }),
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.STATION_HOME;
  await Promise.all(
    cleanupDirs
      .splice(0, cleanupDirs.length)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('install-registry helpers', () => {
  test('reports a corrupt alias store instead of listing a fabricated empty mapping', async () => {
    const { root, home, aliasesPath } = createRegistryHome();
    writeLocalRegistry(home, root);
    writeFileSync(aliasesPath, '{ not json');
    process.env.STATION_HOME = home;
    const { showOrSaveRegistry } = await import(
      '../commands/install-registry.js'
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    await showOrSaveRegistry();

    expect(error).toHaveBeenCalledWith(
      'Registry install aliases are unavailable',
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(readFileSync(aliasesPath, 'utf-8')).toBe('{ not json');
    error.mockRestore();
    exit.mockRestore();
  });

  describe('registryUrl reads from the same file `station config set` writes (station#3239)', () => {
    test('`station registry <url>` persists to config/app.json, and a later read of the same process sees it', async () => {
      const { home } = createRegistryHome();
      process.env.STATION_HOME = home;
      const { showOrSaveRegistry } = await import(
        '../commands/install-registry.js'
      );
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      await showOrSaveRegistry('https://example.invalid/registry.json');

      const appConfig = JSON.parse(
        readFileSync(join(home, 'config', 'app.json'), 'utf-8'),
      );
      expect(appConfig.registryUrl).toBe(
        'https://example.invalid/registry.json',
      );
      expect(existsSync(join(home, 'config.json'))).toBe(false);
      log.mockRestore();
    });

    test('a value left in the legacy config.json location is still honored and migrated forward into config/app.json', async () => {
      const { root, home } = createRegistryHome();
      writeLocalRegistry(home, root); // writes legacy `config.json`
      process.env.STATION_HOME = home;
      const { showOrSaveRegistry } = await import(
        '../commands/install-registry.js'
      );
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      await showOrSaveRegistry();

      const legacyUrl = JSON.parse(
        readFileSync(join(home, 'config.json'), 'utf-8'),
      ).registryUrl;
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(`Fetching registry from ${legacyUrl}`),
      );
      const migratedUrl = JSON.parse(
        readFileSync(join(home, 'config', 'app.json'), 'utf-8'),
      ).registryUrl;
      expect(migratedUrl).toBe(legacyUrl);
      log.mockRestore();
    });

    test('config/app.json takes precedence over a stale legacy config.json value', async () => {
      const { root, home } = createRegistryHome();
      writeLocalRegistry(home, root); // legacy `config.json`, stale value
      // A fresher value written the current way (e.g. `station config set`).
      const freshDir = join(root, 'fresh-registry');
      mkdirSync(freshDir, { recursive: true });
      const freshManifest = join(freshDir, 'plugins.json');
      writeFileSync(
        freshManifest,
        JSON.stringify({ version: 1, plugins: [], tools: [] }),
      );
      writeFileSync(
        join(home, 'config', 'app.json'),
        JSON.stringify({ registryUrl: freshManifest }, null, 2),
      );
      process.env.STATION_HOME = home;
      const { showOrSaveRegistry } = await import(
        '../commands/install-registry.js'
      );
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      await showOrSaveRegistry();

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(`Fetching registry from ${freshManifest}`),
      );
      log.mockRestore();
    });
  });

  test.each([
    [],
    null,
    'aliases',
    { 'curated-demo': '' },
    { 'curated-demo': 1 },
    { 'curated-demo': null },
    { 'curated-demo': {} },
    { 'curated-demo': 'actual-plugin' },
    { 'curated demo': { pluginName: 'actual-plugin', registryKey: 'r' } },
    { 'curated-demo': { pluginName: 'actual/plugin', registryKey: 'r' } },
    { 'curated-demo': { pluginName: 'actual-plugin ', registryKey: 'r' } },
    { 'curated-demo': { pluginName: 'actual-plugin\u0000', registryKey: 'r' } },
    Object.fromEntries([
      ['a'.repeat(65), { pluginName: 'actual-plugin', registryKey: 'r' }],
    ]),
  ])(
    'refuses an invalid or noncanonical alias store without echoing identities or mutating it: %j',
    async (invalidAliases) => {
      const { root, home, aliasesPath } = createRegistryHome();
      writeLocalRegistry(home, root);
      const originalBytes = JSON.stringify(invalidAliases, null, 2);
      writeFileSync(aliasesPath, originalBytes);
      process.env.STATION_HOME = home;
      const { showOrSaveRegistry } = await import(
        '../commands/install-registry.js'
      );
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exit = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => undefined) as never);

      await showOrSaveRegistry();

      expect(error.mock.calls).toEqual([
        ['Registry install aliases are unavailable'],
      ]);
      expect(exit).toHaveBeenCalledWith(1);
      const output = log.mock.calls.flat().join('\n');
      expect(output).not.toContain('Available Plugins');
      expect(output).not.toContain('curated demo');
      expect(output).not.toContain('actual/plugin');
      expect(readFileSync(aliasesPath, 'utf-8')).toBe(originalBytes);
      log.mockRestore();
      error.mockRestore();
      exit.mockRestore();
    },
  );

  test('browses a local manifest and marks a curated registry id as installed via alias mapping', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-registry-cli-'));
    cleanupDirs.push(root);
    const projectHome = join(root, 'home');
    const registryDir = join(root, 'registry');
    const installedPluginDir = join(projectHome, 'plugins', 'actual-plugin');
    mkdirSync(projectHome, { recursive: true });
    writeFileSync(
      join(projectHome, '.station-home-schema.json'),
      JSON.stringify({ version: STATION_HOME_SCHEMA_VERSION }),
    );
    mkdirSync(registryDir, { recursive: true });
    mkdirSync(installedPluginDir, { recursive: true });

    const manifestPath = join(registryDir, 'plugins.json');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          plugins: [
            {
              id: 'curated-demo',
              displayName: 'Curated Demo',
              version: '1.0.0',
              description: 'Registry entry',
              source: '../plugins/actual-plugin',
            },
          ],
          tools: [],
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(projectHome, 'config.json'),
      JSON.stringify({ registryUrl: manifestPath }, null, 2),
    );
    writeFileSync(
      join(installedPluginDir, 'plugin.json'),
      JSON.stringify({ name: 'actual-plugin', version: '1.0.0' }, null, 2),
    );

    process.env.STATION_HOME = projectHome;
    mkdirSync(join(projectHome, 'config'), { recursive: true });
    // The shape the server's registry install writes
    // (src-server/providers/registries/registry-install-aliases.ts).
    writeFileSync(
      join(projectHome, 'config', 'registry-installs.json'),
      JSON.stringify(
        {
          'curated-demo': {
            pluginName: 'actual-plugin',
            registryKey: manifestPath,
          },
        },
        null,
        2,
      ),
    );
    const { showOrSaveRegistry } = await import(
      '../commands/install-registry.js'
    );

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await showOrSaveRegistry();

    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('Curated Demo (curated-demo@1.0.0) [installed]');

    log.mockRestore();
  });

  test.each<[label: string, plugins: unknown[], message: string]>([
    [
      'a plugin entry without a source',
      [{ id: 'missing-source' }],
      'Malformed registry manifest: plugins[0].source must be a string',
    ],
    ...[
      'curated demo',
      'curated/demo',
      'curated\\demo',
      'Curated-demo',
      'curated_demo',
      'a'.repeat(65),
    ].map((invalidId): [string, unknown[], string] => [
      `noncanonical id ${JSON.stringify(invalidId)}`,
      [{ id: invalidId, source: '../plugins/actual-plugin' }],
      'Malformed registry manifest: plugins[0].id must be a canonical plugin identifier',
    ]),
    [
      'duplicate plugin ids',
      [
        { id: 'demo-layout', source: './demo-layout-a' },
        { id: 'demo-layout', source: './demo-layout-b' },
      ],
      'Duplicate registry plugin id: demo-layout',
    ],
  ])(
    'refuses to list a malformed registry manifest: %s',
    async (_label, plugins, message) => {
      const { root, home } = createRegistryHome();
      const registryDir = join(root, 'registry');
      mkdirSync(registryDir, { recursive: true });
      const manifestPath = join(registryDir, 'plugins.json');
      writeFileSync(manifestPath, JSON.stringify({ version: 1, plugins }));
      writeFileSync(
        join(home, 'config.json'),
        JSON.stringify({ registryUrl: manifestPath }),
      );
      process.env.STATION_HOME = home;
      const { showOrSaveRegistry } = await import(
        '../commands/install-registry.js'
      );
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exit = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => undefined) as never);

      await showOrSaveRegistry();

      expect(error.mock.calls).toEqual([[message]]);
      expect(exit).toHaveBeenCalledWith(1);
      expect(log.mock.calls.flat().join('\n')).not.toContain(
        'Available Plugins',
      );
      log.mockRestore();
      error.mockRestore();
      exit.mockRestore();
    },
  );
});

describe('resolveRegistryUrl', () => {
  test('expands owner/repo shorthand to a raw GitHub manifest URL', async () => {
    const { resolveRegistryUrl } = await import(
      '../commands/install-registry.js'
    );
    expect(resolveRegistryUrl('acme/registry')).toBe(
      'https://raw.githubusercontent.com/acme/registry/main/registry.json',
    );
    expect(resolveRegistryUrl('acme/registry@next')).toBe(
      'https://raw.githubusercontent.com/acme/registry/next/registry.json',
    );
  });

  test('expands github.com URLs, honoring an optional /tree/<branch>', async () => {
    const { resolveRegistryUrl } = await import(
      '../commands/install-registry.js'
    );
    expect(resolveRegistryUrl('https://github.com/acme/registry')).toBe(
      'https://raw.githubusercontent.com/acme/registry/main/registry.json',
    );
    expect(
      resolveRegistryUrl('https://github.com/acme/registry/tree/dev'),
    ).toBe('https://raw.githubusercontent.com/acme/registry/dev/registry.json');
  });

  test('passes direct manifest URLs and local paths through unchanged', async () => {
    const { resolveRegistryUrl } = await import(
      '../commands/install-registry.js'
    );
    expect(resolveRegistryUrl('https://example.com/registry.json')).toBe(
      'https://example.com/registry.json',
    );
    expect(resolveRegistryUrl('./registry/manifest.json')).toBe(
      './registry/manifest.json',
    );
    expect(resolveRegistryUrl('/abs/registry.json')).toBe('/abs/registry.json');
  });
});
