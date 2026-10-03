import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSON_SCHEMA, load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
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
      expect(job.needs).toBe('resolve');
      expect(job.if).toBe("needs.resolve.outputs.reuse_run == ''");
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

  test('gates the reusable native cohort and independent CLI on the same exact source', () => {
    const nightly = workflow('nightly.yml');
    const sourceGate = nightly.jobs?.['test-gate'] ?? {};
    const full = nightly.jobs?.['full-regression'] ?? {};
    expect(full.needs).toEqual(['test-gate']);
    expect(full.uses).toBe('./.github/workflows/full-regression.yml');
    expect(full.with?.source_sha).toBe(
      githubExpression('needs.test-gate.outputs.source_sha'),
    );
    expect(
      sourceGate.steps?.some(
        (step) => step.name === 'Bind every Nightly leg to one main revision',
      ),
    ).toBe(true);
    // Staging publishes nothing, so it may run beside the gate (#1453); the
    // publishing cohort must not start until the receipt AND staging succeeded.
    const staging = nightly.jobs?.['native-stage'] ?? {};
    expect(staging.needs).toEqual(['test-gate']);
    expect(staging.if).not.toContain('full-regression');
    expect(staging.uses).toBe('./.github/workflows/nightly-native-stage.yml');
    for (const id of ['native-cohort', 'nightly-cli']) {
      const producer = nightly.jobs?.[id] ?? {};
      expect(producer.if).toContain(
        "needs['full-regression'].result == 'success'",
      );
      if (id === 'native-cohort') {
        expect(producer.needs).toEqual([
          'test-gate',
          'full-regression',
          'native-stage',
        ]);
        expect(producer.if).toContain(
          "needs['native-stage'].result == 'success'",
        );
        expect(producer.uses).toBe(
          './.github/workflows/nightly-native-cohort.yml',
        );
        expect(producer.with?.source_sha).toBe(
          githubExpression('needs.test-gate.outputs.source_sha'),
        );
        expect(producer.secrets).toBe('inherit');
      } else {
        expect(producer.needs).toEqual(['test-gate', 'full-regression']);
        const checkout = producer.steps?.find((step) =>
          step.uses?.startsWith('actions/checkout@'),
        );
        expect(checkout?.with?.ref).toBe(
          githubExpression('needs.test-gate.outputs.source_sha'),
        );
      }
    }
    expect(source('nightly.yml')).not.toContain('run: npm run full:regression');
  });

  test('gates every tagged release producer before artifact work starts', () => {
    const release = workflow('release.yml');
    const full = release.jobs?.['full-regression'] ?? {};
    expect(full.needs).toEqual(['preflight']);
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
