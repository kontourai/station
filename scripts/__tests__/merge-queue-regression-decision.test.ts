import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { JSON_SCHEMA, load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { runFastChecksShardCli } from '../fast-checks-shard.mjs';
import { planChangedVerificationShards } from '../run-changed-verification.mjs';
import {
  mergeQueueRegressionPaths,
  TEST_IMPACT_MANIFEST,
  validateTestImpactManifest,
} from '../test-impact-manifest.mjs';

/**
 * The required `Merge-queue regression` check runs the hosted full
 * regression only for a candidate whose fast-checks plan defers to a lane or
 * names a `mergeQueueRegression` path, and fails closed on anything it cannot
 * read. Plans here come from the real planner through the real `plan` CLI
 * (only the diff and related discovery are injected); the decision and the
 * aggregator run as child processes, the way the workflow runs them.
 */

const root = resolve(import.meta.dirname, '../..');
const WORKFLOW = '.github/workflows/merge-queue-regression.yml';
const DECISION = 'scripts/merge-queue-regression-decision.mjs';
const HEAD = 'c'.repeat(40);
const BASE = 'b'.repeat(40);
const makeTempDir = trackTempDirs();

async function writeRealPlan(
  paths: string[],
  discovered: string[] = [],
): Promise<{ file: string; plan: Record<string, unknown> }> {
  const directory = makeTempDir('station-mq-decision-');
  const lines: string[] = [];
  const status = await runFastChecksShardCli(['plan', '--out=plan.json'], {
    cwd: directory,
    env: {
      STATION_CI_FAST_BASE: BASE,
      STATION_FAST_CHECKS_ADAPTIVE_SHARDS: 'true',
    },
    report: (message) => lines.push(message),
    error: (message) => lines.push(message),
    planShards: (base, options) =>
      planChangedVerificationShards(base, {
        ...options,
        root,
        headSha: HEAD,
        assertDependencyProvenance: () => ({
          repositoryRoot: root,
          packages: [],
        }),
        changedPathsFn: () => ({ mergeBase: BASE, paths }),
        discoverRelatedFiles: async () => discovered,
      }),
  });
  expect(status, lines.join('')).toBe(0);
  const file = join(directory, 'plan.json');
  return { file, plan: JSON.parse(readFileSync(file, 'utf8')) };
}

function decide(
  plan: string,
  { head = HEAD, base = BASE }: { head?: string; base?: string } = {},
) {
  const directory = makeTempDir('station-mq-decision-out-');
  const output = join(directory, 'github-output');
  const summary = join(directory, 'step-summary');
  const result = spawnSync(
    process.execPath,
    [DECISION, `--plan=${plan}`, `--head=${head}`, `--base=${base}`],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
      },
      timeout: 30_000,
      windowsHide: true,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: existsSync(output) ? readFileSync(output, 'utf8') : undefined,
    summary: existsSync(summary) ? readFileSync(summary, 'utf8') : undefined,
  };
}

/** A GitHub expression, without a `${` literal the linter flags. */
const expr = (inner: string) => `\${{ ${inner} }}`;
const RUNS_FULL = 'full-regression=true\n';
const FAST_PATH = 'full-regression=false\n';

describe('the decision over real plans (child process)', () => {
  test('a shared-package change escalates to a deferred lane and runs the full regression', async () => {
    const { file, plan } = await writeRealPlan([
      'packages/shared/src/agent-validation.ts',
    ]);
    expect(
      (plan.deferredLanes as Array<{ id: string }>).map(({ id }) => id),
    ).toContain('ci-fast');
    const result = decide(file);
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe(RUNS_FULL);
    expect(result.stdout).toContain('plan defers to ci-fast');
  });

  test('a deferred plan that dropped its explicit tests over the 32 cap runs the full regression', async () => {
    // 33 real suites the manifest already names, changed in one diff.
    const tests = [
      ...new Set(
        TEST_IMPACT_MANIFEST.flatMap((edge) =>
          'tests' in edge ? edge.tests ?? [] : [],
        ),
      ),
    ]
      .filter(
        (path) =>
          /\.test\.tsx?$/.test(path) &&
          !path.startsWith('tests/') &&
          existsSync(join(root, path)),
      )
      .slice(0, 33);
    expect(tests).toHaveLength(33);
    const { file, plan } = await writeRealPlan([
      'packages/shared/src/agent-validation.ts',
      ...tests,
    ]);
    // The planner ran none of the 33 changed suites.
    expect(plan.fileCount).toBe(0);
    expect(decide(file).output).toBe(RUNS_FULL);
  });

  test('an ordinary related-only change takes the fast path', async () => {
    const { file, plan } = await writeRealPlan(
      ['src-ui/src/components/acp-connections/ACPConnectionCard.tsx'],
      [
        'src-ui/src/components/acp-connections/__tests__/ACPConnectionCard.test.tsx',
      ],
    );
    expect(plan.deferredLanes).toEqual([]);
    expect(plan.mergeQueueRegressionPaths).toEqual([]);
    const result = decide(file);
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe(FAST_PATH);
    expect(result.stdout).toContain('no deferred lane: fast path');
    expect(result.summary).toContain('no deferred lane: fast path');
  });

  test('a path whose consumers only the queue runs takes the full regression without any lane', async () => {
    const { file, plan } = await writeRealPlan([
      'packages/sdk/src/client/http.ts',
    ]);
    expect(plan.deferredLanes).toEqual([]);
    expect(plan.mergeQueueRegressionPaths).toEqual([
      'packages/sdk/src/client/http.ts',
    ]);
    const result = decide(file);
    expect(result.output).toBe(RUNS_FULL);
    expect(result.stdout).toContain('packages/sdk/src/client/http.ts');
  });
});

describe('fail-closed decisions (child process)', () => {
  async function ordinaryPlan() {
    return writeRealPlan(
      ['src-ui/src/components/acp-connections/ACPConnectionCard.tsx'],
      [
        'src-ui/src/components/acp-connections/__tests__/ACPConnectionCard.test.tsx',
      ],
    );
  }

  test('a missing plan runs the full regression', () => {
    const result = decide(join(makeTempDir('station-mq-none-'), 'plan.json'));
    expect(result.status).toBe(0);
    expect(result.output).toBe(RUNS_FULL);
    expect(result.stdout).toContain('missing or unreadable: fail closed');
  });

  test.each([
    ['unparsable', () => '{"schemaVersion":'],
    ['structurally invalid', () => JSON.stringify({ schemaVersion: 1 })],
  ])('a %s plan runs the full regression', (_name, text) => {
    const file = join(makeTempDir('station-mq-bad-'), 'plan.json');
    writeFileSync(file, text());
    const result = decide(file);
    expect(result.output).toBe(RUNS_FULL);
    expect(result.stdout).toContain('fail closed');
  });

  test('an ordinary plan for another candidate or base runs the full regression', async () => {
    const { file } = await ordinaryPlan();
    expect(decide(file).output).toBe(FAST_PATH);
    expect(decide(file, { head: 'd'.repeat(40) }).output).toBe(RUNS_FULL);
    expect(decide(file, { base: 'e'.repeat(40) }).output).toBe(RUNS_FULL);
  });

  test('a plan that does not record mergeQueueRegressionPaths runs the full regression', async () => {
    const { file, plan } = await ordinaryPlan();
    delete plan.mergeQueueRegressionPaths;
    writeFileSync(file, JSON.stringify(plan));
    const result = decide(file);
    expect(result.output).toBe(RUNS_FULL);
    expect(result.stdout).toContain('mergeQueueRegressionPaths: fail closed');
  });

  test('only a deferred ci-fast or test-full lane runs the full regression (owner-chosen scope)', async () => {
    const { file, plan } = await ordinaryPlan();
    const withLanes = (ids: string[]) => {
      writeFileSync(
        file,
        JSON.stringify({
          ...plan,
          deferredLanes: ids.map((id) => ({ id, reason: 'fixture' })),
        }),
      );
      return decide(file).output;
    };
    expect(withLanes(['node-pty-foreign-prebuilds'])).toBe(FAST_PATH);
    expect(withLanes(['ci-fast'])).toBe(RUNS_FULL);
    expect(withLanes(['test-full'])).toBe(RUNS_FULL);
    expect(withLanes(['node-pty-foreign-prebuilds', 'test-full'])).toBe(
      RUNS_FULL,
    );
  });

  test('a usage fault exits 2 and writes no decision, so the workflow runs the full regression', () => {
    const result = decide('plan.json', { head: 'not-a-sha' });
    expect(result.status).toBe(2);
    expect(result.output).toBeUndefined();
  });
});

describe('mergeQueueRegression impact edges', () => {
  test('every edge that leaves its consumers to the merge queue says so structurally', () => {
    const claimed = TEST_IMPACT_MANIFEST.filter((edge) =>
      /merge-queue\s+full\s+regression/.test(edge.reason ?? ''),
    ).map((edge) => edge.pattern);
    const flagged = TEST_IMPACT_MANIFEST.filter(
      (edge) =>
        'mergeQueueRegression' in edge && edge.mergeQueueRegression === true,
    ).map((edge) => edge.pattern);
    expect(flagged.sort()).toEqual(claimed.sort());
    // Pinned independently of the manifest: the nine #2301/#2326/#2458/#2610
    // boundaries.
    expect(flagged).toHaveLength(9);
  });

  test('only an exactly owned path selects the queue regression', () => {
    expect(
      mergeQueueRegressionPaths([
        'src-server/services/orchestration/event-store.ts',
        'packages/sdk/src/client/other.ts',
        'packages/sdk/src/client/http.ts',
      ]),
    ).toEqual([
      'packages/sdk/src/client/http.ts',
      'src-server/services/orchestration/event-store.ts',
    ]);
  });

  test.each([
    ['supplemental', { supplemental: true, tests: ['a/a.test.ts'] }],
    ['conditional', { whenAll: ['b.ts'], tests: ['a/a.test.ts'] }],
    ['testless', { related: true }],
    ['non-boolean', { mergeQueueRegression: 'yes', tests: ['a/a.test.ts'] }],
  ])('a %s queue-regression edge is refused', (_name, shape) => {
    const errors = Reflect.apply(validateTestImpactManifest, undefined, [
      [{ pattern: 'x.ts', mergeQueueRegression: true, ...shape }],
    ]);
    expect(errors.join('\n')).toContain(
      'a merge-queue regression edge must be an unconditional boundary edge with tests: x.ts',
    );
  });
});

type Job = {
  name?: string;
  if?: string;
  needs?: string | string[];
  uses?: string;
  with?: Record<string, unknown>;
  outputs?: Record<string, string>;
  steps?: Array<{
    id?: string;
    name?: string;
    if?: string;
    run?: string;
    env?: Record<string, string>;
    'continue-on-error'?: boolean;
  }>;
};

function workflow() {
  return load(readFileSync(join(root, WORKFLOW), 'utf8'), {
    schema: JSON_SCHEMA,
  }) as { on: Record<string, unknown>; jobs: Record<string, Job> };
}

describe('merge-queue-regression.yml wiring', () => {
  test('exactly one job carries the required context name, literally', () => {
    const named = Object.entries(workflow().jobs).filter(
      ([, job]) => job.name === 'Merge-queue regression',
    );
    expect(named.map(([id]) => id)).toEqual(['merge-queue-regression']);
  });

  test('pull requests never plan or run the full regression', () => {
    const { on, jobs } = workflow();
    expect(on).not.toHaveProperty('pull_request');
    for (const id of ['plan', 'full-regression'])
      expect(jobs[id].if).toContain(
        "github.event_name != 'pull_request_target'",
      );
  });

  test('the plan job plans with the fast-checks inputs and decides from that file', () => {
    const steps = workflow().jobs.plan.steps ?? [];
    const plan = steps.find(
      (step) => step.name === 'Plan the affected-test selection',
    );
    const decision = steps.find((step) => step.id === 'decide');
    expect(plan?.run).toBe(
      'npm run fast-checks:shard -- plan --out="$RUNNER_TEMP/fast-checks-plan/fast-checks-plan.json"',
    );
    expect(plan?.['continue-on-error']).toBe(true);
    expect(plan?.env?.STATION_CI_FAST_BASE).toBe(
      expr("github.event.merge_group.base_sha || 'origin/main'"),
    );
    expect(decision?.if).toBe(expr('!cancelled()'));
    expect(decision?.env?.PLAN_BASE).toBe(plan?.env?.STATION_CI_FAST_BASE);
    expect(decision?.run).toBe(
      `node ${DECISION} --plan="$RUNNER_TEMP/fast-checks-plan/fast-checks-plan.json" --head="$HEAD_SHA" --base="$PLAN_BASE"`,
    );
    expect(workflow().jobs.plan.outputs?.['full-regression']).toBe(
      expr('steps.decide.outputs.full-regression'),
    );
  });

  test('the full regression runs unless the decision is exactly false, on this candidate', () => {
    const job = workflow().jobs['full-regression'];
    expect(job.if).toBe(
      expr(
        "always() && !cancelled() && github.event_name != 'pull_request_target' && needs.plan.outputs.full-regression != 'false'",
      ),
    );
    expect(job.uses).toBe('./.github/workflows/full-regression.yml');
    expect(job.with).toEqual({
      source_sha: expr('github.sha'),
      allow_reuse: true,
    });
  });
});

describe('the required aggregate over job results (bash and jq child process)', () => {
  const bash = spawnSync('bash', ['-c', 'command -v jq'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const run = workflow().jobs['merge-queue-regression'].steps?.[0]?.run ?? '';

  function aggregate(needs: Record<string, unknown>) {
    return spawnSync('bash', ['-eo', 'pipefail', '-c', run], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', NEEDS: JSON.stringify(needs) },
      timeout: 30_000,
      windowsHide: true,
    });
  }
  const job = (result: string, outputs: Record<string, string> = {}) => ({
    result,
    outputs,
  });
  const fast = { 'full-regression': 'false' };
  const full = { 'full-regression': 'true' };

  test('jq is available to the aggregate', () => {
    expect(bash.status, 'jq is required by the real aggregate').toBe(0);
  });

  test.each([
    [
      'fast path: plan says false and the regression was skipped',
      {
        diff: job('success'),
        plan: job('success', fast),
        'full-regression': job('skipped'),
      },
      0,
    ],
    [
      'deferred candidate whose full regression passed',
      {
        diff: job('success'),
        plan: job('success', full),
        'full-regression': job('success'),
      },
      0,
    ],
    [
      'failed plan job whose fail-closed full regression passed',
      {
        diff: job('success'),
        plan: job('failure'),
        'full-regression': job('success'),
      },
      0,
    ],
    [
      'deferred candidate whose full regression failed',
      {
        diff: job('success'),
        plan: job('success', full),
        'full-regression': job('failure'),
      },
      1,
    ],
    [
      'decision true but the regression was skipped',
      {
        diff: job('success'),
        plan: job('success', full),
        'full-regression': job('skipped'),
      },
      1,
    ],
    [
      'no decision and no regression',
      {
        diff: job('success'),
        plan: job('success'),
        'full-regression': job('skipped'),
      },
      1,
    ],
    [
      'failed plan job and skipped regression',
      {
        diff: job('success'),
        plan: job('failure', fast),
        'full-regression': job('skipped'),
      },
      1,
    ],
    [
      'cancelled full regression',
      {
        diff: job('success'),
        plan: job('success', full),
        'full-regression': job('cancelled'),
      },
      1,
    ],
    [
      'failed candidate diff on the fast path',
      {
        diff: job('failure'),
        plan: job('success', fast),
        'full-regression': job('skipped'),
      },
      1,
    ],
  ])('%s', (_name, needs, expected) => {
    const result = aggregate(needs);
    expect(result.status, result.stderr).toBe(expected);
  });

  test('the fast path says so on the required check', () => {
    const result = aggregate({
      diff: job('success'),
      plan: job('success', fast),
      'full-regression': job('skipped'),
    });
    expect(result.stdout).toContain('no deferred lane: fast path');
  });
});
