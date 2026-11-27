import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  DEPLOY_LEDGER_PATHS,
  FAILED_SOURCE_WINDOW_MS,
  FULL_QUALIFICATION_JOB_NAMES,
  failedSourceObservation,
  github,
  LEDGER_WALK_LIMIT,
  ledgerEquivalentSources,
  ledgerOnlyChange,
  QUALIFICATION_JOBS,
  qualificationVerdict,
  reusableRun,
} from '../qualification-evidence.mjs';

const exec = promisify(execFile);
const script = resolve(import.meta.dirname, '../qualification-evidence.mjs');
const makeTempDir = trackTempDirs();
function checkout() {
  const root = makeTempDir('station-qualification-');
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  writeFileSync(join(root, 'source'), 'real source');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  return { root, sha: git('rev-parse', 'HEAD') };
}
function needs(
  result = 'success',
): Record<string, { result: string; outputs: Record<string, string> }> {
  return Object.fromEntries(
    ['resolve', ...QUALIFICATION_JOBS].map((id) => [
      id,
      { result, outputs: {} },
    ]),
  );
}
const run = {
  id: 42,
  head_sha: 'a'.repeat(40),
  head_repository: { full_name: 'owner/repo' },
  head_branch: 'main',
  path: '.github/workflows/main-qualification.yml',
  event: 'schedule',
  status: 'completed',
  conclusion: 'success',
  updated_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  run_attempt: 1,
};

describe('GitHub evidence GET recovery', () => {
  it.each([
    ['GET', 502, 2, 3, true],
    ['GET', 503, 1, 2, true],
    ['GET', 504, 2, 3, true],
    ['GET', 502, 99, 3, false],
    ['GET', 403, 1, 1, false],
    ['POST', 502, 1, 1, false],
    ['PATCH', 503, 1, 1, false],
  ] as const)(
    '%s HTTP %i with %i failures makes %i attempts (recovered=%s)',
    async (method, status, failures, expectedAttempts, recovered) => {
      const observed: Array<{ method: string; path: string }> = [];
      const server = createServer((req, res) => {
        observed.push({ method: req.method!, path: req.url! });
        res.setHeader('content-type', 'application/json');
        if (observed.length <= failures) {
          res.writeHead(status);
          res.end('{}');
        } else {
          res.end(JSON.stringify({ value: 'observed response' }));
        }
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      try {
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('Missing listener');
        const request = github('actions/runs/42/jobs', {
          method,
          env: {
            GITHUB_REPOSITORY: 'owner/repo',
            GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
          },
        });
        if (recovered) {
          await expect(request).resolves.toEqual({
            value: 'observed response',
          });
        } else {
          await expect(request).rejects.toThrow(`HTTP ${status}`);
        }
        expect(observed).toEqual(
          Array.from({ length: expectedAttempts }, () => ({
            method,
            path: '/repos/owner/repo/actions/runs/42/jobs',
          })),
        );
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});

describe('source qualification evidence', () => {
  it('requires every job and matrix slice of the full-regression workflow for reuse', () => {
    const workflow = load(
      readFileSync(
        resolve(
          import.meta.dirname,
          '../../.github/workflows/full-regression.yml',
        ),
        'utf8',
      ),
    ) as {
      jobs: Record<
        string,
        {
          name?: string;
          strategy?: { matrix?: { include?: Array<{ slice?: string }> } };
        }
      >;
    };
    const displayed = Object.entries(workflow.jobs).flatMap(([id, job]) => {
      const name = job.name ?? id;
      const slices = job.strategy?.matrix?.include ?? [];
      if (!name.includes('${{ matrix.slice }}')) return [name];
      expect(slices.length, id).toBeGreaterThan(0);
      return slices.map(({ slice }) =>
        name.replace('${{ matrix.slice }}', String(slice)),
      );
    });
    expect([...FULL_QUALIFICATION_JOB_NAMES].sort()).toEqual(
      [...displayed].sort(),
    );
  });
  it('rejects missing, failed, cancelled or unexpected jobs and permits only validated reuse skips', () => {
    expect(qualificationVerdict(needs(), '')).toBe(true);
    for (const id of QUALIFICATION_JOBS)
      for (const result of ['failure', 'cancelled', 'skipped']) {
        const data = needs();
        data[id].result = result;
        expect(qualificationVerdict(data, '')).toBe(false);
      }
    const missing = needs();
    delete missing.static;
    expect(qualificationVerdict(missing, '')).toBe(false);
    expect(
      qualificationVerdict(
        { ...needs(), unexpected: { result: 'success' } },
        '',
      ),
    ).toBe(false);
    const reused = needs('skipped');
    reused.resolve = { result: 'success', outputs: { reuse_run: '42' } };
    expect(qualificationVerdict(reused, '42')).toBe(true);
    expect(qualificationVerdict(reused, '43')).toBe(false);
    reused.ordinary.result = 'failure';
    expect(qualificationVerdict(reused, '42')).toBe(false);
  });
  it('binds reusable evidence to exact source, canonical workflow, repository and original age', () => {
    const options = {
      source: run.head_sha,
      repository: 'owner/repo',
      currentRun: 99,
      now: Date.now(),
    };
    expect(reusableRun(run, options)).toBe(true);
    for (const change of [
      { head_sha: 'b'.repeat(40) },
      { head_branch: 'feature' },
      { event: 'pull_request' },
      { path: '.github/workflows/other.yml' },
      { conclusion: 'failure' },
      { id: 99 },
      { head_repository: { full_name: 'fork/repo' } },
      { updated_at: new Date(Date.now() - 25 * 3600_000).toISOString() },
    ])
      expect(reusableRun({ ...run, ...change }, options)).toBe(false);
  });
  it('executes the real CLI and refuses a different checkout or incomplete qualification without emitting a receipt', async () => {
    const { root, sha } = checkout();
    const env = {
      ...process.env,
      SOURCE_SHA: sha,
      NEEDS: JSON.stringify(needs()),
    };
    await exec(process.execPath, [script, 'attest'], {
      cwd: root,
      env,
      windowsHide: true,
    });
    expect(
      JSON.parse(readFileSync(join(root, 'source-qualification.json'), 'utf8'))
        .sourceSha,
    ).toBe(sha);
    rmSync(join(root, 'source-qualification.json'));
    await expect(
      exec(process.execPath, [script, 'attest'], {
        cwd: root,
        env: { ...env, SOURCE_SHA: 'f'.repeat(40) },
        windowsHide: true,
      }),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      exec(process.execPath, [script, 'attest'], {
        cwd: root,
        env: { ...env, NEEDS: '{}' },
        windowsHide: true,
      }),
    ).rejects.toMatchObject({ code: 1 });
    expect(() =>
      readFileSync(join(root, 'source-qualification.json')),
    ).toThrow();
  });
  it('uses current-attempt Actions proof independently of recognized optional-delivery parent states', async () => {
    const { root, sha } = checkout();
    let mode = 'valid';
    const observed: string[] = [];
    const names = [
      'resolve',
      'Static and app builds',
      'Ordinary corpus 1-2 of 8',
      'Ordinary corpus 3-4 of 8',
      'Ordinary corpus 5-6 of 8',
      'Ordinary corpus 7-8 of 8',
      'Process-heavy corpus 1 of 3',
      'Process-heavy corpus 2 of 3',
      'Process-heavy corpus 3 of 3',
      'Exclusive corpora',
      'Mobile Playwright (Android viewport)',
      'Full source qualification',
    ];
    const parent = (id = 42) => ({
      ...run,
      id,
      head_sha: sha,
      ...(mode.startsWith('live-')
        ? { status: 'in_progress', conclusion: null }
        : {}),
      ...([
        'pending-valid',
        'queued-valid',
        'waiting-valid',
        'requested-valid',
        'nightly-pending',
        'pending-other',
      ].includes(mode)
        ? {
            status:
              mode === 'nightly-pending' || mode === 'pending-other'
                ? 'pending'
                : mode.split('-')[0],
            conclusion: null,
          }
        : {}),
      ...(mode.startsWith('red-') || mode === 'failed-other'
        ? { conclusion: 'failure' }
        : {}),
      ...(mode === 'red-nightly' || mode === 'nightly-pending'
        ? { path: '.github/workflows/nightly.yml' }
        : {}),
      ...(mode === 'pending-other' || mode === 'failed-other'
        ? {
            path: '.github/workflows/publish-release.yml',
            event: 'workflow_dispatch',
          }
        : {}),
      ...(mode === 'unknown-status'
        ? { status: 'future-state', conclusion: null }
        : {}),
      ...(mode === 'prior-attempt'
        ? { run_attempt: 2, status: 'queued', conclusion: null }
        : {}),
      ...(mode === 'wrong-parent-source' ? { head_sha: 'b'.repeat(40) } : {}),
      ...(mode === 'wrong-parent-repo'
        ? { head_repository: { full_name: 'foreign/repo' } }
        : {}),
      ...(mode === 'wrong-parent-ref' ? { head_branch: 'feature' } : {}),
      ...(mode === 'retry-after-green' && id === 41
        ? { conclusion: 'failure', run_attempt: 2 }
        : {}),
    });
    const server = createServer((req, res) => {
      observed.push(req.url || '');
      res.setHeader('content-type', 'application/json');
      if (mode === 'unavailable') {
        res.writeHead(503);
        res.end('{}');
        return;
      }
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      const id = path.includes('/41/') ? 41 : 42;
      if (path.endsWith('/jobs')) {
        let jobs = names.map((name, index) => ({
          id: id * 100 + index,
          name: `qualification / ${name}`,
          run_id: id,
          run_attempt:
            mode === 'prior-attempt' || mode === 'wrong-job-attempt'
              ? 1
              : parent(id).run_attempt,
          head_sha: sha,
          status: 'completed',
          conclusion: 'success',
          completed_at: new Date(
            Date.now() -
              (mode === 'live-expired'
                ? 25 * 3600000
                : mode === 'retry-after-green' && id === 42
                  ? 10000
                  : 0),
          ).toISOString(),
        }));
        if (mode === 'missing' || mode === 'missing-phase')
          jobs = jobs.filter(
            (job) =>
              !job.name.endsWith(
                mode === 'missing'
                  ? 'Ordinary corpus 7-8 of 8'
                  : 'Static and app builds',
              ),
          );
        if (mode === 'missing-gate')
          jobs = jobs.filter(
            (job) => !job.name.endsWith('Full source qualification'),
          );
        if (mode === 'wrong-job-source') jobs[0].head_sha = 'b'.repeat(40);
        if (mode === 'wrong-job-run') jobs[0].run_id = 999;
        if (mode === 'wrong-job-attempt') jobs[0].run_attempt = 2;
        if (mode === 'failed-phase') jobs[1].conclusion = 'failure';
        if (mode === 'incomplete-phase') jobs[1].status = 'queued';
        if (mode === 'duplicate-phase') jobs.push({ ...jobs[1], id: 9999 });
        const gate = jobs.find((job) =>
          job.name.endsWith('Full source qualification'),
        );
        if (
          gate &&
          (mode === 'red-gate' || (mode === 'retry-after-green' && id === 41))
        )
          gate.conclusion = 'failure';
        if (gate && mode === 'cancelled-gate') gate.conclusion = 'cancelled';
        if (gate && mode === 'incomplete-gate') gate.status = 'in_progress';
        res.end(JSON.stringify({ jobs }));
      } else if (path.endsWith('/artifacts'))
        res.end(
          JSON.stringify({
            artifacts:
              mode === 'missing-artifact'
                ? []
                : [
                    {
                      name: `source-qualification-${sha}-42`,
                      expired: mode === 'expired',
                    },
                  ],
          }),
        );
      else if (/\/runs\/\d+$/.test(path))
        res.end(
          JSON.stringify({
            ...parent(),
            ...(mode === 'attempt-advanced'
              ? { run_attempt: 2, status: 'queued', conclusion: null }
              : {}),
            ...(mode === 'wrong-final-repo'
              ? { head_repository: { full_name: 'foreign/repo' } }
              : {}),
          }),
        );
      else
        res.end(
          JSON.stringify({
            workflow_runs: [
              ...(mode === 'retry-after-green' ? [parent(41)] : []),
              parent(),
            ],
          }),
        );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    const output = join(root, 'output');
    const env = {
      ...process.env,
      SOURCE_SHA: sha,
      ALLOW_REUSE: 'true',
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_RUN_ID: '99',
      GITHUB_OUTPUT: output,
      GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
    };
    const successes = [
      'valid',
      'live-valid',
      'pending-valid',
      'queued-valid',
      'waiting-valid',
      'requested-valid',
      'nightly-pending',
      'red-publication',
      'red-nightly',
    ];
    try {
      for (mode of [
        ...successes,
        'live-expired',
        'retry-after-green',
        'missing',
        'missing-phase',
        'failed-phase',
        'incomplete-phase',
        'duplicate-phase',
        'missing-gate',
        'expired',
        'missing-artifact',
        'unavailable',
        'red-gate',
        'cancelled-gate',
        'incomplete-gate',
        'pending-other',
        'failed-other',
        'unknown-status',
        'prior-attempt',
        'wrong-job-source',
        'wrong-job-run',
        'wrong-job-attempt',
        'attempt-advanced',
        'wrong-parent-source',
        'wrong-parent-repo',
        'wrong-parent-ref',
        'wrong-final-repo',
      ]) {
        writeFileSync(output, '');
        await exec(process.execPath, [script, 'resolve'], {
          cwd: root,
          env,
          windowsHide: true,
        });
        expect(readFileSync(output, 'utf8'), mode).toBe(
          `reuse_run=${successes.includes(mode) ? '42' : ''}\n`,
        );
      }
      expect(observed.some((url) => url.includes(`head_sha=${sha}`))).toBe(
        true,
      );
      expect(observed.some((url) => url.includes('/42/attempts/2/jobs'))).toBe(
        true,
      );
      expect(observed.some((url) => /\/42\/jobs(?:\?|$)/.test(url))).toBe(
        false,
      );
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  // Scheduled re-runs of a source whose corpus already failed tests. The job
  // names, order and conclusions are push run 43546941925 (2026-11-14): two
  // corpus jobs and the Android suite failed in their test steps.
  describe('scheduled re-run of an already-failed source', () => {
    const NOW = Date.parse('2026-11-14T06:00:00Z');
    const SOURCE = 'abac2c09ba'.padEnd(40, '0');
    const TEST_STEP = 'Run full-regression phases';
    const failedPush = {
      id: 43546941925,
      run_attempt: 1,
      head_sha: SOURCE,
      head_repository: { full_name: 'owner/repo' },
      head_branch: 'main',
      path: '.github/workflows/main-qualification.yml',
      event: 'push',
      status: 'completed',
      conclusion: 'failure',
      created_at: '2026-11-14T02:33:10Z',
    };
    const recorded: Array<[string, string, string]> = [
      ['resolve', 'success', ''],
      ['Static and app builds', 'success', ''],
      ['Process-heavy corpus 2 of 2', 'success', ''],
      ['Ordinary corpus 7-8 of 8', 'success', ''],
      ['Process-heavy corpus 1 of 2', 'success', ''],
      ['Ordinary corpus 3-4 of 8', 'failure', TEST_STEP],
      ['Ordinary corpus 5-6 of 8', 'success', ''],
      ['Ordinary corpus 1-2 of 8', 'success', ''],
      ['Exclusive corpora', 'failure', TEST_STEP],
      [
        'Mobile Playwright (Android viewport)',
        'failure',
        'Run Android viewport tests',
      ],
      ['Full source qualification', 'failure', ''],
    ];
    const jobsOf = (
      run: typeof failedPush,
      overrides: Record<string, { conclusion?: string; step?: string }> = {},
    ) =>
      recorded.map(([name, conclusion, failedStep], index) => {
        const override = overrides[name] ?? {};
        const result = override.conclusion ?? conclusion;
        const step = override.step ?? failedStep;
        return {
          id: run.id * 100 + index,
          run_id: run.id,
          run_attempt: run.run_attempt,
          head_sha: run.head_sha,
          name: `qualification / ${name}`,
          status: 'completed',
          conclusion: result,
          completed_at: '2026-11-14T04:34:30Z',
          steps: [
            { name: 'Set up job', conclusion: 'success' },
            {
              name: step || TEST_STEP,
              conclusion: result === 'failure' ? 'failure' : result,
            },
          ],
        };
      });
    const observe = (
      run: typeof failedPush,
      jobs: ReturnType<typeof jobsOf>,
      now = NOW,
    ) =>
      failedSourceObservation(run, jobs, {
        source: SOURCE,
        repository: 'owner/repo',
        now,
      });

    it('lets only a recent test failure in an executed corpus excuse a re-run', () => {
      expect(observe(failedPush, jobsOf(failedPush))).toBe('test-failure');
      // The bound is 24 hours from the failed gate's completion.
      expect(FAILED_SOURCE_WINDOW_MS).toBe(24 * 3_600_000);
      expect(
        observe(
          failedPush,
          jobsOf(failedPush),
          Date.parse('2026-11-14T04:34:30Z') + FAILED_SOURCE_WINDOW_MS + 1,
        ),
      ).toBe('expired');
      // Infrastructure: a failed setup step, a timed-out or cancelled job,
      // or a red gate with no corpus failure behind it.
      expect(
        observe(
          failedPush,
          jobsOf(failedPush, {
            'Mobile Playwright (Android viewport)': {
              step: 'Install Playwright browsers',
            },
          }),
        ),
      ).toBe('infrastructure');
      for (const conclusion of ['timed_out', 'cancelled'])
        expect(
          observe(
            failedPush,
            jobsOf(failedPush, { 'Exclusive corpora': { conclusion } }),
          ),
          conclusion,
        ).toBe('infrastructure');
      expect(
        observe(
          failedPush,
          jobsOf(failedPush, {
            'Ordinary corpus 3-4 of 8': { conclusion: 'success' },
            'Exclusive corpora': { conclusion: 'success' },
            'Mobile Playwright (Android viewport)': { conclusion: 'success' },
          }),
        ),
      ).toBe('infrastructure');
      const cancelled = { ...failedPush, conclusion: 'cancelled' };
      expect(
        observe(
          cancelled,
          jobsOf(cancelled, {
            'Full source qualification': { conclusion: 'cancelled' },
          }),
        ),
      ).toBe('infrastructure');
      const live = { ...failedPush, status: 'in_progress', conclusion: null };
      expect(
        observe(live as unknown as typeof failedPush, jobsOf(failedPush)),
      ).toBe('incomplete');
      expect(
        observe(
          failedPush,
          jobsOf(failedPush, {
            'Ordinary corpus 3-4 of 8': { conclusion: 'success' },
            'Exclusive corpora': { conclusion: 'success' },
            'Mobile Playwright (Android viewport)': { conclusion: 'success' },
            'Full source qualification': { conclusion: 'success' },
          }),
        ),
      ).toBe('passed');
      // A run that skipped its corpus (reuse or an earlier skip) is no evidence.
      const skipped = Object.fromEntries(
        recorded
          .map(([name]) => name)
          .filter(
            (name) =>
              name !== 'resolve' && name !== 'Full source qualification',
          )
          .map((name) => [name, { conclusion: 'skipped' }]),
      );
      expect(observe(failedPush, jobsOf(failedPush, skipped))).toBe(
        'not-executed',
      );
      expect(
        observe(
          { ...failedPush, head_sha: 'b'.repeat(40) },
          jobsOf(failedPush),
        ),
      ).toBe('foreign');
    });

    it('decides through the real resolve and attest CLI, and fails toward a fresh run', async () => {
      const { root, sha } = checkout();
      const now = Date.now();
      const at = (ms: number) => new Date(now - ms).toISOString();
      const pushRun = {
        ...failedPush,
        head_sha: sha,
        created_at: at(3 * 3_600_000),
      };
      const skipRun = {
        ...pushRun,
        id: pushRun.id + 1,
        event: 'schedule',
        created_at: at(3_600_000),
      };
      let mode = 'failed';
      const server = createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (mode === 'unavailable') {
          res.writeHead(503);
          res.end('{}');
          return;
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        const job = (run: typeof failedPush, overrides = {}) =>
          jobsOf(run, overrides).map((item) => ({
            ...item,
            completed_at: at(2 * 3_600_000),
          }));
        if (url.pathname.endsWith(`/${pushRun.id}/attempts/1/jobs`))
          res.end(
            JSON.stringify({
              jobs: job(
                pushRun,
                mode === 'infrastructure'
                  ? {
                      'Exclusive corpora': {
                        step: 'Prepare the corpus prerequisites',
                      },
                    }
                  : {},
              ),
            }),
          );
        else if (url.pathname.endsWith(`/${skipRun.id}/attempts/1/jobs`))
          res.end(
            JSON.stringify({
              jobs: job(
                skipRun,
                Object.fromEntries(
                  recorded
                    .map(([name]) => name)
                    .filter(
                      (name) =>
                        name !== 'resolve' &&
                        name !== 'Full source qualification',
                    )
                    .map((name) => [name, { conclusion: 'skipped' }]),
                ),
              ),
            }),
          );
        else
          res.end(
            JSON.stringify({
              workflow_runs:
                url.searchParams.get('head_sha') === sha && mode !== 'moved'
                  ? [pushRun, ...(mode === 'after-skip' ? [skipRun] : [])]
                  : [],
            }),
          );
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('No address');
      const output = join(root, 'output');
      const env = {
        ...process.env,
        SOURCE_SHA: sha,
        ALLOW_REUSE: 'true',
        SKIP_FAILED_SOURCE: 'true',
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_RUN_ID: '99',
        GITHUB_OUTPUT: output,
        GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
      };
      const resolveWith = async (extra: Record<string, string> = {}) => {
        writeFileSync(output, '');
        await exec(process.execPath, [script, 'resolve'], {
          cwd: root,
          env: { ...env, ...extra },
          windowsHide: true,
        });
        return readFileSync(output, 'utf8');
      };
      try {
        const id = String(pushRun.id);
        expect(await resolveWith()).toBe(`reuse_run=\nfailed_run=${id}\n`);
        mode = 'after-skip';
        expect(await resolveWith()).toBe(`reuse_run=\nfailed_run=${id}\n`);
        for (mode of ['infrastructure', 'moved', 'unavailable'])
          expect(await resolveWith(), mode).toBe('reuse_run=\nfailed_run=\n');
        // Callers that do not ask (release, pushes, dispatches) see no change.
        mode = 'failed';
        expect(await resolveWith({ SKIP_FAILED_SOURCE: 'false' })).toBe(
          'reuse_run=\n',
        );
      } finally {
        await new Promise<void>((done) => server.close(() => done()));
      }
      const skippedNeeds = Object.fromEntries(
        ['resolve', ...QUALIFICATION_JOBS].map((id) => [
          id,
          {
            result: id === 'resolve' ? 'success' : 'skipped',
            outputs: id === 'resolve' ? { failed_run: '42' } : {},
          },
        ]),
      );
      await expect(
        exec(process.execPath, [script, 'attest'], {
          cwd: root,
          env: {
            ...process.env,
            SOURCE_SHA: sha,
            NEEDS: JSON.stringify(skippedNeeds),
            FAILED_RUN: '42',
          },
          windowsHide: true,
        }),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(
          'Not re-run: run 42 already failed tests on this exact source',
        ),
      });
      expect(() =>
        readFileSync(join(root, 'source-qualification.json')),
      ).toThrow();
    });
  });

  // Release-bot ledger pushes start no push run (main-qualification.yml's
  // paths-ignore). A scheduled run on such a commit may inherit a test
  // failure, never a pass, from an ancestor that differs only in the ledger.
  describe('deploy-ledger-equivalent sources', () => {
    function history() {
      const root = makeTempDir('station-qualification-ledger-');
      const git = (...args: string[]) =>
        execFileSync('git', args, {
          cwd: root,
          encoding: 'utf8',
          windowsHide: true,
        }).trim();
      git('init', '-q');
      git('config', 'user.name', 'Fixture');
      git('config', 'user.email', 'fixture@example.test');
      const commit = (
        message: string,
        files: Record<string, string | null>,
      ) => {
        for (const [file, content] of Object.entries(files)) {
          if (content === null) git('rm', '-q', file);
          else {
            mkdirSync(dirname(join(root, file)), { recursive: true });
            writeFileSync(join(root, file), content);
            git('add', file);
          }
        }
        git('commit', '-q', '--allow-empty', '-m', message);
        return git('rev-parse', 'HEAD');
      };
      return { root, git, commit };
    }
    const [ledgerJson, ledgerMarkdown] = DEPLOY_LEDGER_PATHS;
    const botRecord = (n: number) => ({
      [ledgerJson]: `{"entries":${n}}\n`,
      [ledgerMarkdown]: `# Deploy ledger\n\n${n} entries\n`,
    });

    it('names exactly the two files the release bot commits', () => {
      expect(DEPLOY_LEDGER_PATHS).toEqual([
        'docs/reference/deploy-ledger.json',
        'docs/reference/deploy-ledger.md',
      ]);
      expect(ledgerOnlyChange(`M\t${ledgerJson}\nM\t${ledgerMarkdown}\n`)).toBe(
        true,
      );
      expect(ledgerOnlyChange(`M\t${ledgerJson}\nM\tsrc/a.ts\n`)).toBe(false);
      expect(ledgerOnlyChange('')).toBe(false);
      expect(ledgerOnlyChange(`D\t${ledgerJson}\n`)).toBe(false);
      expect(ledgerOnlyChange(`R100\t${ledgerJson}\tdocs/old.json\n`)).toBe(
        false,
      );
    });

    it('walks real bot commits and stops at a mixed, renaming, empty or merge commit', () => {
      const { root, git, commit } = history();
      const base = commit('feat: source', {
        'src/a.ts': 'export const a = 1;\n',
        ...botRecord(1),
      });
      const first = commit('docs(ledger): record nightly-npm', botRecord(2));
      const second = commit('docs(ledger): record nightly-desktop', {
        [ledgerJson]: '{"entries":3}\n',
        [ledgerMarkdown]: '# Deploy ledger\n\n3 entries\n',
      });
      expect(ledgerEquivalentSources(second, { cwd: root })).toEqual([
        second,
        first,
        base,
      ]);
      // A mixed push: the ledger plus a source change is a new source.
      const mixed = commit('fix: source and ledger', {
        'src/a.ts': 'export const a = 2;\n',
        ...botRecord(4),
      });
      const afterMixed = commit('docs(ledger): record', botRecord(5));
      expect(ledgerEquivalentSources(afterMixed, { cwd: root })).toEqual([
        afterMixed,
        mixed,
      ]);
      // Renaming the ledger elsewhere touches a non-ledger path.
      const renamed = commit('chore: move ledger', {
        [ledgerJson]: null,
        'docs/reference/old-ledger.json': '{"entries":5}\n',
      });
      expect(ledgerEquivalentSources(renamed, { cwd: root })).toEqual([
        renamed,
      ]);
      // An empty commit carries no ledger-only evidence.
      const empty = commit('chore: empty', {});
      expect(ledgerEquivalentSources(empty, { cwd: root })).toEqual([empty]);
      // A merge has no single first-parent diff to classify.
      git('checkout', '-q', '-b', 'side', base);
      commit('feat: side', { 'src/b.ts': 'export const b = 1;\n' });
      git('checkout', '-q', '-');
      git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
      const ledgerOnMerge = commit('docs(ledger): record', {
        [ledgerJson]: '{"entries":6}\n',
      });
      const merge = git('rev-parse', `${ledgerOnMerge}^`);
      expect(ledgerEquivalentSources(ledgerOnMerge, { cwd: root })).toEqual([
        ledgerOnMerge,
        merge,
      ]);
      // The walk is bounded: a run of ledger commits longer than the limit
      // yields the source and LIMIT ancestors, never the commit beneath.
      expect(LEDGER_WALK_LIMIT).toBe(30);
      const chain = [ledgerOnMerge];
      for (let index = 0; index < LEDGER_WALK_LIMIT + 1; index++)
        chain.unshift(
          commit(`docs(ledger): record ${index}`, {
            [ledgerJson]: `{"entries":${100 + index}}\n`,
          }),
        );
      expect(ledgerEquivalentSources(chain[0], { cwd: root })).toEqual(
        chain.slice(0, LEDGER_WALK_LIMIT + 1),
      );
      // A shallow clone's boundary is not the end of the walk: it throws, and
      // resolve then runs the corpus.
      const shallow = join(
        makeTempDir('station-qualification-shallow-'),
        'clone',
      );
      execFileSync(
        'git',
        ['clone', '-q', '--depth', '2', `file://${root}`, shallow],
        {
          windowsHide: true,
        },
      );
      expect(() => ledgerEquivalentSources(chain[0], { cwd: shallow })).toThrow(
        /shallow clone boundary/,
      );
      expect(ledgerEquivalentSources(second, { cwd: root, limit: 1 })).toEqual([
        second,
        first,
      ]);
    });

    it('inherits a recent test failure but never a pass from the ledger-free ancestor', async () => {
      const { root, git, commit } = history();
      const parentSha = commit('fix(chat): source change', {
        'src/a.ts': 'export const a = 1;\n',
      });
      const ledgerSha = commit(
        'docs(ledger): record nightly-npm',
        botRecord(1),
      );
      const now = Date.now();
      const at = (ms: number) => new Date(now - ms).toISOString();
      let parentPassed = false;
      // A newer passing re-run of the parent (a manual dispatch after the
      // failed push run).
      let rerunPassed = false;
      const rerunId = 43546941926;
      const parentRun = {
        id: 43546941925,
        run_attempt: 1,
        head_sha: parentSha,
        head_repository: { full_name: 'owner/repo' },
        head_branch: 'main',
        path: '.github/workflows/main-qualification.yml',
        event: 'push',
        status: 'completed',
        conclusion: 'failure',
        created_at: at(3 * 3_600_000),
        updated_at: at(2 * 3_600_000),
      };
      const server = createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname.endsWith('/jobs')) {
          const runId = Number(/\/runs\/(\d+)\//.exec(url.pathname)?.[1]);
          // Every job the exact-source reuse check requires, so a passing
          // parent is evidence the reuse path would accept for the parent.
          const names = [
            'resolve',
            'Static and app builds',
            'Ordinary corpus 1-2 of 8',
            'Ordinary corpus 3-4 of 8',
            'Ordinary corpus 5-6 of 8',
            'Ordinary corpus 7-8 of 8',
            'Process-heavy corpus 1 of 3',
            'Process-heavy corpus 2 of 3',
            'Process-heavy corpus 3 of 3',
            'Exclusive corpora',
            'Mobile Playwright (Android viewport)',
            'Full source qualification',
          ];
          res.end(
            JSON.stringify({
              jobs: names.map((name, index) => {
                const failed =
                  !parentPassed &&
                  runId !== rerunId &&
                  [
                    'Ordinary corpus 3-4 of 8',
                    'Full source qualification',
                  ].includes(name);
                return {
                  id: index,
                  run_id: runId,
                  run_attempt: 1,
                  head_sha: parentSha,
                  name: `qualification / ${name}`,
                  status: 'completed',
                  conclusion: failed ? 'failure' : 'success',
                  completed_at: at(2 * 3_600_000),
                  steps: [
                    {
                      name: 'Run full-regression phases',
                      conclusion: failed ? 'failure' : 'success',
                    },
                  ],
                };
              }),
            }),
          );
          return;
        }
        if (url.pathname.endsWith('/artifacts')) {
          res.end(
            JSON.stringify({
              artifacts: [
                {
                  name: `source-qualification-${parentSha}-${parentRun.id}`,
                  expired: false,
                },
              ],
            }),
          );
          return;
        }
        if (url.pathname.endsWith(`/runs/${parentRun.id}`)) {
          res.end(
            JSON.stringify({
              ...parentRun,
              conclusion: parentPassed ? 'success' : 'failure',
            }),
          );
          return;
        }
        // The ledger commit itself has no run: its push started none.
        res.end(
          JSON.stringify({
            workflow_runs:
              url.searchParams.get('head_sha') === parentSha
                ? [
                    {
                      ...parentRun,
                      conclusion: parentPassed ? 'success' : 'failure',
                    },
                    ...(rerunPassed
                      ? [
                          {
                            ...parentRun,
                            id: rerunId,
                            event: 'workflow_dispatch',
                            conclusion: 'success',
                            created_at: at(2.5 * 3_600_000),
                          },
                        ]
                      : []),
                  ]
                : [],
          }),
        );
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('No address');
      const output = join(root, 'output');
      const resolveOutput = async (source = ledgerSha) => {
        git('checkout', '-q', source);
        writeFileSync(output, '');
        await exec(process.execPath, [script, 'resolve'], {
          cwd: root,
          env: {
            ...process.env,
            SOURCE_SHA: source,
            ALLOW_REUSE: 'true',
            SKIP_FAILED_SOURCE: 'true',
            GITHUB_REPOSITORY: 'owner/repo',
            GITHUB_RUN_ID: '99',
            GITHUB_OUTPUT: output,
            GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
          },
          windowsHide: true,
        });
        return readFileSync(output, 'utf8');
      };
      try {
        expect(await resolveOutput()).toBe(
          `reuse_run=\nfailed_run=${parentRun.id}\n`,
        );
        parentPassed = true;
        // The fixture is a pass the reuse path accepts for the parent itself.
        expect(await resolveOutput(parentSha)).toBe(
          `reuse_run=${parentRun.id}\nfailed_run=\n`,
        );
        // It is still not carried to the ledger commit.
        expect(await resolveOutput()).toBe('reuse_run=\nfailed_run=\n');
        // The parent failed, then a newer re-run of it passed. The newest
        // executed run on the first source that has one decides, so the
        // older failure is not carried past the pass: the ledger commit runs
        // its corpus rather than failing its gate with "Not re-run".
        parentPassed = false;
        rerunPassed = true;
        expect(await resolveOutput()).toBe('reuse_run=\nfailed_run=\n');
      } finally {
        await new Promise<void>((done) => server.close(() => done()));
      }
    });
  });
});
