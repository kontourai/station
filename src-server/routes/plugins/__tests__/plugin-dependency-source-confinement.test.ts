/**
 * A plugin manifest's `dependencies[].source` is untrusted content. These
 * cases drive the real `POST /preview` route, which stages the parent through
 * the real `fetchPluginSource` and resolves dependencies before any consent:
 *
 * - a local parent's local dependencies stay inside the parent's source root
 *   and are plain directories (no local git, no working checkout);
 * - a parent fetched from a remote source names remote dependencies only.
 *
 * The remote transport is simulated: `execGit` clones a local fixture
 * repository when asked for the fixture's https URL, and is otherwise real.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { execGitSync } from '../../../utils/git-exec.js';
import { registerPluginInstallRoutes } from '../plugin-install-routes.js';

const REMOTE_PARENT = 'https://git.example.test/acme/remote-parent.git';
const remote = vi.hoisted(() => ({ repository: '' }));
vi.mock('../../../utils/git-exec.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../utils/git-exec.js')>();
  return {
    ...original,
    execGit: (
      args: string[],
      options: Parameters<typeof original.execGit>[1],
    ) =>
      args.includes(REMOTE_PARENT)
        ? original.execGit(
            args.map((arg) =>
              arg === REMOTE_PARENT ? remote.repository : arg,
            ),
            { ...options, hardening: { allowFileProtocol: true } },
          )
        : original.execGit(args, options),
  };
});

const SECRET = 'outside-dependency-secret';
const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function logger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as any;
}

function writePlugin(dir: string, manifest: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest));
  return dir;
}

function commitRepo(dir: string): void {
  execGitSync(['init', '-b', 'main'], { cwd: dir });
  execGitSync(['config', 'user.email', 'station@example.com'], { cwd: dir });
  execGitSync(['config', 'user.name', 'Station Test'], { cwd: dir });
  execGitSync(['add', '-A'], { cwd: dir });
  execGitSync(['commit', '-m', 'plugin'], { cwd: dir });
}

/**
 * `<root>/packages/parent` declares the dependency; `<root>/packages` is its
 * source root. `<root>/outside/dep` is a real plugin outside that root.
 */
function layout() {
  const root = mkdtempSync(join(tmpdir(), 'station-dependency-confinement-'));
  cleanupDirs.push(root);
  mkdirSync(join(root, 'home', 'plugins'), { recursive: true });
  const packages = join(root, 'packages');
  const dependency = {
    name: 'shared-dep',
    version: '1.0.0',
    description: SECRET,
  };
  const outsideDep = writePlugin(join(root, 'outside', 'dep'), dependency);
  const writeParent = (source: string) =>
    writePlugin(join(packages, 'parent'), {
      name: 'parent-plugin',
      version: '1.0.0',
      dependencies: [{ id: 'shared-dep', source }],
    });
  return { root, packages, outsideDep, dependency, writeParent };
}

async function preview(root: string, source: string) {
  const app = new Hono();
  registerPluginInstallRoutes(app, {
    projectVisiblePlugins: () => (installed) => installed,
    agentsDir: join(root, 'home', 'agents'),
    logger: logger(),
    pluginsDir: join(root, 'home', 'plugins'),
    projectHomeDir: join(root, 'home'),
  });
  const response = await app.request('/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  });
  const body = await readJson(response);
  return {
    status: response.status,
    body: body as any,
    text: JSON.stringify(body),
  };
}

function expectRefused(
  outcome: { status: number; body: any; text: string },
  reason: RegExp,
) {
  expect(outcome.body.valid).not.toBe(true);
  expect(outcome.text).toMatch(reason);
  // The outside dependency was never staged and read.
  expect(outcome.text).not.toContain(SECRET);
}

describe('POST /preview confines plugin dependency sources', () => {
  test('a sibling plain-directory dependency previews (positive control)', async () => {
    const { root, packages, dependency, writeParent } = layout();
    writePlugin(join(packages, 'shared-dep'), dependency);
    const parent = writeParent('../shared-dep');
    const outcome = await preview(root, parent);
    expect(outcome.status).toBe(200);
    expect(outcome.body.valid).toBe(true);
    expect(outcome.body.dependencies).toEqual([
      expect.objectContaining({ id: 'shared-dep', status: 'will-install' }),
    ]);
  });

  test('refuses an absolute dependency source outside the parent source root', async () => {
    const { root, outsideDep, writeParent } = layout();
    const outcome = await preview(root, writeParent(outsideDep));
    expectRefused(outcome, /absolute source escapes its allowed package root/);
  });

  test('refuses a local git repository as a dependency source', async () => {
    const { root, packages, outsideDep, writeParent } = layout();
    commitRepo(outsideDep);
    execGitSync(
      ['clone', '--bare', outsideDep, join(packages, 'shared-dep.git')],
      { hardening: { allowFileProtocol: true } },
    );
    const outcome = await preview(root, writeParent('../shared-dep.git'));
    expectRefused(outcome, /local source must be a plain directory/);
  });

  test('refuses a local dependency source carrying a #branch', async () => {
    const { root, packages, dependency, writeParent } = layout();
    writePlugin(join(packages, 'shared-dep#main'), dependency);
    const outcome = await preview(root, writeParent('../shared-dep#main'));
    expectRefused(outcome, /local source must be a plain directory/);
  });

  test('refuses a working checkout as a dependency source', async () => {
    const { root, packages, dependency, writeParent } = layout();
    const checkout = writePlugin(join(packages, 'shared-dep'), dependency);
    writeFileSync(join(checkout, '.git'), 'gitdir: ../../outside/dep/.git\n');
    const outcome = await preview(root, writeParent('../shared-dep'));
    expectRefused(outcome, /must not contain git metadata \(\.git\)/);
  });

  test('refuses a local dependency declared by a remotely fetched parent', async () => {
    const { root, outsideDep } = layout();
    const parent = writePlugin(join(root, 'remote-parent'), {
      name: 'parent-plugin',
      version: '1.0.0',
      dependencies: [{ id: 'shared-dep', source: outsideDep }],
    });
    commitRepo(parent);
    remote.repository = parent;
    const outcome = await preview(root, REMOTE_PARENT);
    expectRefused(outcome, /names a local source under a remote parent source/);
    expect(
      readdirSync(join(root, 'home', 'plugins')).filter((entry) =>
        entry.startsWith('.preview-'),
      ),
    ).toEqual([]);
    expect(existsSync(join(root, 'home', 'plugins', 'shared-dep'))).toBe(false);
  });

  test('holds a remote dependency to the remote-parent rule for its own dependencies', async () => {
    const { root, packages, writeParent } = layout();
    // Inside the local parent's source root, so only the remote-parent rule
    // (not containment) can refuse it.
    const inner = writePlugin(join(packages, 'inner-dep'), {
      name: 'inner-dep',
      version: '1.0.0',
      description: SECRET,
    });
    const remoteDep = writePlugin(join(root, 'remote-dep'), {
      name: 'shared-dep',
      version: '1.0.0',
      dependencies: [{ id: 'inner-dep', source: inner }],
    });
    commitRepo(remoteDep);
    remote.repository = remoteDep;
    const outcome = await preview(root, writeParent(REMOTE_PARENT));
    expectRefused(outcome, /names a local source under a remote parent source/);
  });
});
