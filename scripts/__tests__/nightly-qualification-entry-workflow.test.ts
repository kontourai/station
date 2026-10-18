import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

type Step = { id?: string; name?: string; run?: string; uses?: string };
type Job = {
  name?: string;
  needs?: string | string[];
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: unknown;
  concurrency?: { group: string; 'cancel-in-progress': boolean };
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: Step[];
};
type Workflow = {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, Job>;
};

const workflowsDir = resolve(import.meta.dirname, '../../.github/workflows');
const read = (name: string) =>
  load(readFileSync(join(workflowsDir, name), 'utf8')) as Workflow;
const qualification = read('main-qualification.yml');
const nightly = read('nightly.yml');
const expr = (inner: string) => `\${{ ${inner} }}`;
describe('independent scheduled delivery and full qualification', () => {
  it('concentrates full qualification every six hours without making Nightly wait', () => {
    expect(Object.keys(qualification.on).sort()).toEqual([
      'schedule',
      'workflow_dispatch',
    ]);
    expect(qualification.on.schedule).toEqual([{ cron: '17 */6 * * *' }]);
    expect(Object.keys(qualification.jobs)).toEqual([
      'qualification',
      'delivery-validation',
    ]);
    expect(qualification.jobs['delivery-validation'].needs).toEqual([
      'qualification',
    ]);
    expect(qualification.jobs['delivery-validation'].if).toBe(
      "needs.qualification.result == 'success'",
    );
    expect(qualification.jobs['delivery-validation'].uses).toBe(
      './.github/workflows/delivery-validation.yml',
    );
    expect(qualification.jobs.qualification.with?.source_sha).toBe(
      expr('github.sha'),
    );
    expect(Object.keys(nightly.on).sort()).toEqual([
      'schedule',
      'workflow_dispatch',
    ]);
    expect(nightly.on.schedule).toEqual([{ cron: '47 * * * *' }]);
    expect(nightly.jobs['full-regression']).toBeUndefined();
    expect(nightly.jobs['test-gate'].needs).toEqual(['delivery-decide']);
    expect(nightly.jobs['test-gate'].if).toContain(
      "needs.delivery-decide.outputs.publish == 'true'",
    );
    expect(nightly.concurrency).toEqual({
      group: 'nightly',
      'cancel-in-progress': false,
    });
  });

  it('retains real source usability evidence and decides cadence before expensive work', () => {
    const decide = nightly.jobs['delivery-decide'];
    expect(decide.needs).toBeUndefined();
    const run = decide.steps?.find((step) => step.id === 'decide')?.run;
    expect(run).toContain('--ledger-ref origin/main');
    expect(run).toContain('refs/tags/nightly-version-code/*');
    const commands = nightly.jobs['test-gate'].steps
      ?.map((step) => step.run)
      .join('\n');
    for (const command of [
      'npm run native-platform:ratchet',
      'npm run lint:check',
      'node scripts/typecheck-aggregate.mjs',
      'npm run test:e2e:pr-smoke',
    ])
      expect(commands).toContain(command);
  });
});

it('passes Actions read permission through both publisher callers and orders platforms after settlement independently of failure', () => {
  const cohort = read('nightly-native-cohort.yml');
  expect(nightly.jobs['native-cohort'].permissions?.actions).toBe('read');
  for (const name of ['promote-android', 'promote-macos'])
    expect(cohort.jobs[name].permissions?.actions).toBe('read');
  const stage = read('nightly-native-stage.yml');
  for (const name of ['stage-ios', 'stage-windows']) {
    expect(stage.jobs[name].if).toContain('always()');
    expect(stage.jobs[name].if).toContain('!cancelled()');
    expect(stage.jobs[name].if).toContain(
      "needs.plan-cohort.result == 'success'",
    );
    expect(stage.jobs[name].if).not.toMatch(
      /needs\.stage-(android|macos)\.result/,
    );
  }
});
describe('Nightly publication admission', () => {
  const publishers = [
    'fleet-staging',
    'native-cohort',
    'portable-nightly',
    'nightly-cli',
  ];
  const evaluate = (
    condition: string,
    needs: Record<string, unknown>,
    sha: string,
    cancelled = false,
  ) => {
    const expression = condition
      .slice(3, -2)
      .replace(/needs\.([\w-]+)/g, 'needs["$1"]');
    return Function(
      'needs',
      'github',
      'inputs',
      'always',
      'cancelled',
      `return (${expression})`,
    )(
      needs,
      { ref: 'refs/heads/main', sha, event_name: 'schedule' },
      {},
      () => true,
      () => cancelled,
    );
  };
  it.each(publishers)(
    '%s requires a successful source gate and binds its event SHA',
    (id) => {
      const job = nightly.jobs[id];
      const sha = 'a'.repeat(40);
      const needs = {
        'test-gate': { result: 'success', outputs: { source_sha: sha } },
        'native-stage': {
          result: 'success',
          outputs: { build: 'true', bundle_version: '123' },
        },
      };
      expect(evaluate(job.if ?? '', needs, sha)).toBe(true);
      for (const result of ['failure', 'cancelled', 'skipped'])
        expect(
          evaluate(
            job.if ?? '',
            { ...needs, 'test-gate': { result, outputs: { source_sha: sha } } },
            sha,
          ),
        ).toBe(false);
      expect(evaluate(job.if ?? '', needs, 'b'.repeat(40))).toBe(false);
      expect(evaluate(job.if ?? '', needs, sha, true)).toBe(false);
      expect(job.needs).toContain('test-gate');
    },
  );
  it('rejects a requested source other than the event SHA', () => {
    const source = nightly.jobs['test-gate'].steps?.find(
      (step) => step.id === 'source',
    );
    expect(source?.run).toContain('test "$source_sha" = "$GITHUB_SHA"');
    expect(source?.run).toContain(
      '[ "$REQUESTED_SOURCE_SHA" != "$GITHUB_SHA" ]',
    );
  });
});
