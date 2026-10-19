import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { main as decideMain } from '../nightly-qualification-decide.mjs';
import {
  finalPublicationDecision,
  nightlySourceGate,
  main as pipelineMain,
  publicationInterval,
  qualificationOccupancy,
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
      [resolve(import.meta.dirname, '../release-pipeline.mjs'), 'observe'],
      { env, windowsHide: true },
    );
    expect(JSON.parse(green.stdout)).toMatchObject({
      occupied: 4,
      headroomObserved: true,
      repositories: ['owner/station', 'owner/peer'],
    });
    expect(green.stdout).not.toContain('admitted');
    expect(green.stdout).toContain('not certified');
    count = 7;
    sameRunCount = 4;
    expect(await qualificationOccupancy(env)).toMatchObject({
      occupied: 18,
      headroomObserved: false,
    });
    // An unobservable repository fails closed at once; it is never waited on.
    writeFileSync(output, '');
    failing = true;
    await expect(
      exec(
        process.execPath,
        [resolve(import.meta.dirname, '../release-pipeline.mjs'), 'observe'],
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
                {
                  name: 'nightly / 2 · Stage native builds / Plan cohort (reserve version code)',
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

describe('qualification scheduler profile and optional one-shot telemetry', () => {
  afterEach(() => vi.restoreAllMocks());
  it('observes once even when there is no headroom, without granting admission or writing scheduler outputs', async () => {
    const root = trackTempDirs()('station-occupancy-');
    const output = join(root, 'output');
    writeFileSync(output, '');
    const observe = vi.fn(async () => ({
      ...runnerProfile({}),
      repositories: ['owner/station'],
      occupied: 20,
      macosOccupied: 0,
      headroomObserved: false,
      observedAt: '2026-10-17T03:00:00Z',
      scope: 'diagnostic snapshot; not a reservation',
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await pipelineMain(['observe'], {
      env: { GITHUB_OUTPUT: output },
      observe,
    });
    expect(observe).toHaveBeenCalledTimes(1);
    expect(readFileSync(output, 'utf8')).toBe('');
  });
  it('writes a validated profile without any API observation and rejects unknown scheduler classes', async () => {
    const root = trackTempDirs()('station-profile-');
    const output = join(root, 'output');
    const observe = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await pipelineMain(['profile'], {
      env: {
        GITHUB_OUTPUT: output,
        STATION_QUALIFICATION_CAPACITY_CLASS: 'integration',
      },
      observe,
    });
    expect(observe).not.toHaveBeenCalled();
    expect(readFileSync(output, 'utf8')).toBe('ordinary=2\nheavy=1\n');
    expect(() =>
      runnerProfile({ STATION_QUALIFICATION_CAPACITY_CLASS: 'typo' }),
    ).toThrow(/CAPACITY_CLASS/);
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
  let runs: Array<
    Omit<typeof run, 'conclusion'> & { conclusion: string | null }
  > = [run];
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
        request.url?.includes('/jobs') ? { jobs } : { workflow_runs: runs },
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
    jobs = [good];
    for (const held of [
      [{ ...run, status: 'in_progress', conclusion: null }],
      [run, { ...run, id: 2 }, { ...run, id: 3 }],
      [{ ...run, conclusion: 'cancelled' }],
    ]) {
      runs = held;
      expect((await reservationRecovery(source, env)).recover).toBe(false);
    }
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

const qualificationReferences = (sha = source) =>
  [
    'full-regression.yml',
    'delivery-validation.yml',
    'install-smoke.yml',
    'portable-server-archives.yml',
    'desktop-rust.yml',
    'desktop-clean-checkout.yml',
    'ecosystem-packaging.yml',
  ].map((name) => ({
    path: `owner/repo/.github/workflows/${name}@${sha}`,
    ref: 'refs/heads/main',
    sha,
  }));

it.each(['live', 'queued-empty', 'failed', 'three-failures'])(
  'ignores positively independent %s full qualification during Nightly recovery',
  async (scenario) => {
    const nightly = {
      ...producer,
      path: '.github/workflows/nightly.yml',
      event: 'schedule',
    };
    const qualifications = Array.from(
      { length: scenario === 'three-failures' ? 3 : 1 },
      (_, index) => ({
        ...producer,
        id: index + 10,
        status:
          scenario === 'queued-empty'
            ? 'queued'
            : scenario === 'live'
              ? 'in_progress'
              : 'completed',
        conclusion: ['live', 'queued-empty'].includes(scenario)
          ? null
          : 'failure',
      }),
    );
    const reads: string[] = [];
    const server = createServer((request, response) => {
      reads.push(request.url ?? '');
      response.setHeader('content-type', 'application/json');
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      const detail = qualifications.find((run) =>
        path.endsWith(`/runs/${run.id}`),
      );
      const body = detail
        ? { ...detail, referenced_workflows: qualificationReferences() }
        : path.endsWith('/jobs')
          ? {
              jobs: path.includes('/runs/1/')
                ? [
                    {
                      name: '1 · Source gate (lint, typecheck, browser smoke)',
                      status: 'completed',
                      conclusion: 'success',
                    },
                  ]
                : scenario === 'queued-empty'
                  ? []
                  : [
                      {
                        name: 'qualification / Full source qualification',
                        status: 'completed',
                        conclusion: 'failure',
                      },
                    ],
            }
          : { workflow_runs: [nightly, ...qualifications] };
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('HTTP fixture unavailable');
    try {
      expect(
        (
          await reservationRecovery(source, {
            GITHUB_REPOSITORY: 'owner/repo',
            GITHUB_RUN_ID: '42',
            GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
          })
        ).recover,
      ).toBe(true);
      expect(reads.filter((path) => /\/runs\/\d+$/.test(path))).toEqual([
        '/repos/owner/repo/actions/runs/10',
      ]);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
);

it('holds live legacy producers and unknown provider graph or job inventories', async () => {
  const nightly = {
    ...producer,
    path: '.github/workflows/nightly.yml',
    event: 'schedule',
  };
  const qualification = {
    ...producer,
    id: 10,
    status: 'queued',
    conclusion: null,
  };
  const independent = qualificationReferences();
  let references: unknown = independent;
  let detailFailure = false;
  let jobFailure = false;
  let missingJobs = false;
  let wrongIdentity = false;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path.endsWith('/runs/10')) {
      if (detailFailure) {
        response.writeHead(503);
        response.end('{}');
        return;
      }
      response.end(
        JSON.stringify({
          ...qualification,
          head_sha: wrongIdentity ? prior : source,
          referenced_workflows: references,
        }),
      );
    } else if (path.includes('/runs/10/jobs')) {
      if (jobFailure) {
        response.writeHead(503);
        response.end('{}');
        return;
      }
      response.end(JSON.stringify(missingJobs ? {} : { jobs: [] }));
    } else if (path.endsWith('/jobs'))
      response.end(
        JSON.stringify({
          jobs: [
            {
              name: '1 · Source gate (lint, typecheck, browser smoke)',
              status: 'completed',
              conclusion: 'success',
            },
          ],
        }),
      );
    else
      response.end(JSON.stringify({ workflow_runs: [nightly, qualification] }));
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
    for (const held of [
      undefined,
      null,
      {},
      [],
      [independent[0]],
      [...independent, independent[0]],
      qualificationReferences(prior),
      [
        ...independent,
        {
          ...independent[0],
          path: `foreign/repo/.github/workflows/full-regression.yml@${source}`,
        },
      ],
      [
        ...independent,
        {
          ...independent[0],
          path: `owner/repo/.github/workflows/unknown.yml@${source}`,
        },
      ],
      [
        ...independent,
        {
          ...independent[0],
          path: `owner/repo/.github/workflows/nightly.yml@${source}`,
        },
      ],
    ]) {
      references = held;
      expect((await reservationRecovery(source, env)).recover).toBe(false);
    }
    references = independent;
    wrongIdentity = true;
    expect((await reservationRecovery(source, env)).recover).toBe(false);
    wrongIdentity = false;
    detailFailure = true;
    await expect(reservationRecovery(source, env)).rejects.toThrow('HTTP 503');
    detailFailure = false;
    jobFailure = true;
    await expect(reservationRecovery(source, env)).rejects.toThrow('HTTP 503');
    jobFailure = false;
    missingJobs = true;
    await expect(reservationRecovery(source, env)).rejects.toThrow(
      'Incomplete GitHub listing',
    );
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

it('loads the actual Nightly decision before dependencies are installed', async () => {
  const exec = promisify(execFile);
  const makeTempDir = trackTempDirs();
  const root = makeTempDir('station-nightly-no-dependencies-');
  const repo = resolve(import.meta.dirname, '../..');
  const copied = new Set<string>();
  const copyModule = (path: string) => {
    if (copied.has(path)) return;
    copied.add(path);
    const contents = readFileSync(join(repo, path), 'utf8');
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
    for (const match of contents.matchAll(
      /(?:from\s*|import\s*)['"]([^'"]+)['"]/g,
    )) {
      if (match[1].startsWith('.')) copyModule(join(dirname(path), match[1]));
    }
  };
  copyModule('scripts/nightly-qualification-decide.mjs');
  try {
    await exec(
      process.execPath,
      [join(root, 'scripts/nightly-qualification-decide.mjs')],
      { cwd: root, windowsHide: true, timeout: 15_000 },
    );
    throw new Error(
      'Decision without required arguments unexpectedly succeeded',
    );
  } catch (error) {
    expect(error).toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        'usage: node scripts/nightly-qualification-decide.mjs',
      ),
    });
    expect(error).not.toMatchObject({
      stderr: expect.stringContaining('ERR_MODULE_NOT_FOUND'),
    });
  }
});
