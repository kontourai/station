import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCLI, resolveConfig } from 'vitest/node';
import packageJson from '../../package.json';
import config from '../../vitest.config';
import {
  buildFocusedVitestInvocation,
  focusedVitestVerdict,
  inspectFocusedVitestOutput,
  plainFocusedVitestOutput,
} from '../run-focused-tests.mjs';
import { buildVitestArgs } from '../run-prepush-tier.mjs';

const ELIGIBLE_FOCUSED_TEST = 'scripts/__tests__/vitest-run-root.test.ts';
const EXCLUDED_WORKTREE_TEST =
  'scripts/__tests__/fixtures/station-worktrees/sentinel/scripts/__tests__/station-dogfood-reconcile.test.ts';

describe('Vitest worktree exclusion', () => {
  it('keeps repository-local Station worktrees out of test discovery', () => {
    const testConfig = config.test as { exclude?: string[] };

    expect(testConfig.exclude).toContain('**/station-worktrees/**');

    const repoRoot = path.resolve(import.meta.dirname, '../..');
    const result = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
        'list',
        ELIGIBLE_FOCUSED_TEST,
        EXCLUDED_WORKTREE_TEST,
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('fixtures/station-worktrees/sentinel');
    // Filter the temp-reclaimer's "[vitest] reclaimed N stale Station temp
    // directories" chatter (station#998) — it shares stdout with `vitest list`
    // after any interrupted or heavy prior run and is not a test entry.
    const listedTests = result.stdout
      .trim()
      .split('\n')
      .filter((line) => !line.startsWith('[vitest]'));
    // The discovered total differs by platform because macOS-only dogfood
    // scenarios are skipped during collection elsewhere. The exclusion proof
    // is the sentinel assertion above; avoid coupling it to unrelated corpus
    // growth or the host operating system.
    expect(listedTests.length).toBeGreaterThan(0);
  }, 35_000);

  it('bounds workers in every canonical unit-test lane', () => {
    expect(packageJson.scripts.test).toBe('npm run test:prepush');
    expect(packageJson.scripts['test:focused']).toBe(
      'node scripts/run-focused-tests.mjs',
    );
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    const focused = buildFocusedVitestInvocation(
      [ELIGIBLE_FOCUSED_TEST],
      repoRoot,
    );
    expect(focused.args).toEqual(
      expect.arrayContaining([
        '--root',
        repoRoot,
        '--maxWorkers=1',
        '--no-file-parallelism',
      ]),
    );
    expect(buildVitestArgs()).toContain('--maxWorkers=1');
    expect(buildVitestArgs()).toContain('--no-file-parallelism');
    expect(packageJson.scripts['test:full']).toBe(
      'node scripts/run-verification.mjs request test-full',
    );
    expect(packageJson.scripts['test:full:raw']).toBe(
      'node scripts/run-vitest-corpus.mjs',
    );
    expect(packageJson.scripts['test:coverage']).toBe(
      'node scripts/run-verification.mjs request test-coverage',
    );
    expect(packageJson.scripts['test:coverage:raw']).toContain(
      '--maxWorkers=1',
    );
  });

  it('resolves the shared worker cap while allowing explicit overrides', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    const defaultCli = parseCLI(['vitest', 'run']);
    const explicitCli = parseCLI(['vitest', 'run', '--maxWorkers=1']);

    const [{ vitestConfig: defaultConfig }, { vitestConfig: explicitConfig }] =
      await Promise.all([
        resolveConfig(defaultCli.options, { root: repoRoot }),
        resolveConfig(explicitCli.options, { root: repoRoot }),
      ]);

    expect(defaultConfig.maxWorkers).toBe(4);
    expect(explicitConfig.maxWorkers).toBe(1);
  });

  it('runs an exact focused file against the active worktree root', () => {
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    const result = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, 'scripts', 'run-focused-tests.mjs'),
        ELIGIBLE_FOCUSED_TEST,
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`[test:focused] root=${repoRoot}; files=1`);
    expect(inspectFocusedVitestOutput(result.stdout, repoRoot)).toMatchObject({
      runRoot: repoRoot,
      expectedRoot: repoRoot,
      zeroTests: false,
    });
    // Strip with the wrapper's own helper rather than a second copy of the
    // escape pattern: vitest colours this summary, and a raw match reads a
    // passing run as a failing one (station#1739).
    expect(plainFocusedVitestOutput(result.stdout)).toMatch(
      /Test Files\s+1 passed \(1\)/,
    );
  }, 35_000);

  it.each([
    ['missing', null],
    ['foreign', path.resolve(import.meta.dirname, '../../foreign-worktree')],
  ])('rejects a %s Vitest RUN root', (_case, runRoot) => {
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    const invocation = buildFocusedVitestInvocation(
      [ELIGIBLE_FOCUSED_TEST],
      repoRoot,
    );
    expect(
      focusedVitestVerdict({
        inspection: {
          runRoot,
          expectedRoot: repoRoot,
          zeroTests: false,
        },
        invocation,
        exitCode: 0,
      }),
    ).toMatchObject({
      exitCode: 2,
      diagnostic: expect.stringContaining('rejected verdict'),
    });
  });

  it('does not reinterpret passing test output as zero collection', () => {
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    const invocation = buildFocusedVitestInvocation(
      [ELIGIBLE_FOCUSED_TEST],
      repoRoot,
    );
    expect(
      focusedVitestVerdict({
        inspection: {
          runRoot: repoRoot,
          expectedRoot: repoRoot,
          zeroTests: true,
        },
        invocation,
        exitCode: 0,
      }),
    ).toEqual({ exitCode: 0, diagnostic: null });
  });

  it('fails actionably when an existing sibling-worktree file collects zero tests', () => {
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    const result = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, 'scripts', 'run-focused-tests.mjs'),
        EXCLUDED_WORKTREE_TEST,
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      `existing focused test files collected zero tests under ${repoRoot}`,
    );
    expect(result.stderr).toContain(EXCLUDED_WORKTREE_TEST);
  }, 35_000);
});
