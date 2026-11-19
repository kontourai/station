import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { execGitSync } from '../../../utils/git-exec.js';
import { checkPluginUpdates } from '../plugin-update-check.js';

const tempDir = trackTempDirs();

describe('checkPluginUpdates (station#2236)', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function pluginsDir(): string {
    const root = mkdtempSync(join(tmpdir(), 'plugin-update-check-'));
    roots.push(root);
    return join(root, 'plugins');
  }

  const logger = { debug: vi.fn() };
  beforeEach(() => logger.debug.mockClear());

  /** A checkout of a two-commit upstream, reset one commit behind it. */
  function checkoutOneCommitBehind(root: string, checkout: string): void {
    const upstream = join(root, 'upstream');
    mkdirSync(upstream);
    const commit = (message: string) => {
      writeFileSync(join(upstream, 'file.txt'), message);
      execGitSync(['add', '-A'], { cwd: upstream });
      execGitSync(
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.test',
          'commit',
          '-m',
          message,
        ],
        { cwd: upstream },
      );
    };
    execGitSync(['init', '-b', 'main'], { cwd: upstream });
    commit('one');
    commit('two');
    execGitSync(['clone', '--quiet', upstream, checkout], {
      hardening: { allowFileProtocol: true },
    });
    execGitSync(['reset', '--quiet', '--hard', 'HEAD~1'], { cwd: checkout });
  }

  test('a missing plugins dir yields no updates', async () => {
    const dir = pluginsDir();
    await expect(
      checkPluginUpdates({ pluginsDir: dir, logger }),
    ).resolves.toEqual({ status: 'complete', updates: [] });
  });

  test('entries without a git checkout and manifest pair are skipped', async () => {
    const dir = pluginsDir();
    // A bare directory (no .git, no plugin.json) can never report drift.
    mkdirSync(join(dir, 'plain-dir'), { recursive: true });
    // A manifest without a checkout is not version-controlled either.
    mkdirSync(join(dir, 'no-git'), { recursive: true });
    writeFileSync(
      join(dir, 'no-git', 'plugin.json'),
      JSON.stringify({ name: 'no-git', version: '1.0.0' }),
    );
    await expect(
      checkPluginUpdates({ pluginsDir: dir, logger }),
    ).resolves.toEqual({ status: 'complete', updates: [] });
    expect(logger.debug).not.toHaveBeenCalled();
  });

  test('a plugin without a usable repository of its own reports no drift from an enclosing checkout', async () => {
    // The plugins dir lives inside a checkout that IS behind its upstream.
    const root = tempDir('plugin-update-check-enclosed-');
    const home = join(root, 'home');
    checkoutOneCommitBehind(root, home);
    // Premise: the enclosing checkout itself is one commit behind.
    expect(
      String(
        execGitSync(['rev-list', '--count', 'HEAD..@{u}'], { cwd: home }),
      ).trim(),
    ).toBe('1');
    const plugins = join(home, 'plugins');
    // An unusable `.git` (an empty directory) of the plugin's own.
    mkdirSync(join(plugins, 'enclosed', '.git'), { recursive: true });
    writeFileSync(
      join(plugins, 'enclosed', 'plugin.json'),
      JSON.stringify({ name: 'enclosed', version: '1.0.0' }),
    );
    await expect(
      checkPluginUpdates({ pluginsDir: plugins, logger }),
    ).resolves.toEqual({ status: 'unavailable', updates: [] });
  });

  test('a plugin checkout behind its own upstream reports its behind-count', async () => {
    const root = tempDir('plugin-update-check-behind-');
    const plugins = join(root, 'plugins');
    const plugin = join(plugins, 'drifted');
    mkdirSync(plugins);
    checkoutOneCommitBehind(root, plugin);
    writeFileSync(
      join(plugin, 'plugin.json'),
      JSON.stringify({ name: 'drifted', version: '1.2.3' }),
    );
    await expect(
      checkPluginUpdates({ pluginsDir: plugins, logger }),
    ).resolves.toEqual({
      status: 'complete',
      updates: [
        {
          name: 'drifted',
          currentVersion: '1.2.3',
          latestVersion: '1 commit behind',
          source: 'git',
        },
      ],
    });
  });
  test.skipIf(process.platform === 'win32')(
    'reads a contained manifest reference in the selected git checkout',
    async () => {
      const root = tempDir('plugin-update-check-contained-');
      const plugins = join(root, 'plugins');
      const plugin = join(plugins, 'linked-manifest');
      mkdirSync(plugins);
      checkoutOneCommitBehind(root, plugin);
      writeFileSync(
        join(plugin, 'manifest.json'),
        JSON.stringify({ name: 'linked-manifest', version: '1.2.3' }),
      );
      symlinkSync('manifest.json', join(plugin, 'plugin.json'), 'file');
      await expect(
        checkPluginUpdates({ pluginsDir: plugins, logger }),
      ).resolves.toMatchObject({
        status: 'complete',
        updates: [{ name: 'linked-manifest', currentVersion: '1.2.3' }],
      });
    },
  );

  test('an installed directory in place of plugin.json is a refused update read', async () => {
    const root = tempDir('plugin-update-check-manifest-type-');
    const plugins = join(root, 'plugins');
    const plugin = join(plugins, 'invalid-manifest');
    mkdirSync(plugins);
    checkoutOneCommitBehind(root, plugin);
    mkdirSync(join(plugin, 'plugin.json'));
    await expect(
      checkPluginUpdates({ pluginsDir: plugins, logger }),
    ).resolves.toEqual({
      status: 'unavailable',
      updates: [],
    });
    expect(logger.debug).toHaveBeenCalledWith(
      'Failed to check git updates for plugin',
      expect.objectContaining({
        plugin: 'invalid-manifest',
        error: expect.objectContaining({ code: 'manifest-not-regular-file' }),
      }),
    );
  });

  test('a failed Git fetch is unavailable rather than a completed empty check', async () => {
    const root = tempDir('plugin-update-check-offline-');
    const plugins = join(root, 'plugins');
    const plugin = join(plugins, 'offline');
    mkdirSync(plugins);
    checkoutOneCommitBehind(root, plugin);
    writeFileSync(
      join(plugin, 'plugin.json'),
      JSON.stringify({ name: 'offline', version: '1.0.0' }),
    );
    execGitSync(['remote', 'set-url', 'origin', join(root, 'missing-origin')], {
      cwd: plugin,
    });

    await expect(
      checkPluginUpdates({ pluginsDir: plugins, logger }),
    ).resolves.toEqual({ status: 'unavailable', updates: [] });
  });
});
