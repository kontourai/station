import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { runFastChecksShardCli } from '../fast-checks-shard.mjs';
import {
  digestText,
  FAST_CHECKS_PART_JOBS,
  FAST_CHECKS_PLAN_KIND,
  FAST_CHECKS_RECEIPT_KIND,
  FAST_CHECKS_SHARD_COUNT,
  sliceFastChecksPlan,
} from '../lib/fast-checks-shards.mjs';
import {
  planChangedVerificationShards,
  planChangedVitestExecutions,
  prepareChangedSelection,
  runChangedVerificationShard,
  selectChangedVerification,
  vitestExecutionsForGroups,
} from '../run-changed-verification.mjs';
import { buildTestImpactManifest } from '../test-impact-manifest.mjs';

const root = resolve(import.meta.dirname, '../..');
const temporary = new Set<string>();
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

afterEach(() => {
  for (const directory of temporary)
    rmSync(directory, { recursive: true, force: true });
  temporary.clear();
});

/** A throwaway Git repository: the CLI reads HEAD for plan identity. */
function repository() {
  const directory = mkdtempSync(join(tmpdir(), 'station-fast-checks-'));
  temporary.add(directory);
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
} = {}) {
  const { directory, head } = repository();
  const plan = planFor(head, files);
  const planText = `${JSON.stringify(plan, null, 2)}\n`;
  mkdirSync(join(directory, 'plan'));
  writeFileSync(join(directory, 'plan/fast-checks-plan.json'), planText);
  for (let index = 1; index <= FAST_CHECKS_SHARD_COUNT; index += 1) {
    if (omit.includes(index)) continue;
    const slice = sliceFastChecksPlan(plan, {
      index,
      count: FAST_CHECKS_SHARD_COUNT,
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
          shard: `${index}/${FAST_CHECKS_SHARD_COUNT}`,
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
  test('passes when every part succeeded and every shard receipt verifies', () => {
    const result = aggregate(aggregateFixture());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('[fast-checks] PASS');
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
  const env = { GITHUB_RUN_ID: '4242', GITHUB_RUN_ATTEMPT: '2' };
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
  const fakeRun = (status: number, contents: string) =>
    vi.fn(async (_command: string, args: string[]) => {
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
        { root, run: fakeRun(status, contents), vitestPath: 'vitest.mjs' },
      );
      expect(result.status).toBe(expected);
    },
  );

  test('runs each file under its resource group profile', async () => {
    const run = fakeRun(0, report(0));
    await runChangedVerificationShard({ deferredLanes: [] }, slice, {
      root,
      run,
      vitestPath: 'vitest.mjs',
    });
    expect(run).toHaveBeenCalledTimes(1);
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
  test('the shards together run exactly the unsharded plan, with no duplicates', async () => {
    // Every tracked scripts test, as a real diff that touched them all: real
    // manifest routing, the real resource partition (ordinary, process-heavy
    // and the serial groups), no stubbed file list. Changed test files are
    // explicit targets, so no discovery child is needed.
    const manifest = buildTestImpactManifest({ root });
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
