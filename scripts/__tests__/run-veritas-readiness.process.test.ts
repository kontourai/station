import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';

const wrapperSource = fileURLToPath(
  new URL('../run-veritas-readiness.mjs', import.meta.url),
);

// Stands in for the Veritas CLI with its range semantics: the changed set is
// the two-point `git diff from to`, and each changed file is read from the
// checkout, which is where the real CLI fails with ENOENT (#5120).
const FAKE_VERITAS = `
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const value = (flag) => { const at = args.lastIndexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
let files = [];
const from = value('--changed-from');
if (from) {
  const diff = spawnSync('git', ['diff', '--name-only', from, value('--changed-to') ?? 'HEAD'], { encoding: 'utf8' });
  if (diff.status !== 0) { process.stderr.write(diff.stderr); process.exit(2); }
  files = diff.stdout.split('\\n').filter(Boolean);
  for (const file of files) readFileSync(file);
}
const shellProbe = args.includes('--probe-shell')
  ? spawnSync('sh', ['-c', 'npm --version'], { encoding: 'utf8', windowsHide: true })
  : undefined;
process.stdout.write(JSON.stringify({ args, files, shellProbe }));
`;

const gitEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
};

describe('run-veritas-readiness merge-base range (#5120)', () => {
  const makeTempDir = trackTempDirs();
  let repo: string;
  let wrapper: string;

  const git = (...args: string[]): string => {
    const result = spawnSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: gitEnv(),
      windowsHide: true,
    });
    if (result.status !== 0)
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commitFile = (name: string): string => {
    writeFileSync(join(repo, name), `${name}\n`);
    git('add', name);
    git('commit', '-q', '-m', name);
    return git('rev-parse', 'HEAD');
  };
  const runWrapper = (
    args: string[],
    env = gitEnv(),
  ): {
    args: string[];
    files: string[];
    stderr: string;
    shellProbe?: { status: number; stdout: string; stderr: string };
  } => {
    const result = spawnSync(process.execPath, [wrapper, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env,
      windowsHide: true,
    });
    expect(result.status, result.stderr).toBe(0);
    return { ...JSON.parse(result.stdout), stderr: result.stderr };
  };

  let mergeBase: string;

  beforeEach(() => {
    const root = makeTempDir('station-readiness-range-');
    const tool = join(root, 'tool');
    mkdirSync(join(tool, 'scripts'), { recursive: true });
    mkdirSync(join(tool, 'node_modules/@kontourai/veritas/bin'), {
      recursive: true,
    });
    wrapper = join(tool, 'scripts/run-veritas-readiness.mjs');
    copyFileSync(wrapperSource, wrapper);
    writeFileSync(
      join(tool, 'node_modules/@kontourai/veritas/bin/veritas.mjs'),
      FAKE_VERITAS,
    );

    repo = join(root, 'repo');
    mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    mergeBase = commitFile('base.txt');
    git('checkout', '-q', '-b', 'feature');
    commitFile('feature.txt');
    // Another lane lands on main after this branch was cut, adding a file
    // the branch's checkout does not have.
    git('checkout', '-q', 'main');
    commitFile('main-only.txt');
    git('update-ref', 'refs/remotes/origin/main', 'main');
    git('checkout', '-q', 'feature');
  });

  test.runIf(process.platform === 'win32')(
    'preserves a mixed-case Windows Path for shell evidence commands',
    () => {
      const env = gitEnv();
      const pathKey = Object.keys(env).find(
        (key) => key.toLowerCase() === 'path',
      )!;
      const originalPath = env[pathKey];
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === 'path') delete env[key];
      }
      env.Path = originalPath;
      const run = runWrapper(['--probe-shell'], env);
      expect(run.shellProbe?.status, run.shellProbe?.stderr).toBe(0);
      expect(run.shellProbe?.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    },
  );

  test('a moving ref past the branch base evaluates only the branch changes', () => {
    const run = runWrapper([
      '--changed-from',
      'origin/main',
      '--changed-to',
      'HEAD',
    ]);
    expect(run.files).toEqual(['feature.txt']);
    expect(run.args).toEqual([
      'readiness',
      '--changed-from',
      mergeBase,
      '--changed-to',
      'HEAD',
    ]);
    expect(run.stderr).toContain(`using its merge base ${mergeBase}`);
  });

  test('an explicit base SHA passes through unchanged', () => {
    const run = runWrapper(['--changed-from', mergeBase]);
    expect(run.args).toEqual(['readiness', '--changed-from', mergeBase]);
    expect(run.files).toEqual(['feature.txt']);
    expect(run.stderr).toBe('');
  });

  test('the CI merge-ref invocation passes through unchanged', () => {
    // CI checks out the PR merged onto its base and diffs `HEAD^..HEAD`.
    git('checkout', '-q', '--detach', 'main');
    git('merge', '-q', '--no-ff', '-m', 'merge', 'feature');
    const head = git('rev-parse', 'HEAD');
    const base = git('rev-parse', 'HEAD^');
    const ciArgs = ['--changed-from', base, '--changed-to', head];
    const run = runWrapper(ciArgs);
    expect(run.args).toEqual(['readiness', ...ciArgs]);
    expect(run.files).toEqual(['feature.txt']);

    const fast = runWrapper(['--working-tree', '--format', 'json']);
    expect(fast.args).toEqual([
      'readiness',
      '--working-tree',
      '--format',
      'json',
    ]);
  });
});
