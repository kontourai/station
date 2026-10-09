import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { main as decideMain } from '../nightly-qualification-decide.mjs';
import {
  finalPublicationDecision,
  publicationInterval,
  recoveryDisposition,
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
      background: 6,
      total: 20,
    });
    expect(
      runnerProfile({
        STATION_QUALIFICATION_RUNNER_PROFILE: 'expanded',
        STATION_HOSTED_TOTAL_SLOTS: '40',
      }),
    ).toMatchObject({ ordinary: 4, heavy: 2, background: 9 });
    expect(
      runnerProfile({
        STATION_QUALIFICATION_RUNNER_PROFILE: 'custom',
        STATION_QUALIFICATION_ORDINARY_SLOTS: '1',
        STATION_QUALIFICATION_PROCESS_HEAVY_SLOTS: '1',
        STATION_INTEGRATION_RESERVE: '12',
      }),
    ).toMatchObject({ ordinary: 1, heavy: 1, background: 5 });
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
          qualification: '42',
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
        qualification: '42',
        now,
      }),
    ).toThrow(/rollback/);
    expect(() =>
      finalPublicationDecision({
        source,
        ledger: [],
        ancestor: () => true,
        qualification: '',
        now,
      }),
    ).toThrow(/qualification/);
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
        qualification: '42',
        now,
      }),
    ).toThrow(/cadence/);
  });
});

it('the real CLI observes configured peer jobs before admitting fanout and retains its snapshot', async () => {
  const makeTempDir = trackTempDirs();
  const root = makeTempDir('station-release-admission-');
  const output = join(root, 'output');
  let count = 0;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify(
        request.url?.includes('/jobs')
          ? {
              jobs: Array.from({ length: count }, () => ({
                status: 'in_progress',
                labels: ['ubuntu-22.04'],
              })),
            }
          : { workflow_runs: [{ id: 42 }] },
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
    count = 8;
    await expect(
      exec(
        process.execPath,
        [resolve(import.meta.dirname, '../release-pipeline.mjs'), 'admission'],
        { env, windowsHide: true },
      ),
    ).rejects.toMatchObject({ code: 1 });
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
      qualification: '42',
      ancestor: () => true,
      now,
    }),
  ).toEqual({ androidNeeded: false, desktopNeeded: true });
});
