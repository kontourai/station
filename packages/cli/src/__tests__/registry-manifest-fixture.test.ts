import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { STATION_HOME_SCHEMA_VERSION } from '@kontourai/station-shared/station-home-schema';
import { afterEach, describe, expect, test, vi } from 'vitest';

const cleanupDirs: string[] = [];

afterEach(async () => {
  vi.resetModules();
  delete process.env.STATION_HOME;
  await Promise.all(
    cleanupDirs
      .splice(0, cleanupDirs.length)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('registry manifest fixture CLI proof', () => {
  test('resolves the checked-in registry fixture to real example plugin directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-registry-cli-fixture-'));
    cleanupDirs.push(root);
    const projectHome = join(root, 'home');
    mkdirSync(projectHome, { recursive: true });
    writeFileSync(
      join(projectHome, '.station-home-schema.json'),
      JSON.stringify({ version: STATION_HOME_SCHEMA_VERSION }),
    );

    const manifestPath = resolve('examples/registry/manifest.json');
    writeFileSync(
      join(projectHome, 'config.json'),
      JSON.stringify({ registryUrl: manifestPath }, null, 2),
    );

    process.env.STATION_HOME = projectHome;
    const { resolveRegistryPluginSource } = await import(
      '../commands/install-registry.js'
    );

    await expect(resolveRegistryPluginSource('demo-layout')).resolves.toBe(
      resolve('examples/demo-layout'),
    );
    expect(existsSync(resolve('examples/demo-layout/plugin.json'))).toBe(true);
  });
});
