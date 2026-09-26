import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { STATION_HOME_SCHEMA_VERSION } from '@kontourai/station-shared/station-home-schema';
import { afterEach, describe, expect, test, vi } from 'vitest';

const cleanupDirs: string[] = [];

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

describe('registry manifest fixture CLI proof', () => {
  // The docs point users at `station registry ./examples/registry/manifest.json`;
  // the CLI's own manifest validation must accept the checked-in fixture.
  // Source resolution of every entry is proven server-side
  // (json-manifest-registry.test.ts), which owns registry installs.
  test('lists every entry of the checked-in registry fixture', async () => {
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
    const { showOrSaveRegistry } = await import(
      '../commands/install-registry.js'
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    await showOrSaveRegistry();

    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    const output = log.mock.calls.flat().join('\n');
    const fixture = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      plugins: Array<{ id: string }>;
    };
    expect(fixture.plugins.length).toBeGreaterThan(0);
    for (const { id } of fixture.plugins) {
      expect(output).toContain(`(${id}@`);
    }
  });
});
