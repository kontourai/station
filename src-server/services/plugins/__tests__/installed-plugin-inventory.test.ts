import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  describePluginManifestRejection,
  rejectedInstalledPluginRecord,
  scanInstalledPluginInventory,
} from '../installed-plugin-inventory.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function home() {
  const root = mkdtempSync(join(tmpdir(), 'station-rejected-plugins-'));
  cleanup.push(root);
  return root;
}

function plugin(root: string, name: string, manifest?: unknown) {
  const directory = join(root, 'plugins', name);
  mkdirSync(directory, { recursive: true });
  if (manifest !== undefined) {
    writeFileSync(
      join(directory, 'plugin.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
    );
  }
}

describe('installed plugin inventory', () => {
  test('classifies coded read failures before the plugin.json path text', () => {
    const error = Object.assign(
      new Error(
        "EACCES: permission denied, open '/private/home/plugins/example/plugin.json'",
      ),
      { code: 'EACCES' },
    );

    expect(describePluginManifestRejection(error)).toEqual({
      code: 'manifest-unreadable',
      reason:
        'plugin.json exists but could not be read as a regular manifest file.',
      recovery: {
        kind: 'restore-manifest',
        instruction:
          'Restore readable plugin.json permissions or replace the file, then choose Reload plugins.',
      },
    });
  });

  test('keeps valid and rejected directories in one deterministic fresh scan', () => {
    const root = home();
    plugin(root, 'valid-plugin', {
      name: 'valid-plugin',
      version: '1.0.0',
      displayName: 'Valid Plugin',
    });
    plugin(root, 'Legacy_Plugin', {
      name: 'Legacy_Plugin',
      version: '1.0.0',
    });
    plugin(root, 'missing-manifest');
    const warn = vi.fn();

    const inventory = scanInstalledPluginInventory(join(root, 'plugins'), {
      warn,
    });

    expect(inventory.map((entry) => entry.directoryName)).toEqual([
      'Legacy_Plugin',
      'missing-manifest',
      'valid-plugin',
    ]);
    expect(inventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: 'rejected',
          directoryName: 'Legacy_Plugin',
          rejection: expect.objectContaining({
            code: 'invalid-plugin-name',
            reason: expect.stringMatching(/not a canonical plugin id/),
          }),
        }),
        expect.objectContaining({
          state: 'rejected',
          directoryName: 'missing-manifest',
          rejection: expect.objectContaining({ code: 'manifest-missing' }),
        }),
        expect.objectContaining({
          state: 'valid',
          directoryName: 'valid-plugin',
          manifest: expect.objectContaining({ name: 'valid-plugin' }),
        }),
      ]),
    );
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test('does not disclose malformed JSON content or a filesystem path', () => {
    const root = home();
    plugin(
      root,
      'broken-json',
      '{"name":"broken-json","token":"must-not-appear",',
    );

    const [entry] = scanInstalledPluginInventory(join(root, 'plugins'));
    expect(entry).toMatchObject({
      state: 'rejected',
      rejection: {
        code: 'malformed-json',
        reason: 'plugin.json contains malformed JSON.',
      },
    });
    expect(JSON.stringify(entry)).not.toContain('must-not-appear');
    expect(JSON.stringify(entry)).not.toContain(root);
  });

  test('recovers from current directory truth without a rejection store', () => {
    const root = home();
    plugin(root, 'repairable', '{');
    const pluginsDir = join(root, 'plugins');
    expect(scanInstalledPluginInventory(pluginsDir)[0]?.state).toBe('rejected');

    writeFileSync(
      join(pluginsDir, 'repairable', 'plugin.json'),
      JSON.stringify({ name: 'repairable', version: '2.0.0' }),
    );
    expect(scanInstalledPluginInventory(pluginsDir)).toEqual([
      expect.objectContaining({
        state: 'valid',
        directoryName: 'repairable',
        manifest: expect.objectContaining({ version: '2.0.0' }),
      }),
    ]);
  });

  test('projects only bounded recovery data to the collection row', () => {
    const row = rejectedInstalledPluginRecord({
      state: 'rejected',
      directoryName: 'broken-plugin',
      rejection: {
        code: 'missing-version',
        reason: 'Plugin manifest version must be a non-empty string',
        recovery: {
          kind: 'repair-manifest',
          instruction: 'Add a version, then choose Reload plugins.',
        },
      },
    });
    expect(row).toEqual({
      status: 'rejected',
      name: 'broken-plugin',
      displayName: 'broken-plugin',
      rejection: expect.objectContaining({ code: 'missing-version' }),
    });
    expect(row).not.toHaveProperty('version');
    expect(row).not.toHaveProperty('manifestPath');
  });
});
