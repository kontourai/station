import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { runFastChecksShardCli } from '../fast-checks-shard.mjs';
import {
  digestText,
  FAST_CHECKS_PART_JOBS,
  FAST_CHECKS_PLAN_BUDGET_MS,
  FAST_CHECKS_PLAN_KIND,
  FAST_CHECKS_RECEIPT_KIND,
  FAST_CHECKS_SHARD_COUNT,
  sliceFastChecksPlan,
} from '../lib/fast-checks-shards.mjs';
import {
  discoverRelatedTestFiles,
  planChangedVerificationShards,
  planChangedVitestExecutions,
  prepareChangedSelection,
  runChangedVerification,
  runChangedVerificationShard,
  selectChangedVerification,
  vitestExecutionsForGroups,
} from '../run-changed-verification.mjs';
import { buildTestImpactManifest } from '../test-impact-manifest.mjs';
import { listWorkspacePackageManifests } from '../workspace-dependency-provenance.mjs';
import { FIXTURE_TOOLCHAIN_IDENTITY } from './fixtures/verification-toolchain.mjs';
import { runWorkflowShell } from './fixtures/workflow-shell.js';

const root = resolve(import.meta.dirname, '../..');
const makeTempDir = trackTempDirs();
/**
 * The CLI and the only modules its slice, empty-run and aggregate paths may
 * load. Each fixture repository gets a copy and no node_modules, so a path
 * that reached for the selector or any dependency fails with a missing
 * module: ci.yml runs the aggregator, and an empty shard, without
 * `npm run dependencies:ci`.
 */
const DEPENDENCY_FREE_CLI = [
  'scripts/fast-checks-shard.mjs',
  'scripts/lib/fast-checks-shards.mjs',
  'scripts/lib/module-entry.mjs',
];

/** A throwaway Git repository: the CLI reads HEAD for plan identity. */
function repository() {
  const directory = makeTempDir('station-fast-checks-');
  for (const file of DEPENDENCY_FREE_CLI) {
    mkdirSync(join(directory, file, '..'), { recursive: true });
    copyFileSync(join(root, file), join(directory, file));
  }
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: directory, windowsHide: true });
  git('init', '-q');
  git('config', 'user.email', 'fast-checks@test.invalid');
  git('config', 'user.name', 'fast-checks');
  writeFileSync(join(directory, 'README'), 'fixture\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: directory,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  return { directory, head };
}

function planFor(head: string, files: string[], deferred = false) {
  return {
    schemaVersion: 1,
    kind: FAST_CHECKS_PLAN_KIND,
    base: 'base-sha',
    headSha: head,
    shardCount: FAST_CHECKS_SHARD_COUNT,
    deferredLanes: deferred ? [{ id: 'test-full', reasons: ['fixture'] }] : [],
    groups: files.length ? [{ resourceGroup: 'ordinary', files }] : [],
    fileCount: files.length,
  };
}

function cli(
  args: string[],
  { cwd, env = {} }: { cwd: string; env?: Record<string, string> },
) {
  return spawnSync(
    process.execPath,
    ['scripts/fast-checks-shard.mjs', ...args],
    {
      cwd,
      encoding: 'utf8',
      // Only what the runner provides; no inherited GitHub context.
      env: { PATH: process.env.PATH ?? '', ...env },
      timeout: 60_000,
      windowsHide: true,
    },
  );
}

const successNeeds = Object.fromEntries([
  ['classify', { result: 'skipped' }],
  ...FAST_CHECKS_PART_JOBS.map((job) => [job, { result: 'success' }]),
]);

/**
 * The aggregator's on-disk inputs, laid out as download-artifact writes
 * them: the plan in one directory, each receipt artifact in its own.
 */
function aggregateFixture({
  files = [
    'a/a.test.ts',
    'a/b.test.ts',
    'a/c.test.ts',
    'a/d.test.ts',
    'a/e.test.ts',
  ],
  receipt = (_index: number, value: Record<string, unknown>) => value,
  omit = [] as number[],
  shardCount = 4,
} = {}) {
  const { directory, head } = repository();
  const plan = { ...planFor(head, files), shardCount };
  const planText = `${JSON.stringify(plan, null, 2)}\n`;
  mkdirSync(join(directory, 'plan'));
  writeFileSync(join(directory, 'plan/fast-checks-plan.json'), planText);
  for (let index = 1; index <= shardCount; index += 1) {
    if (omit.includes(index)) continue;
    const slice = sliceFastChecksPlan(plan, {
      index,
      count: shardCount,
    });
    const artifact = join(
      directory,
      `receipts/fast-checks-receipt-${index}-4242-1`,
    );
    mkdirSync(artifact, { recursive: true });
    writeFileSync(
      join(artifact, 'fast-checks-shard-receipt.json'),
      JSON.stringify(
        receipt(index, {
          schemaVersion: 1,
          kind: FAST_CHECKS_RECEIPT_KIND,
          shard: `${index}/${shardCount}`,
          runId: '4242',
          runAttempt: 1,
          headSha: head,
          planSha256: digestText(planText),
          status: slice.files.length ? 'completed' : 'empty',
          passed: true,
          files: slice.files,
          counts: {
            executed: slice.files.length,
            passed: slice.files.length,
            failed: 0,
            infrastructureErrors: 0,
          },
        }),
      ),
    );
  }
  return directory;
}

function aggregate(directory: string, needs: unknown = successNeeds) {
  return cli(['aggregate', '--plan-dir=plan', '--receipts-dir=receipts'], {
    cwd: directory,
    env: { GITHUB_RUN_ID: '4242', NEEDS: JSON.stringify(needs) },
  });
}

describe('fast-checks aggregator exit status (child process)', () => {
  test.each([1, 2, 4])(
    'passes with %i planned shards and no artifacts for omitted legs',
    (shardCount) => {
      const result = aggregate(aggregateFixture({ shardCount }));
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('[fast-checks] PASS');
    },
  );

  test('rejects a plan exceeding the four-runner cap', () => {
    const result = aggregate(aggregateFixture({ shardCount: 5 }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('plan exceeds the maximum 4 shards');
  });

  test('fails when a shard failed', () => {
    const result = aggregate(
      aggregateFixture({
        receipt: (index, value) =>
          index === 2 ? { ...value, status: 'failed', passed: false } : value,
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("shard 2/4 reported 'failed'");
  });

  test.each(['skipped', 'cancelled', 'failure'])(
    'fails when a shard job was %s, even with every receipt present',
    (outcome) => {
      const result = aggregate(aggregateFixture(), {
        ...successNeeds,
        'fast-checks-shard': { result: outcome },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `fast-checks-shard finished '${outcome}'`,
      );
    },
  );

  test('fails when the checkout is not the commit the plan was computed for', () => {
    const directory = aggregateFixture();
    execFileSync(
      'git',
      [
        '-c',
        'user.email=fast-checks@test.invalid',
        '-c',
        'user.name=fast-checks',
        'commit',
        '--allow-empty',
        '-q',
        '-m',
        'moved on',
      ],
      { cwd: directory, windowsHide: true },
    );
    const result = aggregate(directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /plan was computed for [0-9a-f]{40}, not the checked-out [0-9a-f]{40}/,
    );
  });

  test('fails when a shard left no receipt', () => {
    const result = aggregate(aggregateFixture({ omit: [3] }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('shard 3/4 left no receipt');
  });

  test('fails when the plan is missing', () => {
    const directory = aggregateFixture();
    rmSync(join(directory, 'plan'), { recursive: true });
    const result = aggregate(directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the fast-checks plan artifact is missing');
  });

  test('fails when the job results are unreadable', () => {
    const result = cli(
      ['aggregate', '--plan-dir=plan', '--receipts-dir=receipts'],
      { cwd: aggregateFixture(), env: { GITHUB_RUN_ID: '4242' } },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fast-checks-plan finished 'missing'");
  });
});

describe('fast-checks shard runner (child process)', () => {
  test('an empty slice passes explicitly with an empty receipt and loads no dependencies', () => {
    // Two files over four shards: shards 3 and 4 get nothing. The fixture
    // holds only the dependency-free CLI, so a shard that tried to load the
    // selector would fail here on a missing module.
    const { directory, head } = repository();
    const plan = planFor(head, ['a/a.test.ts', 'a/b.test.ts']);
    writeFileSync(join(directory, 'plan.json'), JSON.stringify(plan));
    const output = join(directory, 'github-output');
    const slice = cli(['slice', '--plan=plan.json', '--shard=4/4'], {
      cwd: directory,
      env: { GITHUB_OUTPUT: output },
    });
    expect(slice.status, slice.stderr).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('empty=true\n');

    const run = cli(
      ['run', '--plan=plan.json', '--shard=4/4', '--receipt=out/receipt.json'],
      {
        cwd: directory,
        env: { GITHUB_RUN_ID: '4242', GITHUB_RUN_ATTEMPT: '1' },
      },
    );
    expect(run.status, run.stderr).toBe(0);
    const receipt = JSON.parse(
      readFileSync(join(directory, 'out/receipt.json'), 'utf8'),
    );
    expect(receipt).toMatchObject({
      shard: '4/4',
      status: 'empty',
      passed: true,
      files: [],
      headSha: head,
      runId: '4242',
      runAttempt: 1,
      counts: { executed: 0 },
    });
  });

  test('reports a non-empty slice to the output so dependencies install', () => {
    const { directory, head } = repository();
    writeFileSync(
      join(directory, 'plan.json'),
      JSON.stringify(planFor(head, ['a/a.test.ts', 'a/b.test.ts'])),
    );
    const output = join(directory, 'github-output');
    const slice = cli(['slice', '--plan=plan.json', '--shard=1/4'], {
      cwd: directory,
      env: { GITHUB_OUTPUT: output },
    });
    expect(slice.status, slice.stderr).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('empty=false\n');
  });

  test('refuses a plan computed for another commit with a failing receipt', () => {
    const { directory } = repository();
    writeFileSync(
      join(directory, 'plan.json'),
      JSON.stringify(planFor('b'.repeat(40), ['a/a.test.ts'])),
    );
    const run = cli(
      ['run', '--plan=plan.json', '--shard=1/4', '--receipt=receipt.json'],
      {
        cwd: directory,
        env: { GITHUB_RUN_ID: '4242', GITHUB_RUN_ATTEMPT: '1' },
      },
    );
    expect(run.status).toBe(1);
    expect(
      JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8')),
    ).toMatchObject({ status: 'infrastructure_error', passed: false });
  });

  test.each([
    [['run', '--plan=plan.json', '--shard=1/4']],
    [['slice', '--plan=plan.json', '--shard=1/4', '--extra=1']],
    [['bogus']],
  ])('exits 2 on usage %j', (args) => {
    const { directory } = repository();
    expect(cli(args, { cwd: directory }).status).toBe(2);
  });

  test('exits 2 on a shard count that does not match the plan', () => {
    const { directory, head } = repository();
    writeFileSync(
      join(directory, 'plan.json'),
      JSON.stringify(planFor(head, ['a/a.test.ts'])),
    );
    expect(
      cli(['slice', '--plan=plan.json', '--shard=1/2'], { cwd: directory })
        .status,
    ).toBe(2);
  });
});

describe('fast-checks shard runner (in process)', () => {
  function inProcessFixture(files = ['a/a.test.ts', 'a/b.test.ts']) {
    const { directory, head } = repository();
    writeFileSync(
      join(directory, 'plan.json'),
      JSON.stringify(planFor(head, files)),
    );
    return directory;
  }
  const env = {
    GITHUB_RUN_ID: '4242',
    GITHUB_RUN_ATTEMPT: '2',
    npm_execpath: '/npm/bin/npm-cli.js',
  };
  const quiet = { report: () => {}, error: () => {} };

  test('a failing slice writes a failing receipt and exits 1', async () => {
    const cwd = inProcessFixture();
    const runShard = vi.fn(async () => ({
      status: 'failed',
      counts: { executed: 1, passed: 0, failed: 1, infrastructureErrors: 0 },
      executions: [{ resourceGroup: 'ordinary', exitCode: 1 }],
    }));
    const status = await runFastChecksShardCli(
      ['run', '--plan=plan.json', '--shard=1/4', '--receipt=receipt.json'],
      { cwd, env, runShard, ...quiet },
    );
    expect(status).toBe(1);
    expect(runShard).toHaveBeenCalledWith(
      expect.objectContaining({ fileCount: 2 }),
      {
        groups: [{ resourceGroup: 'ordinary', files: ['a/a.test.ts'] }],
        files: ['a/a.test.ts'],
      },
      expect.objectContaining({ root: cwd }),
    );
    expect(
      JSON.parse(readFileSync(join(cwd, 'receipt.json'), 'utf8')),
    ).toMatchObject({ status: 'failed', passed: false, runAttempt: 2 });
  });

  test('a non-empty shard refuses to run outside its npm entry (review F1)', async () => {
    const cwd = inProcessFixture();
    const runShard = vi.fn();
    const { npm_execpath: _npm, ...withoutNpm } = env;
    expect(
      await runFastChecksShardCli(
        ['run', '--plan=plan.json', '--shard=1/4', '--receipt=receipt.json'],
        { cwd, env: withoutNpm, runShard, ...quiet },
      ),
    ).toBe(2);
    expect(runShard).not.toHaveBeenCalled();
  });

  test('a shard that outlives its budget is aborted and fails', async () => {
    const cwd = inProcessFixture();
    const status = await runFastChecksShardCli(
      ['run', '--plan=plan.json', '--shard=1/4', '--receipt=receipt.json'],
      {
        cwd,
        env,
        deadlineMs: 20,
        runShard: (_plan, _slice, { signal }) =>
          new Promise((resolvePromise) =>
            signal.addEventListener('abort', () =>
              resolvePromise({
                status: 'completed',
                counts: {
                  executed: 1,
                  passed: 1,
                  failed: 0,
                  infrastructureErrors: 0,
                },
              }),
            ),
          ),
        ...quiet,
      },
    );
    expect(status).toBe(1);
    expect(
      JSON.parse(readFileSync(join(cwd, 'receipt.json'), 'utf8')).status,
    ).toBe('infrastructure_error');
  });

  test('a shard runner that throws still leaves a failing receipt', async () => {
    const cwd = inProcessFixture();
    const status = await runFastChecksShardCli(
      ['run', '--plan=plan.json', '--shard=2/4', '--receipt=receipt.json'],
      {
        cwd,
        env,
        runShard: async () => {
          throw new Error('vitest could not start');
        },
        ...quiet,
      },
    );
    expect(status).toBe(1);
    expect(
      JSON.parse(readFileSync(join(cwd, 'receipt.json'), 'utf8')),
    ).toMatchObject({
      status: 'infrastructure_error',
      preparation: { error: 'vitest could not start' },
    });
  });
});

describe('fast-checks shard execution verdicts', () => {
  // Real test files, so the path validation runs as it does in CI; the Vitest
  // child is replaced by a reporter fixture.
  const slice = {
    groups: [
      {
        resourceGroup: 'ordinary',
        files: ['scripts/__tests__/fast-checks-shards.test.ts'],
      },
    ],
    files: ['scripts/__tests__/fast-checks-shards.test.ts'],
  };
  const report = (failed: number, total = 2) =>
    JSON.stringify({
      numTotalTestSuites: 1,
      numTotalTests: total,
      numPassedTests: total - failed,
      numFailedTests: failed,
    });
  const boundExecution = () => ({
    env: { STATION_VERIFICATION_HISTORY_REF: 'f'.repeat(40) },
  });
  const fakeRun = (status: number, contents: string) =>
    vi.fn(async (_command: string, args: string[], _options?: unknown) => {
      const output = args.find((arg) => arg.startsWith('--outputFile='));
      if (output) writeFileSync(output.slice('--outputFile='.length), contents);
      return { status, launch: { started: true } };
    });

  test.each([
    ['a passing slice', 0, report(0), false, 'completed'],
    ['a passing slice of a deferred plan', 0, report(0), true, 'provisional'],
    ['a failing slice', 1, report(1), false, 'failed'],
    [
      'a slice whose child failed with green JSON',
      1,
      report(0),
      false,
      'failed',
    ],
    ['a slice that executed nothing', 0, report(0, 0), false, 'provisional'],
  ])(
    'reports %s as %s',
    async (_name, status, contents, deferred, expected) => {
      const result = await runChangedVerificationShard(
        {
          deferredLanes: deferred ? [{ id: 'test-full', reasons: [] }] : [],
        },
        slice,
        {
          root,
          run: fakeRun(status, contents),
          vitestPath: 'vitest.mjs',
          prepareExecution: boundExecution,
        },
      );
      expect(result.status).toBe(expected);
    },
  );

  test('runs the dependency provenance preflight before any Vitest child', async () => {
    const run = fakeRun(0, report(0));
    await expect(
      runChangedVerificationShard({ deferredLanes: [] }, slice, {
        root,
        run,
        vitestPath: 'vitest.mjs',
        assertDependencyProvenance: () => {
          throw new Error('workspace package resolves outside this tree');
        },
      }),
    ).rejects.toThrow('workspace package resolves outside this tree');
    expect(run).not.toHaveBeenCalled();
  });

  test('runs no child when the execution preparation refuses (stale install)', async () => {
    const run = fakeRun(0, report(0));
    await expect(
      runChangedVerificationShard({ deferredLanes: [] }, slice, {
        root,
        run,
        vitestPath: 'vitest.mjs',
        prepareExecution: () => {
          throw new Error('environment-stale: node_modules does not match');
        },
      }),
    ).rejects.toThrow('environment-stale');
    expect(run).not.toHaveBeenCalled();
  });

  test('runs each file under its resource group profile, in the prepared environment', async () => {
    const run = fakeRun(0, report(0));
    await runChangedVerificationShard({ deferredLanes: [] }, slice, {
      root,
      run,
      vitestPath: 'vitest.mjs',
      prepareExecution: boundExecution,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][2]).toMatchObject({
      env: { STATION_VERIFICATION_HISTORY_REF: 'f'.repeat(40) },
    });
    expect(run.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        'vitest.mjs',
        'run',
        './scripts/__tests__/fast-checks-shards.test.ts',
      ]),
    );
  });
});

describe('sharding a real selection', () => {
  // Repository discovery prepares the fixture; this test checks plan parity.
  const manifest = buildTestImpactManifest({ root });

  test('the shards together run exactly the unsharded plan, with no duplicates', async () => {
    // Every tracked scripts test, as a real diff that touched them all: real
    // manifest routing, the real resource partition (ordinary, process-heavy
    // and the serial groups), no stubbed file list. Changed test files are
    // explicit targets, so no discovery child is needed.
    const paths = execFileSync(
      'git',
      ['ls-files', 'scripts/__tests__/*.test.ts'],
      { cwd: root, encoding: 'utf8', windowsHide: true },
    )
      .trim()
      .split('\n')
      // A test whose own edge defers to a lane would make the whole diff a
      // deferred, explicit-only selection; keep the ones that route cleanly.
      .filter(
        (path) =>
          selectChangedVerification(
            [path],
            manifest as Parameters<typeof selectChangedVerification>[1],
          ).lanes.length === 0,
      );
    expect(paths.length).toBeGreaterThan(100);
    const changedPathsFn = () => ({ mergeBase: 'HEAD', paths });
    const plan = await planChangedVerificationShards('HEAD', {
      root,
      changedPathsFn,
      headSha: 'c'.repeat(40),
      shardCount: FAST_CHECKS_SHARD_COUNT,
    });
    expect(plan.deferredLanes).toEqual([]);
    expect(plan.fileCount).toBe(paths.length);
    expect(plan.groups.map((group) => group.resourceGroup)).toEqual(
      expect.arrayContaining([
        'ordinary',
        'process-heavy',
        'process-exclusive',
      ]),
    );

    const { executionSelection } = prepareChangedSelection('HEAD', {
      root,
      changedPathsFn,
    });
    const unsharded = await planChangedVitestExecutions(
      root,
      executionSelection,
      { vitestPath: 'vitest.mjs' },
    );
    // Each file with the resource profile (group and worker flags) it runs
    // under, so a shard that ran a file under another profile also fails.
    const profiled = (
      executions: Array<{ resourceGroup: string; command: string[] }>,
    ) =>
      executions.flatMap((execution) => {
        const flags = execution.command
          .filter((argument) => argument.startsWith('--'))
          .join(' ');
        return execution.command
          .filter((argument) => argument.startsWith('./'))
          .map((file) => `${execution.resourceGroup} ${flags} ${file}`);
      });
    const expected = profiled(unsharded);
    expect(expected).toHaveLength(paths.length);

    for (let count = 1; count <= 8; count += 1) {
      const sharded = Array.from({ length: count }, (_, offset) =>
        profiled(
          vitestExecutionsForGroups(
            sliceFastChecksPlan(plan, { index: offset + 1, count }).groups,
            { kind: 'shard', vitest: 'vitest.mjs' },
          ),
        ),
      ).flat();
      expect(new Set(sharded).size, `count ${count}`).toBe(sharded.length);
      expect([...sharded].sort(), `count ${count}`).toEqual(
        [...expected].sort(),
      );
    }
    // Deterministic: a round-tripped plan slices identically.
    const roundTripped = JSON.parse(JSON.stringify(plan));
    for (let index = 1; index <= FAST_CHECKS_SHARD_COUNT; index += 1)
      expect(
        sliceFastChecksPlan(roundTripped, {
          index,
          count: FAST_CHECKS_SHARD_COUNT,
        }),
      ).toEqual(
        sliceFastChecksPlan(plan, { index, count: FAST_CHECKS_SHARD_COUNT }),
      );
  });
});

describe('transitional legacy path: the base-controlled shell in ci.yml (child process, #2709)', () => {
  type Step = { id?: string; name?: string; run?: string };
  const jobs = (
    load(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')) as {
      jobs: Record<string, { steps: Step[] }>;
    }
  ).jobs;
  const detectRun = jobs['fast-checks-plan'].steps.find(
    (step) => step.id === 'mode',
  )?.run;
  const partResultsRun = jobs['fast-checks'].steps.find(
    (step) => step.name === 'Require every fast-checks part job to succeed',
  )?.run;

  /** GitHub's default `run` shell: bash --noprofile --norc -eo pipefail. */
  function bash(
    script: string | undefined,
    cwd: string,
    env: Record<string, string>,
  ) {
    if (!script) throw new Error('ci.yml step not found');
    return runWorkflowShell(script, cwd, env, 30_000);
  }

  function detect(withScript: boolean) {
    const { directory } = repository();
    if (!withScript) rmSync(join(directory, 'scripts/fast-checks-shard.mjs'));
    const output = join(directory, 'github-output');
    writeFileSync(output, '');
    const result = bash(detectRun, directory, { GITHUB_OUTPUT: output });
    expect(result.status, result.stderr).toBe(0);
    return readFileSync(output, 'utf8');
  }

  const needs = (
    legacy: string | undefined,
    results: Partial<Record<string, string>> = {},
  ) => ({
    classify: { result: 'skipped', outputs: {} },
    'fast-checks-plan': {
      result: results.plan ?? 'success',
      outputs: legacy === undefined ? {} : { legacy },
    },
    'fast-checks-shard': { result: results.shard ?? 'success', outputs: {} },
    'fast-checks-statics': {
      result: results.statics ?? 'success',
      outputs: {},
    },
  });
  const partResults = (value: unknown) =>
    bash(partResultsRun, root, { NEEDS: JSON.stringify(value) }).status;

  test('a candidate with the sharded lane is never legacy', () => {
    expect(detect(true)).toBe('legacy=false\n');
  });

  test('a candidate without the sharded lane is legacy', () => {
    expect(detect(false)).toBe('legacy=true\n');
  });

  test('the sharded branch requires every part, shards included', () => {
    expect(partResults(needs('false'))).toBe(0);
    for (const shard of ['skipped', 'cancelled', 'failure'])
      expect(partResults(needs('false', { shard })), shard).toBe(1);
  });

  test('a legacy candidate passes only when its unsharded ci:fast and the statics passed', () => {
    expect(partResults(needs('true', { shard: 'skipped' }))).toBe(0);
    // A failing legacy ci:fast fails fast-checks-plan, and so the check.
    for (const plan of ['failure', 'cancelled'])
      expect(partResults(needs('true', { plan, shard: 'skipped' })), plan).toBe(
        1,
      );
    expect(
      partResults(needs('true', { statics: 'failure', shard: 'skipped' })),
    ).toBe(1);
    // Shards that ran on a legacy candidate mean the gating broke.
    expect(partResults(needs('true'))).toBe(1);
  });

  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['garbled', 'yes'],
    ['padded', 'true '],
  ])('a %s legacy output is not legacy and fails', (_name, legacy) => {
    expect(partResults(needs(legacy, { shard: 'skipped' }))).toBe(1);
    expect(partResults(needs(legacy))).toBe(1);
  });

  test('a sharded candidate whose shards were skipped fails, end to end from detection', () => {
    const legacy = detect(true).trim().split('=')[1];
    expect(partResults(needs(legacy, { shard: 'skipped' }))).toBe(1);
  });
});

describe('plan-level empty-discovery escalation (#2709 review F2)', () => {
  test('a committed file nothing imports defers the plan to test-full, as the unsharded lane exits 3', {
    // The plan step's budget, which discovery may now use, plus the
    // unsharded run and the fixture worktree.
    timeout: FAST_CHECKS_PLAN_BUDGET_MS + 60_000,
  }, async () => {
    // A disposable worktree at HEAD with one committed orphan module, so
    // the diff is a real `git diff` and discovery is the real Vitest graph.
    const worktree = join(makeTempDir('station-fast-checks-orphan-'), 'wt');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
      }).trim();
    // Outside the try: a failed add has nothing to remove, and its own error
    // surfaces unmasked.
    git(root, 'worktree', 'add', '--detach', worktree, 'HEAD');
    let failure: unknown;
    try {
      // A directory of links, not one link: `node_modules/` is ignored only
      // as a directory, so the diff stays exactly the committed file.
      mkdirSync(join(worktree, 'node_modules'));
      for (const entry of readdirSync(join(root, 'node_modules')))
        symlinkSync(
          join(root, 'node_modules', entry),
          join(worktree, 'node_modules', entry),
        );
      const orphan = 'scripts/lib/fast-checks-orphan-fixture.mjs';
      writeFileSync(join(worktree, orphan), 'export const orphan = 1;\n');
      git(worktree, 'add', orphan);
      git(
        worktree,
        '-c',
        'user.email=fast-checks@test.invalid',
        '-c',
        'user.name=fast-checks',
        'commit',
        '-q',
        '-m',
        'test: orphan fixture',
      );
      const headSha = git(worktree, 'rev-parse', 'HEAD');
      // Workspace packages link to the primary checkout on purpose; the
      // provenance preflight would (correctly) refuse that tree.
      const assertDependencyProvenance = () => ({
        repositoryRoot: worktree,
        packages: [],
      });
      let discovered: string[] | undefined;

      // #2855: discovery gets the plan step's own budget, as the plan command
      // gives it, not the old fixed 60s that a loaded host outlasts.
      const discoveryDeadlineAt = Date.now() + FAST_CHECKS_PLAN_BUDGET_MS;
      const plan = await planChangedVerificationShards('HEAD~1', {
        root: worktree,
        headSha,
        assertDependencyProvenance,
        discoveryDeadlineAt,
        discoverRelatedFiles: async (
          discoveryRoot: string,
          paths: string[],
          options?: { base?: string },
        ) => {
          discovered = await discoverRelatedTestFiles(discoveryRoot, paths, {
            ...options,
            deadlineAt: discoveryDeadlineAt,
          });
          return discovered;
        },
      });
      expect(discovered).toEqual([]);
      expect(plan.changedPathCount).toBe(1);
      expect(plan.groups).toEqual([]);
      expect(plan.fileCount).toBe(0);
      expect(plan.emptyRelatedSelection?.relatedPaths).toEqual([orphan]);
      expect(plan.deferredLanes).toEqual([
        {
          id: 'test-full',
          reasons: [expect.stringContaining(`no related suites for ${orphan}`)],
        },
      ]);

      // The unsharded lane on the same diff and discovery answer: exit 3.
      const unsharded = await runChangedVerification(['--base=HEAD~1'], {
        root: worktree,
        assertDependencyProvenance,
        discoverRelatedFiles: async () => discovered ?? [],
        collectProvenance: () => ({
          repositoryId: 'd'.repeat(64),
          worktree,
          headSha,
          workspaceDigest: 'b'.repeat(64),
          environmentDigest: 'e'.repeat(64),
          dependencyDigest: 'c'.repeat(64),
          nodeVersion: process.version,
          toolchain: 'npm@fixture',
          toolchainIdentity: FIXTURE_TOOLCHAIN_IDENTITY,
          platform: process.platform,
          arch: process.arch,
        }),
        writeReceipt: vi.fn(),
      } as unknown as Parameters<typeof runChangedVerification>[1]);
      expect(unsharded.exitCode).toBe(3);
      expect(
        unsharded.selection.lanes.map((lane: { id: string }) => lane.id),
      ).toEqual(plan.deferredLanes.map((lane: { id: string }) => lane.id));
    } catch (error) {
      failure = error;
    }
    // Review nit: a failing cleanup must not replace the test's own error.
    try {
      git(root, 'worktree', 'remove', '--force', worktree);
    } catch (cleanupError) {
      if (failure === undefined) throw cleanupError;
    }
    if (failure !== undefined) throw failure;
  });
});

describe("a real shard run inherits the lane coordinator's bindings (review H1)", () => {
  test('a test in a shard sees STATION_VERIFICATION_HISTORY_REF equal to the head, not origin/main', {
    timeout: 180_000,
  }, () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    // A git-ignored directory Vitest still collects from, so the probe is a
    // real selected test without touching tracked files.
    const probeDir = join(
      root,
      'test-results',
      `fast-checks-history-probe-${process.pid}-${Date.now()}`,
    );
    mkdirSync(probeDir, { recursive: true });
    try {
      const probe = `test-results/${basename(probeDir)}/history-ref.probe.test.ts`;
      const observed = join(probeDir, 'observed.json');
      writeFileSync(
        join(root, probe),
        [
          "import { writeFileSync } from 'node:fs';",
          "import { test } from 'vitest';",
          "test('observes the verification history ref', () => {",
          '  const out = process.env.FAST_CHECKS_PROBE_OUT;',
          '  if (!out) return;',
          '  writeFileSync(out, JSON.stringify({ ref: process.env.STATION_VERIFICATION_HISTORY_REF ?? null }));',
          '});',
          '',
        ].join('\n'),
      );
      const planPath = join(probeDir, 'plan.json');
      writeFileSync(planPath, JSON.stringify(planFor(head, [probe])));
      const env: Record<string, string | undefined> = {
        ...process.env,
        GITHUB_RUN_ID: '4242',
        GITHUB_RUN_ATTEMPT: '1',
        FAST_CHECKS_PROBE_OUT: observed,
      };
      // Inherited from an outer verification run, it would pass vacuously.
      delete env.STATION_VERIFICATION_HISTORY_REF;
      const npmCli = process.env.npm_execpath;
      const [command, prefix] =
        npmCli && /npm-cli\.js$/.test(npmCli)
          ? [process.execPath, [npmCli]]
          : ['npm', []];
      const result = spawnSync(
        command,
        [
          ...prefix,
          'run',
          'fast-checks:shard',
          '--',
          'run',
          `--plan=${planPath}`,
          '--shard=1/4',
          `--receipt=${join(probeDir, 'receipt.json')}`,
        ],
        {
          cwd: root,
          encoding: 'utf8',
          env,
          timeout: 170_000,
          windowsHide: true,
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(readFileSync(observed, 'utf8'))).toEqual({
        ref: head,
      });
      expect(
        JSON.parse(readFileSync(join(probeDir, 'receipt.json'), 'utf8')),
      ).toMatchObject({ status: 'completed', files: [probe] });
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  });
});

describe('the plan command gives discovery the plan step budget (#2855)', () => {
  test('the deadline is the command start plus the plan step fence', async () => {
    const { directory, head } = repository();
    const seen: number[] = [];
    const status = await runFastChecksShardCli(['plan', '--out=plan.json'], {
      cwd: directory,
      env: { STATION_CI_FAST_BASE: 'HEAD' },
      report: () => {},
      error: () => {},
      now: () => 5_000,
      planShards: async (_base, options) => {
        seen.push(options.discoveryDeadlineAt);
        return planFor(head, ['a/a.test.ts']);
      },
    });
    expect(status).toBe(0);
    expect(FAST_CHECKS_PLAN_BUDGET_MS).toBe(300_000);
    expect(seen).toEqual([5_000 + 300_000]);
  });
});

describe('the selector CLI takes its discovery deadline from run-ci-fast (#2855 review M2)', () => {
  test('with the deadline almost spent, the real CLI refuses discovery and writes an infrastructure_error receipt', {
    timeout: 180_000,
  }, () => {
    // A disposable worktree with one changed script, so the selection has
    // a related path and reaches discovery; the only way the refusal can
    // happen is the CLI reading STATION_TEST_CHANGED_DEADLINE_AT. The script
    // must select no deferred lane: a deferred lane drops related paths from
    // execution, so discovery would never run. A module many spawned scripts
    // import defers to test-full (#2922), which is why this is not
    // module-entry.mjs; the premise is checked here so drift names itself.
    const changedScript = 'scripts/lib/icns.mjs';
    const premise = selectChangedVerification(
      [changedScript],
      buildTestImpactManifest({ root }) as Parameters<
        typeof selectChangedVerification
      >[1],
    );
    expect(premise.lanes, 'the changed script must defer no lane').toEqual([]);
    expect(premise.relatedPaths).toEqual([changedScript]);
    const worktree = join(makeTempDir('station-changed-deadline-'), 'wt');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
      }).trim();
    git(root, 'worktree', 'add', '--detach', worktree, 'HEAD');
    let failure: unknown;
    try {
      // node_modules is a directory of links to the primary install, except
      // workspace packages, which point at this worktree's own sources so
      // the CLI's dependency-provenance preflight accepts it.
      const workspace = new Map(
        listWorkspacePackageManifests(worktree).map((entry) => [
          entry.name,
          entry.directory,
        ]),
      );
      const modules = join(worktree, 'node_modules');
      mkdirSync(modules);
      for (const entry of readdirSync(join(root, 'node_modules'))) {
        const scoped = [...workspace.keys()].filter((name) =>
          name.startsWith(`${entry}/`),
        );
        if (!scoped.length) {
          symlinkSync(join(root, 'node_modules', entry), join(modules, entry));
          continue;
        }
        mkdirSync(join(modules, entry));
        for (const member of readdirSync(join(root, 'node_modules', entry))) {
          const name = `${entry}/${member}`;
          symlinkSync(
            workspace.get(name) ?? join(root, 'node_modules', entry, member),
            join(modules, entry, member),
          );
        }
      }
      const changed = join(worktree, changedScript);
      writeFileSync(changed, `${readFileSync(changed, 'utf8')}\n`);

      const env: Record<string, string | undefined> = {
        ...process.env,
        STATION_TEST_CHANGED_DEADLINE_AT: String(Date.now() + 10_000),
      };
      const result = spawnSync(
        process.execPath,
        // This checkout's CLI (the code under test) over the fixture's
        // repository: the CLI takes its root from cwd.
        [join(root, 'scripts/run-changed-verification.mjs'), '--base=HEAD'],
        {
          cwd: worktree,
          encoding: 'utf8',
          env,
          timeout: 170_000,
          windowsHide: true,
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      const selection = JSON.parse(
        readFileSync(
          join(worktree, '.kontourai/test-impact/changed-selection.json'),
          'utf8',
        ),
      );
      expect(selection.receipt.status).toBe('infrastructure_error');
      expect(selection.preparation).toMatchObject({
        phase: 'related-discovery',
        childStarted: false,
      });
      expect(selection.preparation.error).toContain(
        'Related Vitest discovery refused: 0ms of its budget remain',
      );
    } catch (error) {
      failure = error;
    }
    try {
      git(root, 'worktree', 'remove', '--force', worktree);
    } catch (cleanupError) {
      if (failure === undefined) throw cleanupError;
    }
    if (failure !== undefined) throw failure;
  });
});

describe('the plan records its related-discovery cost (#2803)', () => {
  test('a plan that ran discovery records its duration and the timeout its child ran under, and one that did not records nothing', async () => {
    let clock = 1_000;
    const plan = await planChangedVerificationShards('HEAD', {
      root,
      headSha: 'c'.repeat(40),
      assertDependencyProvenance: () => ({
        repositoryRoot: root,
        packages: [],
      }),
      changedPathsFn: () => ({
        mergeBase: 'HEAD',
        paths: ['scripts/lib/fast-checks-shards.mjs'],
      }),
      now: () => clock,
      // As the real discovery does: report the derived timeout, then run.
      discoverRelatedFiles: async (_root, _paths, options) => {
        options?.onTimeout?.(265_000);
        clock += 34_200;
        return ['scripts/__tests__/fast-checks-shards.test.ts'];
      },
    });
    expect(plan.relatedDiscovery).toEqual({
      milliseconds: 34_200,
      timeoutMilliseconds: 265_000,
    });
    const explicit = await planChangedVerificationShards('HEAD', {
      root,
      headSha: 'c'.repeat(40),
      assertDependencyProvenance: () => ({
        repositoryRoot: root,
        packages: [],
      }),
      changedPathsFn: () => ({
        mergeBase: 'HEAD',
        paths: ['scripts/__tests__/fast-checks-shards.test.ts'],
      }),
      discoverRelatedFiles: async () => {
        throw new Error('an explicit-only plan must not run discovery');
      },
    });
    expect(explicit.relatedDiscovery).toBeUndefined();
  });

  test('the plan command reports that cost', async () => {
    const { directory, head } = repository();
    const lines: string[] = [];
    const status = await runFastChecksShardCli(['plan', '--out=plan.json'], {
      cwd: directory,
      env: { STATION_CI_FAST_BASE: 'HEAD' },
      report: (message) => lines.push(message),
      error: () => {},
      planShards: async () => ({
        ...planFor(head, ['a/a.test.ts']),
        relatedDiscovery: {
          milliseconds: 34_200,
          timeoutMilliseconds: 265_000,
        },
      }),
    });
    expect(status).toBe(0);
    expect(lines.join('')).toContain(
      '[fast-checks] related discovery: 34.2s of its 265.0s timeout\n',
    );
  });
});
