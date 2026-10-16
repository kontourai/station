import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { JSON_SCHEMA, load } from 'js-yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { main as decideMain } from '../nightly-qualification-decide.mjs';
import {
  ADMISSION_OBSERVE_INTERVAL_MS,
  ADMISSION_WAIT_CEILING_MS,
  finalPublicationDecision,
  nightlySourceGate,
  main as pipelineMain,
  publicationInterval,
  qualificationAdmission,
  recoveryDisposition,
  reservationRecovery,
  runnerProfile,
} from '../release-pipeline.mjs';

const source = 'a'.repeat(40);
const prior = 'b'.repeat(40);
const now = Date.parse('2026-10-09T12:00:00Z');
const row = (channel: string, sha = source) => ({
  channel,
  sha,
  timestampUtc: '2026-10-08T12:00:00Z',
});
const producer = {
  id: 1,
  head_sha: source,
  head_repository: { full_name: 'owner/repo' },
  head_branch: 'main',
  path: '.github/workflows/main-qualification.yml',
  event: 'push',
  status: 'completed',
  conclusion: 'failure',
};

describe('release pipeline admission', () => {
  it('defaults to bounded Free fanout and rejects unsupported profiles', () => {
    expect(runnerProfile({})).toMatchObject({
      name: 'free',
      ordinary: 2,
      heavy: 1,
      background: 4,
      total: 20,
    });
    expect(
      runnerProfile({
        STATION_QUALIFICATION_RUNNER_PROFILE: 'expanded',
        STATION_HOSTED_TOTAL_SLOTS: '40',
      }),
    ).toMatchObject({ ordinary: 4, heavy: 2, background: 7 });
    expect(
      runnerProfile({
        STATION_QUALIFICATION_RUNNER_PROFILE: 'custom',
        STATION_QUALIFICATION_ORDINARY_SLOTS: '1',
        STATION_QUALIFICATION_PROCESS_HEAVY_SLOTS: '1',
        STATION_INTEGRATION_RESERVE: '12',
      }),
    ).toMatchObject({ ordinary: 1, heavy: 1, background: 3 });
    expect(() =>
      runnerProfile({ STATION_QUALIFICATION_RUNNER_PROFILE: 'custom' }),
    ).toThrow();
    expect(() =>
      runnerProfile({ STATION_QUALIFICATION_RUNNER_PROFILE: 'typo' }),
    ).toThrow();
  });
  it('validates configured cadence instead of silently disabling it', () => {
    expect(publicationInterval({})).toBe(6 * 3_600_000);
    expect(publicationInterval({ STATION_NIGHTLY_INTERVAL_HOURS: '12' })).toBe(
      12 * 3_600_000,
    );
    for (const value of ['0', '-1', '1.5', '169', 'NaN'])
      expect(() =>
        publicationInterval({ STATION_NIGHTLY_INTERVAL_HOURS: value }),
      ).toThrow();
  });
  it('never treats a live, missing, foreign or repeatedly failed producer as recoverable', () => {
    expect(recoveryDisposition([producer], source, 'owner/repo').recover).toBe(
      true,
    );
    for (const runs of [
      [],
      [{ ...producer, status: 'in_progress' }],
      [{ ...producer, head_repository: { full_name: 'foreign/repo' } }],
      [producer, producer, producer],
    ])
      expect(recoveryDisposition(runs, source, 'owner/repo').recover).toBe(
        false,
      );
  });
  it.each([
    ['nightly-android', { androidNeeded: false, desktopNeeded: true }],
    ['nightly-desktop', { androidNeeded: true, desktopNeeded: false }],
  ])(
    'keeps a verified %s publication and admits only the missing native provider',
    (channel, expected) => {
      expect(
        finalPublicationDecision({
          source,
          ledger: [row(channel)],
          ancestor: () => true,
          sourceGate: '42',
          now,
        }),
      ).toEqual(expected);
    },
  );
  it('rejects a delayed older candidate after newer publication and refuses invalidated evidence', () => {
    expect(() =>
      finalPublicationDecision({
        source,
        ledger: [row('nightly-desktop', prior)],
        ancestor: () => false,
        sourceGate: '42',
        now,
      }),
    ).toThrow(/rollback/);
    expect(() =>
      finalPublicationDecision({
        source,
        ledger: [],
        ancestor: () => true,
        sourceGate: '',
        now,
      }),
    ).toThrow(/source gate/);
  });
  it('rechecks cadence under the delivery lock after another source shipped', () => {
    expect(() =>
      finalPublicationDecision({
        source,
        ledger: [
          {
            ...row('nightly-desktop', prior),
            timestampUtc: new Date(now - 1000).toISOString(),
          },
        ],
        ancestor: () => true,
        sourceGate: '42',
        now,
      }),
    ).toThrow(/cadence/);
  });
});

it('admission observes peer and same-run jobs, and the real CLI retains its snapshot', async () => {
  const makeTempDir = trackTempDirs();
  const root = makeTempDir('station-release-admission-');
  const output = join(root, 'output');
  let count = 0;
  let sameRunCount = 0;
  let failing = false;
  const server = createServer((request, response) => {
    if (failing) {
      response.statusCode = 502;
      response.end('{}');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify(
        request.url?.includes('/jobs')
          ? {
              jobs: Array.from(
                {
                  length: request.url.includes('/runs/99/')
                    ? sameRunCount
                    : count,
                },
                () => ({
                  status: 'in_progress',
                  labels: ['ubuntu-22.04'],
                }),
              ),
            }
          : {
              workflow_runs: request.url?.includes('/owner/station/')
                ? [{ id: 42 }, { id: 99 }]
                : [{ id: 42 }],
            },
      ),
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('HTTP fixture did not listen');
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: 'owner/station',
    STATION_CAPACITY_REPOSITORIES: 'owner/station,owner/peer',
    GITHUB_RUN_ID: '99',
    GITHUB_OUTPUT: output,
    GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
  };
  const exec = promisify(execFile);
  try {
    count = 2;
    const green = await exec(
      process.execPath,
      [resolve(import.meta.dirname, '../release-pipeline.mjs'), 'admission'],
      { env, windowsHide: true },
    );
    expect(JSON.parse(green.stdout)).toMatchObject({
      occupied: 4,
      admitted: true,
      repositories: ['owner/station', 'owner/peer'],
    });
    expect(readFileSync(output, 'utf8')).toContain('admitted=true');
    count = 7;
    sameRunCount = 4;
    expect(await qualificationAdmission(env)).toMatchObject({
      occupied: 18,
      admitted: false,
    });
    // An unobservable repository fails closed at once; it is never waited on.
    writeFileSync(output, '');
    failing = true;
    await expect(
      exec(
        process.execPath,
        [resolve(import.meta.dirname, '../release-pipeline.mjs'), 'admission'],
        { env, windowsHide: true, timeout: 30_000 },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('HTTP 502'),
    });
    expect(readFileSync(output, 'utf8')).toBe('');
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

it('recovers the reserved producer after a partial ship adds a ledger-only event commit', async () => {
  const makeTempDir = trackTempDirs();
  const root = makeTempDir('station-ledger-recovery-');
  const refs = join(root, 'refs');
  writeFileSync(refs, `${prior}\trefs/tags/nightly-version-code/123\n`);
  const observed: string[] = [];
  const server = createServer((request, response) => {
    observed.push(request.url || '');
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify(
        request.url?.includes('/jobs')
          ? {
              jobs: [
                {
                  name: 'qualification / Full source qualification',
                  conclusion: 'success',
                },
              ],
            }
          : {
              workflow_runs: [
                {
                  ...producer,
                  head_sha: prior,
                  head_repository: { full_name: 'owner/repo' },
                },
              ],
            },
      ),
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('HTTP fixture unavailable');
  try {
    const status = await decideMain(
      ['--source-sha', source, '--reservation-refs', refs],
      {
        env: {
          GITHUB_REPOSITORY: 'owner/repo',
          GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
          GITHUB_RUN_ID: '99',
          GH_TOKEN: 'fixture-token',
        },
        now: new Date(now),
        readLedger: () => [row('nightly-android', prior)],
        inspectCommit: (_root: string, sha: string) =>
          sha === prior
            ? {
                parents: [],
                subject: 'feat: source',
                changedPaths: ['real-source'],
              }
            : {
                parents: [prior],
                subject:
                  'docs(ledger): record nightly-android 0.1.11-nightly.2466.3 from run 42',
                changedPaths: [
                  'docs/reference/deploy-ledger.json',
                  'docs/reference/deploy-ledger.md',
                ],
              },
      },
    );
    expect(status).toBe(0);
    expect(observed.some((url) => url.includes(`head_sha=${prior}`))).toBe(
      true,
    );
    expect(observed.some((url) => url.includes(`head_sha=${source}`))).toBe(
      false,
    );
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

it('retains a just-published native platform across a ledger-only candidate without imposing another cadence wait', () => {
  expect(
    finalPublicationDecision({
      source,
      sourceCandidates: { 'nightly-android': prior },
      ledger: [
        {
          ...row('nightly-android', prior),
          timestampUtc: new Date(now - 1000).toISOString(),
        },
      ],
      sourceGate: '42',
      ancestor: () => true,
      now,
    }),
  ).toEqual({ androidNeeded: false, desktopNeeded: true });
});

it('checks the current provider pointers without requiring retired ledger history to remain in the current Git graph', () => {
  expect(
    finalPublicationDecision({
      source,
      ledger: [
        row('nightly-android'),
        {
          ...row('nightly-android', prior),
          timestampUtc: '2020-01-01T00:00:00Z',
        },
      ],
      sourceGate: '42',
      ancestor: () => false,
      now,
    }),
  ).toMatchObject({ androidNeeded: false });
});

describe('qualification admission waits for capacity instead of failing (#3612)', () => {
  const capacity = (occupied: number, macosOccupied = 0) => ({
    ...runnerProfile({}),
    repositories: ['owner/station'],
    occupied,
    macosOccupied,
    admitted: occupied + 4 <= 20 && macosOccupied < 5,
    observedAt: '2026-10-12T09:26:20.800Z',
    scope:
      'configured repository snapshot; omitted organization workloads are not certified',
  });
  const makeTempDir = trackTempDirs();
  const workflowFiles = () => {
    const root = makeTempDir('station-admission-wait-');
    const env = {
      GITHUB_OUTPUT: join(root, 'output'),
      GITHUB_STEP_SUMMARY: join(root, 'summary'),
    };
    writeFileSync(env.GITHUB_OUTPUT, '');
    writeFileSync(env.GITHUB_STEP_SUMMARY, '');
    return env;
  };
  const quiet = () => vi.spyOn(console, 'log').mockImplementation(() => {});
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('pins the ceiling and the observation interval', () => {
    expect(ADMISSION_WAIT_CEILING_MS).toBe(15 * 60_000);
    expect(ADMISSION_OBSERVE_INTERVAL_MS).toBe(60_000);
  });

  it('gives the resolve job room to reach the ceiling and report it', () => {
    type Step = { name?: string; run?: string; 'timeout-minutes'?: number };
    const workflow = load(
      readFileSync(
        resolve(
          import.meta.dirname,
          '../../.github/workflows/full-regression.yml',
        ),
        'utf8',
      ),
      { schema: JSON_SCHEMA },
    ) as {
      jobs: { resolve: { 'timeout-minutes': number; steps: Step[] } };
    };
    const job = workflow.jobs.resolve;
    const admission = job.steps.find((step) =>
      step.run?.includes('node scripts/release-pipeline.mjs admission'),
    );
    const ceilingMinutes = ADMISSION_WAIT_CEILING_MS / 60_000;
    // A backstop that fires first kills the step without the explicit
    // timeout message, so both must outlast the ceiling.
    expect(admission?.['timeout-minutes']).toBe(18);
    expect(admission?.['timeout-minutes']).toBeGreaterThan(ceilingMinutes);
    expect(job['timeout-minutes']).toBe(30);
    expect(job['timeout-minutes']).toBeGreaterThan(
      admission?.['timeout-minutes'] ?? Infinity,
    );
  });

  it('admits on a later observation, writes the outputs and summarizes every observation', async () => {
    quiet();
    // The production clock and sleep run on fake timers: no real waiting.
    vi.useFakeTimers();
    const env = workflowFiles();
    const observations = [capacity(18, 4), capacity(15, 5), capacity(16, 4)];
    const observe = vi.fn(async () => {
      const next = observations.shift();
      if (!next) throw new Error('observed past admission');
      return next;
    });
    const run = pipelineMain(['admission'], { env, observe });
    await vi.advanceTimersByTimeAsync(ADMISSION_OBSERVE_INTERVAL_MS - 1);
    expect(observe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * ADMISSION_OBSERVE_INTERVAL_MS);
    await run;
    expect(observe).toHaveBeenCalledTimes(3);
    expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe(
      'admitted=true\nordinary=2\nheavy=1\n',
    );
    const summary = readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')
      .trim()
      .split('\n');
    expect(summary).toHaveLength(3);
    expect(summary[0]).toContain('observation 1 (waiting for capacity)');
    expect(summary[0]).toContain('"occupied":18');
    expect(summary[1]).toContain('"macosOccupied":5');
    expect(summary[2]).toContain('observation 3 (admitted)');
    expect(summary[2]).toContain(
      `"waitedMs":${2 * ADMISSION_OBSERVE_INTERVAL_MS}`,
    );
  });

  it('fails with an explicit timeout and the last observed capacity once the ceiling elapses', async () => {
    quiet();
    const env = workflowFiles();
    let clock = 0;
    const wakes: number[] = [];
    // Each observation takes 7 s of wall clock, which counts against the
    // ceiling: 13 full one-minute sleeps, then a short one that lands on it.
    const observe = vi.fn(async () => {
      clock += 7_000;
      return capacity(18, 5);
    });
    await expect(
      pipelineMain(['admission'], {
        env,
        observe,
        now: () => clock,
        sleep: async (ms: number) => {
          // A broken ceiling would loop on microtasks forever; fail instead.
          if (wakes.length > 100) throw new Error('admission never timed out');
          clock += ms;
          wakes.push(clock);
        },
      }),
    ).rejects.toThrow(
      /timed out after 15 minutes without repository capacity \(15 observations\); last observed at 2026-10-12T09:26:20\.800Z: occupied 18 \+ background 4 exceeds total 20, or macOS occupied 5 is not below 5/,
    );
    expect(observe).toHaveBeenCalledTimes(15);
    // The last re-observation starts exactly at the ceiling, never past it.
    expect(wakes).toHaveLength(14);
    expect(Math.max(...wakes)).toBe(ADMISSION_WAIT_CEILING_MS);
    expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe('');
    const summary = readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
    expect(summary.match(/waiting for capacity/g)).toHaveLength(15);
    expect(summary).toContain(
      'Qualification admission failed: qualification admission timed out',
    );
  });

  it('fails closed at once when an observation throws, without retrying or sleeping', async () => {
    quiet();
    const env = workflowFiles();
    const slept: number[] = [];
    let calls = 0;
    const observe = vi.fn(async () => {
      calls++;
      if (calls === 1) return capacity(18);
      throw new Error('GitHub GET actions/runs: HTTP 502');
    });
    await expect(
      pipelineMain(['admission'], {
        env,
        observe,
        now: () => slept.reduce((sum, ms) => sum + ms, 0),
        sleep: async (ms: number) => {
          slept.push(ms);
        },
      }),
    ).rejects.toThrow('GitHub GET actions/runs: HTTP 502');
    expect(observe).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([ADMISSION_OBSERVE_INTERVAL_MS]);
    expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe('');
    expect(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')).toContain(
      'Qualification admission failed: GitHub GET actions/runs: HTTP 502',
    );
  });
});

it('admits only the trusted current Nightly run and its completed source usability gate', async () => {
  let run = {
    ...producer,
    id: 42,
    path: '.github/workflows/nightly.yml',
    event: 'schedule',
    status: 'in_progress',
    conclusion: null as string | null,
  };
  let jobs = [
    {
      name: '1 · Source gate (lint, typecheck, browser smoke)',
      status: 'completed',
      conclusion: 'success',
    },
  ];
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify(request.url?.includes('/jobs') ? { jobs } : run),
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('HTTP fixture unavailable');
  const env = {
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_RUN_ID: '42',
    GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
  };
  try {
    expect(await nightlySourceGate(source, env)).toBe(true);
    const original = { ...run };
    for (const override of [
      { head_sha: prior },
      { head_repository: { full_name: 'foreign/repo' } },
      { head_branch: 'feature' },
      { path: '.github/workflows/ci.yml' },
      { event: 'pull_request' },
      { status: 'completed', conclusion: 'failure' },
      { status: 'completed', conclusion: 'cancelled' },
      { id: 43 },
    ]) {
      run = { ...original, ...override };
      expect(await nightlySourceGate(source, env)).toBe(false);
    }
    run = original;
    const good = jobs[0];
    for (const rejected of [
      [],
      [good, good],
      [{ ...good, status: 'in_progress' }],
      [{ ...good, conclusion: 'failure' }],
      [{ ...good, conclusion: 'cancelled' }],
      [{ ...good, conclusion: 'skipped' }],
    ]) {
      jobs = rejected;
      expect(await nightlySourceGate(source, env)).toBe(false);
    }
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

it('recovers terminal Nightly delivery only after its actual source gate succeeded', async () => {
  const run = {
    ...producer,
    path: '.github/workflows/nightly.yml',
    event: 'schedule',
  };
  let jobs = [
    {
      name: '1 · Source gate (lint, typecheck, browser smoke)',
      status: 'completed',
      conclusion: 'success',
    },
  ];
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify(
        request.url?.includes('/jobs') ? { jobs } : { workflow_runs: [run] },
      ),
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('HTTP fixture unavailable');
  const env = {
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_RUN_ID: '42',
    GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
  };
  try {
    expect((await reservationRecovery(source, env)).recover).toBe(true);
    const good = jobs[0];
    for (const rejected of [
      [],
      [{ ...good, status: 'in_progress' }],
      [{ ...good, conclusion: 'failure' }],
      [{ ...good, conclusion: 'cancelled' }],
    ]) {
      jobs = rejected;
      expect((await reservationRecovery(source, env)).recover).toBe(false);
    }
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});
