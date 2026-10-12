/**
 * #3101 slice F: the fixture policy's "a baseline entry may only shrink" rule
 * is judged against the baseline this branch started from (its merge base
 * with origin/main), not origin/main's tip. Runs the real `main()` in a child
 * process against a real Git graph, so the git reads it makes are the ones
 * under test. The shipped baseline is empty, so only a fixture can reach this.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { sanitizedGitEnvironment } from '../lib/git-environment.mjs';

const POLICY = pathToFileURL(
  realpathSync('scripts/test-fixture-policy.mjs'),
).href;
const CASE_TIMEOUT = 60_000;
const makeTempDir = trackTempDirs();

const entry = (name: string) => ({
  file: `tests/${name}.spec.ts`,
  rule: 'click',
  fingerprint: name.repeat(8),
  reason: 'legacy-unqualified',
});

function repo() {
  const root = realpathSync(makeTempDir('station-fixture-policy-base-'));
  const env = {
    ...sanitizedGitEnvironment(process.env),
    GIT_CEILING_DIRECTORIES: join(root, '..'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, {
      cwd: root,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  mkdirSync(join(root, 'tests'));
  mkdirSync(join(root, 'scripts'));
  const step = (entries: object[], extra?: string) => {
    if (extra) writeFileSync(join(root, 'tests', extra), 'export {};\n');
    writeFileSync(
      join(root, 'scripts', 'test-fixture-policy-baseline.json'),
      `${JSON.stringify({ version: 1, entries }, null, 2)}\n`,
    );
    git('add', '-A');
    git('commit', '-qm', 'step');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  // Merge base: two legacy entries.
  const base = step([entry('a'), entry('b')], 'helper.ts');
  // Main moves on and drops entry b.
  const mainTip = step([entry('a')]);
  git('update-ref', 'refs/remotes/origin/main', mainTip);
  git('checkout', '-q', '-b', 'feat', base);
  const run = () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { main } from ${JSON.stringify(POLICY)}; main(process.argv[1]);`,
        root,
      ],
      { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 45_000 },
    );
    expect(result.error).toBeUndefined();
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
    };
  };
  return { step, run };
}

describe('fixture-policy baseline growth is judged against the merge base', () => {
  it('does not call an entry main has since removed a new bypass', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const { step, run } = repo();
    step([entry('a'), entry('b')], 'unrelated.ts');
    const { output } = run();
    // The fixture has no findings, so the stale-entry check still fails; the
    // claim under test is only that nothing is reported as newly added.
    expect(output).toContain('[fixture-policy]');
    expect(output).not.toContain('New bypass cannot be baselined');
  });

  it('still refuses a branch that adds a baseline entry (exit 1)', {
    timeout: CASE_TIMEOUT,
  }, () => {
    const { step, run } = repo();
    step([entry('a'), entry('b'), entry('c')]);
    const { status, output } = run();
    expect(output).toContain(
      'New bypass cannot be baselined: tests/c.spec.ts click',
    );
    expect(output).not.toContain('New bypass cannot be baselined: tests/b');
    expect(status, output).toBe(1);
  });
});
