/**
 * The File Preview's Changes read over the real route and real git.
 *
 * Every state is produced by an actual repository shaped the way a user's
 * would be, and read back through `POST /:slug/file-preview/changes` -- the
 * seam the pane calls. The #2363 refusal is proven live first: the planted
 * diff driver runs under plain git, so a refusal here is Station declining
 * a program that would otherwise have executed.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_FILE_CHANGES_MAX_BYTES } from '@kontourai/station-contracts/workspace-file-preview';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  fileTreeOps: { add: vi.fn() },
}));

const { createWorkspacePanePreviewRoutes } = await import(
  '../workspace-pane-previews.js'
);

const makeTempDir = trackTempDirs();

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.test',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.test',
    },
  });
}

function repo(files: Record<string, string>, commit = true) {
  const root = makeTempDir('station-file-changes-');
  git(root, ['init', '-q', '-b', 'main']);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  if (commit) {
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'base']);
  }
  return root;
}

async function changes(workingDirectory: string, body: unknown) {
  const app = new Hono();
  app.route(
    '/:slug/file-preview',
    createWorkspacePanePreviewRoutes({
      getProject: vi.fn((slug: string) => {
        if (slug !== 'alpha') throw new Error('Not found');
        return { workingDirectory };
      }),
    } as never),
  );
  const response = await app.request('/alpha/file-preview/changes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await json(response) };
}

describe('POST /:slug/file-preview/changes', () => {
  test('returns the one file patch against HEAD, staged and unstaged together', async () => {
    const root = repo({ 'src/a.ts': 'one\ntwo\n', 'src/b.ts': 'b\n' });
    writeFileSync(join(root, 'src/a.ts'), 'one\nTWO\n');
    git(root, ['add', 'src/a.ts']);
    writeFileSync(join(root, 'src/a.ts'), 'one\nTWO\nthree\n');
    writeFileSync(join(root, 'src/b.ts'), 'changed too\n');

    const { status, body } = await changes(root, { path: 'src/a.ts' });

    expect(status).toBe(200);
    expect(body.data.state).toBe('changed');
    expect(body.data.base).toBe('HEAD');
    const patch = body.data.patch as string;
    expect(patch).toContain('diff --git a/src/a.ts b/src/a.ts');
    expect(patch).toContain('-two');
    expect(patch).toContain('+TWO');
    expect(patch).toContain('+three');
    // Exactly this file: the other changed file is not in its patch.
    expect(patch).not.toContain('src/b.ts');
    expect(JSON.stringify(body)).not.toContain(root);
  });

  test('distinguishes unchanged, untracked, no commits and no repository', async () => {
    const root = repo({ 'a.txt': 'a\n' });
    writeFileSync(join(root, 'new.txt'), 'new\n');
    expect((await changes(root, { path: 'a.txt' })).body.data).toEqual({
      state: 'unchanged',
      base: 'HEAD',
    });
    expect((await changes(root, { path: 'new.txt' })).body.data).toEqual({
      state: 'untracked',
    });

    const unborn = repo({ 'a.txt': 'a\n' }, false);
    expect((await changes(unborn, { path: 'a.txt' })).body.data).toEqual({
      state: 'no-commits',
    });

    const plain = makeTempDir('station-file-changes-plain-');
    writeFileSync(join(plain, 'a.txt'), 'a\n');
    expect((await changes(plain, { path: 'a.txt' })).body.data).toEqual({
      state: 'not-a-repository',
    });
  });

  test('reads the file in a nested repository of a multi-repository Project', async () => {
    const umbrella = makeTempDir('station-file-changes-umbrella-');
    const inner = join(umbrella, 'service');
    mkdirSync(inner);
    git(inner, ['init', '-q', '-b', 'main']);
    writeFileSync(join(inner, 'main.go'), 'package main\n');
    git(inner, ['add', '-A']);
    git(inner, ['commit', '-q', '-m', 'base']);
    writeFileSync(join(inner, 'main.go'), 'package main\n\nfunc main() {}\n');

    const { body } = await changes(umbrella, { path: 'service/main.go' });

    expect(body.data.state).toBe('changed');
    // Named from the nested repository's root, as git reports it.
    expect(body.data.patch).toContain('diff --git a/main.go b/main.go');
  });

  test('treats a file name as a literal path, never a pathspec glob', async () => {
    const root = repo({ '*.ts': 'star\n', 'x.ts': 'x\n' });
    writeFileSync(join(root, 'x.ts'), 'x changed\n');

    const { body } = await changes(root, { path: '*.ts' });

    // A glob would have matched x.ts and returned its change.
    expect(body.data).toEqual({ state: 'unchanged', base: 'HEAD' });
  });

  test('refuses a repository whose own config runs a diff driver, which plain git runs', async () => {
    const root = repo({ 'a.txt': 'a\n' });
    const marker = join(root, '..', `ran-${Date.now()}`);
    writeFileSync(join(root, '.gitattributes'), 'a.txt diff=planted\n');
    git(root, [
      'config',
      'diff.planted.textconv',
      `sh -c 'touch "${marker}"; cat "$1"' --`,
    ]);
    writeFileSync(join(root, 'a.txt'), 'b\n');
    // Live plant: plain git executes the driver.
    git(root, ['diff', 'HEAD', '--', 'a.txt']);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    const { status, body } = await changes(root, { path: 'a.txt' });

    expect(status).toBe(200);
    expect(body.data.state).toBe('refused');
    expect(body.data.reason).toContain('diff.planted.textconv');
    expect(existsSync(marker)).toBe(false);
  });

  test('refuses an oversized patch rather than truncating it', async () => {
    const root = repo({ 'big.txt': 'x\n' });
    writeFileSync(
      join(root, 'big.txt'),
      `${'y'.repeat(99)}\n`.repeat(WORKSPACE_FILE_CHANGES_MAX_BYTES / 100 + 50),
    );

    const { body } = await changes(root, { path: 'big.txt' });

    expect(WORKSPACE_FILE_CHANGES_MAX_BYTES).toBe(262_144);
    expect(body.data).toEqual({ state: 'oversized', limitBytes: 262_144 });
  });

  test('refuses traversal, absolute paths and a symlink leaving the Project', async () => {
    const root = repo({ 'a.txt': 'a\n' });
    for (const path of ['../a.txt', '/etc/hosts', 'src/../../x']) {
      const { status, body } = await changes(root, { path });
      expect(status, path).toBe(400);
      expect(JSON.stringify(body)).not.toContain(root);
    }
    const outside = makeTempDir('station-file-changes-outside-');
    writeFileSync(join(outside, 'secret.txt'), 'nope\n');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
    expect((await changes(root, { path: 'link.txt' })).status).toBe(400);
    const { status } = await changes(root, { path: 'a.txt', extra: 1 });
    expect(status).toBe(400);
  });

  describe('a git directory the Project does not own', () => {
    /** An operator repository outside the Project with a committed secret. */
    function outsideRepository() {
      const outside = repo({ 'secret.txt': 'operator-only secret\n' });
      return outside;
    }
    const plainDiff = (cwd: string) =>
      git(cwd, ['diff', 'HEAD', '--', 'secret.txt']);

    test('refuses a .git file that names another repository, which plain git follows', async () => {
      const outside = outsideRepository();
      const project = makeTempDir('station-file-changes-project-');
      mkdirSync(join(project, 'sub'));
      writeFileSync(
        join(project, 'sub', '.git'),
        `gitdir: ${join(outside, '.git')}\n`,
      );
      // Live plant: plain git in that folder reads the outside repository.
      expect(plainDiff(join(project, 'sub'))).toContain('operator-only secret');

      const { status, body } = await changes(project, {
        path: 'sub/secret.txt',
      });

      expect(status).toBe(200);
      expect(body.data.state).toBe('refused');
      expect(body.data.reason).toContain("not the Project's own");
      expect(JSON.stringify(body)).not.toContain('operator-only secret');
    });

    test('refuses a symbolic-link .git, which plain git follows', async () => {
      const outside = outsideRepository();
      const project = makeTempDir('station-file-changes-project-');
      mkdirSync(join(project, 'sub'));
      symlinkSync(join(outside, '.git'), join(project, 'sub', '.git'));
      expect(plainDiff(join(project, 'sub'))).toContain('operator-only secret');

      const { body } = await changes(project, { path: 'sub/secret.txt' });

      expect(body.data.state).toBe('refused');
      expect(body.data.reason).toContain('.git is a symbolic link');
      expect(JSON.stringify(body)).not.toContain('operator-only secret');
    });

    test('refuses alternates that borrow another repository, which plain git reads', async () => {
      const outside = outsideRepository();
      const outsideHead = git(outside, ['rev-parse', 'HEAD']).trim();
      const project = makeTempDir('station-file-changes-project-');
      git(project, ['init', '-q', '-b', 'main']);
      writeFileSync(
        join(project, '.git', 'objects', 'info', 'alternates'),
        `${join(outside, '.git', 'objects')}\n`,
      );
      writeFileSync(
        join(project, '.git', 'refs', 'heads', 'main'),
        `${outsideHead}\n`,
      );
      expect(plainDiff(project)).toContain('operator-only secret');

      const { body } = await changes(project, { path: 'secret.txt' });

      expect(body.data.state).toBe('refused');
      expect(body.data.reason).toContain('alternates');
      expect(JSON.stringify(body)).not.toContain('operator-only secret');
    });

    test("still reads a genuine linked worktree, a session's own checkout", async () => {
      const main = repo({ 'a.txt': 'one\n' });
      const worktree = join(makeTempDir('station-file-changes-wt-'), 'wt');
      git(main, ['worktree', 'add', '-q', worktree]);
      writeFileSync(join(worktree, 'a.txt'), 'two\n');

      const { body } = await changes(worktree, { path: 'a.txt' });

      expect(body.data.state).toBe('changed');
      expect(body.data.patch).toContain('+two');
    });

    test('still reads the repository that contains the Project from above', async () => {
      const outer = repo({ 'app/a.txt': 'one\n' });
      writeFileSync(join(outer, 'app', 'a.txt'), 'two\n');

      const { body } = await changes(join(outer, 'app'), { path: 'a.txt' });

      expect(body.data.state).toBe('changed');
      expect(body.data.patch).toContain('diff --git a/app/a.txt b/app/a.txt');
    });

    test('refuses a planted repository whose core.worktree steers discovery above the Project', async () => {
      // The operator's repository holds a file at the path the Project's
      // own file would have if the work tree started one folder too high.
      const higher = repo({ 'proj/sub/secret.txt': 'operator-only secret\n' });
      const above = join(higher, 'a');
      const project = join(above, 'proj');
      const sub = join(project, 'sub');
      mkdirSync(sub, { recursive: true });
      // A member-written repository inside the Project that claims a work
      // tree above it, so discovery from `sub` lands outside the checked area.
      git(sub, ['init', '-q', '-b', 'main']);
      git(sub, ['config', 'core.worktree', above]);
      expect(git(sub, ['rev-parse', '--show-toplevel']).trim()).toBe(
        realpathSync(above),
      );

      const { body } = await changes(project, { path: 'sub/secret.txt' });

      expect(body.data.state).toBe('refused');
      expect(JSON.stringify(body)).not.toContain('operator-only secret');
    });
  });

  test('refuses a path through a regular file as a bad request', async () => {
    const root = repo({ 'a.txt': 'a\n' });
    const { status } = await changes(root, { path: 'a.txt/b' });
    expect(status).toBe(400);
  });
});
