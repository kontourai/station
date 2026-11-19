import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { JSON_SCHEMA, load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';

const exec = promisify(execFile);
const makeTempDir = trackTempDirs();
const head = 'a'.repeat(40);
const old = 'b'.repeat(40);
const repository = 'kontourai/station';
const script = resolve(import.meta.dirname, '../pr-ci-supersession.mjs');

function run(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    run_attempt: 1,
    status: 'in_progress',
    event: 'pull_request_target',
    path: '.github/workflows/ci.yml',
    head_sha: old,
    head_branch: 'feature',
    head_repository: { full_name: repository },
    pull_requests: [{ number: 7 }],
    ...overrides,
  };
}

async function exercise({
  runs = [run(1)],
  changedHead = false,
  failure = false,
  completed = false,
  fork = false,
  cancellationStalls = false,
  forceStalls = false,
  headChangesAfterCancel = false,
  attemptChangesAfterCancel = false,
  activeRunner = false,
  activeRunnerRuns = undefined as number[] | undefined,
  refusedCancellations = [] as number[],
  refusalStatus = 409,
  headChangesDuringJobs = false,
  badJob = undefined as Record<string, unknown> | undefined,
  forceRefusals = [] as number[],
  forceRefusalStatus = 409,
  terminalAtForceRefusal = false,
  attemptChangesAtForceRefusal = false,
  statusAtForceRefusal = undefined as string | undefined,
} = {}) {
  const cancelled: number[] = [];
  const forced: number[] = [];
  const forceRefused: number[] = [];
  let reads = 0;
  let jobsRead = false;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname.endsWith('/pulls/7')) {
      reads++;
      if (failure && reads > 1) {
        res.writeHead(503);
        res.end('{}');
        return;
      }
      res.end(
        JSON.stringify({
          state: 'open',
          base: { ref: 'main' },
          head: {
            sha:
              (changedHead && reads > 1) ||
              (headChangesAfterCancel && cancelled.length > 0) ||
              (headChangesDuringJobs && jobsRead)
                ? old
                : head,
            ref: 'feature',
            repo: { full_name: fork ? 'someone/station' : repository },
          },
        }),
      );
    } else if (url.pathname.endsWith('/actions/runs')) {
      res.end(
        JSON.stringify({
          workflow_runs: runs.filter(
            (run) => run.status === url.searchParams.get('status'),
          ),
        }),
      );
    } else if (/\/actions\/runs\/\d+\/jobs$/.test(url.pathname)) {
      jobsRead = true;
      const runId = Number(url.pathname.split('/').at(-2));
      const jobs: Record<string, unknown>[] =
        activeRunner || activeRunnerRuns?.includes(runId)
          ? [
              {
                id: 10,
                run_id: Number(url.pathname.split('/').at(-2)),
                run_attempt: 1,
                head_sha: old,
                status: 'in_progress',
                runner_id: 123,
              },
            ]
          : [];
      if (badJob)
        jobs.push({
          id: 11,
          run_id: Number(url.pathname.split('/').at(-2)),
          run_attempt: 1,
          head_sha: old,
          ...badJob,
        });
      res.end(JSON.stringify({ total_count: jobs.length, jobs }));
    } else if (/\/actions\/runs\/\d+\/cancel$/.test(url.pathname)) {
      expect(req.method).toBe('POST');
      const runId = Number(url.pathname.split('/').at(-2));
      // GitHub's answer for a run it will not cancel (observed on runs stuck
      // queued with no jobs); nothing is cancelled.
      if (refusedCancellations.includes(runId)) {
        res.writeHead(refusalStatus);
        res.end('{"message":"Cannot cancel this workflow run."}');
        return;
      }
      cancelled.push(runId);
      res.writeHead(202);
      res.end();
    } else if (/\/actions\/runs\/\d+\/force-cancel$/.test(url.pathname)) {
      expect(req.method).toBe('POST');
      const runId = Number(url.pathname.split('/').at(-2));
      // With terminalAtForceRefusal the stalled normal cancellation finishes
      // as GitHub refuses (runs 43793311034 and 43764828590 read cancelled
      // within a second of their refusals).
      if (forceRefusals.includes(runId)) {
        forceRefused.push(runId);
        res.writeHead(forceRefusalStatus);
        res.end('{"message":"Cannot force cancel this workflow run."}');
        return;
      }
      forced.push(runId);
      res.writeHead(202);
      res.end();
    } else if (/\/actions\/runs\/\d+$/.test(url.pathname)) {
      const item = runs.find(
        (r) => r.id === Number(url.pathname.split('/').at(-1)),
      );
      if (!item) {
        res.writeHead(404);
        res.end('{}');
        return;
      }
      res.end(
        JSON.stringify({
          ...item,
          ...(completed ||
          (cancelled.includes(item.id) && !cancellationStalls) ||
          (terminalAtForceRefusal && forceRefused.includes(item.id)) ||
          (forced.includes(item.id) && !forceStalls)
            ? { status: 'completed', conclusion: 'cancelled' }
            : {}),
          ...(attemptChangesAfterCancel && cancelled.includes(item.id)
            ? { run_attempt: 2 }
            : {}),
          ...(attemptChangesAtForceRefusal && forceRefused.includes(item.id)
            ? { run_attempt: 2 }
            : {}),
          ...(statusAtForceRefusal && forceRefused.includes(item.id)
            ? { status: statusAtForceRefusal }
            : {}),
        }),
      );
    } else {
      res.writeHead(404);
      res.end('{}');
    }
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const event = join(makeTempDir('pr-ci-supersession-'), 'event.json');
  // A late event names the old head. Only the live REST head authorizes effects.
  writeFileSync(
    event,
    JSON.stringify({
      workflow_run: { head_sha: old, pull_requests: [{ number: 7 }] },
    }),
  );
  let code = 0;
  let stdout = '';
  try {
    ({ stdout } = await exec(process.execPath, [script], {
      windowsHide: true,
      env: {
        PATH: process.env.PATH ?? '',
        GITHUB_EVENT_PATH: event,
        GITHUB_REPOSITORY: repository,
        GITHUB_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      },
    }));
  } catch (error) {
    code = (error as { code: number }).code;
    stdout = (error as { stdout: string }).stdout;
  } finally {
    await new Promise<void>((ok, reject) =>
      server.close((error) => (error ? reject(error) : ok())),
    );
  }
  lastStdout = stdout;
  lastForceRefused = forceRefused;
  return { code, cancelled, forced };
}
// The previous exercise's stdout, kept out of the result so the many exact
// `{ code, cancelled, forced }` assertions stay as they are.
let lastStdout = '';
let lastForceRefused: number[] = [];

describe('obsolete PR CI cancellation through the GitHub API', () => {
  it.each(['in_progress', 'queued', 'pending'])(
    'cancels obsolete %s verification while retaining the current head and unrelated work',
    async (status) => {
      const result = await exercise({
        runs: [
          run(1, { status }),
          run(2, { head_sha: head, status }),
          run(3, { event: 'merge_group' }),
          run(4, { event: 'workflow_dispatch' }),
          run(5, { path: '.github/workflows/nightly.yml' }),
          run(6, { head_repository: { full_name: 'someone/station' } }),
          run(7, { pull_requests: [{ number: 8 }] }),
          run(8, { head_branch: 'another-feature' }),
          run(9, { path: '.github/workflows/build-ios.yml' }),
        ],
      });
      expect(result).toEqual({ code: 0, cancelled: [1, 9], forced: [] });
    },
  );

  it.each([{ changedHead: true }, { completed: true }, { fork: true }])(
    'leaves work alone when its cancellation authority disappears: %j',
    async (world) => {
      expect(await exercise(world)).toEqual({
        code: 0,
        cancelled: [],
        forced: [],
      });
    },
  );

  it('settles a stuck obsolete pending run through one force-cancel after normal cancellation', async () => {
    expect(
      await exercise({
        runs: [
          run(1, { status: 'pending' }),
          run(2, { status: 'pending', head_sha: head }),
        ],
        cancellationStalls: true,
      }),
    ).toEqual({ code: 0, cancelled: [1], forced: [1] });
  });

  it.each([
    { headChangesAfterCancel: true },
    { attemptChangesAfterCancel: true },
  ])(
    'does not force a run after cancellation authority changes: %j',
    async (change) => {
      expect(
        await exercise({
          runs: [run(1, { status: 'pending' })],
          cancellationStalls: true,
          ...change,
        }),
      ).toEqual({ code: 0, cancelled: [1], forced: [] });
    },
  );

  it('rechecks the PR after job inventory before force-cancel', async () => {
    expect(
      await exercise({
        runs: [run(1, { status: 'pending' })],
        cancellationStalls: true,
        headChangesDuringJobs: true,
      }),
    ).toEqual({ code: 0, cancelled: [1], forced: [] });
  });

  // A requested cancellation that a runner has not yet acted on is reported,
  // not fatal: the run was not forced, and the next event retries it.
  it('does not force-cancel while an assigned runner is still unfinished', async () => {
    expect(
      await exercise({
        runs: [run(1, { status: 'pending' })],
        cancellationStalls: true,
        activeRunner: true,
      }),
    ).toEqual({ code: 0, cancelled: [1], forced: [] });
    expect(lastStdout).toContain(
      '::warning::Obsolete run 1 still has an assigned runner; force-cancel refused',
    );
    expect(lastStdout).toContain('1 obsolete run(s) not yet terminal');
  });

  // Real shapes from failed passes on 2026-11-11/12: one run that will not
  // settle (an assigned runner, a 409 refusal) used to end the pass before
  // later obsolete runs were reached.
  it.each([
    { name: 'assigned runner', world: { activeRunnerRuns: [1] } },
    { name: 'HTTP 409', world: { refusedCancellations: [1] } },
  ])(
    'still cancels later obsolete runs after one does not settle ($name)',
    async ({ world }) => {
      const result = await exercise({
        runs: [
          run(1, { status: 'pending' }),
          run(9, {
            status: 'pending',
            path: '.github/workflows/build-ios.yml',
          }),
        ],
        cancellationStalls: true,
        ...world,
      });
      expect(result.code).toBe(0);
      expect(result.cancelled).toContain(9);
      expect(result.forced).toEqual([9]);
      expect(lastStdout).toMatch(/::warning::.*run 1\b/);
      expect(lastStdout).toContain('1 obsolete run(s) not yet terminal');
    },
  );

  // Any other refusal is not a cancellation in flight and stays fatal
  // (HTTP 502 on this request was also seen in the failed passes).
  it('still fails when a cancellation request fails for another reason', async () => {
    expect(
      await exercise({
        runs: [
          run(1, { status: 'pending' }),
          run(9, {
            status: 'pending',
            path: '.github/workflows/build-ios.yml',
          }),
        ],
        refusedCancellations: [1],
        refusalStatus: 502,
      }),
    ).toEqual({ code: 1, cancelled: [], forced: [] });
  });

  it.each([null, 0])(
    'accepts explicit unassigned runner identity %j',
    async (runner_id) => {
      expect(
        await exercise({
          runs: [run(1, { status: 'pending' })],
          cancellationStalls: true,
          badJob: { status: 'queued', runner_id },
        }),
      ).toEqual({ code: 0, cancelled: [1], forced: [1] });
    },
  );

  it.each([
    { status: 'queued' },
    { status: 'mystery', runner_id: null },
    { status: 'queued', runner_id: 'unassigned' },
  ])(
    'refuses ambiguous job metadata before force-cancel: %j',
    async (badJob) => {
      expect(
        await exercise({
          runs: [run(1, { status: 'pending' })],
          cancellationStalls: true,
          badJob,
        }),
      ).toEqual({ code: 1, cancelled: [1], forced: [] });
    },
  );

  it('reports, without failing, a force-cancel that is not yet terminal', async () => {
    expect(
      await exercise({
        runs: [run(1, { status: 'pending' })],
        cancellationStalls: true,
        forceStalls: true,
      }),
    ).toEqual({ code: 0, cancelled: [1], forced: [1] });
    expect(lastStdout).toContain(
      '::warning::Force cancellation of obsolete run 1 is not terminal',
    );
  });

  // Runs 43793311034 and 43764828590: the normal cancellation finished
  // between the last read and the force-cancel, which GitHub then refused.
  const twoStalled = () => [
    run(1, { status: 'pending' }),
    run(9, { status: 'pending', path: '.github/workflows/build-ios.yml' }),
  ];

  it('treats a force-cancel refused because the run became terminal as settled', async () => {
    const result = await exercise({
      runs: twoStalled(),
      cancellationStalls: true,
      forceRefusals: [1],
      terminalAtForceRefusal: true,
    });
    expect(lastForceRefused).toEqual([1]);
    expect(result).toEqual({ code: 0, cancelled: [1, 9], forced: [9] });
    expect(lastStdout).toContain('Obsolete run 1 is terminal: cancelled');
    expect(lastStdout).not.toContain('::warning::');
  });

  it('warns and continues when a force-cancel is refused while the run stays live', async () => {
    const result = await exercise({
      runs: twoStalled(),
      cancellationStalls: true,
      forceRefusals: [1],
    });
    expect(lastForceRefused).toEqual([1]);
    expect(result).toEqual({ code: 0, cancelled: [1, 9], forced: [9] });
    expect(lastStdout).toContain(
      '::warning::GitHub refused force cancellation of obsolete run 1 (HTTP 409)',
    );
    expect(lastStdout).toContain('1 obsolete run(s) not yet terminal');
  });

  it('says nothing about a refused force-cancel once the run is a new attempt', async () => {
    const result = await exercise({
      runs: twoStalled(),
      cancellationStalls: true,
      forceRefusals: [1],
      attemptChangesAtForceRefusal: true,
    });
    expect(lastForceRefused).toEqual([1]);
    expect(result).toEqual({ code: 0, cancelled: [1, 9], forced: [9] });
    expect(lastStdout).not.toContain('Obsolete run 1 is terminal');
    expect(lastStdout).not.toContain('::warning::');
  });

  it('fails when a refused force-cancel leaves the run in an unknown state', async () => {
    const result = await exercise({
      runs: twoStalled(),
      cancellationStalls: true,
      forceRefusals: [1],
      statusAtForceRefusal: 'unheard-of',
    });
    expect(lastForceRefused).toEqual([1]);
    expect(result).toEqual({ code: 1, cancelled: [1], forced: [] });
  });

  it('still fails when a force-cancel fails for another reason', async () => {
    const result = await exercise({
      runs: twoStalled(),
      cancellationStalls: true,
      forceRefusals: [1],
      forceRefusalStatus: 500,
      terminalAtForceRefusal: true,
    });
    expect(lastForceRefused).toEqual([1]);
    expect(result).toEqual({ code: 1, cancelled: [1], forced: [] });
  });

  it('refuses cancellation when the live-head read fails', async () => {
    expect(await exercise({ failure: true })).toEqual({
      code: 1,
      cancelled: [],
      forced: [],
    });
  });
});

// Identity and source-job names retained from merged #3754 run 39011497715.
// The live optional row models the parent's observed pre-cancellation holder;
// it is not a claim that this now-terminal run is still running.
const holderHead = '98529c9591b63669a358ce33457a5684237adb54';
const holderBase = '1fe533c675abf352a519c3a9ab5a878f64928459';
const holder = {
  id: 39011497715,
  workflow_id: 344177106,
  run_attempt: 1,
  status: 'queued',
  event: 'pull_request_target',
  path: '.github/workflows/ci.yml',
  head_sha: holderHead,
  head_branch: 'fix/free-pool-repository-budgets-20261017',
  head_repository: { full_name: repository },
  pull_requests: [],
  referenced_workflows: [
    'source-verification-policy.yml',
    'full-regression.yml',
    'delivery-validation.yml',
    'install-smoke.yml',
    'portable-server-archives.yml',
    'desktop-rust.yml',
    'desktop-clean-checkout.yml',
    'ecosystem-packaging.yml',
  ].map((name) => ({
    path: `${repository}/.github/workflows/${name}@${holderBase}`,
    sha: holderBase,
    ref: 'refs/heads/main',
  })),
};
const merged = {
  number: 3754,
  state: 'closed',
  merged: true,
  merged_at: '2026-10-17T07:14:39Z',
  merge_commit_sha: '94434cc23e8004c7f4041be6a63b4a769bf8a1c3',
  head: {
    sha: holderHead,
    ref: holder.head_branch,
    repo: { full_name: repository },
  },
  base: { ref: 'main', repo: { full_name: repository } },
};
const sourceNames = [
  'PR source admission',
  'Pinned actionlint artifact',
  'Repository source scans',
  'fast-checks plan',
  'fast-checks statics',
  'PR title status publisher',
  'UI entry bundle delta (report only)',
  'Fork pull-request smoke',
  'Exact full-diff classification',
  'diff',
  'fast-checks shard 2',
  'fast-checks shard 1',
  'fast-checks',
  'Publish source admission / reconcile',
  'Merge-queue regression',
  'full-regression',
  'manual-completion-diagnostics',
  'Plan affected delivery checks',
];
const skippedNames = new Set([
  'Fork pull-request smoke',
  'Exact full-diff classification',
  'diff',
  'Merge-queue regression',
  'full-regression',
  'manual-completion-diagnostics',
]);
function mergedWorld() {
  return {
    pr: structuredClone(merged),
    run: structuredClone(holder),
    jobs: [
      ...sourceNames.map((name, index) => ({
        id: 100 + index,
        name,
        status: 'completed',
        conclusion: skippedNames.has(name) ? 'skipped' : 'success',
        run_id: holder.id,
        run_attempt: 1,
        head_sha: holderHead,
      })),
      {
        id: 117351982579,
        name: 'delivery-validation / install / install-prebuilt-archive (macos-15, darwin-arm64)',
        status: 'in_progress',
        conclusion: null,
        run_id: holder.id,
        run_attempt: 1,
        head_sha: holderHead,
      },
    ],
    shared: false,
    reopen: false,
    attemptChanges: false,
    unknownReference: false,
    truncated: false,
    failedRead: false,
    sharedAtEffect: false,
    refuseCancel: false,
  };
}
async function exerciseMerged(world = mergedWorld()) {
  const cancelled: number[] = [];
  const requests: string[] = [];
  let prReads = 0,
    runReads = 0,
    ownerReads = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const path = url.pathname.replace(`/repos/${repository}/`, '');
    requests.push(path);
    res.setHeader('content-type', 'application/json');
    if (world.failedRead && path.includes('/jobs')) {
      res.writeHead(503);
      res.end('{}');
      return;
    }
    let value: unknown;
    if (path === 'pulls/3754') {
      prReads++;
      value = {
        ...world.pr,
        ...(world.reopen && prReads > 1
          ? { state: 'open', merged: false }
          : {}),
      };
    } else if (path === 'actions/workflows/ci.yml')
      value = { id: holder.workflow_id, path: holder.path, name: 'PR: CI' };
    else if (path === `commits/${holderHead}/pulls`) {
      ownerReads++;
      value = [
        world.pr,
        ...(world.shared || (world.sharedAtEffect && ownerReads > 1)
          ? [{ ...world.pr, number: 4000, state: 'open' }]
          : []),
      ];
    } else if (path === `actions/workflows/${holder.workflow_id}/runs`)
      value = { total_count: 1, workflow_runs: [world.run] };
    else if (path === `actions/runs/${holder.id}/cancel`) {
      expect(req.method).toBe('POST');
      if (world.refuseCancel) {
        res.writeHead(409);
        res.end('{"message":"Cannot cancel this workflow run."}');
        return;
      }
      cancelled.push(holder.id);
      res.writeHead(202);
      res.end();
      return;
    } else if (path === `actions/runs/${holder.id}`) {
      runReads++;
      value = {
        ...world.run,
        ...(world.attemptChanges && runReads > 1 ? { run_attempt: 2 } : {}),
        ...(world.unknownReference
          ? {
              referenced_workflows: [
                ...world.run.referenced_workflows,
                {
                  path: 'unreviewed/workflow@main',
                  sha: 'd'.repeat(40),
                  ref: 'refs/heads/main',
                },
              ],
            }
          : {}),
      };
    } else if (path.endsWith('/attempts/1/jobs')) {
      const page = Number(url.searchParams.get('page'));
      value = {
        total_count: world.jobs.length + (world.truncated ? 1 : 0),
        jobs: world.jobs.slice((page - 1) * 100, page * 100),
      };
    } else {
      res.writeHead(404);
      res.end('{}');
      return;
    }
    res.end(JSON.stringify(value));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const event = join(makeTempDir('merged-delivery-'), 'event.json');
  writeFileSync(
    event,
    JSON.stringify({ action: 'closed', pull_request: { number: 3754 } }),
  );
  let code = 0,
    stdout = '';
  try {
    const child = await exec(process.execPath, [script], {
      windowsHide: true,
      env: {
        PATH: process.env.PATH ?? '',
        GITHUB_EVENT_PATH: event,
        GITHUB_REPOSITORY: repository,
        GITHUB_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      },
    });
    stdout = child.stdout;
  } catch (error) {
    code = (error as { code: number }).code;
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
  return { code, cancelled, stdout, requests };
}

describe('merged optional-tail retirement through the real GitHub HTTP boundary', () => {
  // The close event is one-shot: failing on a 409 retries nothing and would
  // stop the pass before any later holder run.
  it('warns and continues when GitHub refuses to cancel a holder (HTTP 409)', async () => {
    const result = await exerciseMerged({
      ...mergedWorld(),
      refuseCancel: true,
    });
    expect(result.code).toBe(0);
    expect(result.cancelled).toEqual([]);
    expect(result.stdout).toContain(
      `::warning::GitHub refused cancellation of run ${holder.id} (HTTP 409)`,
    );
    expect(result.stdout).not.toContain('Requested cancellation');
  });
  it('retires the new-topology optional holder without a fabricated deleted corpus job', async () => {
    const result = await exerciseMerged();
    expect(result.code).toBe(0);
    expect(result.cancelled).toEqual([holder.id]);
    expect(result.stdout).toContain('Requested cancellation');
    expect(result.stdout).toContain(
      'terminal cancellation is not yet verified',
    );
  });
  it('retires a run whose inventory includes the successful actionlint artifact producer (#4748)', async () => {
    const world = mergedWorld();
    const producer = world.jobs.find(
      (job) => job.name === 'Pinned actionlint artifact',
    );
    // The row is really there and really succeeded: otherwise this proves nothing.
    expect(producer?.conclusion).toBe('success');
    expect((await exerciseMerged(world)).cancelled).toEqual([holder.id]);
  });
  it.each(['failure', 'cancelled', 'timed_out', 'neutral'])(
    'a %s actionlint artifact producer does not authorize retirement (#4748)',
    async (conclusion) => {
      const world = mergedWorld();
      const producer = world.jobs.find(
        (job) => job.name === 'Pinned actionlint artifact',
      );
      if (!producer) throw new Error('Expected the producer row.');
      producer.conclusion = conclusion;
      expect((await exerciseMerged(world)).cancelled).toEqual([]);
    },
  );
  it('does not treat a similarly named job as the reviewed producer (#4748)', async () => {
    const world = mergedWorld();
    const producer = world.jobs.find(
      (job) => job.name === 'Pinned actionlint artifact',
    );
    if (!producer) throw new Error('Expected the producer row.');
    producer.name = 'Pinned actionlint artifact (copy)';
    expect((await exerciseMerged(world)).cancelled).toEqual([]);
  });
  it.each(['skipped', 'success', 'failure', 'cancelled'])(
    'a legacy corpus row with %s authorizes retirement only when skipped',
    async (conclusion) => {
      const world = mergedWorld();
      world.jobs.push({
        ...world.jobs[0],
        id: 1000,
        name: 'merge-integration-full-regression',
        conclusion,
      });
      expect((await exerciseMerged(world)).cancelled).toEqual(
        conclusion === 'skipped' ? [holder.id] : [],
      );
    },
  );
  it('can retire a known optional callee waiting before any child rows materialize', async () => {
    const world = mergedWorld();
    world.jobs = world.jobs.filter(
      (job) => !job.name.startsWith('delivery-validation / '),
    );
    expect((await exerciseMerged(world)).cancelled).toEqual([holder.id]);
  });
  it.each([
    'failed core',
    'active core',
    'missing core',
    'unknown active job',
    'unknown hidden workflow',
    'manual run',
    'merge-group run',
    'release workflow',
    'unmerged close',
    'foreign head',
    'other base',
    'shared owner',
    'changed attempt',
    'reopened',
    'shared owner at effect',
    'wrong job attempt',
    'missing skipped marker',
    'mixed referenced revisions',
    'foreign referenced repository',
    'malformed reference identity',
    'unknown optional state',
  ])('leaves the run alone for %s', async (change) => {
    const world = mergedWorld();
    if (change === 'failed core') world.jobs[2].conclusion = 'failure';
    if (change === 'active core') world.jobs[2].status = 'in_progress';
    if (change === 'missing core')
      world.jobs = world.jobs.filter((job) => job.name !== 'fast-checks');
    if (change === 'unknown active job')
      world.jobs.push({
        ...world.jobs[0],
        id: 999,
        name: 'new required proof',
        status: 'in_progress',
      });
    if (change === 'unknown hidden workflow') world.unknownReference = true;
    if (change === 'manual run') world.run.event = 'workflow_dispatch';
    if (change === 'merge-group run') world.run.event = 'merge_group';
    if (change === 'release workflow')
      world.run.path = '.github/workflows/release.yml';
    if (change === 'unmerged close') world.pr.merged = false;
    if (change === 'foreign head')
      world.pr.head.repo.full_name = 'foreign/station';
    if (change === 'other base') world.pr.base.ref = 'other';
    if (change === 'shared owner') world.shared = true;
    if (change === 'changed attempt') world.attemptChanges = true;
    if (change === 'reopened') world.reopen = true;
    if (change === 'shared owner at effect') world.sharedAtEffect = true;
    if (change === 'mixed referenced revisions')
      world.run.referenced_workflows[0] = {
        ...world.run.referenced_workflows[0],
        path: `${repository}/.github/workflows/source-verification-policy.yml@${'e'.repeat(40)}`,
        sha: 'e'.repeat(40),
      };
    if (change === 'foreign referenced repository')
      world.run.referenced_workflows[0].path =
        world.run.referenced_workflows[0].path.replace(
          repository,
          'foreign/station',
        );
    if (change === 'malformed reference identity')
      world.run.referenced_workflows[0].sha = holderHead;
    if (change === 'unknown optional state')
      world.jobs.at(-1)!.status = 'unknown';
    if (change === 'wrong job attempt') world.jobs[2].run_attempt = 2;
    if (change === 'missing skipped marker')
      world.jobs = world.jobs.filter((job) => job.name !== 'full-regression');
    expect((await exerciseMerged(world)).cancelled).toEqual([]);
  });
  it.each(['unavailable', 'truncated', 'duplicate'])(
    'an %s inventory refuses any cancellation request',
    async (change) => {
      const world = mergedWorld();
      if (change === 'unavailable') world.failedRead = true;
      if (change === 'truncated') world.truncated = true;
      if (change === 'duplicate') world.jobs.push({ ...world.jobs[0] });
      const result = await exerciseMerged(world);
      expect(result.code).toBe(1);
      expect(result.cancelled).toEqual([]);
    },
  );
  it('reads every inventory page and refuses an unknown source job on the final page', async () => {
    const world = mergedWorld();
    while (world.jobs.length < 100)
      world.jobs.push({
        ...world.jobs.at(-1)!,
        id: 1000 + world.jobs.length,
        name: `delivery-validation / fixture-${world.jobs.length}`,
      });
    world.jobs.push({ ...world.jobs[0], id: 5000, name: 'unknown source job' });
    const result = await exerciseMerged(world);
    expect(result.cancelled).toEqual([]);
    expect(
      result.requests.filter((path) => path.endsWith('/jobs')),
    ).toHaveLength(2);
  });
});

// Workflow identities as GitHub lists them for this repository's merge-group
// runs (`gh api repos/kontourai/station/actions/runs?event=merge_group`).
const GROUP_WORKFLOWS = {
  ci: {
    id: 344177106,
    path: '.github/workflows/ci.yml',
    name: 'Source verification',
  },
  ios: {
    id: 344177103,
    path: '.github/workflows/build-ios.yml',
    name: 'PR: iOS build',
  },
  docs: {
    id: 381162934,
    path: '.github/workflows/docs-kit.yml',
    name: 'PR: Docs kit',
  },
  windows: {
    id: 345371894,
    path: '.github/workflows/windows-pr-verification.yml',
    name: 'PR: Windows',
  },
  gallery: {
    id: 366668403,
    path: '.github/workflows/gallery-pr-check.yml',
    name: 'PR: Gallery',
  },
} as const;

async function replacedGroup(
  options: {
    oldRef?: boolean;
    replacementMissing?: boolean;
    badRun?: boolean;
    movedOwner?: boolean;
    badJobs?: boolean;
    refError?: boolean;
    attemptMoved?: boolean;
    queueHeadMismatch?: boolean;
    queueOwnerMismatch?: boolean;
    queueBaseMismatch?: boolean;
    queueMoved?: boolean;
    queueMissing?: boolean;
    queueError?: boolean;
    queueHttpStatus?: number;
    queueRepositoryMismatch?: boolean;
    queueNumberMismatch?: boolean;
    queueUnmergeable?: boolean;
    oldRefDisplaced?: boolean;
    refuseCancel?: boolean;
    // The dead group's PR: CI run already finished; its other runs still run.
    oldCiFinished?: boolean;
    // 100 live runs of another PR's group fill the first listing page.
    paged?: boolean;
    // The first N repository-wide run listings name one run they never
    // return, as GitHub's count does while a new group's runs are created.
    inconsistentListings?: number;
    // Every listing of this status names one run it never returns.
    inconsistentStatus?: string;
    // Listings answer a non-integer total_count.
    malformedCount?: boolean;
    // PR_CI_SUPERSESSION_LISTING_PAUSE_MS for the child (default '0').
    pauseMs?: string;
  } = {},
) {
  const candidateBase = 'e'.repeat(40);
  const laterSha = '1'.repeat(40);
  const otherPrSha = 'f'.repeat(40);
  const branch = (sha: string) =>
    `gh-readonly-queue/main/pr-7-${sha === head ? candidateBase : old}`;
  const candidate = (
    id: number,
    sha: string,
    workflow: (typeof GROUP_WORKFLOWS)[keyof typeof GROUP_WORKFLOWS],
    overrides: Record<string, unknown> = {},
  ) => ({
    id,
    name: workflow.name,
    path: workflow.path,
    workflow_id: workflow.id,
    run_attempt: 1,
    status: 'in_progress',
    conclusion: null,
    event: 'merge_group',
    head_sha: sha,
    head_branch: branch(sha),
    head_repository: { full_name: repository },
    pull_requests: [],
    created_at: sha === old ? '2026-10-22T00:00:00Z' : '2026-10-22T00:01:00Z',
    ...overrides,
  });
  // The dead group: one candidate commit, three workflows.
  const obsoleteIds = [1, 3, 4];
  const runs: Record<string, unknown>[] = [
    candidate(
      1,
      old,
      GROUP_WORKFLOWS.ci,
      options.oldCiFinished
        ? { status: 'completed', conclusion: 'failure' }
        : {},
    ),
    candidate(3, old, GROUP_WORKFLOWS.ios, { status: 'queued' }),
    candidate(4, old, GROUP_WORKFLOWS.docs),
    // The live replacement group (the trigger and a sibling workflow).
    candidate(2, head, GROUP_WORKFLOWS.ci),
    candidate(5, head, GROUP_WORKFLOWS.windows),
    // Another PR's group built on the dead candidate commit.
    candidate(6, otherPrSha, GROUP_WORKFLOWS.gallery, {
      head_branch: `gh-readonly-queue/main/pr-8-${old}`,
      created_at: '2026-10-22T00:00:00Z',
    }),
    // A same-PR candidate created after the replacement.
    candidate(7, laterSha, GROUP_WORKFLOWS.gallery, {
      head_branch: `gh-readonly-queue/main/pr-7-${'2'.repeat(40)}`,
      created_at: '2026-10-22T00:02:00Z',
    }),
  ];
  const filler = options.paged
    ? Array.from({ length: 100 }, (_, index) =>
        candidate(1000 + index, '3'.repeat(40), GROUP_WORKFLOWS.windows, {
          head_branch: `gh-readonly-queue/main/pr-9-${'4'.repeat(40)}`,
        }),
      )
    : [];
  const byId = new Map(runs.map((item) => [item.id as number, item]));
  const replacement = byId.get(2)!;
  const ownerHead = 'c'.repeat(40);
  const cancelled: number[] = [];
  let ownerReads = 0;
  const runReads = new Map<number, number>();
  let queueReads = 0;
  let displacedResponses = 0;
  let listings = 0;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url ?? '', 'http://localhost');
    const path = url.pathname.replace('/repos/kontourai/station/', '');
    let data: unknown;
    const runRoute =
      /^actions\/runs\/(\d+)(\/attempts\/1\/jobs|\/cancel)?$/.exec(path);
    const runId = Number(runRoute?.[1]);
    if (url.pathname === '/graphql') {
      expect(req.method).toBe('POST');
      if (options.queueHttpStatus) {
        res.writeHead(options.queueHttpStatus);
        res.end('{}');
        return;
      }
      queueReads++;
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const request = JSON.parse(body);
        expect(request.variables).toEqual({
          owner: 'kontourai',
          name: 'station',
          number: 7,
        });
        res.end(
          JSON.stringify(
            options.queueError
              ? { errors: [{ message: 'denied' }] }
              : {
                  data: {
                    repository: {
                      pullRequest: {
                        mergeQueueEntry: options.queueMissing
                          ? null
                          : {
                              id:
                                options.queueMoved && queueReads > 1
                                  ? 'changed-entry'
                                  : 'entry-7',
                              state: options.queueUnmergeable
                                ? 'UNMERGEABLE'
                                : 'AWAITING_CHECKS',
                              headCommit: {
                                oid: options.queueHeadMismatch ? old : head,
                              },
                              baseCommit: {
                                oid: options.queueBaseMismatch
                                  ? head
                                  : candidateBase,
                              },
                              pullRequest: {
                                number: options.queueNumberMismatch ? 8 : 7,
                                headRefOid: options.queueOwnerMismatch
                                  ? old
                                  : ownerHead,
                                baseRefName: 'main',
                                headRepository: {
                                  nameWithOwner: options.queueRepositoryMismatch
                                    ? 'someone/station'
                                    : repository,
                                },
                              },
                            },
                      },
                    },
                  },
                },
          ),
        );
      });
      return;
    }
    const live = (item: Record<string, unknown>) => ({
      ...item,
      ...(cancelled.includes(item.id as number)
        ? { status: 'completed', conclusion: 'cancelled' }
        : {}),
    });
    const listed = (filter: (item: Record<string, unknown>) => boolean) => {
      const status = url.searchParams.get('status');
      const all = [...filler, ...runs]
        .filter(filter)
        .map(live)
        .filter((item) => item.status === status);
      const page = Number(url.searchParams.get('page'));
      const size = Number(url.searchParams.get('per_page'));
      return {
        total_count: options.malformedCount
          ? 'unknown'
          : all.length +
            (listings <= (options.inconsistentListings ?? 0) ||
            status === options.inconsistentStatus
              ? 1
              : 0),
        workflow_runs: all.slice((page - 1) * size, page * size),
      };
    };
    if (path === 'actions/workflows/ci.yml')
      data = {
        id: GROUP_WORKFLOWS.ci.id,
        path: GROUP_WORKFLOWS.ci.path,
        name: 'PR: CI',
      };
    else if (path === 'pulls/7') {
      ownerReads++;
      data = {
        state: 'open',
        base: { ref: 'main' },
        head: {
          sha: options.movedOwner && ownerReads > 1 ? old : ownerHead,
          repo: { full_name: repository },
        },
      };
    } else if (path === 'actions/runs') {
      expect(url.searchParams.get('event')).toBe('merge_group');
      listings++;
      data = listed(() => true);
    } else if (path === `actions/workflows/${GROUP_WORKFLOWS.ci.id}/runs`) {
      // The PR: CI-only listing the controller used before every workflow of
      // a dead group was retired; served so a revert is caught by its effect.
      expect(url.searchParams.get('event')).toBe('merge_group');
      data = listed((item) => item.workflow_id === GROUP_WORKFLOWS.ci.id);
    } else if (runRoute && !runRoute[2]) {
      const id = runId;
      const item = byId.get(id) ?? filler.find((run) => run.id === id);
      if (!item) {
        res.writeHead(404);
        res.end('{}');
        return;
      }
      const reads = (runReads.get(id) ?? 0) + 1;
      runReads.set(id, reads);
      const obsolete = obsoleteIds.includes(id);
      data = {
        ...live(item),
        ...(obsolete && options.badRun ? { event: 'workflow_dispatch' } : {}),
        ...(obsolete && options.attemptMoved && reads > 1
          ? { run_attempt: 2 }
          : {}),
      };
    } else if (runRoute?.[2] === '/attempts/1/jobs') {
      const id = runId;
      const item = byId.get(id)!;
      data = {
        total_count: 1,
        jobs: [
          {
            id: id * 10,
            run_id: id,
            run_attempt: options.badJobs ? 2 : 1,
            head_sha: item.head_sha,
            status: item.status === 'queued' ? 'queued' : 'in_progress',
            runner_id: item.status === 'queued' ? null : 123,
          },
        ],
      };
    } else if (path === `git/ref/heads/${branch(head)}`) {
      if (options.replacementMissing) {
        res.writeHead(404);
        res.end('{}');
        return;
      }
      data = { ref: `refs/heads/${branch(head)}`, object: { sha: head } };
    } else if (path === `git/ref/heads/${branch(old)}`) {
      if (options.refError) {
        res.writeHead(503);
        res.end('{}');
        return;
      }
      if (!options.oldRef) {
        res.writeHead(404);
        res.end('{}');
        return;
      }
      if (options.oldRefDisplaced) displacedResponses++;
      data = {
        ref: `refs/heads/${branch(old)}`,
        object: { sha: options.oldRefDisplaced ? head : old },
      };
    } else if (runRoute?.[2] === '/cancel') {
      expect(req.method).toBe('POST');
      if (options.refuseCancel) {
        res.writeHead(409);
        res.end('{"message":"Cannot cancel this workflow run."}');
        return;
      }
      cancelled.push(runId);
      res.writeHead(202);
      res.end();
      return;
    } else {
      // Every other ref (the other PR's and the later candidate's) is gone.
      res.writeHead(404);
      res.end('{}');
      return;
    }
    res.end(JSON.stringify(data));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const event = join(makeTempDir('merge-group-supersession-'), 'event.json');
  writeFileSync(event, JSON.stringify({ workflow_run: replacement }));
  let code = 0;
  lastGroupStdout = '';
  try {
    ({ stdout: lastGroupStdout } = await exec(process.execPath, [script], {
      windowsHide: true,
      env: {
        PATH: process.env.PATH ?? '',
        GITHUB_EVENT_PATH: event,
        GITHUB_REPOSITORY: repository,
        GITHUB_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        PR_CI_SUPERSESSION_LISTING_PAUSE_MS: options.pauseMs ?? '0',
      },
    }));
  } catch (error) {
    code = (error as { code: number }).code;
    lastGroupStdout = (error as { stdout: string }).stdout;
    lastGroupStderr = (error as { stderr: string }).stderr;
  } finally {
    await new Promise<void>((ok, reject) =>
      server.close((error) => (error ? reject(error) : ok())),
    );
  }
  if (options.oldRefDisplaced && cancelled.length)
    expect(displacedResponses).toBeGreaterThan(0);
  lastGroupListings = listings;
  return { code, cancelled: cancelled.sort((a, b) => a - b) };
}
let lastGroupListings = 0;
// The last replacedGroup run's output, kept out of its exact result shape.
let lastGroupStdout = '';
let lastGroupStderr = '';

describe('replaced merge candidate retirement through the GitHub API', () => {
  it.each([{}, { oldRef: true, oldRefDisplaced: true }])(
    'normally cancels every workflow run of the obsolete queue-bound squash candidate with destroyed/displaced ref: %j',
    async (options) => {
      // 1 is the dead group's PR: CI run; 3 (queued iOS) and 4 (Docs kit) are
      // its other workflows. The live group (2, 5), another PR's group built
      // on the dead commit (6) and a newer same-PR candidate (7) survive.
      expect(await replacedGroup(options)).toEqual({
        code: 0,
        cancelled: [1, 3, 4],
      });
      expect(lastGroupStdout).toContain(
        'Merge retirement #7: 3 normal cancellation request(s), 0 refused (HTTP 409)',
      );
    },
  );
  it('retires the rest of a dead group after its PR: CI run has finished', async () => {
    expect(await replacedGroup({ oldCiFinished: true })).toEqual({
      code: 0,
      cancelled: [3, 4],
    });
  });
  it('reads every listing page before retiring', async () => {
    expect(await replacedGroup({ paged: true })).toEqual({
      code: 0,
      cancelled: [1, 3, 4],
    });
  });
  it.each([
    { oldRef: true },
    { replacementMissing: true },
    { badRun: true },
    { movedOwner: true },
    { attemptMoved: true },
    { queueHeadMismatch: true },
    { queueOwnerMismatch: true },
    { queueBaseMismatch: true },
    { queueMoved: true },
    { queueMissing: true },
    { queueRepositoryMismatch: true },
    { queueNumberMismatch: true },
    { queueUnmergeable: true },
  ])(
    'preserves work when replacement or obsolete identity is not proven: %j',
    async (options) => {
      expect(await replacedGroup(options)).toEqual({ code: 0, cancelled: [] });
    },
  );
  // Nothing was cancelled, and the next queue event for this PR retries it.
  it('warns and continues when GitHub refuses the cancellation (HTTP 409)', async () => {
    expect(await replacedGroup({ refuseCancel: true })).toEqual({
      code: 0,
      cancelled: [],
    });
    expect(lastGroupStdout).toContain(
      '0 normal cancellation request(s), 3 refused (HTTP 409)',
    );
  });
  it('re-reads a listing that did not account for every run, then retires normally', async () => {
    expect(await replacedGroup({ inconsistentListings: 1 })).toEqual({
      code: 0,
      cancelled: [1, 3, 4],
    });
    // One inconsistent queued listing, then a complete three-status pass.
    expect(lastGroupListings).toBe(4);
  });
  it('cancels nothing, and does not fail, while every listing attempt is inconsistent', async () => {
    expect(await replacedGroup({ inconsistentListings: 99 })).toEqual({
      code: 0,
      cancelled: [],
    });
    expect(lastGroupListings).toBe(3);
    expect(lastGroupStdout).toContain(
      '::warning::Merge retirement skipped for #7: Truncated retirement inventory on all 3 listing attempts; nothing was cancelled',
    );
  });
  it('retires nothing from a partial listing when a later status stays inconsistent', async () => {
    // The queued listing (dead iOS run 3) is complete on every attempt; the
    // in_progress listing never is, so no attempt yields a whole picture.
    expect(await replacedGroup({ inconsistentStatus: 'in_progress' })).toEqual({
      code: 0,
      cancelled: [],
    });
    expect(lastGroupListings).toBe(9);
    expect(lastGroupStdout).toContain(
      '::warning::Merge retirement skipped for #7: Truncated retirement inventory on all 3 listing attempts; nothing was cancelled',
    );
  });
  it('fails on a malformed listing count without retrying it', async () => {
    expect(await replacedGroup({ malformedCount: true })).toEqual({
      code: 1,
      cancelled: [],
    });
    expect(lastGroupListings).toBe(1);
    expect(lastGroupStderr).toContain('Malformed retirement inventory count');
  });
  it('refuses an out-of-range listing pause', async () => {
    expect(await replacedGroup({ pauseMs: '10001' })).toEqual({
      code: 1,
      cancelled: [],
    });
    expect(lastGroupStderr).toContain(
      'PR_CI_SUPERSESSION_LISTING_PAUSE_MS must be 0-10000',
    );
  });
  it.each([
    { badJobs: true },
    { refError: true },
    { queueError: true },
    { queueHttpStatus: 403 },
    { queueHttpStatus: 503 },
  ])('fails closed on ambiguous evidence: %j', async (options) => {
    expect(await replacedGroup(options)).toEqual({ code: 1, cancelled: [] });
  });
});

// A second merge-group world whose refs, queue entry and run re-reads change
// per read, for the mid-pass fences (ported from independent verification).
type QueueRun = Record<string, unknown> & { id: number };
type QueueEntry = { id: string; head: string; base: string } | null;
const queueBranch = (pr: number, base: string) =>
  `gh-readonly-queue/main/pr-${pr}-${base}`;
function queueRun(
  id: number,
  base: string,
  sha: string,
  workflow: (typeof GROUP_WORKFLOWS)[keyof typeof GROUP_WORKFLOWS],
  created: string,
  extra: Record<string, unknown> = {},
): QueueRun {
  return {
    id,
    name: workflow.name,
    path: workflow.path,
    workflow_id: workflow.id,
    run_attempt: 1,
    status: 'in_progress',
    conclusion: null,
    event: 'merge_group',
    head_sha: sha,
    head_branch: queueBranch(7, base),
    head_repository: { full_name: repository },
    pull_requests: [],
    created_at: created,
    ...extra,
  };
}
async function queueWorld(o: {
  runs: QueueRun[];
  trigger: number;
  // branch -> sha (null = 404); a function receives that branch's read count.
  refs: Record<string, string | null | ((reads: number) => string | null)>;
  entry: (reads: number) => QueueEntry;
  reread?: (run: QueueRun, reads: number) => Partial<QueueRun>;
}) {
  const cancelled: number[] = [];
  const refReads = new Map<string, number>();
  const runReads = new Map<number, number>();
  let queueReads = 0;
  const byId = new Map(o.runs.map((item) => [item.id, item]));
  const live = (item: QueueRun) =>
    cancelled.includes(item.id)
      ? { ...item, status: 'completed', conclusion: 'cancelled' }
      : item;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url ?? '', 'http://localhost');
    const path = url.pathname.replace('/repos/kontourai/station/', '');
    const send = (data: unknown, code = 200) => {
      res.writeHead(code);
      res.end(JSON.stringify(data));
    };
    if (url.pathname === '/graphql') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const number = JSON.parse(body).variables.number;
        queueReads++;
        const entry = o.entry(queueReads);
        send({
          data: {
            repository: {
              pullRequest: {
                mergeQueueEntry: entry && {
                  id: entry.id,
                  state: 'AWAITING_CHECKS',
                  headCommit: { oid: entry.head },
                  baseCommit: { oid: entry.base },
                  pullRequest: {
                    number,
                    headRefOid: 'c'.repeat(40),
                    baseRefName: 'main',
                    headRepository: { nameWithOwner: repository },
                  },
                },
              },
            },
          },
        });
      });
      return;
    }
    const route =
      /^actions\/runs\/(\d+)(\/attempts\/\d+\/jobs|\/cancel)?$/.exec(path);
    if (path === 'actions/workflows/ci.yml')
      return send({
        id: GROUP_WORKFLOWS.ci.id,
        path: GROUP_WORKFLOWS.ci.path,
        name: 'PR: CI',
      });
    if (path === 'pulls/7')
      return send({
        state: 'open',
        base: { ref: 'main' },
        head: { sha: 'c'.repeat(40), repo: { full_name: repository } },
      });
    if (path === 'actions/runs') {
      const all = o.runs
        .map(live)
        .filter((item) => item.status === url.searchParams.get('status'));
      const page = Number(url.searchParams.get('page'));
      return send({
        total_count: all.length,
        workflow_runs: all.slice((page - 1) * 100, page * 100),
      });
    }
    if (route && !route[2]) {
      const id = Number(route[1]);
      const item = byId.get(id);
      if (!item) return send({}, 404);
      const reads = (runReads.get(id) ?? 0) + 1;
      runReads.set(id, reads);
      return send({ ...live(item), ...(o.reread?.(item, reads) ?? {}) });
    }
    if (route?.[2]?.endsWith('/jobs')) {
      const item = byId.get(Number(route[1]))!;
      return send({
        total_count: 1,
        jobs: [
          {
            id: item.id * 10,
            run_id: item.id,
            run_attempt: item.run_attempt,
            head_sha: item.head_sha,
            status: 'queued',
            runner_id: null,
          },
        ],
      });
    }
    if (route?.[2] === '/cancel') {
      cancelled.push(Number(route[1]));
      res.writeHead(202);
      res.end();
      return;
    }
    if (path.startsWith('git/ref/heads/')) {
      const branch = path.slice('git/ref/heads/'.length);
      const reads = (refReads.get(branch) ?? 0) + 1;
      refReads.set(branch, reads);
      const ref = o.refs[branch];
      const value = typeof ref === 'function' ? ref(reads) : ref;
      if (!value) return send({}, 404);
      return send({ ref: `refs/heads/${branch}`, object: { sha: value } });
    }
    send({}, 404);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const event = join(makeTempDir('merge-group-fences-'), 'event.json');
  writeFileSync(event, JSON.stringify({ workflow_run: byId.get(o.trigger) }));
  let code = 0;
  try {
    await exec(process.execPath, [script], {
      windowsHide: true,
      env: {
        PATH: process.env.PATH ?? '',
        GITHUB_EVENT_PATH: event,
        GITHUB_REPOSITORY: repository,
        GITHUB_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        PR_CI_SUPERSESSION_LISTING_PAUSE_MS: '0',
      },
    });
  } catch (error) {
    code = (error as { code: number }).code;
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
  return { code, cancelled: cancelled.sort((a, b) => a - b) };
}

describe('merge-group retirement fences that move during the pass', () => {
  const deadBase = '1'.repeat(40);
  const liveBase = '2'.repeat(40);
  const dead = 'a'.repeat(40);
  const live = 'b'.repeat(40);
  const before = '2026-11-14T00:00:00Z';
  const after = '2026-11-14T00:06:00Z';
  // Dead group (10-12) and the live replacement group (20-22) for PR 7.
  const groups = () => [
    queueRun(10, deadBase, dead, GROUP_WORKFLOWS.ci, before),
    queueRun(11, deadBase, dead, GROUP_WORKFLOWS.ios, before),
    queueRun(12, deadBase, dead, GROUP_WORKFLOWS.docs, before),
    queueRun(20, liveBase, live, GROUP_WORKFLOWS.ci, after),
    queueRun(21, liveBase, live, GROUP_WORKFLOWS.ios, after),
    queueRun(22, liveBase, live, GROUP_WORKFLOWS.docs, after),
  ];
  const entry = { id: 'entry-7', head: live, base: liveBase };

  it('stops cancelling once the replacement ref disappears mid-pass', async () => {
    // Read 1 admits the pass and read 2 fences run 10; from read 3 it is gone.
    const result = await queueWorld({
      runs: groups(),
      trigger: 20,
      refs: {
        [queueBranch(7, deadBase)]: null,
        [queueBranch(7, liveBase)]: (reads) => (reads <= 2 ? live : null),
      },
      entry: () => entry,
    });
    expect(result).toEqual({ code: 0, cancelled: [10] });
  });

  it('ends the whole pass at the first queue-entry change, even if it changes back', async () => {
    const result = await queueWorld({
      runs: groups(),
      trigger: 20,
      refs: {
        [queueBranch(7, deadBase)]: null,
        [queueBranch(7, liveBase)]: live,
      },
      entry: (reads) => (reads === 3 ? { ...entry, id: 'other-entry' } : entry),
    });
    expect(result).toEqual({ code: 0, cancelled: [10] });
  });

  it('takes each run identity from the listing, never from the re-read', async () => {
    const result = await queueWorld({
      runs: [
        ...groups(),
        // Listed without a workflow identity.
        queueRun(16, deadBase, dead, GROUP_WORKFLOWS.ios, before, {
          workflow_id: undefined,
        }),
        // Re-read under another workflow's path.
        queueRun(17, deadBase, dead, GROUP_WORKFLOWS.ios, before),
        // The live candidate's commit listed under the dead group's branch,
        // whose ref is gone: only the replacement-sha check refuses it.
        queueRun(18, deadBase, live, GROUP_WORKFLOWS.windows, before),
      ],
      trigger: 20,
      refs: {
        [queueBranch(7, deadBase)]: null,
        [queueBranch(7, liveBase)]: live,
      },
      entry: () => entry,
      reread: (item) =>
        item.id === 17 ? { path: GROUP_WORKFLOWS.windows.path } : {},
    });
    expect(result).toEqual({ code: 0, cancelled: [10, 11, 12] });
  });
});

/**
 * Evaluates a GitHub Actions expression made only of `github.*` properties,
 * string and boolean literals, ==, !=, !, &&, || and parentheses. Anything
 * else is refused so a richer expression fails loudly instead of evaluating
 * wrongly. && and || return operand values, as GitHub's do.
 */
function evaluateGithubExpression(
  expression: string,
  github: Record<string, unknown>,
) {
  const body = expression.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
  const stripped = body
    .replace(/'[^']*'/g, '')
    .replace(/github(?:\.[A-Za-z_]+)+/g, '')
    .replace(/\b(?:true|false)\b/g, '')
    .replace(/==|!=|&&|\|\||[!()\s]/g, '');
  if (stripped) throw new Error(`unsupported expression syntax: ${stripped}`);
  const js = body
    .replace(
      /github((?:\.[A-Za-z_]+)+)/g,
      (_m, path: string) => `github${path.replaceAll('.', '?.')}`,
    )
    .replace(/==/g, '===')
    .replace(/!===/g, '!==');
  return new Function('github', `return (${js});`)(github) as unknown;
}

describe('supersession controller admission', () => {
  const read = (name: string) =>
    load(
      readFileSync(
        resolve(import.meta.dirname, '../../.github/workflows', name),
        'utf8',
      ),
      { schema: JSON_SCHEMA },
    ) as {
      'run-name'?: string;
      jobs: Record<string, { if?: string }>;
    };
  const ci = read('ci.yml');
  const guard = read('pr-ci-supersession.yml').jobs['cancel-obsolete'].if;
  if (!ci['run-name'] || !guard) throw new Error('Missing workflow guards');
  const pullRequest = {
    head: { repo: { full_name: repository } },
    merged: false,
  };
  // The triggering run's display_title is ci.yml's own run-name evaluated
  // for the PR event that started it, so this follows the real producer.
  const ciRun = (action: string, changes: Record<string, unknown> = {}) => ({
    event: 'pull_request_target',
    head_repository: { full_name: repository },
    display_title: evaluateGithubExpression(ci['run-name']!, {
      event_name: 'pull_request_target',
      event: { action, changes, pull_request: pullRequest },
    }),
  });
  const admits = (workflowRun: Record<string, unknown>) =>
    evaluateGithubExpression(guard, {
      event_name: 'workflow_run',
      repository,
      event: { action: 'requested', workflow_run: workflowRun },
    });

  it('allocates no runner for a metadata-only PR: CI run', () => {
    const metadata = ciRun('edited', { title: { from: 'old' } });
    expect(metadata.display_title).toBe('PR metadata');
    expect(admits(metadata)).toBe(false);
  });

  it.each([
    ['a base retarget', ciRun('edited', { base: { ref: { from: 'next' } } })],
    ['a pushed head', ciRun('synchronize')],
    ['an opened PR', ciRun('opened')],
    [
      'a merge-queue candidate',
      {
        event: 'merge_group',
        head_repository: { full_name: repository },
        display_title: 'Source verification',
      },
    ],
  ])('still retires obsolete work after %s', (_label, run) => {
    expect(run.display_title).toBe('Source verification');
    expect(admits(run)).toBe(true);
  });

  it('still retires merged optional delivery on a merged close', () => {
    expect(
      evaluateGithubExpression(guard, {
        event_name: 'pull_request_target',
        repository,
        event: {
          action: 'closed',
          pull_request: { ...pullRequest, merged: true },
        },
      }),
    ).toBe(true);
  });
});
