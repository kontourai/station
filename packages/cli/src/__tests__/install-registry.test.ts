import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  vi.doUnmock('node:fs');
  vi.doUnmock('@kontourai/station-shared/lifecycle-events');
  vi.resetModules();
  delete process.env.STATION_HOME;
  await Promise.all(
    cleanupDirs
      .splice(0, cleanupDirs.length)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('install-registry helpers', () => {
  test('refuses a corrupt alias store from record and preserves its bytes', async () => {
    const { home, aliasesPath } = createRegistryHome();
    const corruptBytes = '{ not json';
    writeFileSync(aliasesPath, corruptBytes);
    process.env.STATION_HOME = home;
    const { recordRegistryInstall } = await import(
      '../commands/install-registry.js'
    );

    expect(() =>
      recordRegistryInstall('curated-demo', 'actual-plugin'),
    ).toThrow('Registry install aliases are unavailable');
    expect(readFileSync(aliasesPath, 'utf-8')).toBe(corruptBytes);
  });

  test('refuses a corrupt alias store during registry source preflight', async () => {
    const { root, home, aliasesPath } = createRegistryHome();
    writeLocalRegistry(home, root);
    writeFileSync(aliasesPath, '{ not json');
    process.env.STATION_HOME = home;
    const { resolveRegistryPluginSource } = await import(
      '../commands/install-registry.js'
    );

    await expect(resolveRegistryPluginSource('curated-demo')).rejects.toThrow(
      'Registry install aliases are unavailable',
    );
  });

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
    test('a value written to config/app.json (what `station config set registryUrl` writes) is honored by `station registry`', async () => {
      const { root, home } = createRegistryHome();
      const registryDir = join(root, 'registry');
      const pluginDir = join(root, 'plugins', 'actual-plugin');
      mkdirSync(registryDir, { recursive: true });
      mkdirSync(pluginDir, { recursive: true });
      const manifestPath = join(registryDir, 'plugins.json');
      writeFileSync(
        manifestPath,
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
      // Simulates `station config set registryUrl <manifestPath>`, which
      // writes `config/app.json`, not the legacy `config.json`.
      writeFileSync(
        join(home, 'config', 'app.json'),
        JSON.stringify({ registryUrl: manifestPath }, null, 2),
      );
      process.env.STATION_HOME = home;
      const { resolveRegistryPluginSource } = await import(
        '../commands/install-registry.js'
      );

      await expect(resolveRegistryPluginSource('curated-demo')).resolves.toBe(
        pluginDir,
      );
    });

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
      const { resolveRegistryPluginSource } = await import(
        '../commands/install-registry.js'
      );

      await expect(resolveRegistryPluginSource('curated-demo')).resolves.toBe(
        join(root, 'plugins', 'actual-plugin'),
      );

      const migratedUrl = JSON.parse(
        readFileSync(join(home, 'config', 'app.json'), 'utf-8'),
      ).registryUrl;
      const legacyUrl = JSON.parse(
        readFileSync(join(home, 'config.json'), 'utf-8'),
      ).registryUrl;
      expect(migratedUrl).toBe(legacyUrl);
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
  ])('refuses an invalid alias-store shape: %j', async (invalidAliases) => {
    const { home, aliasesPath } = createRegistryHome();
    writeFileSync(aliasesPath, JSON.stringify(invalidAliases));
    process.env.STATION_HOME = home;
    const { recordRegistryInstall } = await import(
      '../commands/install-registry.js'
    );

    expect(() =>
      recordRegistryInstall('curated-demo', 'actual-plugin'),
    ).toThrow('Registry install aliases are unavailable');
  });

  test.each([
    { 'curated demo': 'actual-plugin' },
    { 'curated-demo': 'actual/plugin' },
    { 'curated-demo': 'actual-plugin ' },
    { 'curated-demo': 'actual-plugin\u0000' },
    Object.fromEntries([['a'.repeat(65), 'actual-plugin']]),
  ])(
    'refuses noncanonical persisted aliases without echoing identities or mutating them: %j',
    async (invalidAliases) => {
      const { home, aliasesPath } = createRegistryHome();
      const originalBytes = JSON.stringify(invalidAliases, null, 2);
      writeFileSync(aliasesPath, originalBytes);
      process.env.STATION_HOME = home;
      const { recordRegistryInstall } = await import(
        '../commands/install-registry.js'
      );

      let thrown: unknown;
      try {
        recordRegistryInstall('curated-new', 'plugin-new');
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({
        message: 'Registry install aliases are unavailable',
      });
      expect((thrown as Error).message).not.toContain('curated demo');
      expect((thrown as Error).message).not.toContain('actual/plugin');
      expect(readFileSync(aliasesPath, 'utf-8')).toBe(originalBytes);
    },
  );

  test.each([
    '',
    'curated demo',
    'curated\tdemo',
    '../curated-demo',
    'curated/demo',
    'curated\\demo',
    'Curated-demo',
    'curated_demo',
    '-curated-demo',
    'a'.repeat(65),
  ])('rejects noncanonical alias inputs: %j', async (invalidIdentity) => {
    const { home, aliasesPath } = createRegistryHome();
    process.env.STATION_HOME = home;
    const { recordRegistryInstall } = await import(
      '../commands/install-registry.js'
    );

    expect(() =>
      recordRegistryInstall(invalidIdentity, 'actual-plugin'),
    ).toThrow('Registry install requires a canonical registry plugin id');
    expect(() =>
      recordRegistryInstall('curated-demo', invalidIdentity),
    ).toThrow('Registry install requires a canonical installed plugin name');
    expect(existsSync(aliasesPath)).toBe(false);
  });

  test('accepts the canonical registry identity boundary', async () => {
    const { home, aliasesPath } = createRegistryHome();
    process.env.STATION_HOME = home;
    const { recordRegistryInstall } = await import(
      '../commands/install-registry.js'
    );
    const boundaryId = `a${'b'.repeat(63)}`;

    recordRegistryInstall(boundaryId, 'actual-plugin');

    expect(JSON.parse(readFileSync(aliasesPath, 'utf-8'))).toEqual({
      [boundaryId]: 'actual-plugin',
    });

    recordRegistryInstall('acme.tools', 'actual-plugin.tools');
    expect(JSON.parse(readFileSync(aliasesPath, 'utf-8'))).toMatchObject({
      'acme.tools': 'actual-plugin.tools',
    });
  });

  test('serializes a fresh alias read so concurrently begun distinct installs both survive', async () => {
    const { home, aliasesPath } = createRegistryHome();
    process.env.STATION_HOME = home;
    let secondStarted = false;
    let recordSecond: (() => void) | undefined;
    vi.doMock(
      '@kontourai/station-shared/lifecycle-events',
      async (importOriginal) => {
        const actual =
          await importOriginal<
            typeof import('@kontourai/station-shared/lifecycle-events')
          >();
        return {
          ...actual,
          acquireFileMutationLock: (lockPath: string) => {
            if (
              lockPath === `${aliasesPath}.mutation` &&
              !secondStarted &&
              recordSecond
            ) {
              secondStarted = true;
              recordSecond();
            }
            return () => {};
          },
        };
      },
    );
    const { recordRegistryInstall } = await import(
      '../commands/install-registry.js'
    );
    recordSecond = () => recordRegistryInstall('curated-second', 'plugin-two');

    recordRegistryInstall('curated-first', 'plugin-one');

    expect(JSON.parse(readFileSync(aliasesPath, 'utf-8'))).toEqual({
      'curated-second': 'plugin-two',
      'curated-first': 'plugin-one',
    });
  });

  test('fails before creating an alias file when the mutation lock cannot be acquired', async () => {
    const { home, aliasesPath } = createRegistryHome();
    process.env.STATION_HOME = home;
    vi.doMock(
      '@kontourai/station-shared/lifecycle-events',
      async (importOriginal) => {
        const actual =
          await importOriginal<
            typeof import('@kontourai/station-shared/lifecycle-events')
          >();
        return {
          ...actual,
          acquireFileMutationLock: (lockPath: string) => {
            if (lockPath === `${aliasesPath}.mutation`) {
              throw new Error('registry alias mutation lock is held');
            }
            return actual.acquireFileMutationLock(lockPath);
          },
        };
      },
    );
    const { recordRegistryInstall } = await import(
      '../commands/install-registry.js'
    );

    expect(() =>
      recordRegistryInstall('curated-demo', 'actual-plugin'),
    ).toThrow('registry alias mutation lock is held');
    expect(existsSync(aliasesPath)).toBe(false);
  });

  test('cleans the mutation lock and temporary file when rename fails', async () => {
    const { home, aliasesPath } = createRegistryHome();
    writeFileSync(
      aliasesPath,
      JSON.stringify({ 'curated-existing': 'plugin-existing' }),
    );
    process.env.STATION_HOME = home;
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        renameSync: (...args: Parameters<typeof actual.renameSync>) => {
          if (String(args[0]).startsWith(`${aliasesPath}.${process.pid}.`)) {
            throw new Error('simulated alias rename failure');
          }
          return actual.renameSync(...args);
        },
      };
    });
    const { recordRegistryInstall } = await import(
      '../commands/install-registry.js'
    );

    expect(() => recordRegistryInstall('curated-new', 'plugin-new')).toThrow(
      'simulated alias rename failure',
    );
    expect(JSON.parse(readFileSync(aliasesPath, 'utf-8'))).toEqual({
      'curated-existing': 'plugin-existing',
    });
    expect(existsSync(`${aliasesPath}.mutation`)).toBe(false);
    expect(
      readdirSync(join(home, 'config')).filter((name) => name.includes('.tmp')),
    ).toEqual([]);
  });

  test('retains a primary write failure while independently attempting close and temporary cleanup', async () => {
    const { home, aliasesPath } = createRegistryHome();
    writeFileSync(
      aliasesPath,
      JSON.stringify({ 'curated-existing': 'plugin-existing' }),
    );
    process.env.STATION_HOME = home;
    let temporaryDescriptor: number | undefined;
    let closeAttempts = 0;
    let removeAttempts = 0;
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        openSync: (...args: Parameters<typeof actual.openSync>) => {
          const descriptor = actual.openSync(...args);
          if (String(args[0]).startsWith(`${aliasesPath}.${process.pid}.`)) {
            temporaryDescriptor = descriptor;
          }
          return descriptor;
        },
        writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
          if (args[0] === temporaryDescriptor) {
            throw new Error('primary alias write failure');
          }
          return actual.writeFileSync(...args);
        },
        closeSync: (...args: Parameters<typeof actual.closeSync>) => {
          if (args[0] === temporaryDescriptor) {
            closeAttempts += 1;
            actual.closeSync(...args);
            throw new Error('cleanup close failure');
          }
          return actual.closeSync(...args);
        },
        rmSync: (...args: Parameters<typeof actual.rmSync>) => {
          if (String(args[0]).startsWith(`${aliasesPath}.${process.pid}.`)) {
            removeAttempts += 1;
            throw new Error('cleanup remove failure');
          }
          return actual.rmSync(...args);
        },
      };
    });
    const { recordRegistryInstall } = await import(
      '../commands/install-registry.js'
    );

    expect(() => recordRegistryInstall('curated-new', 'plugin-new')).toThrow(
      'primary alias write failure',
    );
    expect(closeAttempts).toBe(1);
    expect(removeAttempts).toBe(1);
    expect(JSON.parse(readFileSync(aliasesPath, 'utf-8'))).toEqual({
      'curated-existing': 'plugin-existing',
    });
  });

  test('fails with a stable persistence diagnostic when cleanup fails after a write', async () => {
    const { home, aliasesPath } = createRegistryHome();
    process.env.STATION_HOME = home;
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        rmSync: (...args: Parameters<typeof actual.rmSync>) => {
          if (String(args[0]).startsWith(`${aliasesPath}.${process.pid}.`)) {
            throw new Error('cleanup remove failure');
          }
          return actual.rmSync(...args);
        },
      };
    });
    const { recordRegistryInstall } = await import(
      '../commands/install-registry.js'
    );

    expect(() => recordRegistryInstall('curated-new', 'plugin-new')).toThrow(
      'Registry install aliases could not be persisted',
    );
    expect(JSON.parse(readFileSync(aliasesPath, 'utf-8'))).toEqual({
      'curated-new': 'plugin-new',
    });
  });

  test('resolves relative local plugin sources against a local manifest path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-registry-cli-'));
    cleanupDirs.push(root);
    const projectHome = join(root, 'home');
    const registryDir = join(root, 'registry');
    const pluginDir = join(root, 'plugins', 'demo-layout');
    mkdirSync(projectHome, { recursive: true });
    writeFileSync(
      join(projectHome, '.station-home-schema.json'),
      JSON.stringify({ version: STATION_HOME_SCHEMA_VERSION }),
    );
    mkdirSync(registryDir, { recursive: true });
    mkdirSync(pluginDir, { recursive: true });

    const manifestPath = join(registryDir, 'plugins.json');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          plugins: [
            {
              id: 'demo-layout',
              source: '../plugins/demo-layout',
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

    process.env.STATION_HOME = projectHome;
    const { resolveRegistryPluginSource } = await import(
      '../commands/install-registry.js'
    );

    await expect(resolveRegistryPluginSource('demo-layout')).resolves.toBe(
      pluginDir,
    );
  });

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
    const { recordRegistryInstall, showOrSaveRegistry } = await import(
      '../commands/install-registry.js'
    );
    recordRegistryInstall('curated-demo', 'actual-plugin');

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await showOrSaveRegistry();

    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('Curated Demo (curated-demo@1.0.0) [installed]');
    expect(
      JSON.parse(
        readFileSync(
          join(projectHome, 'config', 'registry-installs.json'),
          'utf-8',
        ),
      ),
    ).toEqual({ 'curated-demo': 'actual-plugin' });

    log.mockRestore();
  });

  test('rejects registry plugin sources with disallowed protocols', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-registry-cli-'));
    cleanupDirs.push(root);
    const projectHome = join(root, 'home');
    const registryDir = join(root, 'registry');
    mkdirSync(projectHome, { recursive: true });
    writeFileSync(
      join(projectHome, '.station-home-schema.json'),
      JSON.stringify({ version: STATION_HOME_SCHEMA_VERSION }),
    );
    mkdirSync(registryDir, { recursive: true });

    const manifestPath = join(registryDir, 'plugins.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: 'unsafe', source: 'file:///tmp/unsafe' }],
        tools: [],
      }),
    );
    writeFileSync(
      join(projectHome, 'config.json'),
      JSON.stringify({ registryUrl: manifestPath }, null, 2),
    );

    process.env.STATION_HOME = projectHome;
    const { resolveRegistryPluginSource } = await import(
      '../commands/install-registry.js'
    );

    await expect(resolveRegistryPluginSource('unsafe')).rejects.toThrow(
      /Unsupported plugin source protocol/,
    );
  });

  test('rejects local registry sources that escape the registry root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-registry-cli-'));
    cleanupDirs.push(root);
    const projectHome = join(root, 'home');
    const registryDir = join(root, 'registry');
    mkdirSync(projectHome, { recursive: true });
    writeFileSync(
      join(projectHome, '.station-home-schema.json'),
      JSON.stringify({ version: STATION_HOME_SCHEMA_VERSION }),
    );
    mkdirSync(registryDir, { recursive: true });

    const manifestPath = join(registryDir, 'plugins.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: 'escape', source: '../../outside-plugin' }],
        tools: [],
      }),
    );
    writeFileSync(
      join(projectHome, 'config.json'),
      JSON.stringify({ registryUrl: manifestPath }, null, 2),
    );

    process.env.STATION_HOME = projectHome;
    const { resolveRegistryPluginSource } = await import(
      '../commands/install-registry.js'
    );

    await expect(resolveRegistryPluginSource('escape')).rejects.toThrow(
      /escapes the registry root/,
    );
  });

  test('rejects malformed registry manifests before resolving plugin sources', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-registry-cli-'));
    cleanupDirs.push(root);
    const projectHome = join(root, 'home');
    const registryDir = join(root, 'registry');
    mkdirSync(projectHome, { recursive: true });
    writeFileSync(
      join(projectHome, '.station-home-schema.json'),
      JSON.stringify({ version: STATION_HOME_SCHEMA_VERSION }),
    );
    mkdirSync(registryDir, { recursive: true });

    const manifestPath = join(registryDir, 'plugins.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({ version: 1, plugins: [{ id: 'missing-source' }] }),
    );
    writeFileSync(
      join(projectHome, 'config.json'),
      JSON.stringify({ registryUrl: manifestPath }, null, 2),
    );

    process.env.STATION_HOME = projectHome;
    const { resolveRegistryPluginSource } = await import(
      '../commands/install-registry.js'
    );

    await expect(resolveRegistryPluginSource('missing-source')).rejects.toThrow(
      /Malformed registry manifest/,
    );
  });

  test.each([
    'curated demo',
    'curated/demo',
    'curated\\demo',
    'Curated-demo',
    'curated_demo',
    'a'.repeat(65),
  ])('rejects noncanonical registry manifest ids: %j', async (invalidId) => {
    const { root, home } = createRegistryHome();
    const registryDir = join(root, 'registry');
    mkdirSync(registryDir, { recursive: true });
    const manifestPath = join(registryDir, 'plugins.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        plugins: [{ id: invalidId, source: '../plugins/actual-plugin' }],
      }),
    );
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ registryUrl: manifestPath }),
    );
    process.env.STATION_HOME = home;
    const { resolveRegistryPluginSource } = await import(
      '../commands/install-registry.js'
    );

    await expect(resolveRegistryPluginSource('curated-demo')).rejects.toThrow(
      'Malformed registry manifest: plugins[0].id must be a canonical plugin identifier',
    );
  });

  test('rejects a local plugin manifest name outside the registry identity contract', async () => {
    const { root, home } = createRegistryHome();
    writeLocalRegistry(home, root);
    writeFileSync(
      join(root, 'plugins', 'actual-plugin', 'plugin.json'),
      JSON.stringify({ name: 'actual/plugin', version: '1.0.0' }),
    );
    process.env.STATION_HOME = home;
    const { resolveRegistryPluginSource } = await import(
      '../commands/install-registry.js'
    );

    await expect(resolveRegistryPluginSource('curated-demo')).rejects.toThrow(
      'Installed plugin manifest has an invalid plugin name',
    );
  });

  test('rejects duplicate plugin ids in registry manifests', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-registry-cli-'));
    cleanupDirs.push(root);
    const projectHome = join(root, 'home');
    const registryDir = join(root, 'registry');
    mkdirSync(projectHome, { recursive: true });
    writeFileSync(
      join(projectHome, '.station-home-schema.json'),
      JSON.stringify({ version: STATION_HOME_SCHEMA_VERSION }),
    );
    mkdirSync(registryDir, { recursive: true });

    const manifestPath = join(registryDir, 'plugins.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: 'demo-layout', source: './demo-layout-a' },
          { id: 'demo-layout', source: './demo-layout-b' },
        ],
        tools: [],
      }),
    );
    writeFileSync(
      join(projectHome, 'config.json'),
      JSON.stringify({ registryUrl: manifestPath }, null, 2),
    );

    process.env.STATION_HOME = projectHome;
    const { resolveRegistryPluginSource } = await import(
      '../commands/install-registry.js'
    );

    await expect(resolveRegistryPluginSource('demo-layout')).rejects.toThrow(
      /Duplicate registry plugin id/,
    );
  });

  test('rejects registry alias collisions instead of rewriting installed-state semantics', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-registry-cli-'));
    cleanupDirs.push(root);
    const projectHome = join(root, 'home');
    mkdirSync(join(projectHome, 'config'), { recursive: true });
    writeFileSync(
      join(projectHome, '.station-home-schema.json'),
      JSON.stringify({ version: STATION_HOME_SCHEMA_VERSION }),
    );
    writeFileSync(
      join(projectHome, 'config', 'registry-installs.json'),
      JSON.stringify({ 'curated-a': 'actual-plugin' }, null, 2),
    );

    process.env.STATION_HOME = projectHome;
    const { recordRegistryInstall } = await import(
      '../commands/install-registry.js'
    );

    expect(() => recordRegistryInstall('curated-b', 'actual-plugin')).toThrow(
      /already linked to registry item/,
    );
  });
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
