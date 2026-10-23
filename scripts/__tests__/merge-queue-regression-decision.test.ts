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

/** Exercise the real planner, decision CLI and workflow aggregate. A bounded
 * integration pass must never depend on a full corpus or admit foreign plans. */

const root = resolve(import.meta.dirname, '../..');
const WORKFLOW = '.github/workflows/ci.yml';
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
const RUNS_FULL = 'integration-ready=true\nfull-regression=true\n';
const BLOCKED = 'integration-ready=false\nfull-regression=true\n';
const FAST_PATH = 'integration-ready=true\nfull-regression=false\n';

describe('the decision over real plans (child process)', () => {
  test('a shared-package change retains its broad deferral without blocking bounded integration', async () => {
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

  test('a deferred hosted plan retains more than32 explicit tests and retains its full qualification obligation', async () => {
    // 33 real suites the manifest already names, changed in one diff.
    const tests = [
      ...new Set(
        TEST_IMPACT_MANIFEST.flatMap((edge) =>
          'tests' in edge ? (edge.tests ?? []) : [],
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
    expect(plan.fileCount).toBeGreaterThanOrEqual(33);
    const planned = (plan.groups as Array<{ files: string[] }>).flatMap(
      (group) => group.files,
    );
    expect(planned).toEqual(expect.arrayContaining(tests));
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

  test('consumer coverage remains deferred while its boundary plan is accepted', async () => {
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

  test('a missing plan blocks integration', () => {
    const result = decide(join(makeTempDir('station-mq-none-'), 'plan.json'));
    expect(result.status).toBe(1);
    expect(result.output).toBe(BLOCKED);
    expect(result.stdout).toContain('missing or unreadable: fail closed');
  });

  test.each([
    ['unparsable', () => '{"schemaVersion":'],
    ['structurally invalid', () => JSON.stringify({ schemaVersion: 1 })],
  ])('a %s plan blocks integration', (_name, text) => {
    const file = join(makeTempDir('station-mq-bad-'), 'plan.json');
    writeFileSync(file, text());
    const result = decide(file);
    expect(result.output).toBe(BLOCKED);
    expect(result.stdout).toContain('fail closed');
  });

  test('an ordinary plan for another candidate or base blocks integration', async () => {
    const { file } = await ordinaryPlan();
    expect(decide(file).output).toBe(FAST_PATH);
    expect(decide(file, { head: 'd'.repeat(40) }).output).toBe(BLOCKED);
    expect(decide(file, { base: 'e'.repeat(40) }).output).toBe(BLOCKED);
  });

  test('a plan that does not record mergeQueueRegressionPaths blocks integration', async () => {
    const { file, plan } = await ordinaryPlan();
    delete plan.mergeQueueRegressionPaths;
    writeFileSync(file, JSON.stringify(plan));
    const result = decide(file);
    expect(result.output).toBe(BLOCKED);
    expect(result.stdout).toContain('mergeQueueRegressionPaths: fail closed');
  });

  test('broader coverage stays explicit independently of bounded integration', async () => {
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

  test('a usage fault exits 2 and writes no admission decision', () => {
    const result = decide('plan.json', { head: 'not-a-sha' });
    expect(result.status).toBe(2);
    expect(result.output).toBeUndefined();
  });
});

describe('mergeQueueRegression impact edges', () => {
  test('each consumer deferral remains explicitly identified', () => {
    const claimed = TEST_IMPACT_MANIFEST.filter((edge) =>
      /main\/release full qualification/.test(edge.reason ?? ''),
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

  test('only an exactly owned path identifies deferred consumer coverage', () => {
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

describe('same-run merge integration wiring', () => {
  test('one automatic required context shares the sole fast-checks planner', () => {
    const { jobs } = workflow();
    expect(
      Object.entries(jobs)
        .filter(([, job]) => job.name === 'Merge-queue regression')
        .map(([id]) => id),
    ).toEqual(['merge-queue-regression']);
    const planners = Object.entries(jobs).filter(([, job]) =>
      job.steps?.some((step) =>
        /fast-checks:shard -- plan/.test(step.run ?? ''),
      ),
    );
    expect(planners.map(([id]) => id)).toEqual(['fast-checks-plan']);
    const steps = jobs['fast-checks-plan'].steps ?? [];
    const decision = steps.find((step) => step.id === 'merge-decision');
    expect(decision?.env).toEqual({
      HEAD_SHA: expr('github.sha'),
      PLAN_BASE: expr('github.event.merge_group.base_sha'),
    });
    expect(decision?.run).toContain(`node ${DECISION} --plan=`);
    expect(decision?.if).toBe(
      expr("always() && !cancelled() && github.event_name == 'merge_group'"),
    );
    expect(jobs['fast-checks-plan'].outputs?.['integration-ready']).toBe(
      expr('steps.merge-decision.outputs.integration-ready'),
    );
    expect(jobs['merge-queue-regression'].needs).toContain('fast-checks');
    const diagnostic = load(
      readFileSync(
        join(root, '.github/workflows/merge-queue-regression.yml'),
        'utf8',
      ),
      { schema: JSON_SCHEMA },
    ) as { on: Record<string, unknown> };
    expect(Object.keys(diagnostic.on)).toEqual(['workflow_dispatch']);
  });

  test('an old candidate without the decision CLI cannot gain bounded admission', () => {
    const directory = makeTempDir('station-mq-legacy-decision-');
    const output = join(directory, 'output');
    const step = workflow().jobs['fast-checks-plan'].steps?.find(
      (candidate) => candidate.id === 'merge-decision',
    );
    const result = spawnSync(
      'bash',
      ['-eo', 'pipefail', '-c', String(step?.run)],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH ?? '',
          GITHUB_OUTPUT: output,
          RUNNER_TEMP: directory,
          HEAD_SHA: HEAD,
          PLAN_BASE: BASE,
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('MODULE_NOT_FOUND');
    expect(existsSync(output)).toBe(false);
  });

  test('the required integration DAG has no full-corpus dependency', () => {
    const { jobs } = workflow();
    expect(jobs).not.toHaveProperty('merge-integration-full-regression');
    expect(jobs['merge-queue-regression'].needs).toEqual([
      'diff',
      'fast-checks-plan',
      'fast-checks',
    ]);
    // The remaining canonical full call is a manual diagnostic only.
    expect(jobs['full-regression'].if).toContain(
      "github.event_name == 'workflow_dispatch'",
    );
  });
});

describe('the required aggregate over job results (bash and jq child process)', () => {
  const run = workflow().jobs['merge-queue-regression'].steps?.[0]?.run ?? '';
  const job = (result: string, outputs: Record<string, string> = {}) => ({
    result,
    outputs,
  });
  function aggregate(overrides: Record<string, unknown> = {}) {
    return spawnSync('bash', ['-eo', 'pipefail', '-c', run], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        NEEDS: JSON.stringify({
          diff: job('success'),
          'fast-checks': job('success'),
          'fast-checks-plan': job('success', {
            'integration-ready': 'true',
            'full-regression': 'true',
          }),
          ...overrides,
        }),
      },
      timeout: 30_000,
      windowsHide: true,
    });
  }

  test('accepts passed bounded checks while the corpus remains explicitly unqualified', () => {
    const result = aggregate();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'Bounded integration only; full qualification runs on main and before release',
    );
  });

  test.each(['diff', 'fast-checks-plan', 'fast-checks'])(
    '%s must succeed even when other evidence is green',
    (part) => {
      for (const result of ['failure', 'cancelled', 'skipped', 'in_progress']) {
        expect(
          aggregate({ [part]: job(result, { 'integration-ready': 'true' }) })
            .status,
        ).toBe(1);
      }
      expect(aggregate({ [part]: undefined }).status).toBe(1);
    },
  );

  test.each([undefined, 'false', 'garbled'])(
    'invalid/missing admission decision %s cannot be replaced by a full-run success',
    (ready) => {
      const result = aggregate({
        'fast-checks-plan': job(
          'success',
          ready === undefined ? {} : { 'integration-ready': ready },
        ),
        'merge-integration-full-regression': job('success'),
      });
      expect(result.status).toBe(1);
    },
  );
});
