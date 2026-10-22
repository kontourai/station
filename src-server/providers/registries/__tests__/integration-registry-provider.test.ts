import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { IIntegrationRegistryProvider } from '../../provider-interfaces.js';
import {
  createIntegrationRegistryProvider,
  mergeRegistryItems,
  readDiskIntegrations,
} from '../integration-registry-provider.js';

const synchronousReads = vi.hoisted(() => [] as string[]);
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => {
      synchronousReads.push(String(path));
      return actual.existsSync(path);
    },
  };
});

const lookups = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      lookups.count++;
      return actual.execFileSync(...args);
    },
    execFile: (...args: Parameters<typeof actual.execFile>) => {
      lookups.count++;
      return actual.execFile(...args);
    },
  };
});

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs
      .splice(0, cleanupDirs.length)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function createHomeDir() {
  const root = mkdtempSync(join(tmpdir(), 'station-integration-registry-'));
  cleanupDirs.push(root);
  return root;
}

describe('integration-registry-provider helpers', () => {
  test('mergeRegistryItems prefers disk items when ids overlap', () => {
    expect(
      mergeRegistryItems(
        [{ id: 'tool-1', displayName: 'Disk Tool' } as any],
        [
          { id: 'tool-1', displayName: 'Provider Tool' } as any,
          { id: 'tool-2', displayName: 'Other Tool' } as any,
        ],
      ),
    ).toEqual([
      { id: 'tool-1', displayName: 'Disk Tool' },
      { id: 'tool-2', displayName: 'Other Tool' },
    ]);
  });

  test('readDiskIntegrations returns installed items from the integrations directory', async () => {
    const homeDir = createHomeDir();
    const integrationDir = join(homeDir, 'integrations', 'demo-tool');
    mkdirSync(integrationDir, { recursive: true });
    writeFileSync(
      join(integrationDir, 'integration.json'),
      JSON.stringify({
        id: 'demo-tool',
        displayName: 'Demo Tool',
        description: 'Demo',
      }),
    );

    const items = await readDiskIntegrations(homeDir);
    expect(items).toEqual([
      {
        id: 'demo-tool',
        displayName: 'Demo Tool',
        description: 'Demo',
        installed: true,
        status: 'missing binary',
      },
    ]);
  });

  test('catalog listings coalesce lookups and refresh on PATH changes and TTL while definitions stay fresh', async () => {
    const homeDir = createHomeDir();
    const dir = join(homeDir, 'integrations', 'cached-command');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'integration.json');
    writeFileSync(
      path,
      JSON.stringify({
        id: 'cached-command',
        command: 'node',
        displayName: 'Before',
      }),
    );
    const originalPath = process.env.PATH;
    const clock = vi.spyOn(Date, 'now');
    try {
      process.env.PATH = `${originalPath}${process.platform === 'win32' ? ';' : ':'}${homeDir}`;
      const registry = createIntegrationRegistryProvider([], homeDir);
      const before = lookups.count;
      const pages = await Promise.all([
        registry.listAvailable(),
        registry.listInstalled(),
      ]);
      expect(synchronousReads.filter((path) => path === dir)).toEqual([]);
      expect(pages[0][0].status).toBe('connected');
      expect(lookups.count - before).toBe(1);
      writeFileSync(
        path,
        JSON.stringify({
          id: 'cached-command',
          command: 'node',
          displayName: 'After',
        }),
      );
      expect((await registry.listAvailable())[0].displayName).toBe('After');
      expect(lookups.count - before).toBe(1);
      clock.mockReturnValue(Date.now() + 30_001);
      await registry.listAvailable();
      expect(lookups.count - before).toBe(2);
      process.env.PATH = '';
      expect((await registry.listAvailable())[0].status).toBe('missing binary');
      expect(lookups.count - before).toBe(3);
    } finally {
      clock.mockRestore();
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  test('station#3063: built-in integrations list as connected from their stripped, command-less files', async () => {
    // Post-#3063 the persisted built-in files carry NO command/args — the
    // spawn identity is overlaid at load time. The registry's disk scan must
    // derive binary presence from the same spawn command the overlay uses
    // (`node`, which necessarily exists wherever this suite runs), not
    // conclude 'missing binary' from the stripped file.
    const homeDir = createHomeDir();
    for (const id of ['station-control', 'station-docs']) {
      const dir = join(homeDir, 'integrations', id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'integration.json'),
        JSON.stringify({
          id,
          displayName: id,
          kind: 'mcp',
          transport: 'stdio',
        }),
      );
    }

    const items = await readDiskIntegrations(homeDir);
    expect(items.find((item) => item.id === 'station-control')?.status).toBe(
      'connected',
    );
    expect(items.find((item) => item.id === 'station-docs')?.status).toBe(
      'connected',
    );
  });

  test('station#3063: a third-party integration without a command still reports missing binary', async () => {
    const homeDir = createHomeDir();
    const dir = join(homeDir, 'integrations', 'command-less-tool');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'integration.json'),
      JSON.stringify({ id: 'command-less-tool', displayName: 'No Command' }),
    );

    const items = await readDiskIntegrations(homeDir);
    expect(items[0].status).toBe('missing binary');
  });

  test('readDiskIntegrations passes through a manifest-declared icon (issue #691)', async () => {
    const homeDir = createHomeDir();
    const integrationDir = join(homeDir, 'integrations', 'iconed-tool');
    mkdirSync(integrationDir, { recursive: true });
    writeFileSync(
      join(integrationDir, 'integration.json'),
      JSON.stringify({
        id: 'iconed-tool',
        displayName: 'Iconed Tool',
        icon: '📋',
      }),
    );

    const items = await readDiskIntegrations(homeDir);
    expect(items).toEqual([
      {
        id: 'iconed-tool',
        displayName: 'Iconed Tool',
        description: '',
        icon: '📋',
        installed: true,
        status: 'missing binary',
      },
    ]);
  });

  test('readDiskIntegrations omits icon when absent from the manifest', async () => {
    const homeDir = createHomeDir();
    const integrationDir = join(homeDir, 'integrations', 'demo-tool');
    mkdirSync(integrationDir, { recursive: true });
    writeFileSync(
      join(integrationDir, 'integration.json'),
      JSON.stringify({ id: 'demo-tool', displayName: 'Demo Tool' }),
    );

    const items = await readDiskIntegrations(homeDir);
    expect(items[0].icon).toBeUndefined();
  });

  test('readDiskIntegrations exposes a local URL only for valid installed raster art', async () => {
    const homeDir = createHomeDir();
    const integrationDir = join(homeDir, 'integrations', 'iconed-tool');
    mkdirSync(integrationDir, { recursive: true });
    writeFileSync(
      join(integrationDir, 'integration.json'),
      JSON.stringify({ id: 'iconed-tool', icon: 'icon.png' }),
    );
    writeFileSync(
      join(integrationDir, 'icon.png'),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    );

    await expect(readDiskIntegrations(homeDir)).resolves.toEqual([
      expect.objectContaining({
        id: 'iconed-tool',
        iconUrl: '/integrations/iconed-tool/icon',
      }),
    ]);
  });

  test('readDiskIntegrations does not shell-interpret plugin commands', async () => {
    const homeDir = createHomeDir();
    const marker = join(homeDir, 'command-injection-marker');
    const integrationDir = join(homeDir, 'integrations', 'evil-tool');
    mkdirSync(integrationDir, { recursive: true });
    writeFileSync(
      join(integrationDir, 'integration.json'),
      JSON.stringify({
        command: `node; touch ${marker}`,
        displayName: 'Evil Tool',
        id: 'evil-tool',
      }),
    );

    const items = await readDiskIntegrations(homeDir);

    expect(existsSync(marker)).toBe(false);
    expect(items).toEqual([
      {
        id: 'evil-tool',
        displayName: 'Evil Tool',
        description: '',
        installed: true,
        status: 'missing binary',
      },
    ]);
  });

  test('createIntegrationRegistryProvider merges disk and provider items', async () => {
    const homeDir = createHomeDir();
    const integrationDir = join(homeDir, 'integrations', 'demo-tool');
    mkdirSync(integrationDir, { recursive: true });
    writeFileSync(
      join(integrationDir, 'integration.json'),
      JSON.stringify({
        id: 'demo-tool',
        displayName: 'Demo Tool',
      }),
    );

    const provider = {
      listAvailable: vi
        .fn()
        .mockResolvedValue([
          { id: 'provider-tool', displayName: 'Provider Tool' },
        ]),
      listInstalled: vi.fn().mockResolvedValue([]),
      install: vi.fn().mockResolvedValue({ success: true }),
      uninstall: vi.fn().mockResolvedValue({ success: true }),
      getToolDef: vi.fn().mockResolvedValue(null),
      sync: vi.fn().mockResolvedValue(undefined),
    };

    const registry = createIntegrationRegistryProvider(
      [provider] as any,
      homeDir,
    );

    await expect(registry.listAvailable()).resolves.toEqual([
      {
        id: 'demo-tool',
        displayName: 'Demo Tool',
        description: '',
        installed: true,
        status: 'missing binary',
      },
      {
        id: 'provider-tool',
        displayName: 'Provider Tool',
        toolOrigin: {
          kind: 'registry',
          registryName: 'Registry provider',
          itemId: 'provider-tool',
        },
      },
    ]);
  });
  test('pinned installation never runs a same-ID source from a different registry', async () => {
    function provider(registryKey: string): IIntegrationRegistryProvider {
      return {
        registryKey,
        listAvailable: async () => [
          {
            id: 'reports',
            displayName: 'Reports',
            description: '',
            installed: false,
          },
        ],
        listInstalled: async () => [],
        install: vi.fn(async () => ({ success: true, message: 'Installed' })),
        uninstall: async () => ({ success: true, message: 'Installed' }),
        getToolDef: async () => ({
          id: 'reports',
          kind: 'mcp',
          transport: 'stdio',
          command: 'node',
        }),
        sync: async () => {},
      };
    }
    const other = provider('other');
    const selected = provider('selected');
    const registry = createIntegrationRegistryProvider(
      [other, selected],
      createHomeDir(),
    );
    expect(
      await registry.installWithDefinition!('reports', 'selected'),
    ).toMatchObject({
      result: { success: true, message: 'Installed' },
      origin: { registryId: 'selected' },
    });
    expect(other.install).not.toHaveBeenCalled();
    expect(selected.install).toHaveBeenCalledOnce();
    expect(
      await registry.installWithDefinition!('reports', 'removed'),
    ).toMatchObject({ result: { success: false } });
    expect(other.install).not.toHaveBeenCalled();
  });
});
