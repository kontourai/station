/**
 * The File Preview's Changes read over the real route and real git.
 *
 * Every state is produced by an actual repository shaped the way a user's
 * would be, and read back through `POST /:slug/file-preview/changes`, the
 * seam the pane calls. Each plant below is proven live first: plain git in
 * the planted folder reads the outside repository or runs the planted
 * program, so a refusal, or a discarded read, is Station declining what
 * would otherwise have happened. The read itself goes through the shared
 * resolver (`git-read-repository.ts`), which the coding git reads use too;
 * this file proves it through THIS route.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_FILE_CHANGES_MAX_BYTES } from '@kontourai/station-contracts/workspace-file-preview';
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

/**
 * A hook on every git call Station makes, so a test can change the
 * repository at a chosen moment (after Station judged its config, before
 * `git diff` starts) and see what git printed before Station judged it.
 * Otherwise the real runner.
 */
const hooks = vi.hoisted(() => ({
  beforeGit: undefined as ((args: string[]) => void) | undefined,
  afterGit: undefined as ((args: string[], stdout: string) => void) | undefined,
}));

vi.mock('../../../utils/git-exec.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../utils/git-exec.js')>();
  return {
    ...original,
    execGit: (async (args, options) => {
      hooks.beforeGit?.(args);
      const result = await original.execGit(args, options);
      hooks.afterGit?.(args, result.stdout);
      return result;
    }) as typeof original.execGit,
  };
});

vi.mock('../../../telemetry/metrics.js', () => ({
  fileTreeOps: { add: vi.fn() },
}));

const { createWorkspacePanePreviewRoutes } = await import(
  '../workspace-pane-previews.js'
);

const SECRET = 'operator-only secret';

const makeTempDir = trackTempDirs();
/** This test's own folder, outside every repository it makes. */
let scratch: string;

beforeEach(() => {
  hooks.beforeGit = undefined;
  hooks.afterGit = undefined;
  scratch = realpathSync(makeTempDir('station-file-changes-scratch-'));
  // Station's runner reads the operator's own global configuration by
  // design; here it is this test's, so a planted program is the only one.
  const global = join(scratch, 'global.gitconfig');
  writeFileSync(global, '[user]\n\tname = T\n\temail = t@example.test\n');
  writeFileSync(join(scratch, 'system.gitconfig'), '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', global);
  vi.stubEnv('GIT_CONFIG_SYSTEM', join(scratch, 'system.gitconfig'));
  return () => vi.unstubAllEnvs();
});

/** Plain git, NOT Station's runner. Throws when git fails. */
function git(cwd: string, args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A repository at `dir` (a fresh temp folder by default) holding `files`. */
function repo(
  files: Record<string, string>,
  { commit = true, dir }: { commit?: boolean; dir?: string } = {},
) {
  const root = dir ?? makeTempDir('station-file-changes-');
  mkdirSync(root, { recursive: true });
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

/** The operator's other repository, outside every Project, with a secret. */
function outsideRepository() {
  return repo({ 'secret.txt': `${SECRET}\n` });
}

/** A program that records each run, and `ran()` to count them. */
function plantedProgram() {
  const marker = join(scratch, 'ran.log');
  const program = join(scratch, 'program.sh');
  writeFileSync(program, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`, {
    mode: 0o755,
  });
  return {
    program,
    ran: () =>
      existsSync(marker)
        ? readFileSync(marker, 'utf-8').split('\n').filter(Boolean).length
        : 0,
  };
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
  return {
    status: response.status,
    body: await json(response),
    retryAfter: response.headers.get('Retry-After'),
  };
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
    // A read never touches the member's index: staging is as it was.
    expect(git(root, ['diff', '--cached', '--name-only']).trim()).toBe(
      'src/a.ts',
    );
  });

  test('distinguishes unchanged, untracked, a deleted file, no commits and no repository', async () => {
    const root = repo({ 'a.txt': 'a\n', 'gone.txt': 'gone\n' });
    writeFileSync(join(root, 'new.txt'), 'new\n');
    rmSync(join(root, 'gone.txt'));
    expect((await changes(root, { path: 'a.txt' })).body.data).toEqual({
      state: 'unchanged',
      base: 'HEAD',
    });
    expect((await changes(root, { path: 'new.txt' })).body.data).toEqual({
      state: 'untracked',
    });
    const deleted = (await changes(root, { path: 'gone.txt' })).body.data;
    expect(deleted.state).toBe('changed');
    expect(deleted.patch).toContain('-gone');

    const unborn = repo({ 'a.txt': 'a\n' }, { commit: false });
    expect((await changes(unborn, { path: 'a.txt' })).body.data).toEqual({
      state: 'no-commits',
    });

    const plain = makeTempDir('station-file-changes-plain-');
    writeFileSync(join(plain, 'a.txt'), 'a\n');
    expect((await changes(plain, { path: 'a.txt' })).body.data).toEqual({
      state: 'not-a-repository',
    });
  });

  test("reads a file in a nested repository of a multi-repository Project, as that repository's", async () => {
    const umbrella = makeTempDir('station-file-changes-umbrella-');
    const inner = repo(
      { 'main.go': 'package main\n' },
      {
        dir: join(umbrella, 'service'),
      },
    );
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

  test('refuses a path through a regular file as a bad request', async () => {
    const root = repo({ 'a.txt': 'a\n' });
    const { status } = await changes(root, { path: 'a.txt/b' });
    expect(status).toBe(400);
  });

  describe('a repository whose own configuration names a program `git diff` would run', () => {
    /**
     * Each key, with the attributes that select it for `a.txt`. Plain git
     * runs the program on `git diff HEAD -- a.txt`; that is asserted first.
     */
    const PROGRAMS: Array<[key: string, attributes: string]> = [
      ['diff.external', ''],
      ['diff.planted.textconv', 'a.txt diff=planted\n'],
      ['diff.planted.command', 'a.txt diff=planted\n'],
      ['filter.planted.clean', 'a.txt filter=planted\n'],
    ];

    test.each(PROGRAMS)(
      '%s: refused by that name, and the program does not run',
      async (key, attributes) => {
        const root = repo({ 'a.txt': 'a\n', '.gitattributes': attributes });
        const { program, ran } = plantedProgram();
        git(root, ['config', key, program]);
        writeFileSync(join(root, 'a.txt'), 'b\n');
        // Live plant: plain git executes the program.
        git(root, ['diff', 'HEAD', '--', 'a.txt']);
        expect(ran(), 'control: plain git runs it').toBeGreaterThan(0);
        const before = ran();

        const { status, body } = await changes(root, { path: 'a.txt' });

        expect(status).toBe(200);
        expect(body.data.state).toBe('refused');
        expect(body.data.reason).toContain(key);
        expect(JSON.stringify(body)).not.toContain(scratch);
        expect(ran(), 'the planted program ran under Station').toBe(before);
      },
    );

    test("a nested repository's own program: the read of its file is refused, and it does not run", async () => {
      const project = repo({ 'README.md': '# project\n' });
      const sub = repo({ 'f.txt': 'one\n' }, { dir: join(project, 'sub') });
      const { program, ran } = plantedProgram();
      git(sub, ['config', 'diff.external', program]);
      writeFileSync(join(sub, 'f.txt'), 'two\n');
      git(sub, ['diff', 'HEAD', '--', 'f.txt']);
      expect(ran(), 'control: plain git runs it').toBeGreaterThan(0);
      const before = ran();

      const { body } = await changes(project, { path: 'sub/f.txt' });

      expect(body.data.state).toBe('refused');
      expect(body.data.reason).toContain('diff.external');
      expect(ran()).toBe(before);
    });

    /**
     * Written AFTER Station judged the configuration and BEFORE `git diff`
     * starts, as a member racing the read would; taken away again at the
     * next git call, so every attempt judges a clean configuration and
     * meets the planted one only while git runs.
     */
    test.each([
      [
        'config.worktree created under extensions.worktreeConfig',
        (root: string) => {
          git(root, ['config', 'extensions.worktreeConfig', 'true']);
          const file = join(root, '.git', 'config.worktree');
          return {
            plant: (filter: string) => writeFileSync(file, filter),
            unplant: () => rmSync(file, { force: true }),
          };
        },
      ],
      [
        '.git/config rewritten in place',
        (root: string) => {
          const file = join(root, '.git', 'config');
          const clean = readFileSync(file, 'utf-8');
          return {
            plant: (filter: string) => writeFileSync(file, clean + filter),
            unplant: () => writeFileSync(file, clean),
          };
        },
      ],
    ])(
      '%s during the read: the filter does not run, and the read is answered busy, not from the planted state',
      async (_name, prepare) => {
        const root = repo({
          'a.txt': 'one\n',
          '.gitattributes': 'a.txt filter=planted\n',
        });
        const { program, ran } = plantedProgram();
        const filter = `[filter "planted"]\n\tclean = ${program}\n`;
        const { plant, unplant } = prepare(root);
        writeFileSync(join(root, 'a.txt'), 'two\n');
        let planted = false;
        let diffs = 0;
        hooks.beforeGit = (args) => {
          if (args.includes('diff')) {
            diffs += 1;
            plant(filter);
            planted = true;
          } else if (planted) {
            unplant();
            planted = false;
          }
        };

        const { status, body, retryAfter } = await changes(root, {
          path: 'a.txt',
        });
        hooks.beforeGit = undefined;

        expect(diffs, 'git diff ran against the planted state').toBeGreaterThan(
          0,
        );
        expect(ran(), 'the planted filter ran under Station').toBe(0);
        expect(status).toBe(503);
        expect(body).toMatchObject({
          success: false,
          code: 'repository-busy',
          retryable: true,
        });
        expect(retryAfter).toBe('1');
        expect(body.data).toBeUndefined();

        // Control, last: plain git reading that configuration runs it.
        plant(filter);
        git(root, ['diff', 'HEAD', '--', 'a.txt']);
        expect(ran(), 'control: plain git runs the filter').toBeGreaterThan(0);
      },
    );
  });

  describe('a git directory the Project does not own', () => {
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
      expect(plainDiff(join(project, 'sub'))).toContain(SECRET);

      const { status, body } = await changes(project, {
        path: 'sub/secret.txt',
      });

      expect(status).toBe(200);
      expect(body.data.state).toBe('refused');
      expect(body.data.reason).toContain("not the Project's own");
      expect(body.data.reason).toContain('outside this Project');
      expect(JSON.stringify(body)).not.toContain(SECRET);
      expect(JSON.stringify(body)).not.toContain(outside);
    });

    test('refuses a symbolic-link .git, which plain git follows', async () => {
      const outside = outsideRepository();
      const project = makeTempDir('station-file-changes-project-');
      mkdirSync(join(project, 'sub'));
      symlinkSync(join(outside, '.git'), join(project, 'sub', '.git'));
      expect(plainDiff(join(project, 'sub'))).toContain(SECRET);

      const { body } = await changes(project, { path: 'sub/secret.txt' });

      expect(body.data.state).toBe('refused');
      expect(body.data.reason).toContain('.git is a symbolic link');
      expect(JSON.stringify(body)).not.toContain(SECRET);
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
      expect(plainDiff(project)).toContain(SECRET);

      const { body } = await changes(project, { path: 'secret.txt' });

      expect(body.data.state).toBe('refused');
      expect(body.data.reason).toContain('alternates');
      expect(JSON.stringify(body)).not.toContain(SECRET);
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

    /**
     * git trusts an index entry's cached size and mtime unless the file was
     * modified in the same second the index was written (a "racy" entry,
     * which it re-reads by content). Station runs git on a COPY of the
     * index; a copy with a fresh timestamp is newer than every entry, so a
     * same-size rewrite that landed in the same second as the index, read a
     * second later, read as unchanged (3 of 20 runs of the two tests above
     * before the copy kept the index's own timestamp). Here the race is made
     * certain: the entry's cached mtime, the file's mtime and the index's
     * mtime are all two seconds in the past, so any copy made now is newer.
     */
    test('a same-size rewrite in the same second as the index was written is read by content, as plain git reads it', async () => {
      const root = repo({ 'a.txt': 'one\n' });
      const file = join(root, 'a.txt');
      const index = join(root, '.git', 'index');
      const past = new Date(statSync(file).mtimeMs - 2_000);
      // The index caches the file's stat with that mtime...
      utimesSync(file, past, past);
      git(root, ['update-index', '--refresh']);
      // ...then the file changes without its size or mtime changing, and
      // the index is as old as the entry: racy, in git's own reading.
      writeFileSync(file, 'two\n');
      utimesSync(file, past, past);
      utimesSync(index, past, past);

      const { body } = await changes(root, { path: 'a.txt' });

      expect(body.data.state).toBe('changed');
      expect(body.data.patch).toContain('+two');
      // Control, last (plain git refreshes the index as it reads): reading
      // its own index, git sees the change.
      expect(git(root, ['diff', 'HEAD', '--', 'a.txt'])).toContain('+two');
    });

    test('refuses a planted repository whose core.worktree steers discovery above the Project', async () => {
      // The operator's repository holds a file at the path the Project's
      // own file would have if the work tree started one folder too high.
      const higher = repo({ 'proj/sub/secret.txt': `${SECRET}\n` });
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
      expect(JSON.stringify(body)).not.toContain(SECRET);
    });

    test('a .git swapped for a link to another repository during the read, and put back: the output is discarded and the read answered busy', async () => {
      const outside = outsideRepository();
      const project = makeTempDir('station-file-changes-project-');
      // The member's own repository inside the Project, on the same branch
      // name as the outside one, so the HEAD Station copied resolves there.
      const folder = repo(
        { 'own.txt': 'own\n' },
        {
          dir: join(project, 'sub'),
        },
      );
      symlinkSync(join(outside, '.git'), join(folder, '.git-link'));
      const swapIn = () => {
        renameSync(join(folder, '.git'), join(folder, '.git-real'));
        renameSync(join(folder, '.git-link'), join(folder, '.git'));
      };
      const swapOut = () => {
        renameSync(join(folder, '.git'), join(folder, '.git-link'));
        renameSync(join(folder, '.git-real'), join(folder, '.git'));
      };
      // Live: in the swapped state, plain git by that path reads the
      // outside repository's file as deleted here, content and all.
      swapIn();
      expect(plainDiff(folder)).toContain(`-${SECRET}`);
      swapOut();
      let swapped = false;
      const printed: string[] = [];
      hooks.beforeGit = (args) => {
        // After Station checked `.git` and judged the config, before the
        // diff starts; back again at the next git call.
        if (args.includes('diff')) {
          swapIn();
          swapped = true;
        } else if (swapped) {
          swapOut();
          swapped = false;
        }
      };
      hooks.afterGit = (args, stdout) => {
        if (args.includes('diff')) printed.push(stdout);
      };

      const { status, body, retryAfter } = await changes(project, {
        path: 'sub/secret.txt',
      });
      hooks.beforeGit = undefined;
      hooks.afterGit = undefined;
      if (swapped) swapOut();

      // git, run by Station, printed the outside repository's content on
      // every attempt; none of it was answered.
      expect(printed.length).toBeGreaterThan(1);
      for (const output of printed) expect(output).toContain(`-${SECRET}`);
      expect(status).toBe(503);
      expect(body).toMatchObject({
        success: false,
        code: 'repository-busy',
        retryable: true,
      });
      expect(retryAfter).toBe('1');
      expect(JSON.stringify(body)).not.toContain(SECRET);
      expect(JSON.stringify(body)).not.toContain(outside);
      // The member's repository is as it was.
      expect(readFileSync(join(folder, '.git', 'HEAD'), 'utf-8')).toContain(
        'refs/heads/main',
      );
      expect(git(folder, ['log', '-1', '--format=%s']).trim()).toBe('base');
    });
  });
});

describe('POST /:slug/file-preview/changes: what an empty patch means', () => {
  test('a path that is neither tracked, in HEAD, nor present is not found, never "matches HEAD"', async () => {
    const root = repo({ 'a.txt': 'a\n' });

    const { status, body } = await changes(root, { path: 'never.txt' });

    expect(status).toBe(404);
    expect(body).toMatchObject({ success: false, code: 'file-not-found' });
    expect(JSON.stringify(body)).not.toContain(root);
    // The same path, present and untracked, is a different fact.
    writeFileSync(join(root, 'never.txt'), 'now\n');
    expect((await changes(root, { path: 'never.txt' })).body.data).toEqual({
      state: 'untracked',
    });
    // And an ignored file is still a file git sees, not one that is missing.
    writeFileSync(join(root, '.gitignore'), 'secret.env\n');
    writeFileSync(join(root, 'secret.env'), 'x\n');
    expect((await changes(root, { path: 'secret.env' })).body.data).toEqual({
      state: 'untracked',
    });
  });

  test('a HEAD check that fails for any reason but "no commits yet" is a failure, not "no commits"', async () => {
    const root = repo({ 'a.txt': 'a\n' });
    hooks.beforeGit = (args) => {
      if (args.includes('rev-parse') && args.includes('--verify')) {
        throw Object.assign(new Error('fatal: bad object HEAD'), {
          code: 128,
          stderr: 'fatal: bad object HEAD\n',
        });
      }
    };

    const { status, body } = await changes(root, { path: 'a.txt' });

    expect(status).toBe(502);
    expect(body.success).toBe(false);
    expect(JSON.stringify(body)).not.toContain('no-commits');
  });
});
