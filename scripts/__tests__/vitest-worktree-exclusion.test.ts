import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCLI, resolveConfig } from 'vitest/node';
import type { JsonAssertionResult } from 'vitest/reporters';
import packageJson from '../../package.json';
import config from '../../vitest.config';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';
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
const NAMED_FOCUSED_TEST =
  'vitest run root is a unique sibling per call, so concurrent runs cannot share one';

function runFocusedCli(args: string[]) {
  const root = path.resolve(import.meta.dirname, '../..');
  return spawnSyncBounded(
    process.execPath,
    [path.join(root, 'scripts', 'run-focused-tests.mjs'), ...args],
    { cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true },
  );
}

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
      'node scripts/heavy-check-slot.mjs test:focused scripts/run-focused-tests.mjs',
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
    // Coverage runs through the resource-profiled corpus slices, each bounded
    // by its group's worker count (scripts/run-vitest-corpus.mjs).
    expect(packageJson.scripts['test:coverage:raw']).toBe(
      'node scripts/check-full-regression-browser.mjs && node scripts/run-coverage-corpus.mjs',
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
    {
      names: [NAMED_FOCUSED_TEST],
      summary: /Tests\s+1 passed \| 1 skipped \(2\)/,
    },
    {
      names: [
        NAMED_FOCUSED_TEST,
        'vitest run root lives under the Station temp root so the day-old sweep reclaims it',
      ],
      summary: /Tests\s+2 passed \(2\)/,
    },
  ])(
    'runs only the requested fully qualified names through the CLI: $names',
    ({ names, summary }) => {
      const result = runFocusedCli([
        ELIGIBLE_FOCUSED_TEST,
        ...names.map((name) => `--test-name=${name}`),
      ]);

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(plainFocusedVitestOutput(result.stdout)).toMatch(summary);
      expect(result.stdout).toContain(
        `selected named cases passed: ${JSON.stringify(names)}`,
      );
    },
    35_000,
  );

  it.each([
    {
      label: 'unmatched, all-skipped',
      names: ['vitest run root missing case'],
      summary: /Tests\s+2 skipped \(2\)/,
    },
    {
      label: 'partially matched',
      names: [NAMED_FOCUSED_TEST, 'vitest run root missing case'],
      summary: /Tests\s+1 passed \| 1 skipped \(2\)/,
    },
  ])(
    'rejects an $label named selection after the real child',
    ({ names, summary }) => {
      const result = runFocusedCli([
        ELIGIBLE_FOCUSED_TEST,
        ...names.map((name) => `--test-name=${name}`),
      ]);

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(2);
      expect(plainFocusedVitestOutput(result.stdout)).toMatch(summary);
      expect(result.stderr).toContain(
        'selected tests did not all pass exactly once',
      );
      expect(result.stdout).not.toContain('selected named cases passed:');
    },
    35_000,
  );

  it.each([
    ['--test-name='],
    ['--test-name= leading space'],
    ['--test-name=embedded\nnewline'],
    ['--test-name=duplicate', '--test-name=duplicate'],
    ['--test-name', NAMED_FOCUSED_TEST],
    ['--config=foreign.config.ts'],
    ['--maxWorkers=2'],
    [`${ELIGIBLE_FOCUSED_TEST}:1`],
    [process.execPath],
  ])('rejects malformed selectors and unrelated arguments: %j', (...args) => {
    const result = runFocusedCli([ELIGIBLE_FOCUSED_TEST, ...args]);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).not.toMatch(/RUN\s+v/);
  });

  it('treats a selected name literally, including regular-expression characters', async () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const name = 'suite [case].* (v2)+ $done?';
    const invocation = buildFocusedVitestInvocation(
      [ELIGIBLE_FOCUSED_TEST, `--test-name=${name}`],
      root,
    );
    const cli = parseCLI(['vitest', ...invocation.args.slice(1)]);
    const { vitestConfig } = await resolveConfig(cli.options, { root });
    const pattern = vitestConfig.testNamePattern;

    expect(pattern?.test(name)).toBe(true);
    expect(pattern?.test(`prefix ${name}`)).toBe(false);
    expect(pattern?.test(`${name} suffix`)).toBe(false);
    expect(pattern?.test('suite cXYZ v22 done')).toBe(false);
  });

  it('refuses a missing selected-test report despite a successful child exit', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const invocation = buildFocusedVitestInvocation(
      [ELIGIBLE_FOCUSED_TEST, `--test-name=${NAMED_FOCUSED_TEST}`],
      root,
    );

    expect(
      focusedVitestVerdict({
        inspection: { runRoot: root, expectedRoot: root, zeroTests: false },
        invocation,
        exitCode: 0,
      }),
    ).toMatchObject({ exitCode: 2 });
  });

  it('refuses a passed case with a skipped duplicate of its selected full name', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const invocation = buildFocusedVitestInvocation(
      [ELIGIBLE_FOCUSED_TEST, `--test-name=${NAMED_FOCUSED_TEST}`],
      root,
    );
    const passed: JsonAssertionResult = {
      ancestorTitles: ['vitest run root'],
      fullName: NAMED_FOCUSED_TEST,
      title:
        'is a unique sibling per call, so concurrent runs cannot share one',
      status: 'passed',
      failureMessages: [],
      meta: {},
      tags: [],
    };

    expect(
      focusedVitestVerdict({
        inspection: { runRoot: root, expectedRoot: root, zeroTests: false },
        invocation,
        exitCode: 0,
        selectionReport: {
          success: true,
          numFailedTests: 0,
          numFailedTestSuites: 0,
          numPassedTests: 1,
          testResults: [
            {
              name: path.join(root, ELIGIBLE_FOCUSED_TEST),
              message: '',
              status: 'passed',
              startTime: 0,
              endTime: 0,
              assertionResults: [passed, { ...passed, status: 'pending' }],
            },
          ],
        },
      }),
    ).toMatchObject({ exitCode: 2 });
  });

  it('refuses a signal termination with no exit code', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const invocation = buildFocusedVitestInvocation(
      [ELIGIBLE_FOCUSED_TEST],
      root,
    );

    expect(
      focusedVitestVerdict({
        inspection: { runRoot: root, expectedRoot: root, zeroTests: false },
        invocation,
        exitCode: null,
        signal: 'SIGTERM',
      }),
    ).toMatchObject({
      exitCode: 2,
      diagnostic: expect.stringContaining('SIGTERM'),
    });
  });

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
