import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSON_SCHEMA, load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { runnerProfile } from '../release-pipeline.mjs';
import { FULL_REGRESSION_PHASES } from '../verification-lanes.mjs';

const root = resolve(import.meta.dirname, '../..');

type WorkflowStep = {
  name?: string;
  id?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  if?: string;
  'timeout-minutes'?: number;
  'continue-on-error'?: boolean;
};

type WorkflowJob = {
  if?: string;
  needs?: string | string[];
  uses?: string;
  secrets?: string;
  with?: Record<string, unknown>;
  steps?: WorkflowStep[];
  'timeout-minutes'?: number;
  strategy?: {
    'fail-fast'?: boolean;
    matrix?: { include?: Array<{ phases: string }> };
  };
};

type Workflow = {
  on?: Record<string, any>;
  concurrency?: {
    group: string;
    queue?: string;
    'cancel-in-progress': boolean;
  };
  jobs?: Record<string, WorkflowJob>;
};

function source(name: string): string {
  return readFileSync(resolve(root, '.github/workflows', name), 'utf8');
}

function workflow(name: string): Workflow {
  return load(source(name), { schema: JSON_SCHEMA }) as Workflow;
}

function namedStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`missing ${name}`);
  return step;
}

function githubExpression(expression: string): string {
  return `\${{ ${expression} }}`;
}

describe('promotion full-regression workflow', () => {
  test('qualifies every canonical phase against one immutable source without cancelling siblings', () => {
    const reusable = workflow('full-regression.yml');
    expect(Object.keys(reusable.on ?? {})).toEqual(['workflow_call']);
    expect(reusable.on?.workflow_call?.inputs?.source_sha).toMatchObject({
      required: true,
      type: 'string',
    });
    const jobs = reusable.jobs ?? {};
    const resolveSource = namedStep(
      jobs.resolve,
      'Resolve exact-source evidence',
    );
    expect(resolveSource.run).toBe(
      'node scripts/qualification-evidence.mjs resolve',
    );
    expect(resolveSource.env).toMatchObject({
      SOURCE_SHA: githubExpression('inputs.source_sha'),
      ALLOW_REUSE: githubExpression('inputs.allow_reuse'),
    });
    const covered: string[] = [];
    for (const id of [
      'static',
      'ordinary',
      'process-heavy',
      'exclusive',
      'android-viewport',
    ]) {
      const job = jobs[id];
      const checkout = job.steps?.find((step) =>
        step.uses?.startsWith('actions/checkout@'),
      );
      expect(checkout?.with).toMatchObject({
        ref: githubExpression('inputs.source_sha'),
        'persist-credentials': false,
      });
      expect(job['timeout-minutes']).toBeGreaterThan(0);
      if (id === 'android-viewport') {
        expect(
          job.steps?.some((step) => step.run === 'npm run test:android'),
        ).toBe(true);
        continue;
      }
      const run = namedStep(job, 'Run full-regression phases');
      if (id === 'static' || id === 'process-heavy') {
        const install = namedStep(job, 'Install pinned actionlint');
        expect(install.env?.ACTIONLINT_SHA256).toMatch(/^[0-9a-f]{64}$/u);
        expect(install.run).toContain('sha256sum --check --status');
        expect(install.run).toContain('>> "$GITHUB_PATH"');
        expect(job.steps?.indexOf(install)).toBeLessThan(
          job.steps?.indexOf(run) ?? -1,
        );
      }
      expect(run.run?.trim()).toBe(
        'set -o pipefail\nread -r -a phases <<< "$PHASES"\nnode scripts/run-full-regression-phases.mjs "${phases[@]}" 2>&1 \\\n  | tee "$RUNNER_TEMP/full-regression.log"',
      );
      expect(run).not.toHaveProperty('continue-on-error');
      expect(job['timeout-minutes']).toBeGreaterThanOrEqual(
        run['timeout-minutes'] ?? Infinity,
      );
      const matrix = job.strategy?.matrix?.include;
      if (matrix) {
        expect(job.strategy?.['fail-fast']).toBe(false);
        expect(run.env?.PHASES).toBe(githubExpression('matrix.phases'));
      }
      const selections = matrix?.map((row) => row.phases) ?? [
        run.env?.PHASES ?? '',
      ];
      if (id === 'process-heavy')
        expect(
          selections
            .map(
              (selection) =>
                selection.match(/--process-heavy-shard=(\d+\/\d+)/u)?.[1],
            )
            .sort(),
        ).toEqual(['1/2', '2/2']);
      for (const selection of selections)
        covered.push(
          ...selection
            .split(/\s+/u)
            .filter((argument) => argument.startsWith('--phase='))
            .map((phase) => phase.replace(/^--phase=/u, '')),
        );
      if (id !== 'static') {
        expect(
          namedStep(job, 'Prepare the corpus prerequisites').run,
        ).toContain('--phase=browser-prerequisite --phase=sdk-builds');
        const shell = namedStep(
          job,
          'Provision and preflight zsh for process-heavy installer fixtures',
        );
        expect(shell.run).toContain('test -x /bin/zsh');
        expect(
          namedStep(job, 'Install Chromium for full-corpus browser assertions')
            .run,
        ).toContain('exit 1');
      }
    }
    expect(covered.sort()).toEqual(
      [
        ...FULL_REGRESSION_PHASES.map((phase) => phase.id).filter(
          (id) => id !== 'browser-prerequisite',
        ),
        'test-full-process-heavy',
      ].sort(),
    );
    const final = jobs.qualification;
    expect(final.if).toBe('always() && !cancelled()');
    expect(final.needs).toEqual([
      'resolve',
      'static',
      'ordinary',
      'process-heavy',
      'exclusive',
      'android-viewport',
    ]);
    const attest = namedStep(
      final,
      'Require every qualification job to succeed',
    );
    expect(attest.run).toBe('node scripts/qualification-evidence.mjs attest');
    expect(attest.env).toMatchObject({
      NEEDS: githubExpression('toJSON(needs)'),
      SOURCE_SHA: githubExpression('inputs.source_sha'),
      REUSE_RUN: githubExpression('needs.resolve.outputs.reuse_run'),
    });
    expect(attest).not.toHaveProperty('continue-on-error');
  });

  test('every hosted process-heavy corpus caller installs the reviewed real parser before executing it', () => {
    const reusable = workflow('full-regression.yml');
    const staticJob = reusable.jobs?.static;
    if (!staticJob) throw new Error('Missing static qualification job');
    const pinned = namedStep(staticJob, 'Install pinned actionlint');
    expect(pinned.run).toContain('sha256sum --check --status');
    expect(pinned.run).toContain('"$RUNNER_TEMP/actionlint" >> "$GITHUB_PATH"');
    for (const [job, command] of [
      [
        reusable.jobs?.['process-heavy'],
        'node scripts/run-full-regression-phases.mjs',
      ],
      [
        workflow('ci-extended.yml').jobs?.['coverage-shard'],
        'node scripts/run-vitest-corpus.mjs',
      ],
    ] as const) {
      if (!job) throw new Error('Missing process-heavy corpus caller');
      const install = namedStep(job, 'Install pinned actionlint');
      const { if: condition, ...provision } = install;
      expect(provision).toEqual(pinned);
      if (command.includes('run-vitest-corpus'))
        expect(condition).toBe("matrix.id == 'process-heavy'");
      else expect(condition).toBeUndefined();
      const steps = job.steps ?? [];
      expect(steps.indexOf(install)).toBeLessThan(
        steps.findIndex((step) => step.run?.includes(command)),
      );
    }
  });

  test('bounds the workflow DAG to the admitted profile without canceling distinct queued sources', () => {
    const reusable = workflow('full-regression.yml');
    const delivery = workflow('delivery-validation.yml');
    const scheduled = workflow('main-qualification.yml');
    expect(scheduled).not.toHaveProperty('concurrency');
    expect(scheduled.jobs?.qualification).not.toHaveProperty('concurrency');
    expect(delivery.concurrency).toEqual({
      group: 'station-background-compute',
      queue: 'max',
      'cancel-in-progress': false,
    });
    expect(reusable.concurrency).toEqual({
      group: `\${{ inputs.capacity_class == 'background' && 'station-background-compute' || inputs.capacity_class == 'release' && 'station-release-qualification' || format('station-integration-qualification-{0}', inputs.source_sha) }}`,
      queue: 'max',
      'cancel-in-progress': false,
    });
    expect(
      workflow('ci.yml').jobs?.['merge-integration-full-regression'].with
        ?.capacity_class,
    ).toBe('integration');
    for (const file of [
      'release.yml',
      'publish-release.yml',
      'publish-packages.yml',
    ]) {
      const calls = Object.values(workflow(file).jobs ?? {}).filter(
        (job) => job.uses === './.github/workflows/full-regression.yml',
      );
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls)
        expect(call.with?.capacity_class).toBe('release');
    }
    expect(
      workflow('main-qualification.yml').jobs?.qualification.with
        ?.capacity_class,
    ).toBe('background');
    const resolveSteps = reusable.jobs?.resolve.steps ?? [];
    expect(
      resolveSteps.some((step) =>
        step.run?.includes('release-pipeline.mjs admission'),
      ),
    ).toBe(false);
    expect(
      resolveSteps.some((step) =>
        step.run?.includes('release-pipeline.mjs profile'),
      ),
    ).toBe(true);
    // Evaluate the real expression's supported string/boolean/format subset.
    // This checks routing, not GitHub's hosted scheduling implementation.
    const expression = reusable.concurrency?.group.slice(3, -2);
    const group = (capacity_class: string, source_sha: string) =>
      Function(
        'inputs',
        'format',
        `return (${expression});`,
      )({ capacity_class, source_sha }, (template: string, value: string) =>
        template.replace('{0}', value),
      );
    for (const sha of ['a'.repeat(40), 'b'.repeat(40)]) {
      expect(group('background', sha)).toBe(delivery.concurrency?.group);
      expect(group('integration', sha)).not.toBe(delivery.concurrency?.group);
      expect(group('release', sha)).not.toBe(delivery.concurrency?.group);
    }
    expect(group('integration', 'a'.repeat(40))).not.toBe(
      group('integration', 'b'.repeat(40)),
    );
    expect(group('release', 'a'.repeat(40))).toBe(
      group('release', 'b'.repeat(40)),
    );
    const jobs = reusable.jobs ?? {};
    const continueSuites =
      "always() && !cancelled() && needs.resolve.result == 'success' && needs.resolve.outputs.reuse_run == ''";
    expect(jobs.exclusive).toMatchObject({
      needs: ['resolve', 'static'],
      if: continueSuites,
    });
    expect(jobs['android-viewport']).toMatchObject({
      needs: ['resolve', 'exclusive'],
      if: continueSuites,
    });
    const ids = Object.keys(jobs);
    const predecessors = (id: string): Set<string> => {
      const needs = jobs[id].needs ?? [];
      const direct = typeof needs === 'string' ? [needs] : needs;
      return new Set(
        direct.flatMap((parent) => [parent, ...predecessors(parent)]),
      );
    };
    expect(
      ids.reduce(
        (count, id) =>
          count + (jobs[id].strategy?.matrix?.include?.length ?? 1),
        0,
      ),
    ).toBe(11);
    for (const [name, total, expectedPeak] of [
      ['free', '20', 4],
      ['expanded', '40', 7],
      ['custom', '20', 3],
    ] as const) {
      const profile = runnerProfile({
        STATION_QUALIFICATION_RUNNER_PROFILE: name,
        STATION_HOSTED_TOTAL_SLOTS: total,
        STATION_QUALIFICATION_ORDINARY_SLOTS: '1',
        STATION_QUALIFICATION_PROCESS_HEAVY_SLOTS: '1',
        STATION_INTEGRATION_RESERVE: '12',
      });
      // Enumerate runnable antichains: jobs related by needs cannot overlap.
      // Matrix caps determine the weight of the two corpus jobs.
      let peak = 0;
      for (let mask = 1; mask < 2 ** ids.length; mask++) {
        const active = ids.filter((_, index) => mask & (1 << index));
        if (
          active.some((id) =>
            active.some((other) => predecessors(id).has(other)),
          )
        )
          continue;
        peak = Math.max(
          peak,
          active.reduce(
            (sum, id) =>
              sum +
              (id === 'ordinary'
                ? profile.ordinary
                : id === 'process-heavy'
                  ? profile.heavy
                  : 1),
            0,
          ),
        );
      }
      expect(peak, name).toBe(expectedPeak);
      expect(profile.background, name).toBe(peak);
    }
  });

  test('requires an exact-source qualification receipt before promotion', () => {
    const retain = namedStep(
      workflow('full-regression.yml').jobs?.qualification ?? {},
      'Retain exact-SHA completion receipts',
    );
    expect(retain.with).toMatchObject({
      path: 'source-qualification.json',
      'if-no-files-found': 'error',
      'retention-days': 30,
    });
    expect(retain.with?.name).toContain(githubExpression('inputs.source_sha'));
    expect(retain).not.toHaveProperty('continue-on-error');
  });

  test('retains bounded per-job failure diagnostics without making them qualification evidence', () => {
    const jobs = workflow('full-regression.yml').jobs ?? {};
    for (const id of [
      'static',
      'ordinary',
      'process-heavy',
      'exclusive',
      'android-viewport',
    ]) {
      const retain = namedStep(jobs[id], 'Retain failure diagnostics');
      expect(retain.if).toBe('failure()');
      expect(retain.with?.['if-no-files-found']).toBe('ignore');
      expect(String(retain.with?.path)).toContain(
        id === 'android-viewport' ? 'test-results/' : 'full-regression.log',
      );
      expect(retain.with?.name).toContain(githubExpression('github.job'));
    }
  });

  test('keeps manual dispatch while excluding ordinary PR and main-push runs', () => {
    const ci = workflow('ci.yml');
    expect(ci.on?.workflow_dispatch).toBeDefined();
    const manual = ci.jobs?.['full-regression'] ?? {};
    expect(manual.uses).toBe('./.github/workflows/full-regression.yml');
    expect(manual.with?.source_sha).toBe(githubExpression('github.sha'));
    expect(manual.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(manual.if).not.toContain("github.event_name == 'push'");
    expect(manual.if).not.toContain("github.event_name == 'merge_group'");
    expect(source('ci.yml')).not.toContain('run: npm run full:regression');

    const diagnostics = ci.jobs?.['manual-completion-diagnostics'] ?? {};
    expect(diagnostics.needs).toEqual(['classify', 'full-regression']);
    expect(diagnostics.if).toContain(
      "github.event_name == 'workflow_dispatch'",
    );
    expect(
      diagnostics.steps?.some(
        (step) => step.run === 'npm run test:connected-agents',
      ),
    ).toBe(true);
    expect(namedStep(diagnostics, 'Veritas readiness evidence').run).toContain(
      'node scripts/veritas-readiness-evidence.mjs --check evidence',
    );
  });

  test('gates every tagged release producer before artifact work starts', () => {
    const release = workflow('release.yml');
    const full = release.jobs?.['full-regression'] ?? {};
    expect(full.needs).toEqual(['preflight', 'advisory']);
    expect(full.uses).toBe('./.github/workflows/full-regression.yml');
    expect(full.with?.source_sha).toBe(
      githubExpression('needs.preflight.outputs.sha'),
    );

    for (const id of [
      'desktop-macos',
      'desktop-windows',
      'desktop-linux',
      'portable',
      'android',
      'ios-simulator',
      'ios-device',
      'container',
    ]) {
      const producer = release.jobs?.[id] ?? {};
      expect(producer.needs, id).toEqual(['preflight', 'full-regression']);
      expect(producer.if, id).toContain(
        "needs['full-regression'].result == 'success'",
      );
    }
    expect(source('release.yml')).not.toContain('run: npm run full:regression');
  });
});
