import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSON_SCHEMA, load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { FULL_REGRESSION_TIMEOUT_MS } from '../verification-lanes.mjs';

const root = resolve(import.meta.dirname, '../..');

type WorkflowStep = {
  name?: string;
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
  test('has one reusable exact-SHA implementation and no automatic trigger', () => {
    const reusable = workflow('full-regression.yml');
    expect(Object.keys(reusable.on ?? {})).toEqual(['workflow_call']);
    expect(reusable.on?.workflow_call?.inputs?.source_sha).toMatchObject({
      required: true,
      type: 'string',
    });

    const gate = reusable.jobs?.['full-regression'] ?? {};
    expect(gate.uses).toBeUndefined();
    expect(gate['timeout-minutes']).toBe(340);
    expect(source('full-regression.yml')).not.toContain('timeout-minutes: 150');
    const validate = namedStep(gate, 'Validate immutable source identity');
    expect(validate.run).toContain('^[0-9a-f]{40}$');
    expect(validate['timeout-minutes']).toBe(2);
    const checkout = gate.steps?.find((step) =>
      step.uses?.startsWith('actions/checkout@'),
    );
    expect(checkout?.with).toMatchObject({
      ref: githubExpression('inputs.source_sha'),
      'fetch-depth': 0,
      'persist-credentials': false,
    });
    expect(checkout?.['timeout-minutes']).toBe(10);
    const receipts = namedStep(gate, 'Retain exact-SHA completion receipts');
    expect(receipts['timeout-minutes']).toBe(10);
    const proveCheckout = namedStep(
      gate,
      'Prove checkout matches the requested source',
    );
    expect(proveCheckout['timeout-minutes']).toBe(2);
    expect(
      namedStep(gate, 'Prove checkout matches the requested source').run,
    ).toContain('git rev-parse HEAD');
    const gateSteps = gate.steps ?? [];
    const actionlint = namedStep(gate, 'Install pinned actionlint');
    const ciFast = workflow('ci.yml').jobs?.['fast-checks'] ?? {};
    expect(actionlint).toEqual(namedStep(ciFast, 'Install pinned actionlint'));
    expect(actionlint).not.toHaveProperty('continue-on-error');
    const actionlintIndex = gateSteps.indexOf(actionlint);
    const dependenciesIndex = gateSteps.findIndex(
      (step) => step.run === 'npm run dependencies:ci',
    );
    const zsh = namedStep(
      gate,
      'Provision and preflight zsh for process-heavy installer fixtures',
    );
    const zshIndex = gateSteps.indexOf(zsh);
    const completionIndex = gateSteps.findIndex(
      (step) => step.name === 'Run canonical completion gate',
    );
    expect(actionlintIndex).toBeGreaterThan(-1);
    expect(dependenciesIndex).toBeGreaterThan(actionlintIndex);
    expect(zshIndex).toBeGreaterThan(dependenciesIndex);
    expect(gateSteps[dependenciesIndex]['timeout-minutes']).toBe(15);
    expect(zsh['timeout-minutes']).toBe(5);
    expect(zsh.run).toContain('if [[ ! -x /bin/zsh ]]; then');
    expect(zsh.run).toContain('apt-get install --yes zsh');
    expect(zsh.run).toContain('test -x /bin/zsh');
    expect(zsh.run).toContain('/bin/zsh --version');
    expect(completionIndex).toBeGreaterThan(dependenciesIndex);
    expect(
      namedStep(gate, 'Install Chromium for full-corpus browser assertions')
        .run,
    ).toContain('npx playwright install chromium');
    // #1459 changed this step's shape deliberately: it now pipes the gate
    // through `tee` so the verdict report below can read the captured stdout.
    // The pins that matter are unchanged and are asserted individually rather
    // than through one `toBe` on the whole script: the canonical command is
    // still what runs, and the job's failure signal is still the gate's own
    // exit status. `set -o pipefail` is the second of those — without it the
    // pipeline reports `tee`'s status and a red gate would pass the job.
    const completionRun = namedStep(gate, 'Run canonical completion gate').run;
    expect(completionRun).toContain('npm run full:regression');
    expect(completionRun).toContain('set -o pipefail');
    expect(completionRun?.indexOf('set -o pipefail')).toBeLessThan(
      completionRun?.indexOf('| tee') as number,
    );
    expect(namedStep(gate, 'Run canonical completion gate')).not.toHaveProperty(
      'continue-on-error',
    );
    const verdictReport = namedStep(gate, 'Report the completion gate verdict');
    expect(verdictReport.if).toBe('always()');
    expect(verdictReport['timeout-minutes']).toBe(2);
    expect(verdictReport.run).toContain(
      'node scripts/verification-gate-summary.mjs',
    );
    // Both steps must name the SAME capture file, or the report renders an
    // empty summary for a run whose verdict was captured elsewhere.
    expect(completionRun).toContain(
      '"$RUNNER_TEMP/full-regression.stdout.log"',
    );
    expect(verdictReport.run).toContain(
      '"$RUNNER_TEMP/full-regression.stdout.log"',
    );
    expect(gateSteps.indexOf(verdictReport)).toBeGreaterThan(completionIndex);
    // The job's own deadline is the last-resort backstop once every phase
    // has its own; this proves it actually covers the bounded worst case
    // rather than merely stating a number, so drift here fails loudly
    // instead of silently narrowing a completed gate's real margin.
    const chromium = namedStep(
      gate,
      'Install Chromium for full-corpus browser assertions',
    );
    const setupNode = gate.steps?.find((step) =>
      step.uses?.startsWith('actions/setup-node@'),
    );
    expect(setupNode?.['timeout-minutes']).toBe(5);
    expect(actionlint['timeout-minutes']).toBe(5);
    // Every step in this list must declare `timeout-minutes`: no `?? 0`
    // fallback, so an added or edited pre-gate/publication step without one
    // silently drops out of the bound instead of failing this assertion.
    const boundedSteps = [
      validate,
      checkout,
      setupNode,
      actionlint,
      gateSteps[dependenciesIndex],
      zsh,
      chromium,
      proveCheckout,
      verdictReport,
      receipts,
    ];
    for (const step of boundedSteps) {
      expect(typeof step?.['timeout-minutes']).toBe('number');
    }
    const boundedSetupMinutes = boundedSteps.reduce(
      (total, step) => total + (step?.['timeout-minutes'] as number),
      0,
    );
    const phaseMinutes = FULL_REGRESSION_TIMEOUT_MS / 60_000;
    expect(gate['timeout-minutes']).toBeGreaterThanOrEqual(
      boundedSetupMinutes + phaseMinutes,
    );
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    );
    expect(manifest['trust-reconcile-manifest']).toContainEqual({
      id: 'full-regression',
      command: 'npm run full:regression',
    });
    expect(manifest.scripts['full:regression:raw']).toContain(
      'npm run proof:repo-governance',
    );
    expect(manifest.scripts['full:regression:raw']).toContain(
      'npm run test:full:raw',
    );
    expect(source('full-regression.yml')).not.toContain(
      'run: npm run test:connected-agents',
    );
    expect(source('full-regression.yml')).not.toContain(
      'node scripts/veritas-readiness-evidence.mjs',
    );
  });

  test('retains hidden canonical receipts as required promotion evidence', () => {
    const gate =
      workflow('full-regression.yml').jobs?.['full-regression'] ?? {};
    const retain = namedStep(gate, 'Retain exact-SHA completion receipts');
    expect(retain.if).toBe('always()');
    expect(retain.with).toMatchObject({
      'if-no-files-found': 'error',
      'include-hidden-files': true,
      'retention-days': 14,
    });
    expect(String(retain.with?.path)).toContain(
      '.kontourai/verification-receipts/',
    );
    expect(String(retain.with?.path)).toContain(
      '.kontourai/verification-output/',
    );
    expect(String(retain.with?.path)).toContain(
      '.kontourai/verification-phase-records/',
    );
    expect(source('full-regression.yml')).not.toContain('continue-on-error');
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
    for (const id of ['native-cohort', 'nightly-cli']) {
      const producer = nightly.jobs?.[id] ?? {};
      expect(producer.needs).toEqual(['test-gate', 'full-regression']);
      expect(producer.if).toContain(
        "needs['full-regression'].result == 'success'",
      );
      if (id === 'native-cohort') {
        expect(producer.uses).toBe(
          './.github/workflows/nightly-native-cohort.yml',
        );
        expect(producer.with?.source_sha).toBe(
          githubExpression('needs.test-gate.outputs.source_sha'),
        );
        expect(producer.secrets).toBe('inherit');
      } else {
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
