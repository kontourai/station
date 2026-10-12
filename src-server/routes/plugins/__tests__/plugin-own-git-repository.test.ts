/**
 * Plugin git routes act on the plugin's own repository only. The Station home
 * here is itself a git checkout, one commit behind its upstream; a plugin
 * inside it whose own `.git` is unusable must never be answered for, or
 * updated through, that enclosing checkout. Real routes, real git.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { withOperatorPrincipal } from '../../../__test-utils__/operator-principal.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { installPluginFromSource } from '../../../services/plugins/plugin-install-transaction.js';
import { execGitSync } from '../../../utils/git-exec.js';
import type { Logger } from '../../../utils/logger.js';
import { createPluginRoutes } from '../plugins.js';

const tempDir = trackTempDirs();
const ENCLOSING_SUBJECT = 'enclosing-upstream-commit';

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    setLevel: vi.fn(),
    getLevel: vi.fn(() => 'info' as const),
  } as unknown as Logger;
}

function git(cwd: string, ...args: string[]): string {
  return String(
    execGitSync(
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        ...args,
      ],
      { cwd, hardening: { allowFileProtocol: true } },
    ),
  ).trim();
}

/** A Station home that is a checkout one commit behind its upstream, with a
 * legacy plugin installed in it whose own `.git` is an empty directory. */
async function enclosedPlugin() {
  const root = tempDir('station-own-git-');
  const upstream = join(root, 'upstream');
  mkdirSync(upstream);
  git(upstream, 'init', '-q', '-b', 'main');
  writeFileSync(join(upstream, 'file.txt'), 'one');
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '-q', '-m', 'first');
  writeFileSync(join(upstream, 'file.txt'), 'two');
  git(upstream, 'commit', '-q', '-am', ENCLOSING_SUBJECT);
  const home = join(root, 'home');
  git(root, 'clone', '-q', upstream, home);
  git(home, 'reset', '-q', '--hard', 'HEAD~1');
  mkdirSync(join(home, 'plugins'));
  mkdirSync(join(home, 'agents'));
  const source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(
    join(source, 'plugin.json'),
    JSON.stringify({ name: 'enclosed', version: '1.0.0' }),
  );
  await installPluginFromSource(source, [], {
    agentsDir: join(home, 'agents'),
    buildPlugin: vi.fn().mockResolvedValue(undefined),
    logger: makeLogger(),
    pluginsDir: join(home, 'plugins'),
    projectHomeDir: home,
  } as any);
  const pluginDir = join(home, 'plugins', 'enclosed');
  mkdirSync(join(pluginDir, '.git'));
  const head = git(home, 'rev-parse', 'HEAD');
  // Premise: the enclosing checkout has a commit a pull would bring in.
  expect(git(home, 'rev-list', '--count', 'HEAD..@{u}')).toBe('1');
  return {
    home,
    head,
    app: withOperatorPrincipal(createPluginRoutes(home, makeLogger())),
  };
}

describe('plugin git routes use only the plugin’s own repository', () => {
  test('the changelog lists no commits of an enclosing checkout', async () => {
    const { app } = await enclosedPlugin();
    const response = await app.request('/enclosed/changelog');
    const body = (await response.json()) as { entries: unknown[] };
    expect(body.entries).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('first');
  });

  test('a legacy update fails closed and leaves the enclosing checkout unchanged', async () => {
    const { app, home, head } = await enclosedPlugin();
    const response = await app.request('/enclosed/update', { method: 'POST' });
    const body = (await response.json()) as { success?: boolean };
    expect(body.success, JSON.stringify(body)).not.toBe(true);
    expect(git(home, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(home, 'rev-list', '--count', 'HEAD..@{u}')).toBe('1');
  });

  test('a legacy update pulls into the plugin directory, whatever working tree its repository names', async () => {
    const root = tempDir('station-own-worktree-');
    // A `.git`-suffixed local path is cloned, so the plugin tracks it.
    const origin = join(root, 'origin.git');
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    writeFileSync(
      join(origin, 'plugin.json'),
      JSON.stringify({ name: 'worktree-plugin', version: '1.0.0' }),
    );
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', 'v1');
    const home = join(root, 'home');
    mkdirSync(join(home, 'plugins'), { recursive: true });
    mkdirSync(join(home, 'agents'));
    await installPluginFromSource(origin, [], {
      agentsDir: join(home, 'agents'),
      buildPlugin: vi.fn().mockResolvedValue(undefined),
      logger: makeLogger(),
      pluginsDir: join(home, 'plugins'),
      projectHomeDir: home,
    } as any);
    const pluginDir = join(home, 'plugins', 'worktree-plugin');
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    git(pluginDir, 'config', 'core.worktree', elsewhere);
    writeFileSync(
      join(origin, 'plugin.json'),
      JSON.stringify({ name: 'worktree-plugin', version: '1.1.0' }),
    );
    git(origin, 'commit', '-q', '-am', 'v2');
    const app = withOperatorPrincipal(createPluginRoutes(home, makeLogger()));
    const response = await app.request('/worktree-plugin/update', {
      method: 'POST',
    });
    const body = await response.json();
    expect(body, JSON.stringify(body)).toMatchObject({ success: true });
    expect(
      JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8')).version,
    ).toBe('1.1.0');
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});
