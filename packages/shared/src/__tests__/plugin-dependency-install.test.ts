import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, test } from 'vitest';
import { buildPlugin, hostWorkspaceRootFor } from '../build.js';

describe('plugin dependency installation', () => {
  const temporaryDirectories: string[] = [];
  const originalOffline = process.env.npm_config_offline;

  afterEach(() => {
    if (originalOffline === undefined) {
      delete process.env.npm_config_offline;
    } else {
      process.env.npm_config_offline = originalOffline;
    }
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // buildPlugin performs a real offline dependency install and bundle. Keep
  // its assertions intact while giving that process work a measured budget.
  test('builds offline when a plugin declares a host-provided unpublished peer', async () => {
    const pluginDirectory = mkdtempSync(
      join(tmpdir(), 'station-plugin-host-peer-'),
    );
    temporaryDirectories.push(pluginDirectory);
    mkdirSync(join(pluginDirectory, 'src'));
    writeFileSync(
      join(pluginDirectory, 'package.json'),
      JSON.stringify({
        name: 'station-host-peer-fixture',
        version: '1.0.0',
        peerDependencies: {
          '@kontourai/station-e2e-unpublished-host-peer': '*',
        },
      }),
    );
    writeFileSync(
      join(pluginDirectory, 'plugin.json'),
      JSON.stringify({
        name: 'station-host-peer-fixture',
        version: '1.0.0',
        entrypoint: 'src/index.ts',
      }),
    );
    writeFileSync(
      join(pluginDirectory, 'src', 'index.ts'),
      'export const fixture = true;\n',
    );
    process.env.npm_config_offline = 'true';

    await expect(buildPlugin(pluginDirectory)).resolves.toMatchObject({
      built: true,
    });
    expect(existsSync(join(pluginDirectory, 'dist', 'bundle.js'))).toBe(true);
    expect(
      existsSync(
        join(
          pluginDirectory,
          'node_modules',
          '@kontourai',
          'station-e2e-unpublished-host-peer',
        ),
      ),
    ).toBe(false);
  }, 45_000);

  test('keeps an author-installed SDK across builds', async () => {
    // The scaffold declares `@kontourai/station-sdk` as a peerDependency, and
    // `npm install --legacy-peer-deps` resolves as if peerDependencies did not
    // exist — so it prunes the real copy an external author installed for
    // IntelliSense and `tsc`. Inside the monorepo the workspace symlink hid
    // that; outside it there is nothing to hide it, and every build silently
    // uninstalled the SDK. The marker below distinguishes the author's own
    // installed copy from a symlink back into this repo.
    const pluginDirectory = mkdtempSync(
      join(tmpdir(), 'station-plugin-sdk-retained-'),
    );
    temporaryDirectories.push(pluginDirectory);
    mkdirSync(join(pluginDirectory, 'src'));
    writeFileSync(
      join(pluginDirectory, 'package.json'),
      JSON.stringify({
        name: 'station-sdk-retained-fixture',
        version: '1.0.0',
        peerDependencies: { '@kontourai/station-sdk': '^0.4.0' },
      }),
    );
    writeFileSync(
      join(pluginDirectory, 'plugin.json'),
      JSON.stringify({
        name: 'station-sdk-retained-fixture',
        version: '1.0.0',
        entrypoint: 'src/index.ts',
      }),
    );
    writeFileSync(
      join(pluginDirectory, 'src', 'index.ts'),
      'export const fixture = true;\n',
    );

    const installedSdk = join(
      pluginDirectory,
      'node_modules',
      '@kontourai',
      'station-sdk',
    );
    mkdirSync(installedSdk, { recursive: true });
    writeFileSync(
      join(installedSdk, 'package.json'),
      JSON.stringify({
        name: '@kontourai/station-sdk',
        version: '0.4.0',
        marker: 'installed-from-registry',
      }),
    );
    process.env.npm_config_offline = 'true';

    await expect(buildPlugin(pluginDirectory)).resolves.toMatchObject({
      built: true,
    });

    expect(existsSync(installedSdk)).toBe(true);
    expect(lstatSync(installedSdk).isSymbolicLink()).toBe(false);
    expect(
      JSON.parse(readFileSync(join(installedSdk, 'package.json'), 'utf8'))
        .marker,
    ).toBe('installed-from-registry');
    expect(
      existsSync(join(pluginDirectory, 'node_modules', '.station-preserved')),
    ).toBe(false);
  }, 45_000);
});

describe('host lockfile protection (#875 root cause)', () => {
  it('detects the host workspace root from a plugin inside the monorepo', () => {
    // npm resolves the "project" by walking up from cwd, so an install run from
    // a plugin nested in this repo reaches the workspace root and rewrites its
    // package-lock.json. Under --legacy-peer-deps that drops required peer
    // entries and breaks `npm ci` on every clean checkout — which is exactly
    // how the graphql entry kept disappearing after being restored by hand.
    const repoRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../..',
    );
    const nested = join(repoRoot, 'examples', 'some-plugin');
    expect(hostWorkspaceRootFor(nested)).toBe(repoRoot);
  });

  it('returns null for a plugin outside any workspace', () => {
    const outside = mkdtempSync(join(tmpdir(), 'standalone-plugin-'));
    try {
      writeFileSync(
        join(outside, 'package.json'),
        JSON.stringify({ name: 'standalone-plugin', version: '1.0.0' }),
      );
      expect(hostWorkspaceRootFor(outside)).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not treat the plugin’s own manifest as the host root', () => {
    // A plugin that itself declared `workspaces` must not match on itself,
    // or --no-save would be skipped for the case it exists to cover.
    const dir = mkdtempSync(join(tmpdir(), 'ws-plugin-'));
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'p', version: '1.0.0', workspaces: ['x'] }),
      );
      expect(hostWorkspaceRootFor(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
