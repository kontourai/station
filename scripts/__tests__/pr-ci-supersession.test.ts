import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
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
} = {}) {
  const cancelled: number[] = [];
  let reads = 0;
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
            sha: changedHead && reads > 1 ? old : head,
            ref: 'feature',
            repo: { full_name: fork ? 'someone/station' : repository },
          },
        }),
      );
    } else if (url.pathname.endsWith('/actions/runs')) {
      res.end(
        JSON.stringify({
          workflow_runs:
            url.searchParams.get('status') === 'in_progress' ? runs : [],
        }),
      );
    } else if (/\/actions\/runs\/\d+\/cancel$/.test(url.pathname)) {
      expect(req.method).toBe('POST');
      cancelled.push(Number(url.pathname.split('/').at(-2)));
      res.writeHead(202);
      res.end();
    } else if (/\/actions\/runs\/\d+$/.test(url.pathname)) {
      const item = runs.find(
        (r) => r.id === Number(url.pathname.split('/').at(-1)),
      );
      res.end(
        JSON.stringify({
          ...item,
          ...(completed ? { status: 'completed' } : {}),
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
  try {
    await exec(process.execPath, [script], {
      windowsHide: true,
      env: {
        PATH: process.env.PATH ?? '',
        GITHUB_EVENT_PATH: event,
        GITHUB_REPOSITORY: repository,
        GITHUB_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      },
    });
  } catch (error) {
    code = (error as { code: number }).code;
  } finally {
    await new Promise<void>((ok, reject) =>
      server.close((error) => (error ? reject(error) : ok())),
    );
  }
  return { code, cancelled };
}

describe('obsolete PR CI cancellation through the GitHub API', () => {
  it('cancels obsolete verification while retaining the current head and unrelated work', async () => {
    const result = await exercise({
      runs: [
        run(1),
        run(2, { head_sha: head }),
        run(3, { event: 'merge_group' }),
        run(4, { event: 'workflow_dispatch' }),
        run(5, { path: '.github/workflows/nightly.yml' }),
        run(6, { head_repository: { full_name: 'someone/station' } }),
        run(7, { pull_requests: [{ number: 8 }] }),
        run(8, { head_branch: 'another-feature' }),
        run(9, { path: '.github/workflows/build-ios.yml' }),
      ],
    });
    expect(result).toEqual({ code: 0, cancelled: [1, 9] });
  });

  it.each([{ changedHead: true }, { completed: true }, { fork: true }])(
    'leaves work alone when its cancellation authority disappears: %j',
    async (world) => {
      expect(await exercise(world)).toEqual({ code: 0, cancelled: [] });
    },
  );

  it('refuses cancellation when the live-head read fails', async () => {
    expect(await exercise({ failure: true })).toEqual({
      code: 1,
      cancelled: [],
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
  'merge-integration-full-regression',
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
  'merge-integration-full-regression',
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
  it('requests retirement of the retained queued-parent holder only after all source evidence completed successfully', async () => {
    const result = await exerciseMerged();
    expect(result.code).toBe(0);
    expect(result.cancelled).toEqual([holder.id]);
    expect(result.stdout).toContain('Requested cancellation');
    expect(result.stdout).toContain(
      'terminal cancellation is not yet verified',
    );
  });
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
