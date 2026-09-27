import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
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

  test('a missing plugins dir yields no updates without touching the network', async () => {
    const dir = pluginsDir();
    await expect(
      checkPluginUpdates({ pluginsDir: dir, logger }),
    ).resolves.toEqual({ updates: [] });
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
    ).resolves.toEqual({ updates: [] });
    expect(logger.debug).not.toHaveBeenCalled();
  });

  test('a plugin without a usable repository of its own reports no drift from an enclosing checkout', async () => {
    // The plugins dir lives inside a checkout that IS behind its upstream.
    const root = tempDir('plugin-update-check-enclosed-');
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
    const home = join(root, 'home');
    execGitSync(['clone', '--quiet', upstream, home], {
      hardening: { allowFileProtocol: true },
    });
    execGitSync(['reset', '--quiet', '--hard', 'HEAD~1'], { cwd: home });
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
    ).resolves.toEqual({ updates: [] });
  });
});
