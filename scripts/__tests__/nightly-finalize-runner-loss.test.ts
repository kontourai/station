import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { evaluateIf } from './helpers/github-if.js';

/**
 * A protected verifier that GitHub never gives a runner must not cost the
 * whole, already-published cohort (run 43863134706: "The job was not acquired
 * by Runner of type hosted even after multiple attempts"). These tests drive
 * the cohort's real job graph, parsed from the workflow, through every run
 * shape the second verifier attempt touches. The `confirm-finalize-runner-loss`
 * decision is the real step script under bash, reading a jobs listing in the
 * exact shape GitHub's run-attempt jobs API returned for that run; the
 * incomplete-cohort receipt is the real step script and the real
 * `release-cohort-workflow.mjs`. What the record job writes once it runs is
 * deploy-ledger-nightly-batch.test.ts's subject.
 */

const root = resolve(import.meta.dirname, '../..');
const COHORT_URL = new URL(
  '../../.github/workflows/nightly-native-cohort.yml',
  import.meta.url,
);
const makeTempDir = trackTempDirs();

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};
type Job = {
  name?: string;
  if?: string;
  needs?: string[];
  'runs-on'?: string;
  outputs?: Record<string, string>;
  steps?: Step[];
  [key: string]: unknown;
};
type Workflow = { jobs: Record<string, Job> };
const cohort = () => load(readFileSync(COHORT_URL, 'utf8')) as Workflow;

/**
 * Every job from the verifier on, in the workflow's (dependency) order: read
 * from the workflow, so a job added after the verifier is walked too.
 */
const tail = (workflow: Workflow) => {
  const ids = Object.keys(workflow.jobs);
  const after = ids.slice(ids.indexOf('protected-finalize'));
  expect(after).toEqual(
    expect.arrayContaining([
      'protected-finalize',
      'confirm-finalize-runner-loss',
      'protected-finalize-retry',
      'record-native-completion',
      'clear-promotion-fence',
      'record-native-recovery',
    ]),
  );
  return after;
};
const SOURCE_SHA = 'a'.repeat(40);
const RUN_ID = '43863134706';

/** Run 43863134706's verifier job as `GET .../attempts/1/jobs` returned it. */
const neverAcquired = {
  id: 133326067954,
  run_id: Number(RUN_ID),
  run_attempt: 1,
  name: '3 · Publish native cohort / Verify providers and finalize',
  status: 'completed',
  conclusion: 'cancelled',
  created_at: '2026-11-16T13:22:26Z',
  started_at: '2026-11-16T13:22:26Z',
  completed_at: '2026-11-16T13:37:53Z',
  runner_id: 0,
  runner_name: '',
  runner_group_id: 0,
  labels: ['macos-15'],
  steps: [],
};
/** The same run's desktop publisher: a job that did get a runner. */
const desktopPublisher = {
  id: 133320826774,
  run_id: Number(RUN_ID),
  run_attempt: 1,
  name: '3 · Publish native cohort / Publish the complete desktop release',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-11-16T13:12:43Z',
  started_at: '2026-11-16T13:19:28Z',
  completed_at: '2026-11-16T13:22:26Z',
  runner_id: 1000397655,
  runner_name: 'GitHub Actions 1000397655',
  runner_group_id: 0,
  labels: ['macos-15'],
  steps: [
    {
      name: 'Set up job',
      status: 'completed',
      conclusion: 'success',
      number: 1,
    },
  ],
};
/** A verifier that got a runner and then ended `conclusion` (a timeout is `cancelled`). */
const ranThen = (conclusion: string) => ({
  ...neverAcquired,
  conclusion,
  started_at: '2026-11-16T13:24:02Z',
  runner_id: 1000397777,
  runner_name: 'GitHub Actions 1000397777',
  steps: desktopPublisher.steps,
});

function harness() {
  const dir = makeTempDir('station-finalize-runner-loss-');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // `gh api --paginate --slurp <path>`: prints the fixture pages and keeps
  // the arguments, so the test also sees which listing the step asked for.
  writeFileSync(
    join(bin, 'gh'),
    '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$STUB_GH_ARGS"\n[ "$STUB_GH_FAIL" = 1 ] && { echo \'gh: HTTP 503\' >&2; exit 1; }\ncat "$STUB_GH_PAGES"\n',
  );
  chmodSync(join(bin, 'gh'), 0o755);
  let scripts = 0;
  const bash = (script: string, env: Record<string, string>) => {
    scripts += 1;
    const file = join(dir, `step-${scripts}.sh`);
    writeFileSync(file, script);
    return spawnSync(
      'bash',
      ['--noprofile', '--norc', '-eo', 'pipefail', file],
      {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        env: {
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          HOME: process.env.HOME ?? dir,
          GITHUB_REPOSITORY: 'kontourai/station',
          GITHUB_RUN_ID: RUN_ID,
          GITHUB_RUN_ATTEMPT: '1',
          RUNNER_TEMP: dir,
          ...env,
        },
      },
    );
  };

  /**
   * Runs the confirm job's real decision step against a jobs listing: one
   * complete page by default, or exactly `pages`, or a `gh` that fails.
   */
  const confirm = (
    jobs: unknown[],
    firstResult: string,
    {
      pages: rawPages,
      ghFails = false,
    }: { pages?: unknown; ghFails?: boolean } = {},
  ) => {
    scripts += 1;
    const pages = join(dir, `pages-${scripts}.json`);
    const args = join(dir, `gh-args-${scripts}`);
    const output = join(dir, `output-${scripts}`);
    writeFileSync(
      pages,
      JSON.stringify(rawPages ?? [{ total_count: jobs.length, jobs }]),
    );
    writeFileSync(args, '');
    writeFileSync(output, '');
    const step = (
      cohort().jobs['confirm-finalize-runner-loss'].steps ?? []
    ).find((candidate) => candidate.id === 'decide');
    expect(step?.env?.FIRST_ATTEMPT_RESULT).toBe(
      '$' + '{{ needs.protected-finalize.result }}',
    );
    expect(step?.run).not.toContain('${{');
    const result = bash(step?.run ?? '', {
      GH_TOKEN: 'fixture-token',
      FIRST_ATTEMPT_RESULT: firstResult,
      GITHUB_OUTPUT: output,
      STUB_GH_PAGES: pages,
      STUB_GH_ARGS: args,
      STUB_GH_FAIL: ghFails ? '1' : '',
    });
    return {
      ...result,
      ghArgs: readFileSync(args, 'utf8'),
      outputs: Object.fromEntries(
        readFileSync(output, 'utf8')
          .split('\n')
          .filter((line) => line.includes('='))
          .map((line) => line.split('=') as [string, string]),
      ),
    };
  };

  /** Runs the recovery job's real receipt step with these job results. */
  const recoveryReceipt = (
    needs: Record<string, { result: string; outputs: Record<string, string> }>,
  ) => {
    const job = cohort().jobs['record-native-recovery'];
    const step = (job.steps ?? []).find(
      (candidate) =>
        candidate.name === 'Construct content-bound incomplete-cohort receipt',
    );
    const jobResults = (step?.env?.JOB_RESULTS ?? '').replace(
      /\$\{\{ needs\.([\w-]+)\.(result|outputs\.(\w+)) \}\}/g,
      (_, id: string, _field: string, output?: string) => {
        expect(needs[id], `recovery reads a job it needs: ${id}`).toBeDefined();
        return output ? (needs[id].outputs[output] ?? '') : needs[id].result;
      },
    );
    expect(jobResults).not.toContain('${{');
    scripts += 1;
    const work = join(dir, `recovery-${scripts}`);
    mkdirSync(work);
    const run = (step?.run ?? '').replaceAll(
      'node scripts/',
      `node ${root}/scripts/`,
    );
    const result = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run],
      {
        cwd: work,
        encoding: 'utf8',
        windowsHide: true,
        env: {
          PATH: process.env.PATH ?? '',
          SOURCE_SHA,
          GITHUB_RUN_ID: RUN_ID,
          JOB_RESULTS: jobResults,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(
      readFileSync(join(work, 'native-cohort-recovery.json'), 'utf8'),
    ) as {
      jobResults: Record<string, string>;
      completion: { providerFinality: string; durableCompletion: string };
    };
  };
  return { confirm, recoveryReceipt };
}

type Shape = {
  /** How the first verifier attempt ended, as its job record shows it. */
  first: 'success' | 'failure' | 'never-acquired' | 'ran-then-cancelled';
  /** How the second attempt ends if it runs. */
  retry?: 'success' | 'failure' | 'never-acquired';
  /**
   * A person cancels the run: `during` a job (it ends `cancelled`) or
   * `after` it ended. Every job admitted later sees cancelled().
   */
  cancel?: { during: string } | { after: string };
  /** The confirm job cannot read the listing. */
  confirmFails?: 'api-unreachable' | 'listing-incomplete';
  /** The record job died before any durable write. */
  recordFails?: boolean;
};

const resultOf = (attempt: string) =>
  attempt === 'never-acquired' || attempt === 'ran-then-cancelled'
    ? 'cancelled'
    : attempt;

type Done = { result: string; outputs: Record<string, string> };
const UPSTREAM = [
  'admit-cohort',
  'create-promotion-fence',
  'promote-android',
  'promote-macos',
  'deliver-ios',
];

/**
 * Walks the cohort's tail in `needs` order (a job is admitted only after
 * every job it needs has ended): each job runs when its parsed `if` is true
 * over its own `needs` and all its ancestors, a job that never ran is
 * `skipped` with no outputs, as GitHub reports it, and each job gets a
 * start/end tick so the test can see what was still running when.
 */
function simulate(shape: Shape, h: ReturnType<typeof harness>) {
  const workflow = cohort();
  const done: Record<string, Done> = Object.fromEntries(
    UPSTREAM.map((id) => [id, { result: 'success', outputs: {} }]),
  );
  const ticks: Record<string, { start: number; end: number }> =
    Object.fromEntries(UPSTREAM.map((id) => [id, { start: 0, end: 0 }]));
  const ancestorsOf = (id: string): string[] => {
    const direct = workflow.jobs[id]?.needs ?? [];
    return [...new Set(direct.flatMap((need) => [need, ...ancestorsOf(need)]))];
  };
  const ran: string[] = [];
  let cancelled = false;
  let recovery: ReturnType<
    ReturnType<typeof harness>['recoveryReceipt']
  > | null = null;
  const pending = tail(workflow);
  while (pending.length > 0) {
    const index = pending.findIndex((candidate) =>
      (workflow.jobs[candidate].needs ?? []).every((need) => need in done),
    );
    expect(index, `a job in ${pending.join(', ')} can be admitted`).not.toBe(
      -1,
    );
    const [id] = pending.splice(index, 1);
    const job = workflow.jobs[id];
    const needs = Object.fromEntries(
      (job.needs ?? []).map((need) => [need, done[need]]),
    );
    const ancestors = Object.fromEntries(
      ancestorsOf(id).map((ancestor) => [ancestor, done[ancestor]]),
    );
    const start = Math.max(
      0,
      ...(job.needs ?? []).map((need) => ticks[need].end),
    );
    if (!evaluateIf(job.if ?? '', { needs, ancestors, cancelled })) {
      done[id] = { result: 'skipped', outputs: {} };
      ticks[id] = { start, end: start };
      continue;
    }
    ran.push(id);
    ticks[id] = { start, end: start + 1 };
    if (id === 'protected-finalize') {
      done[id] = { result: resultOf(shape.first), outputs: {} };
    } else if (id === 'confirm-finalize-runner-loss') {
      const first =
        shape.first === 'never-acquired'
          ? neverAcquired
          : shape.first === 'ran-then-cancelled'
            ? ranThen('cancelled')
            : ranThen(shape.first);
      const firstResult = done['protected-finalize'].result;
      const decision =
        shape.confirmFails === 'api-unreachable'
          ? h.confirm([desktopPublisher, first], firstResult, { ghFails: true })
          : shape.confirmFails === 'listing-incomplete'
            ? h.confirm([desktopPublisher, first], firstResult, {
                pages: [{ total_count: 140, jobs: [desktopPublisher, first] }],
              })
            : h.confirm([desktopPublisher, first], firstResult);
      expect(decision.ghArgs).toContain(
        `repos/kontourai/station/actions/runs/${RUN_ID}/attempts/1/jobs`,
      );
      if (shape.confirmFails) {
        expect(decision.status, decision.stderr).toBe(1);
        expect(decision.outputs).toEqual({});
        done[id] = { result: 'failure', outputs: {} };
      } else {
        expect(decision.status, decision.stderr).toBe(0);
        done[id] = { result: 'success', outputs: decision.outputs };
      }
    } else if (id === 'protected-finalize-retry') {
      expect(
        shape.retry,
        'the shape says how a second attempt ends',
      ).toBeDefined();
      done[id] = { result: resultOf(shape.retry ?? ''), outputs: {} };
    } else if (id === 'record-native-recovery') {
      recovery = h.recoveryReceipt(needs);
      done[id] = { result: 'success', outputs: {} };
    } else if (id === 'record-native-completion' && shape.recordFails) {
      done[id] = { result: 'failure', outputs: {} };
    } else {
      done[id] = { result: 'success', outputs: {} };
    }
    const cancel = shape.cancel ?? {};
    if ('during' in cancel && cancel.during === id) {
      done[id] = { result: 'cancelled', outputs: {} };
      cancelled = true;
    }
    if ('after' in cancel && cancel.after === id) cancelled = true;
  }
  const finalizers = ['protected-finalize', 'protected-finalize-retry'].filter(
    (id) => done[id].result === 'success',
  );
  // Every job that writes the deploy ledger or moves the marker.
  const writers = Object.entries(workflow.jobs)
    .filter(([, job]) =>
      (job.steps ?? []).some(
        (step) =>
          step.run?.includes('deploy-ledger-commit.mjs') ||
          step.run?.includes('git/refs/tags/nightly"'),
      ),
    )
    .map(([id]) => id);
  return {
    ran,
    done,
    ticks,
    /** Which jobs left a final receipt; the artifact name is one per run. */
    finalReceipts: finalizers,
    ledgerWrites: writers.filter((id) => ran.includes(id)),
    recovery,
  };
}

describe.skipIf(process.platform === 'win32')(
  'a protected verifier that never got a runner',
  () => {
    it('is the same verifier job step for step, uploading the one final-receipt name', () => {
      const { jobs } = cohort();
      const first = jobs['protected-finalize'];
      const second = jobs['protected-finalize-retry'];
      const { name: _a, needs: _b, if: _c, ...firstRest } = first;
      const { name: _d, needs: _e, if: _f, ...secondRest } = second;
      // Same image, environment, permissions, timeout, env and steps.
      expect(secondRest).toEqual(firstRest);
      expect(second['runs-on']).toBe('macos-15');
      expect(second.needs).toEqual([
        ...(first.needs ?? []),
        'protected-finalize',
        'confirm-finalize-runner-loss',
      ]);
      const finalUpload = (job: Job) =>
        (job.steps ?? []).find(
          (step) =>
            step.uses?.startsWith('actions/upload-artifact@') &&
            step.with?.path === 'final-cohort-receipt.json',
        )?.with?.name;
      expect(finalUpload(second)).toBe(
        'nightly-cohort-final-$' + '{{ github.run_id }}',
      );
      expect(finalUpload(second)).toBe(finalUpload(first));
    });

    it('never acquired, then the second attempt verifies: one receipt, one record, no incomplete receipt', () => {
      const run = simulate(
        { first: 'never-acquired', retry: 'success' },
        harness(),
      );
      expect(run.done['confirm-finalize-runner-loss'].outputs).toEqual({
        runner_lost: 'true',
      });
      expect(run.ran).toEqual([
        'protected-finalize',
        'confirm-finalize-runner-loss',
        'protected-finalize-retry',
        'record-native-completion',
        'clear-promotion-fence',
      ]);
      expect(run.finalReceipts).toEqual(['protected-finalize-retry']);
      // The record job (ledger rows, then the Android marker) runs once.
      expect(run.ledgerWrites).toEqual(['record-native-completion']);
      expect(run.recovery).toBeNull();
    });

    it('a second attempt that verified is the finality the incomplete-cohort receipt reports', () => {
      // The record job failing after a verified second attempt is the shape
      // in which the recovery receipt must name finality confirmed.
      const run = simulate(
        { first: 'never-acquired', retry: 'success', recordFails: true },
        harness(),
      );
      expect(run.finalReceipts).toEqual(['protected-finalize-retry']);
      expect(run.recovery?.jobResults).toMatchObject({
        'protected-finalize': 'cancelled',
        'protected-finalize-retry': 'success',
      });
      expect(run.recovery?.completion).toMatchObject({
        providerFinality: 'confirmed',
        durableCompletion: 'not-recorded',
      });
    });

    it('never acquired, then the second attempt fails for real: nothing recorded, finality unconfirmed', () => {
      const run = simulate(
        { first: 'never-acquired', retry: 'failure' },
        harness(),
      );
      expect(run.ran).toContain('protected-finalize-retry');
      expect(run.finalReceipts).toEqual([]);
      expect(run.ledgerWrites).toEqual([]);
      expect(run.recovery?.jobResults['protected-finalize-retry']).toBe(
        'failure',
      );
      expect(run.recovery?.completion).toMatchObject({
        providerFinality: 'unconfirmed',
        durableCompletion: 'not-recorded',
      });
    });

    it('never acquired twice: no third attempt, nothing recorded', () => {
      const run = simulate(
        { first: 'never-acquired', retry: 'never-acquired' },
        harness(),
      );
      expect(
        run.ran.filter((id) => id.startsWith('protected-finalize')),
      ).toEqual(['protected-finalize', 'protected-finalize-retry']);
      expect(run.finalReceipts).toEqual([]);
      expect(run.ledgerWrites).toEqual([]);
      expect(run.recovery?.jobResults).toMatchObject({
        'protected-finalize': 'cancelled',
        'protected-finalize-retry': 'cancelled',
      });
      expect(run.recovery?.completion.providerFinality).toBe('unconfirmed');
    });

    it('a verifier that ran and failed stays a failure: no second attempt', () => {
      const run = simulate({ first: 'failure' }, harness());
      expect(run.done['confirm-finalize-runner-loss'].result).toBe('skipped');
      expect(run.done['protected-finalize-retry'].result).toBe('skipped');
      expect(run.finalReceipts).toEqual([]);
      expect(run.ledgerWrites).toEqual([]);
      expect(run.recovery?.completion.providerFinality).toBe('unconfirmed');
    });

    it('a verifier that ran and was then cancelled (a timeout) is not retried', () => {
      const run = simulate({ first: 'ran-then-cancelled' }, harness());
      expect(run.done['confirm-finalize-runner-loss']).toEqual({
        result: 'success',
        outputs: { runner_lost: 'false' },
      });
      expect(run.done['protected-finalize-retry'].result).toBe('skipped');
      expect(run.ledgerWrites).toEqual([]);
      expect(run.recovery?.completion.providerFinality).toBe('unconfirmed');
    });

    it('a verifier that succeeded: no second attempt, recorded once, no incomplete receipt', () => {
      const run = simulate({ first: 'success' }, harness());
      expect(run.ran).toEqual([
        'protected-finalize',
        'record-native-completion',
        'clear-promotion-fence',
      ]);
      expect(run.finalReceipts).toEqual(['protected-finalize']);
      expect(run.ledgerWrites).toEqual(['record-native-completion']);
      expect(run.recovery).toBeNull();
    });

    it('a person cancelling the run at any point stops the second attempt, records nothing and leaves the marker', () => {
      const h = harness();
      // While the first attempt waited for a runner: it ends cancelled with
      // the run, and nothing after it is admitted but the receipt.
      const waiting = simulate(
        { first: 'never-acquired', cancel: { during: 'protected-finalize' } },
        h,
      );
      expect(waiting.ran).toEqual([
        'protected-finalize',
        'record-native-recovery',
      ]);
      // GitHub gave up on the runner, then the cancel landed before the
      // confirm job was admitted.
      const beforeConfirm = simulate(
        { first: 'never-acquired', cancel: { after: 'protected-finalize' } },
        h,
      );
      expect(beforeConfirm.done['confirm-finalize-runner-loss'].result).toBe(
        'skipped',
      );
      // The confirm job read a lost runner, then the cancel landed before the
      // second attempt was admitted: `always()` alone would start it.
      const beforeRetry = simulate(
        {
          first: 'never-acquired',
          retry: 'success',
          cancel: { after: 'confirm-finalize-runner-loss' },
        },
        h,
      );
      expect(beforeRetry.done['confirm-finalize-runner-loss'].outputs).toEqual({
        runner_lost: 'true',
      });
      // The second attempt was running when the cancel landed.
      const duringRetry = simulate(
        {
          first: 'never-acquired',
          retry: 'success',
          cancel: { during: 'protected-finalize-retry' },
        },
        h,
      );
      expect(duringRetry.done['protected-finalize-retry'].result).toBe(
        'cancelled',
      );
      for (const [label, run] of [
        ['waiting', waiting],
        ['before confirm', beforeConfirm],
        ['before the second attempt', beforeRetry],
      ] as const)
        expect(run.done['protected-finalize-retry'].result, label).toBe(
          'skipped',
        );
      for (const [label, run] of [
        ['waiting', waiting],
        ['before confirm', beforeConfirm],
        ['before the second attempt', beforeRetry],
        ['during the second attempt', duringRetry],
      ] as const) {
        expect(run.finalReceipts, label).toEqual([]);
        // The ledger rows and the marker step live in these jobs only.
        expect(run.ledgerWrites, label).toEqual([]);
        expect(run.done['clear-promotion-fence'].result, label).toBe('skipped');
        expect(run.recovery?.completion.providerFinality, label).toBe(
          'unconfirmed',
        );
      }
    });

    it('the confirm job failing or the jobs API being unreachable is no second attempt', () => {
      for (const confirmFails of [
        'api-unreachable',
        'listing-incomplete',
      ] as const) {
        const run = simulate(
          { first: 'never-acquired', confirmFails },
          harness(),
        );
        expect(
          run.done['confirm-finalize-runner-loss'].result,
          confirmFails,
        ).toBe('failure');
        expect(run.done['protected-finalize-retry'].result, confirmFails).toBe(
          'skipped',
        );
        expect(run.ledgerWrites, confirmFails).toEqual([]);
        expect(run.recovery?.completion.providerFinality, confirmFails).toBe(
          'unconfirmed',
        );
      }
    });

    it('holds the promotion fence until the second attempt has ended', () => {
      for (const retry of ['success', 'failure', 'never-acquired'] as const) {
        const run = simulate({ first: 'never-acquired', retry }, harness());
        expect(run.ran, retry).toContain('protected-finalize-retry');
        expect(run.ran, retry).toContain('clear-promotion-fence');
        expect(
          run.ticks['clear-promotion-fence'].start,
          `${retry}: the fence is cleared only after the second attempt`,
        ).toBeGreaterThanOrEqual(run.ticks['protected-finalize-retry'].end);
      }
    });

    it('records only when exactly one verifier attempt verified', () => {
      const record = cohort().jobs['record-native-completion'];
      const results = ['success', 'failure', 'cancelled', 'skipped'];
      for (const first of results)
        for (const second of results) {
          const needs = {
            'protected-finalize': { result: first, outputs: {} },
            'protected-finalize-retry': { result: second, outputs: {} },
            'deliver-ios': { result: 'success', outputs: {} },
          };
          const runs = evaluateIf(record.if ?? '', { needs });
          const verified = [first, second].filter(
            (r) => r === 'success',
          ).length;
          if (runs)
            expect(verified, `record ran on ${first}/${second}`).toBe(1);
          if (verified === 0)
            expect(runs, `record ran on ${first}/${second}`).toBe(false);
        }
      // The two shapes the graph can reach with one verified attempt.
      for (const [first, second] of [
        ['success', 'skipped'],
        ['cancelled', 'success'],
      ])
        expect(
          evaluateIf(record.if ?? '', {
            needs: {
              'protected-finalize': { result: first, outputs: {} },
              'protected-finalize-retry': { result: second, outputs: {} },
              'deliver-ios': { result: 'failure', outputs: {} },
            },
          }),
          `${first}/${second} with iOS failed`,
        ).toBe(true);
    });

    it('reads only the exact job shape GitHub leaves for a runner it never assigned', () => {
      const h = harness();
      const decide = (jobs: unknown[], result: string) =>
        h.confirm(jobs, result);
      // Each departure from the never-acquired shape is a verdict.
      for (const [label, job] of [
        [
          'a runner name',
          { ...neverAcquired, runner_name: 'GitHub Actions 7' },
        ],
        ['a runner id', { ...neverAcquired, runner_id: 7 }],
        ['a step', { ...neverAcquired, steps: desktopPublisher.steps }],
      ] as const) {
        const run = decide([job], 'cancelled');
        expect(run.status, `${label}: ${run.stderr}`).toBe(0);
        expect(run.outputs, label).toEqual({ runner_lost: 'false' });
      }
      for (const result of ['failure', 'success']) {
        const run = decide([ranThen(result)], result);
        expect(run.status, run.stderr).toBe(0);
        expect(run.outputs).toEqual({ runner_lost: 'false' });
      }
      // An answer it cannot read is not a decision: exit 1, no output.
      for (const [label, jobs, result, message] of [
        ['no verifier job', [desktopPublisher], 'cancelled', 'found 0'],
        [
          'two verifier jobs',
          [neverAcquired, { ...neverAcquired, id: 1 }],
          'cancelled',
          'found 2',
        ],
        [
          'a job still running',
          [{ ...neverAcquired, status: 'in_progress', conclusion: null }],
          'cancelled',
          'is in_progress, not completed',
        ],
        [
          'a result the job record contradicts',
          [neverAcquired],
          'failure',
          'disagrees',
        ],
      ] as const) {
        const run = decide([...jobs], result);
        expect(run.status, label).toBe(1);
        expect(run.stderr, label).toContain(message);
        expect(run.outputs, label).toEqual({});
      }
      // A listing that is not the whole run attempt is not a decision either:
      // the first of two pages (the verifier on the second), or a page whose
      // job count disagrees with its total_count.
      const filler = Array.from({ length: 99 }, (_, n) => ({
        ...desktopPublisher,
        id: n,
        name: `3 · Publish native cohort / filler ${n}`,
      }));
      for (const [label, pages, message] of [
        [
          'the first page only',
          [{ total_count: 101, jobs: [...filler, desktopPublisher] }],
          'holds 100 job(s) but states total_count 101',
        ],
        [
          'a count mismatch',
          [{ total_count: 3, jobs: [desktopPublisher, neverAcquired] }],
          'holds 2 job(s) but states total_count 3',
        ],
        [
          'pages that disagree',
          [
            { total_count: 2, jobs: [desktopPublisher] },
            { total_count: 3, jobs: [neverAcquired] },
          ],
          'do not state one total_count',
        ],
      ] as const) {
        const run = h.confirm([], 'cancelled', { pages });
        expect(run.status, label).toBe(1);
        expect(run.stderr, label).toContain(message);
        expect(run.outputs, label).toEqual({});
      }
      // Two complete pages are read whole.
      const paged = h.confirm([], 'cancelled', {
        pages: [
          { total_count: 101, jobs: [...filler, desktopPublisher] },
          { total_count: 101, jobs: [neverAcquired] },
        ],
      });
      expect(paged.status, paged.stderr).toBe(0);
      expect(paged.outputs).toEqual({ runner_lost: 'true' });
      // The second attempt's own name never reads as the first attempt.
      const retryName = `3 · Publish native cohort / ${cohort().jobs['protected-finalize-retry'].name}`;
      const run = decide(
        [
          { ...neverAcquired, id: 2, name: retryName, status: 'queued' },
          neverAcquired,
        ],
        'cancelled',
      );
      expect(run.status, run.stderr).toBe(0);
      expect(run.outputs).toEqual({ runner_lost: 'true' });
    });
  },
);
