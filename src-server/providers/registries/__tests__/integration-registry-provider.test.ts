import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createIntegrationRegistryProvider,
  mergeRegistryItems,
  readDiskIntegrations,
} from '../integration-registry-provider.js';

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
      { id: 'provider-tool', displayName: 'Provider Tool' },
    ]);
  });
});
