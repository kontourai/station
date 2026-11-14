import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  findMergeGroupVerdict,
  githubRequest,
  runVerdictStep,
} from '../ci-merge-group-verdict.mjs';

const exec = promisify(execFile);
const makeTempDir = trackTempDirs();
const script = resolve(import.meta.dirname, '../ci-merge-group-verdict.mjs');
const fixtures = resolve(
  import.meta.dirname,
  'fixtures/ci-merge-group-verdict',
);

// Trimmed from the real Actions API responses for the landing of
// 1005fcd1 (#4879): merge_group run 43514715024 and its attempt-1 jobs.
const realRuns = () =>
  JSON.parse(readFileSync(join(fixtures, 'merge-group-runs.json'), 'utf8'));
const realJobs = () =>
  JSON.parse(readFileSync(join(fixtures, 'merge-group-run-jobs.json'), 'utf8'));
// Literals pinned independently of the fixture files.
const SHA = '1005fcd1245b43cba1e38f7c9ff1a5f5d906069e';
const BEFORE = '2ef7f1758d1e0d72e9b11ca74467443a84a7c0fd';
const REPOSITORY = 'kontourai/station';
const RUNS_PATH = `repos/${REPOSITORY}/actions/workflows/ci.yml/runs?event=merge_group&head_sha=${SHA}&per_page=100`;
const JOBS_PATH = `repos/${REPOSITORY}/actions/runs/43514715024/attempts/1/jobs?per_page=100`;

type Json = Record<string, unknown>;
type Routes = Record<string, Json | number | (() => Json | number)>;

function requestFrom(routes: Routes) {
  const seen: string[] = [];
  const request = async (path: string) => {
    seen.push(path);
    const route = routes[path];
    if (route === undefined) throw new Error(`unexpected request ${path}`);
    const value = typeof route === 'function' ? route() : route;
    if (typeof value === 'number')
      throw new Error(`GitHub ${path} responded ${value}`);
    return value;
  };
  return { request, seen };
}

function decide(
  routes: Routes,
  overrides: { sha?: string; before?: string } = {},
) {
  const { request, seen } = requestFrom(routes);
  return findMergeGroupVerdict({
    sha: overrides.sha ?? SHA,
    before: overrides.before ?? BEFORE,
    repository: REPOSITORY,
    request,
  }).then((result) => ({ ...result, seen }));
}

function runsWith(mutate: (run: Json, listing: Json) => void) {
  const listing = realRuns();
  mutate(listing.workflow_runs[0], listing);
  return listing;
}

function jobsWith(mutate: (jobs: Json[], listing: Json) => void) {
  const listing = realJobs();
  mutate(listing.jobs, listing);
  return listing;
}

describe('findMergeGroupVerdict', () => {
  it('reuses the verdict of a real queue landing whose base is the push before', async () => {
    const result = await decide({
      [RUNS_PATH]: realRuns(),
      [JOBS_PATH]: realJobs(),
    });
    expect(result).toMatchObject({
      verified: true,
      reason: 'merge-group-run:43514715024/attempt:1',
    });
    expect(result.seen).toEqual([RUNS_PATH, JOBS_PATH]);
  });

  // The bypass path: a direct or admin push to main has no merge-group run.
  it('runs the full lane when the exact SHA has no merge-group verdict', async () => {
    const result = await decide({
      [RUNS_PATH]: { total_count: 0, workflow_runs: [] },
    });
    expect(result).toMatchObject({
      verified: false,
      reason: 'no-merge-group-run',
    });
    expect(result.seen).toEqual([RUNS_PATH]);
  });

  it.each([
    [
      'failed',
      (run: Json) => Object.assign(run, { conclusion: 'failure' }),
      'merge-group-run-completed-failure',
    ],
    [
      'cancelled',
      (run: Json) => Object.assign(run, { conclusion: 'cancelled' }),
      'merge-group-run-completed-cancelled',
    ],
    [
      'still running',
      (run: Json) =>
        Object.assign(run, { status: 'in_progress', conclusion: null }),
      'merge-group-run-in_progress-null',
    ],
    [
      'for another SHA',
      (run: Json) => Object.assign(run, { head_sha: 'c'.repeat(40) }),
      'no-merge-group-run',
    ],
    [
      'from a fork head repository',
      (run: Json) =>
        Object.assign(run, { head_repository: { full_name: 'fork/station' } }),
      'no-merge-group-run',
    ],
    [
      'of another workflow file',
      (run: Json) =>
        Object.assign(run, { path: '.github/workflows/docs-kit.yml' }),
      'no-merge-group-run',
    ],
    [
      'of another event',
      (run: Json) => Object.assign(run, { event: 'push' }),
      'no-merge-group-run',
    ],
    [
      'on an unrecognized branch',
      (run: Json) =>
        Object.assign(run, {
          head_branch: `gh-readonly-queue/main/pr-4879-${BEFORE}-extra`,
        }),
      'unrecognized-queue-branch',
    ],
  ])(
    'runs the full lane when the only run is %s',
    async (_label, mutate, reason) => {
      const result = await decide({
        [RUNS_PATH]: runsWith(mutate),
        [JOBS_PATH]: realJobs(),
      });
      expect(result).toMatchObject({ verified: false, reason });
    },
  );

  // A push that fast-forwards main over several queue entries carries commits
  // that this run's base..head diff did not plan.
  it('runs the full lane when the queue base is not the push before', async () => {
    const result = await decide(
      { [RUNS_PATH]: realRuns(), [JOBS_PATH]: realJobs() },
      { before: 'd'.repeat(40) },
    );
    expect(result).toMatchObject({
      verified: false,
      reason: 'queue-base-differs-from-push-before',
    });
    expect(result.seen).toEqual([RUNS_PATH]);
  });

  it('judges by the newest run when the SHA was queued more than once', async () => {
    const listing = realRuns();
    const older = listing.workflow_runs[0];
    listing.workflow_runs.push({
      ...older,
      id: older.id + 1,
      created_at: '2026-11-13T22:00:00Z',
      conclusion: 'failure',
    });
    listing.total_count = 2;
    const result = await decide({ [RUNS_PATH]: listing });
    expect(result).toMatchObject({
      verified: false,
      reason: 'merge-group-run-completed-failure',
    });
  });

  it.each([
    [
      'fast-checks failed',
      (jobs: Json[]) =>
        Object.assign(jobs.find((job) => job.name === 'fast-checks')!, {
          conclusion: 'failure',
        }),
      'required-job-not-success:fast-checks',
    ],
    [
      'fast-checks was skipped',
      (jobs: Json[]) =>
        Object.assign(jobs.find((job) => job.name === 'fast-checks')!, {
          conclusion: 'skipped',
        }),
      'required-job-not-success:fast-checks',
    ],
    [
      'the merge-queue regression job is missing',
      (jobs: Json[]) =>
        jobs.splice(
          jobs.findIndex((job) => job.name === 'Merge-queue regression'),
          1,
        ),
      'required-job-count-0:Merge-queue regression',
    ],
    [
      'the merge-queue regression job is duplicated',
      (jobs: Json[]) =>
        jobs.push({
          ...jobs.find((job) => job.name === 'Merge-queue regression')!,
        }),
      'required-job-count-2:Merge-queue regression',
    ],
  ])('runs the full lane when %s', async (_label, mutate, reason) => {
    const jobs = jobsWith((list, listing) => {
      mutate(list);
      listing.total_count = list.length;
    });
    const result = await decide({ [RUNS_PATH]: realRuns(), [JOBS_PATH]: jobs });
    expect(result).toMatchObject({ verified: false, reason });
  });

  it.each([
    [
      'the run listing is truncated',
      {
        [RUNS_PATH]: runsWith((_run, listing) =>
          Object.assign(listing, { total_count: 101 }),
        ),
      },
      'run-listing-truncated',
    ],
    [
      'the job listing is truncated',
      {
        [RUNS_PATH]: realRuns(),
        [JOBS_PATH]: jobsWith((_jobs, listing) =>
          Object.assign(listing, { total_count: 21 }),
        ),
      },
      'job-listing-truncated',
    ],
    [
      'the run listing is malformed',
      { [RUNS_PATH]: { workflow_runs: 'nope' } },
      'malformed-run-listing',
    ],
    [
      'the job listing is malformed',
      { [RUNS_PATH]: realRuns(), [JOBS_PATH]: { total_count: 1 } },
      'malformed-job-listing',
    ],
  ])('runs the full lane when %s', async (_label, routes, reason) => {
    const result = await decide(routes as Routes);
    expect(result).toMatchObject({ verified: false, reason });
  });

  it.each([
    ['sha', { sha: 'HEAD' }, 'invalid-sha'],
    [
      'before (a new-branch push has no before)',
      { before: '' },
      'invalid-before',
    ],
  ])(
    'refuses an invalid %s without calling the API',
    async (_label, overrides, reason) => {
      const result = await decide({}, overrides);
      expect(result).toMatchObject({ verified: false, reason });
      expect(result.seen).toEqual([]);
    },
  );
});

describe('runVerdictStep (fail open)', () => {
  const mainPush = (output: string) => ({
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: SHA,
    PUSH_BEFORE: BEFORE,
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_API_URL: 'https://api.example.test',
    GH_TOKEN: 'token',
    GITHUB_OUTPUT: output,
  });
  const outputFile = () => {
    const file = join(makeTempDir('ci-merge-group-verdict-'), 'output');
    writeFileSync(file, '');
    return file;
  };
  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const quiet = () => {};

  it('writes verified=true only for a reusable verdict, sending the token', async () => {
    const output = outputFile();
    const auth: (string | null)[] = [];
    const result = await runVerdictStep({
      env: mainPush(output),
      log: quiet,
      fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
        auth.push(new Headers(init?.headers).get('authorization'));
        const path = String(url).replace('https://api.example.test/', '');
        if (path === RUNS_PATH) return respond(realRuns());
        if (path === JOBS_PATH) return respond(realJobs());
        return respond({}, 404);
      },
    });
    expect(result.verified).toBe(true);
    expect(auth).toEqual(['Bearer token', 'Bearer token']);
    expect(readFileSync(output, 'utf8')).toBe(
      'verified=true\nreason=merge-group-run:43514715024/attempt:1\n',
    );
  });

  it.each([
    [
      'an API error status',
      async () => respond({ message: 'Server Error' }, 503),
      'lookup-failed: GitHub ',
    ],
    [
      'a refused read (a token without actions: read)',
      async () => respond({ message: 'Resource not accessible' }, 403),
      'lookup-failed: GitHub ',
    ],
    [
      'a network failure',
      async () => {
        throw new TypeError('fetch failed');
      },
      'lookup-failed: fetch failed',
    ],
    [
      'an invalid JSON body',
      async () => new Response('<html>', { status: 200 }),
      'lookup-failed: ',
    ],
  ])(
    'answers verified=false on %s, with a visible warning',
    async (_label, fetchImpl, reasonPrefix) => {
      const output = outputFile();
      const lines: string[] = [];
      const result = await runVerdictStep({
        env: mainPush(output),
        log: (line: string) => lines.push(line),
        fetchImpl,
      });
      expect(result.verified).toBe(false);
      expect(result.reason.startsWith(reasonPrefix)).toBe(true);
      expect(readFileSync(output, 'utf8')).toMatch(
        /^verified=false\nreason=lookup-failed: [^\n]*\n$/,
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(
        /^::warning title=Merge-queue verdict lookup failed::Could not read the merge-queue verdict \(lookup-failed: /,
      );
    },
  );

  it('warns on an unexpected response body, which also stops the saving', async () => {
    const lines: string[] = [];
    const result = await runVerdictStep({
      env: mainPush(outputFile()),
      log: (line: string) => lines.push(line),
      fetchImpl: async () => respond({ unexpected: true }),
    });
    expect(result).toEqual({
      verified: false,
      reason: 'malformed-run-listing',
    });
    expect(lines).toEqual([
      "::warning title=Merge-queue verdict lookup failed::Could not read the merge-queue verdict (malformed-run-listing); the push runs the classifier's full lane.",
    ]);
  });

  it('keeps an ordinary non-queue push a notice, not a warning', async () => {
    const lines: string[] = [];
    const result = await runVerdictStep({
      env: mainPush(outputFile()),
      log: (line: string) => lines.push(line),
      fetchImpl: async () => respond({ total_count: 0, workflow_runs: [] }),
    });
    expect(result).toEqual({ verified: false, reason: 'no-merge-group-run' });
    expect(lines).toEqual([
      "::notice::No reusable merge-queue verdict (no-merge-group-run); the push runs the classifier's full lane.",
    ]);
  });

  it('warns on a truncated run listing, which would repeat on every push', async () => {
    const lines: string[] = [];
    const result = await runVerdictStep({
      env: mainPush(outputFile()),
      log: (line: string) => lines.push(line),
      fetchImpl: async () => respond({ total_count: 2, workflow_runs: [] }),
    });
    expect(result).toEqual({
      verified: false,
      reason: 'run-listing-truncated',
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^::warning title=Merge-queue verdict lookup failed::Could not read the merge-queue verdict \(run-listing-truncated\)/,
    );
  });

  it('escapes a percent sign in the warning text', async () => {
    const lines: string[] = [];
    await runVerdictStep({
      env: mainPush(outputFile()),
      log: (line: string) => lines.push(line),
      fetchImpl: async () => {
        throw new Error('100%0Aforged');
      },
    });
    expect(lines[0]).toContain('(lookup-failed: 100%250Aforged)');
  });

  it('keeps a multi-line error on one output line', async () => {
    const output = outputFile();
    await runVerdictStep({
      env: mainPush(output),
      log: quiet,
      fetchImpl: async () => {
        throw new Error('first\nverified=true');
      },
    });
    expect(readFileSync(output, 'utf8')).toBe(
      'verified=false\nreason=lookup-failed: first verified=true\n',
    );
  });

  it.each([
    ['a merge-group event', { GITHUB_EVENT_NAME: 'merge_group' }],
    ['a push to another branch', { GITHUB_REF: 'refs/heads/feature' }],
  ])('never reuses a verdict for %s', async (_label, overrides) => {
    const output = outputFile();
    let calls = 0;
    const result = await runVerdictStep({
      env: { ...mainPush(output), ...overrides },
      log: quiet,
      fetchImpl: async () => {
        calls++;
        return respond(realRuns());
      },
    });
    expect(result).toEqual({ verified: false, reason: 'not-a-main-push' });
    expect(calls).toBe(0);
  });

  it('bounds a hung request', async () => {
    const request = githubRequest({
      token: 't',
      apiUrl: 'https://api.example.test',
      timeoutMs: 20,
      fetchImpl: (_url: string | URL | Request, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          );
        }),
    });
    await expect(request(RUNS_PATH)).rejects.toThrow(/timeout|abort/i);
  });
});

describe('the workflow step as a child process', () => {
  async function withApi(
    handler: (path: string) => { status: number; body: unknown },
    run: (url: string) => Promise<void>,
  ) {
    const server = createServer((request, response) => {
      const { status, body } = handler((request.url ?? '').replace(/^\//, ''));
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
      await new Promise((done) => server.close(done));
    }
  }

  async function step(apiUrl: string) {
    const output = join(makeTempDir('ci-merge-group-verdict-child-'), 'output');
    writeFileSync(output, '');
    const child = await exec(process.execPath, [script], {
      env: {
        PATH: process.env.PATH,
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_SHA: SHA,
        PUSH_BEFORE: BEFORE,
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_API_URL: apiUrl,
        GH_TOKEN: 'token',
        GITHUB_OUTPUT: output,
      },
      timeout: 30_000,
      windowsHide: true,
    });
    return { stdout: child.stdout, output: readFileSync(output, 'utf8') };
  }

  it('exits 0 and fails open when the API errors', async () => {
    await withApi(
      () => ({ status: 500, body: { message: 'boom' } }),
      async (url) => {
        const { stdout, output } = await step(url);
        expect(output).toMatch(
          /^verified=false\nreason=lookup-failed: GitHub [^\n]+ responded 500\n$/,
        );
        expect(stdout).toContain('runs the classifier');
        expect(stdout).toMatch(
          /^::warning title=Merge-queue verdict lookup failed::/m,
        );
      },
    );
  });

  it('exits 0 with verified=true for a real-shaped queue landing', async () => {
    await withApi(
      (path) =>
        path === RUNS_PATH
          ? { status: 200, body: realRuns() }
          : path === JOBS_PATH
            ? { status: 200, body: realJobs() }
            : { status: 404, body: {} },
      async (url) => {
        const { output } = await step(url);
        expect(output).toBe(
          'verified=true\nreason=merge-group-run:43514715024/attempt:1\n',
        );
      },
    );
  });
});
