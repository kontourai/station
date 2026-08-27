/**
 * The git-backed half of the worktree-hygiene proof.
 *
 * The pure decision layer (`worktree-hygiene.test.ts`) can be tested without a
 * repository, and was. That is exactly why the first version of this tool
 * shipped with eight injectable faults — primary-checkout guard disabled,
 * every catch failing open, `-maxdepth` cut to 1, untracked detection broken,
 * `isCurrent` forced false — and a green suite: not one test ever ran the I/O
 * layer where all of them live.
 *
 * Every fixture here is a throwaway `git init` repository under the OS temp
 * directory, and every one is removed in `afterEach`. The tool itself no
 * longer executes any command that changes a repository, so nothing in this
 * file removes a worktree either — the fixtures exist to prove what the
 * report DERIVES, against a real `git`.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import {
  classifyWorktree,
  collectWorktreeFacts,
  FRESHNESS_UNSUPPORTED_PLATFORM,
  parseWorktreeList,
} from '../worktree-hygiene.mjs';

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'worktree-hygiene.mjs',
);

/** Fully isolated git: no user config, no system config, no hooks. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
    windowsHide: true,
  });
}

const fixtures: string[] = [];

afterEach(() => {
  while (fixtures.length > 0) {
    const root = fixtures.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

/** Push every mtime under `dir` outside the freshness window. */
function coolDown(dir: string, hoursAgo = 24): void {
  const when = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
  const walk = (path: string): void => {
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(path);
    } catch {
      return;
    }
    if (stats.isDirectory()) {
      for (const child of readdirSync(path)) walk(join(path, child));
    }
    try {
      utimesSync(path, when, when);
    } catch {
      /* a symlink or a vanished file cannot block the fixture */
    }
  };
  walk(dir);
}

function warm(path: string): void {
  const now = new Date();
  utimesSync(path, now, now);
}

/**
 * A repository with two commits and six lanes, each a distinct disposition:
 *
 *   lane-clean      merged, cold, nothing uncommitted   -> FINISHED
 *   lane-untracked  merged, cold, one NEW SOURCE FILE   -> keep (HIGH-1)
 *   lane-ignored    merged, cold, node_modules + dist   -> FINISHED
 *   lane-ahead      one commit `main` does not have     -> keep
 *   lane-distname   holds a TRACKED `distribution.ts`   -> FINISHED until it
 *                                                          is touched (MED-2)
 *   dist-lane       a worktree DIRECTORY named `dist-*` -> FINISHED until
 *                                                          anything in it is
 *                                                          touched (MED-2)
 *
 * The last two exist because the freshness walk used to prune `-name 'dist*'`,
 * a basename glob applied at every depth and to the start path itself.
 */
function makeFixture(): {
  root: string;
  repo: string;
  lane: (n: string) => string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-hygiene-')));
  fixtures.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main', '.']);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\ndist/\n');
  // Depth 5 relative to a worktree root: the region `-maxdepth 3` cannot see.
  mkdirSync(join(repo, 'src', 'a', 'b', 'c'), { recursive: true });
  writeFileSync(
    join(repo, 'src', 'a', 'b', 'c', 'deep.ts'),
    'export const x = 1;\n',
  );
  // A TRACKED file whose basename starts with `dist`. Station has four of
  // these (`packages/contracts/src/distribution.ts`,
  // `packages/cli/src/distribution.ts`,
  // `src-server/services/plugins/distribution-profile-service.ts`,
  // `docs/guides/distribution-profiles.md`); editing one was invisible to the
  // freshness walk.
  mkdirSync(join(repo, 'packages', 'core'), { recursive: true });
  writeFileSync(
    join(repo, 'packages', 'core', 'distribution.ts'),
    'export const dist = 1;\n',
  );
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'init']);
  // A second commit so a "narrow base" (the root commit) is genuinely
  // narrower than `main`, which is what the --base test needs to discriminate.
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'second']);

  const lane = (name: string) => join(root, name);
  for (const name of [
    'lane-clean',
    'lane-untracked',
    'lane-ignored',
    'lane-ahead',
    'lane-distname',
    // The worktree DIRECTORY is named `dist-lane`, which `-name 'dist*'`
    // matched on the start path itself — pruning the whole tree at depth 0.
    'dist-lane',
  ]) {
    git(repo, ['worktree', 'add', '-q', lane(name), '-b', name]);
  }

  writeFileSync(
    join(lane('lane-untracked'), 'brand-new-source.ts'),
    'export const y = 2;\n',
  );
  mkdirSync(join(lane('lane-ignored'), 'node_modules', 'pkg'), {
    recursive: true,
  });
  writeFileSync(
    join(lane('lane-ignored'), 'node_modules', 'pkg', 'index.js'),
    'x\n',
  );
  mkdirSync(join(lane('lane-ignored'), 'dist'), { recursive: true });
  writeFileSync(join(lane('lane-ignored'), 'dist', 'out.js'), 'y\n');

  writeFileSync(join(lane('lane-ahead'), 'ahead.ts'), 'export const z = 3;\n');
  git(lane('lane-ahead'), ['add', '-A']);
  git(lane('lane-ahead'), ['commit', '-qm', 'ahead of main']);

  coolDown(root);
  return { root, repo, lane };
}

function factsFor(
  repo: string,
  path: string,
  overrides: Record<string, unknown> = {},
) {
  const entries = parseWorktreeList(
    git(repo, ['worktree', 'list', '--porcelain', '-z']),
  );
  const entry = entries.find((candidate) => candidate.path === path);
  expect(entry, `no registered worktree at ${path}`).toBeDefined();
  return collectWorktreeFacts(entry, {
    repoRoot: repo,
    comparisonRef: 'main',
    windowHours: 6,
    currentPath: '/definitely/not/here',
    ...overrides,
  });
}

/**
 * Drive the real CLI as a child process. `spawnSync` rather than
 * `execFileSync` because the exit STATUS is the assertion in several of these
 * tests, and a rejection path that has never executed is unproven.
 */
function runCli(
  args: string[],
  cwd: string,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
    windowsHide: true,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('worktree hygiene against real repositories', () => {
  test('an untracked file that git is not ignoring keeps the worktree', async () => {
    // HIGH-1. `git worktree remove` never deletes the branch, so committed
    // work survives removal; an untracked file exists in exactly one place.
    const { repo, lane } = makeFixture();
    const result = classifyWorktree(
      await factsFor(repo, lane('lane-untracked')),
    );
    expect(result.untrackedFiles).toBe(1);
    expect(result.finished).toBe(false);
    expect(result.keepReasons).toContain(
      '1 untracked file(s) — not committed anywhere',
    );
  }, 60_000);

  test('ignored build output does not keep the worktree', async () => {
    // The other half of HIGH-1: a guard that keeps everything is the failure
    // mode that let ~140 worktrees accumulate. `??` records exclude ignored
    // paths by definition, so node_modules and dist do not block.
    const { repo, lane } = makeFixture();
    const result = classifyWorktree(await factsFor(repo, lane('lane-ignored')));
    expect(result.untrackedFiles).toBe(0);
    expect(result.keepReasons).toEqual([]);
    expect(result.finished).toBe(true);
  }, 60_000);

  test('a file edited at depth 5 counts as recent activity', async () => {
    // HIGH-2. Measured on station: 3762 of 4884 tracked paths are at depth
    // >= 4, so `-maxdepth 3` could not see a lane's source at all.
    const { repo, lane } = makeFixture();
    const deep = join(lane('lane-clean'), 'src', 'a', 'b', 'c', 'deep.ts');
    warm(deep);

    // The A/B that makes this test discriminating rather than incidental:
    // the bounded walk the tool used to perform sees nothing at all here.
    const bounded = execFileSync(
      'find',
      [
        lane('lane-clean'),
        '-maxdepth',
        '3',
        '-newermt',
        '-6 hours',
        '-type',
        'f',
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(bounded.trim()).toBe('');

    const result = classifyWorktree(await factsFor(repo, lane('lane-clean')));
    expect(result.finished).toBe(false);
    expect(result.keepReasons).toContain(
      'modified recently — a session may be live',
    );
  }, 60_000);

  // MED-2. `-name 'dist*'` was a BASENAME glob evaluated at every depth, and
  // `-prune` returns true, so the `-o` short-circuited and `-newermt` never
  // ran for the matched path. Each of these two tests carries its own A/B:
  // the retired argv is executed against the same warmed fixture and shown to
  // find nothing, so a green here cannot be incidental.
  test('editing a tracked file named dist* counts as recent activity', async () => {
    const { repo, lane } = makeFixture();
    const tracked = join(
      lane('lane-distname'),
      'packages',
      'core',
      'distribution.ts',
    );
    warm(tracked);

    const pruned = execFileSync(
      'find',
      [
        lane('lane-distname'),
        '(',
        '-name',
        'node_modules',
        '-o',
        '-name',
        '.git',
        '-o',
        '-name',
        'dist*',
        ')',
        '-prune',
        '-o',
        '-newermt',
        '-6 hours',
        '-print',
        '-quit',
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(
      pruned.trim(),
      'the retired basename glob would have seen this edit',
    ).toBe('');

    const result = classifyWorktree(
      await factsFor(repo, lane('lane-distname')),
    );
    expect(result.finished).toBe(false);
    expect(result.keepReasons).toContain(
      'modified recently — a session may be live',
    );
  }, 60_000);

  test('a worktree DIRECTORY named dist* is still walked, not pruned at its root', async () => {
    // The worst shape: `find` evaluates the start path, so the entire lane was
    // pruned at depth 0 and every file in it was invisible. A lane edited
    // seconds ago read as cold.
    const { repo, lane } = makeFixture();
    const deep = join(lane('dist-lane'), 'src', 'a', 'b', 'c', 'deep.ts');
    warm(deep);

    const pruned = execFileSync(
      'find',
      [
        lane('dist-lane'),
        '(',
        '-name',
        'node_modules',
        '-o',
        '-name',
        '.git',
        '-o',
        '-name',
        'dist*',
        ')',
        '-prune',
        '-o',
        '-newermt',
        '-6 hours',
        '-print',
        '-quit',
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(
      pruned.trim(),
      'the retired basename glob would have seen inside this lane',
    ).toBe('');

    const result = classifyWorktree(await factsFor(repo, lane('dist-lane')));
    expect(result.finished).toBe(false);
    expect(result.keepReasons).toContain(
      'modified recently — a session may be live',
    );
  }, 60_000);

  test('real build output at the worktree root is still pruned', async () => {
    // The other direction: the fix must not turn a `npm run build` into
    // "someone is working here". `lane-ignored` carries `dist/out.js`.
    const { repo, lane } = makeFixture();
    warm(join(lane('lane-ignored'), 'dist', 'out.js'));
    const result = classifyWorktree(await factsFor(repo, lane('lane-ignored')));
    expect(result.keepReasons).toEqual([]);
    expect(result.finished).toBe(true);
  }, 60_000);

  test('the primary checkout is never finished', async () => {
    const { repo } = makeFixture();
    const result = classifyWorktree(await factsFor(repo, repo));
    expect(result.keepReasons).toContain('primary checkout');
  }, 60_000);

  test('a branch with commits the base lacks is kept', async () => {
    const { repo, lane } = makeFixture();
    const result = classifyWorktree(await factsFor(repo, lane('lane-ahead')));
    expect(result.commitsNotInBase).toBe(1);
    expect(result.keepReasons).toContain('1 commit(s) not in the base');
  }, 60_000);

  test('a worktree whose directory is gone is kept, not silently cleared', async () => {
    // Fail-closed proof for the status and freshness catches: both commands
    // fail, and neither may report a benign zero.
    const { repo, lane } = makeFixture();
    rmSync(lane('lane-clean'), { recursive: true, force: true });
    const facts = await factsFor(repo, lane('lane-clean'));
    expect(facts.statusError).toBeTruthy();
    expect(facts.modifiedTrackedFiles).toBeNull();
    expect(facts.untrackedFiles).toBeNull();
    expect(facts.freshnessError).toBeTruthy();
    expect(classifyWorktree(facts).finished).toBe(false);
  }, 60_000);

  test('an unresolvable base keeps every branch, rather than reading as merged', async () => {
    // Fail-closed proof for the rev-list catch.
    const { repo, lane } = makeFixture();
    const facts = await factsFor(repo, lane('lane-clean'), {
      comparisonRef: 'origin/does-not-exist',
    });
    expect(facts.commitsNotInBase).toBeNull();
    expect(facts.baseError).toBeTruthy();
    expect(classifyWorktree(facts).finished).toBe(false);
  }, 60_000);

  test('on Windows the missing freshness check is named, not silently skipped', async () => {
    // `find -newermt` does not exist there. The original code let that fall
    // into a catch that reported "assume live" for every worktree: safe, but
    // a permanent silent no-op nobody would ever notice.
    const { repo, lane } = makeFixture();
    const facts = await factsFor(repo, lane('lane-clean'), {
      platform: 'win32',
    });
    expect(facts.freshnessError).toBe(FRESHNESS_UNSUPPORTED_PLATFORM);
    expect(classifyWorktree(facts).keepReasons).toContain(
      `freshness undecidable: ${FRESHNESS_UNSUPPORTED_PLATFORM}`,
    );
  }, 60_000);

  test('running from a SUBDIRECTORY still recognises the current worktree', () => {
    // HIGH-3. `entry.path === process.cwd()` held only from the worktree
    // root; from a subdirectory git removed the worktree out from under the
    // running process, and a linked worktree has no refusal of its own.
    const { repo, lane } = makeFixture();
    const subdirectory = join(lane('lane-clean'), 'src', 'a', 'b');
    const { status, stdout } = runCli(
      ['--repo', repo, '--base', 'main', '--json'],
      subdirectory,
    );
    expect(status).toBe(0);
    const report = JSON.parse(stdout);
    const entry = report.classifications.find(
      (candidate: { path: string }) => candidate.path === lane('lane-clean'),
    );
    expect(entry.finished).toBe(false);
    expect(entry.keepReasons).toContain('current worktree');
  }, 60_000);

  test('--base=<ref> is honored rather than silently degrading', () => {
    // In the dangerous direction: an operator passing a NARROWER base and
    // silently getting origin/main sees strictly more worktrees as done.
    const { repo, lane } = makeFixture();
    const empty = git(repo, ['rev-list', '--max-parents=0', 'main']).trim();
    git(repo, ['branch', 'narrow-base', empty]);
    // Wide base: every lane is merged. Narrow base: none of them are.
    const wide = JSON.parse(
      runCli(['--repo', repo, '--base=main', '--json'], repo).stdout,
    );
    const narrow = JSON.parse(
      runCli(['--repo', repo, '--base=narrow-base', '--json'], repo).stdout,
    );
    expect(wide.summary.finished).toBe(4);
    expect(narrow.summary.finished).toBe(0);
    const kept = narrow.classifications.find(
      (candidate: { path: string }) => candidate.path === lane('lane-clean'),
    );
    expect(kept.keepReasons).toContain('1 commit(s) not in the base');
  }, 60_000);

  test.each([
    [['--base'], 'requires a value'],
    [['--nope'], 'unrecognized argument'],
    [['--base', 'refs/heads/no-such-ref'], 'does not resolve'],
  ])(
    'exits 2 on %j',
    (args, expected) => {
      // A rejection path that has never executed is unproven: this asserts the
      // real exit STATUS of a real child process, not a thrown error object.
      const { repo } = makeFixture();
      const result = runCli(['--repo', repo, ...args], repo);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(expected);
    },
    60_000,
  );

  test('--help exits 0, documents the flags, and offers no mutation', () => {
    const { repo } = makeFixture();
    const { status, stdout } = runCli(['--help'], repo);
    expect(status).toBe(0);
    expect(stdout).toContain('--base <ref>');
    expect(stdout).toContain('--json');
    expect(stdout).toContain('--concurrency <n>');
    // The help text is the tool's own account of what it can do. It must not
    // offer a flag that changes anything, and it must hand the reader git's
    // command rather than implying this one will act.
    expect(stdout).not.toContain('--remove');
    expect(stdout).not.toContain('--dry-run');
    expect(stdout).not.toContain('--force');
    expect(stdout).toContain('git worktree remove <path>');
  }, 60_000);

  test('the retired destructive flags exit 2 rather than being ignored', () => {
    // `--remove=false` used to turn removal ON: the value was parsed and
    // discarded. A retired flag must be a usage error, not a silent no-op
    // that leaves a reader believing they asked for something.
    const { repo } = makeFixture();
    for (const flag of ['--remove', '--remove=false', '--dry-run', '--force']) {
      const result = runCli(['--repo', repo, '--base', 'main', flag], repo);
      expect(result.status, `${flag} did not exit 2`).toBe(2);
      expect(result.stderr).toContain('unrecognized argument');
    }
  }, 60_000);

  test('a full report run leaves every registered worktree in place', () => {
    // The whole scope decision in one assertion: the tool reads. Anything
    // that reintroduces a mutation path has to make this red.
    const { repo, lane } = makeFixture();
    const before = git(repo, ['worktree', 'list', '--porcelain', '-z']);
    const { status } = runCli(
      ['--repo', repo, '--base', 'main', '--verbose'],
      repo,
    );
    expect(status).toBe(0);
    expect(git(repo, ['worktree', 'list', '--porcelain', '-z'])).toBe(before);
    for (const name of [
      'lane-clean',
      'lane-untracked',
      'lane-ignored',
      'lane-ahead',
      'lane-distname',
      'dist-lane',
    ]) {
      expect(existsSync(lane(name)), `${name} was removed`).toBe(true);
    }
  }, 60_000);

  test('the report tells the reader to run git, and names git as the guard', () => {
    const { repo } = makeFixture();
    const { status, stdout } = runCli(['--repo', repo, '--base', 'main'], repo);
    expect(status).toBe(0);
    expect(stdout).toContain('FINISHED');
    expect(stdout).toContain('git worktree remove <path>');
    expect(stdout).toContain('refuses when the tree has modified');
    // A FINISHED line can only ever carry untracked=0 — a field that cannot
    // vary reads as a quantity somebody checked.
    expect(stdout).not.toContain('untracked=');
  }, 60_000);
});
