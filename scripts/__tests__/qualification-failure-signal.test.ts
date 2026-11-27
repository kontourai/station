import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  JOB_MANIFEST_FILE,
  MANIFEST_BOUNDS,
} from '../lib/qualification-failure-manifest.mjs';
import {
  classifyRun,
  KNOWN_FAILURES_PATH,
  loadKnownFailures,
  MANIFEST_PHASE_STEPS,
  parseKnownFailures,
  qualificationFailureSignal,
  readJobManifests,
  signalMode,
} from '../qualification-failure-signal.mjs';
import { checkQualificationHealth } from '../qualification-health.mjs';
import { repairState } from '../qualification-repair.mjs';
import { phaseJobManifest } from '../run-full-regression-phases.mjs';

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, '../..');
const repairScript = join(repo, 'scripts/qualification-repair.mjs');
const makeTempDir = trackTempDirs();

const SHA = 'a'.repeat(40);
const RUN = {
  id: 42,
  run_attempt: 1,
  head_sha: SHA,
  head_branch: 'main',
  head_repository: { full_name: 'owner/repo' },
  path: '.github/workflows/main-qualification.yml',
  event: 'push',
  status: 'completed',
  conclusion: 'failure',
  created_at: '2026-11-14T02:33:10Z',
  updated_at: '2026-11-14T04:34:31Z',
  run_started_at: '2026-11-14T02:33:10Z',
  html_url: 'https://example.test/runs/42',
};
// Real identities of today's standing failures (#4917, #4941).
const PREVIEW =
  'src-server/services/__tests__/html-reply-preview.process.test.ts';
const KNOWN_TEST = {
  file: PREVIEW,
  titlePath: ['preview navigation and fetch cannot reach a loopback listener'],
};
const ANDROID_TEST = {
  file: 'tests/android/mobile-layout.spec.ts',
  titlePath: [
    'Android — Mobile Layout',
    'sidebar drawer is named navigation with contained, restorable focus',
  ],
  project: 'android',
};
const NEW_TEST = {
  file: 'scripts/__tests__/seed-dev-home.test.ts',
  titlePath: [
    'seedDevHome',
    'gives every known Station home root a deliberate decision',
  ],
};
const LIST = {
  schemaVersion: 1,
  entries: [
    { issue: 4917, ...KNOWN_TEST },
    { issue: 4941, ...ANDROID_TEST },
    {
      issue: 4901,
      file: 'scripts/__tests__/learning-media.test.ts',
      titlePath: ['checks it'],
    },
  ],
};

type Test = { file: string; titlePath: string[]; project?: string };
function group(failedTests: Test[], overrides: Record<string, unknown> = {}) {
  const files = new Set(failedTests.map((test) => test.file));
  return {
    group: 'process-exclusive',
    exitStatus: failedTests.length ? 1 : 0,
    signal: null,
    failedTests,
    failedFiles: [],
    runnerErrors: [],
    counts: {
      reporterFailedTests: failedTests.length,
      reporterFailedFiles: files.size,
      unhandledErrors: 0,
    },
    explained: true,
    ...overrides,
  };
}
/** A job manifest built by the producer's own function. */
function manifest(
  label: string,
  groups: ReturnType<typeof group>[],
  identity: Record<string, string> = {},
) {
  const phase = 'test-full-process-exclusive';
  const failed = groups.some((entry) => entry.exitStatus !== 0);
  return phaseJobManifest(
    [{ id: phase }],
    [{ id: phase, status: failed ? 1 : 0, error: null }],
    new Map([[phase, { groups, errors: [] }]]),
    {
      jobLabel: label,
      sourceSha: SHA,
      runId: '42',
      runAttempt: '1',
      ...identity,
    },
  );
}
/**
 * A job as the jobs API lists it. A failed qualification job's only failed
 * step is its phase step, as in real run 43611171188 (2026-11-14), where
 * every failed corpus and Android job showed exactly that one step failed.
 */
function job(
  name: string,
  conclusion = 'failure',
  steps: { name: string; conclusion: string }[] = [
    { name: 'Set up job', conclusion: 'success' },
    {
      name: name.startsWith('Mobile')
        ? 'Run Android viewport tests'
        : 'Run full-regression phases',
      conclusion,
    },
    {
      name: 'Retain the qualification failure manifest',
      conclusion: 'success',
    },
  ],
) {
  return {
    name: `qualification / ${name}`,
    status: 'completed',
    conclusion,
    steps,
  };
}
const JOBS = (...failed: ReturnType<typeof job>[]) => [
  job('resolve', 'success'),
  job('Static and app builds', 'success'),
  ...failed,
  job('Full source qualification', 'failure'),
];
function artifacts(manifests: Record<string, unknown>) {
  const directory = makeTempDir('station-manifests-');
  for (const [name, value] of Object.entries(manifests)) {
    mkdirSync(join(directory, name), { recursive: true });
    writeFileSync(
      join(directory, name, JOB_MANIFEST_FILE),
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  }
  return directory;
}
const open = () =>
  new Map<number, string>([
    [4917, 'open'],
    [4941, 'open'],
    [4901, 'open'],
  ]);
function classify(
  jobs: ReturnType<typeof job>[],
  manifests: Record<string, unknown>,
  issueStates = open(),
) {
  return classifyRun({
    run: RUN,
    jobs,
    manifests: readJobManifests(artifacts(manifests)),
    entries: parseKnownFailures(JSON.stringify(LIST)),
    issueStates,
  });
}

describe('main qualification failure signal (manifests, never logs)', () => {
  const exclusive = job('Exclusive corpora');

  it('calls a run known-only only when every failed job is explained by open entries', () => {
    const result = classify(JOBS(exclusive), {
      'qualification-manifest-exclusive-0-1': manifest('Exclusive corpora', [
        group([KNOWN_TEST]),
      ]),
    });
    expect(result.fresh).toEqual([]);
    expect(result.knownOnly).toBe(true);
    expect(
      result.removable.map((entry: { issue: number }) => entry.issue),
    ).toEqual([4941, 4901]);
  });

  it('matches per test: a known and a new test in one job alert', () => {
    const result = classify(JOBS(exclusive), {
      a: manifest('Exclusive corpora', [group([KNOWN_TEST, NEW_TEST])]),
    });
    expect(result.knownOnly).toBe(false);
    expect(result.fresh).toEqual([
      expect.objectContaining({ reason: 'no known-failure entry' }),
    ]);
  });

  it('never explains a job whose manifest records anything but named tests', () => {
    const cases: Record<string, ReturnType<typeof group>> = {
      'runner error': group([KNOWN_TEST], {
        runnerErrors: [{ kind: 'process-tree-alive', message: 'left alive' }],
      }),
      'load failure': group([KNOWN_TEST], {
        failedFiles: [{ file: 'b.test.ts', reason: 'load' }],
      }),
      'count mismatch': group([KNOWN_TEST], {
        counts: {
          reporterFailedTests: 2,
          reporterFailedFiles: 1,
          unhandledErrors: 0,
        },
      }),
      'unhandled error': group([KNOWN_TEST], {
        counts: {
          reporterFailedTests: 1,
          reporterFailedFiles: 1,
          unhandledErrors: 1,
        },
      }),
    };
    for (const [name, entry] of Object.entries(cases)) {
      const built = manifest('Exclusive corpora', [entry]);
      // Even a producer that claimed `explained` is re-checked.
      const result = classify(JOBS(exclusive), {
        a: {
          ...built,
          explained: true,
          phases: built.phases.map((phase: { groups: object[] }) => ({
            ...phase,
            explained: true,
            groups: phase.groups.map((g: object) => ({
              ...g,
              explained: true,
            })),
          })),
        },
      });
      expect(result.knownOnly, name).toBe(false);
      expect(result.fresh[0].reason, name).toMatch(/^unexplained/);
    }
  });

  it('alerts on a missing, invalid, foreign or duplicate manifest', () => {
    const own = manifest('Exclusive corpora', [group([KNOWN_TEST])]);
    const reasons = (manifests: Record<string, unknown>) =>
      classify(JOBS(exclusive), manifests).fresh.map((item) => item.reason);
    expect(reasons({})).toEqual(['no failure manifest']);
    expect(reasons({ a: '{ not json' })[0]).toMatch(
      /^no valid failure manifest/,
    );
    expect(reasons({ a: { ...own, extra: true } })[0]).toMatch(
      /^no valid failure manifest/,
    );
    for (const identity of [
      { runId: '41' } as Record<string, string>,
      { runAttempt: '2' },
      { sourceSha: 'b'.repeat(40) },
    ])
      expect(
        reasons({
          a: manifest('Exclusive corpora', [group([KNOWN_TEST])], identity),
        }),
        JSON.stringify(identity),
      ).toEqual(['failure manifest belongs to another run, attempt or source']);
    for (const layouts of [
      { a: own, b: own },
      { '.': own, a: own },
    ]) {
      expect(reasons(layouts)).toEqual([
        'more than one failure manifest for this job',
      ]);
    }
    // A job that failed in setup, before the driver ran, writes none.
    expect(
      reasons({
        other: manifest('Ordinary corpus 1-2 of 8', [group([KNOWN_TEST])]),
      }),
    ).toEqual(['no failure manifest']);
  });

  it('alerts on cancelled, timed-out or unfinished jobs and on a red run with no failed job', () => {
    for (const conclusion of ['cancelled', 'timed_out', 'startup_failure'])
      expect(
        classify(JOBS(job('Exclusive corpora', conclusion)), {}).fresh[0]
          .reason,
      ).toBe(`job ${conclusion}`);
    expect(classify(JOBS(), {}).fresh[0].reason).toBe(
      'the run failed without a failed qualification job',
    );
  });

  it('counts an entry only while its issue is open', () => {
    const manifests = {
      a: manifest('Exclusive corpora', [group([KNOWN_TEST])]),
    };
    for (const state of ['closed', 'unavailable']) {
      const result = classify(
        JOBS(exclusive),
        manifests,
        new Map([...open(), [4917, state]]),
      );
      expect(result.knownOnly, state).toBe(false);
      expect(result.fresh[0].reason, state).toMatch(/issue #4917/);
    }
  });

  it('matches exact identities only: no bracket stripping, no case folding, project respected', () => {
    for (const variant of [
      { ...KNOWN_TEST, titlePath: [`${KNOWN_TEST.titlePath[0]} [ipv6]`] },
      { ...KNOWN_TEST, titlePath: [KNOWN_TEST.titlePath[0].toUpperCase()] },
      { ...KNOWN_TEST, project: 'android' },
      { ...ANDROID_TEST, project: 'chromium' },
      { ...ANDROID_TEST, project: undefined },
    ])
      expect(
        classify(JOBS(exclusive), {
          a: manifest('Exclusive corpora', [group([variant as Test])]),
        }).knownOnly,
        JSON.stringify(variant),
      ).toBe(false);
  });

  it('accepts only exact-identity entries in the list', () => {
    expect(loadKnownFailures(repo).length).toBeLessThanOrEqual(20);
    expect(parseKnownFailures('{"schemaVersion":1,"entries":[]}')).toEqual([]);
    for (const bad of [
      { schemaVersion: 1, entries: [{ issue: 1, file: PREVIEW }] },
      {
        schemaVersion: 1,
        entries: [{ issue: 1, file: 'src/**', titlePath: ['x'] }],
      },
      { schemaVersion: 1, entries: [{ issue: 1, test: `${PREVIEW} > x` }] },
      {
        schemaVersion: 1,
        entries: [{ issue: 1, deadline: 'test-full-process-heavy' }],
      },
      {
        schemaVersion: 1,
        entries: [{ issue: 1, file: PREVIEW, titlePath: [] }],
      },
      { schemaVersion: 1, entries: [{ issue: 0, ...KNOWN_TEST }] },
      {
        schemaVersion: 1,
        entries: [{ issue: 1, ...KNOWN_TEST, pattern: '.*' }],
      },
      {
        schemaVersion: 1,
        entries: [
          { issue: 1, ...KNOWN_TEST },
          { issue: 2, ...KNOWN_TEST },
        ],
      },
      {
        schemaVersion: 1,
        entries: Array.from({ length: 21 }, (_, index) => ({
          issue: index + 1,
          file: `f${index}.test.ts`,
          titlePath: ['t'],
        })),
      },
      { schemaVersion: 2, entries: [] },
    ])
      expect(
        () => parseKnownFailures(JSON.stringify(bad)),
        JSON.stringify(bad).slice(0, 80),
      ).toThrow();
  });

  it('alerts when the list is unreadable or the issue API fails', async () => {
    const manifests = artifacts({
      a: manifest('Exclusive corpora', [group([KNOWN_TEST])]),
    });
    const broken = makeTempDir('station-list-');
    mkdirSync(join(broken, 'config'), { recursive: true });
    writeFileSync(
      join(broken, KNOWN_FAILURES_PATH),
      '{"schemaVersion":1,"entries":[{"issue":1}]}',
    );
    const withList = await qualificationFailureSignal(RUN, JOBS(exclusive), {
      env: {},
      root: broken,
      manifestDirectory: manifests,
      readIssue: async () => 'open',
    });
    expect(withList.knownOnly).toBe(false);
    expect(withList.fresh[0].failure).toBe('known-failure list unreadable');
    const outage = await qualificationFailureSignal(RUN, JOBS(exclusive), {
      env: {
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_API_URL: 'http://127.0.0.1:9',
      },
      root: repo,
      manifestDirectory: manifests,
    });
    expect(outage.knownOnly).toBe(false);
  });

  it('defaults to report mode, and only the exact word enforces', () => {
    expect(signalMode(undefined)).toBe('report');
    expect(signalMode('')).toBe('report');
    expect(signalMode('report')).toBe('report');
    expect(signalMode('Enforce')).toBe('report');
    expect(signalMode('enforce')).toBe('enforce');
  });
});

describe('tracker decisions: report mode changes nothing, enforce mode decides', () => {
  const knownJobs = [
    job('resolve', 'success'),
    job('Exclusive corpora'),
    job('Full source qualification', 'failure', []),
  ];
  function rootWithList() {
    const root = makeTempDir('station-signal-root-');
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, KNOWN_FAILURES_PATH), JSON.stringify(LIST));
    return root;
  }
  async function api<T>(
    state: { trackers: object[] },
    body: (base: string, writes: any[]) => Promise<T>,
  ) {
    const writes: any[] = [];
    const server = createServer(async (req, res) => {
      let input = '';
      for await (const chunk of req) input += chunk;
      const url = new URL(req.url ?? '/', 'http://localhost');
      res.setHeader('content-type', 'application/json');
      if (req.method !== 'GET') {
        writes.push({
          method: req.method,
          path: url.pathname,
          body: JSON.parse(input),
        });
        res.end(JSON.stringify({ number: 7 }));
        return;
      }
      const issue = /\/issues\/(\d+)$/.exec(url.pathname);
      if (issue)
        res.end(JSON.stringify({ number: Number(issue[1]), state: 'open' }));
      else if (url.pathname.endsWith('/issues'))
        res.end(JSON.stringify(state.trackers));
      else if (url.pathname.endsWith('/jobs'))
        res.end(
          JSON.stringify({
            jobs: knownJobs.map((item) => ({
              ...item,
              started_at: '2026-11-14T03:00:00Z',
              completed_at: '2026-11-14T04:30:00Z',
            })),
          }),
        );
      else if (/\/runs\/42$/.test(url.pathname)) res.end(JSON.stringify(RUN));
      else if (url.pathname.endsWith('/runs'))
        res.end(
          JSON.stringify({
            workflow_runs: url.pathname.includes('/nightly.yml/')
              ? []
              : [{ ...RUN, event: 'schedule' }],
          }),
        );
      else {
        res.writeHead(404);
        res.end('{}');
      }
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    try {
      return await body(`http://127.0.0.1:${address.port}`, writes);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  }
  const manifests = () =>
    artifacts({ '.': manifest('Exclusive corpora', [group([KNOWN_TEST])]) });

  async function prepare(mode: string | undefined, trackers: object[]) {
    return api({ trackers }, async (base, writes) => {
      const root = rootWithList();
      const event = join(root, 'event.json');
      writeFileSync(event, JSON.stringify({ workflow_run: { id: 42 } }));
      const env: Record<string, string | undefined> = {
        ...process.env,
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_API_URL: base,
        GITHUB_EVENT_PATH: event,
        GITHUB_OUTPUT: join(root, 'output'),
        GITHUB_RUN_ID: '99',
        GITHUB_RUN_ATTEMPT: '1',
        QUALIFICATION_MANIFEST_DIR: manifests(),
      };
      delete env.QUALIFICATION_REPAIR_AGENT;
      delete env.STATION_QUALIFICATION_SIGNAL;
      if (mode !== undefined) env.STATION_QUALIFICATION_SIGNAL = mode;
      await exec(process.execPath, [repairScript, 'prepare'], {
        cwd: root,
        env,
        windowsHide: true,
      });
      return writes;
    });
  }
  const episode = {
    episode: 41,
    failedRun: 41,
    failedSha: 'b'.repeat(40),
    openedAt: '2026-11-13T00:00:00Z',
    lastStartedAt: '2026-11-13T00:00:00Z',
    repairState: 'needs-owner',
    attemptConsumed: true,
  };
  const tracker = {
    number: 7,
    state: 'open',
    title: 'Main qualification repair',
    user: { login: 'github-actions[bot]' },
    body: `<!-- station-qualification:${JSON.stringify(episode)} -->`,
  };

  it('report mode keeps the repair decision: a known-only run still opens the episode, with the classification in its body', async () => {
    for (const mode of [undefined, 'report', 'typo']) {
      const writes = await prepare(mode, []);
      expect(writes, String(mode)).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        method: 'POST',
        body: { state: 'open' },
      });
      expect(writes[0].body.body).toContain(
        'report only; tracker decisions unchanged',
      );
      expect(writes[0].body.body).toContain(
        'Main qualification is still red, only on known failures owned by open issues #4917.',
      );
    }
  });

  it('enforce mode: known-only opens nothing, and refreshes an open episode without closing it', async () => {
    expect(await prepare('enforce', [])).toEqual([]);
    const writes = await prepare('enforce', [tracker]);
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe('PATCH');
    expect(writes[0].body).not.toHaveProperty('state');
    expect(repairState(writes[0].body.body)?.repairState).toBe('needs-owner');
    expect(writes[0].body.body).toContain(
      'Only a green qualification run or a person closes this episode.',
    );
  });

  async function health(
    mode: string | undefined,
    at = '2026-11-14T06:00:00Z',
    trackers: object[] = [],
  ) {
    return api({ trackers }, async (base, writes) => {
      const env: Record<string, string | undefined> = {
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_API_URL: base,
        QUALIFICATION_CLASSIFY_RUN: '42',
        QUALIFICATION_MANIFEST_DIR: manifests(),
      };
      if (mode !== undefined) env.STATION_QUALIFICATION_SIGNAL = mode;
      const result = await checkQualificationHealth(env, Date.parse(at), {
        root: rootWithList(),
      });
      return { result, writes };
    });
  }
  const stale =
    'No successful source qualification within 14 hours (conservative successful-source freshness bound).';

  it('report mode keeps every health reason and adds the classification and the since line', async () => {
    const { result, writes } = await health(undefined);
    expect(result.reasons).toContain(stale);
    const body = writes[0].body.body as string;
    expect(body).toContain(
      'Main qualification has been red only on known failures since 2026-11-14T04:34:31Z',
    );
    expect(body).toContain('Release qualification stays blocked');
    expect(body).toContain(
      '<!-- station-qualification-known-only:{"runId":42,"at":"2026-11-14T04:34:31Z"} -->',
    );
  });

  it('enforce mode replaces staleness with the known-only line inside the 24-hour window, and keeps the first such run', async () => {
    const first = await health('enforce');
    expect(first.result.reasons).not.toContain(stale);
    expect(first.result.reasons.join('\n')).toContain(
      'red only on known failures since 2026-11-14T04:34:31Z',
    );
    const kept = {
      number: 42,
      title: 'Main qualification health',
      state: 'open',
      user: { login: 'github-actions[bot]' },
      body: '<!-- station-qualification-known-only:{"runId":30,"at":"2026-11-10T00:00:00Z"} -->',
    };
    const later = await health('enforce', '2026-11-15T00:00:00Z', [kept]);
    expect(later.result.reasons.join('\n')).toContain(
      'since 2026-11-10T00:00:00Z',
    );
    const expired = await health('enforce', '2026-11-15T05:00:00Z');
    expect(expired.result.reasons).toContain(stale);
  });
});

describe('review round: hooks, duplicates, steps, bounds', () => {
  const exclusive = job('Exclusive corpora');
  const reasons = (
    jobs: ReturnType<typeof job>[],
    manifests: Record<string, unknown>,
  ) => classify(jobs, manifests).fresh.map((item) => item.reason);

  it('never explains a group with any failed file, even another file failing in a hook', () => {
    for (const reason of ['suite', 'load'])
      expect(
        reasons(JOBS(exclusive), {
          a: manifest('Exclusive corpora', [
            group([KNOWN_TEST], {
              failedFiles: [{ file: 'other.test.ts', reason }],
            }),
          ]),
        })[0],
        reason,
      ).toMatch(/^unexplained/);
  });

  it('never explains a repeated test identity', () => {
    expect(
      reasons(JOBS(exclusive), {
        a: manifest('Exclusive corpora', [
          group([KNOWN_TEST, KNOWN_TEST], {
            counts: {
              reporterFailedTests: 2,
              reporterFailedFiles: 1,
              unhandledErrors: 0,
            },
          }),
        ]),
      })[0],
    ).toMatch(/^unexplained/);
  });

  it('alerts on a failed job whose manifest lists no failed test', () => {
    expect(
      reasons(JOBS(exclusive), {
        a: manifest('Exclusive corpora', [group([])]),
      }),
    ).toEqual(['failed with no failed test listed']);
  });

  it('treats any failed step besides the phase step as a new failure', () => {
    const manifests = {
      a: manifest('Exclusive corpora', [group([KNOWN_TEST])]),
    };
    const withSteps = (steps: { name: string; conclusion: string }[]) =>
      reasons(JOBS(job('Exclusive corpora', 'failure', steps)), manifests);
    const phase = { name: 'Run full-regression phases', conclusion: 'failure' };
    expect(withSteps([phase])).toEqual([]);
    expect(
      withSteps([
        phase,
        {
          name: 'Retain the qualification failure manifest',
          conclusion: 'failure',
        },
      ])[0],
    ).toMatch(/^failed in step/);
    expect(
      withSteps([
        {
          name: 'Install Chromium for full-corpus browser assertions',
          conclusion: 'failure',
        },
      ])[0],
    ).toMatch(/^failed in step/);
    expect(withSteps([{ ...phase, conclusion: 'success' }])[0]).toMatch(
      /^failed in step/,
    );
    const { steps: _steps, ...stepless } = exclusive;
    expect(
      reasons(JOBS(stepless as ReturnType<typeof job>), manifests),
    ).toEqual(['job steps unavailable']);
  });

  it('enforces the manifest bounds: bytes, entries and manifest count', () => {
    const big = manifest('Exclusive corpora', [group([KNOWN_TEST])]);
    const padded = JSON.stringify(big).replace(
      '"producer"',
      `"padding":"${'x'.repeat(MANIFEST_BOUNDS.bytes)}","producer"`,
    );
    expect(reasons(JOBS(exclusive), { a: padded })[0]).toMatch(/exceeds/);
    const many = Array.from(
      // A literal, not the constant: raising the bound must fail this.
      { length: 501 },
      (_, index) => ({
        file: 'many.test.ts',
        titlePath: [`t${index}`],
      }),
    );
    expect(
      reasons(JOBS(exclusive), {
        a: { ...big, phases: [{ ...big.phases[0], groups: [group(many)] }] },
      })[0],
    ).toMatch(/holds 501 entries; at most 500\)$/);
    const directory = makeTempDir('station-many-manifests-');
    for (let index = 0; index < 70; index++) {
      mkdirSync(join(directory, `m${index}`));
      writeFileSync(
        join(directory, `m${index}`, JOB_MANIFEST_FILE),
        JSON.stringify(big),
      );
    }
    expect(
      readJobManifests(directory).some(
        (item) => item.error === 'too many manifests',
      ),
    ).toBe(true);
  });

  it('requires the single non-success step to be the phase step and to have failed', () => {
    const manifests = {
      a: manifest('Exclusive corpora', [group([KNOWN_TEST])]),
    };
    for (const conclusion of ['cancelled', 'timed_out', 'neutral', null])
      expect(
        reasons(
          JOBS(
            job('Exclusive corpora', 'failure', [
              {
                name: 'Run full-regression phases',
                conclusion: conclusion as string,
              },
            ]),
          ),
          manifests,
        )[0],
        String(conclusion),
      ).toMatch(/^failed in step/);
  });

  it('names the cause when a failed file or a repeated identity leaves a job unexplained', () => {
    expect(
      reasons(JOBS(exclusive), {
        a: manifest('Exclusive corpora', [
          group([KNOWN_TEST], {
            failedFiles: [{ file: 'other.test.ts', reason: 'suite' }],
          }),
        ]),
      })[0],
    ).toMatch(
      /other\.test\.ts failed outside a named test \(a hook or suite failed\)/,
    );
    expect(
      reasons(JOBS(exclusive), {
        a: manifest('Exclusive corpora', [
          group([KNOWN_TEST], {
            failedFiles: [{ file: 'b.test.ts', reason: 'load' }],
          }),
        ]),
      })[0],
    ).toMatch(/b\.test\.ts failed outside a named test \(did not load\)/);
    expect(
      reasons(JOBS(exclusive), {
        a: manifest('Exclusive corpora', [
          group([KNOWN_TEST, KNOWN_TEST], {
            counts: {
              reporterFailedTests: 2,
              reporterFailedFiles: 1,
              unhandledErrors: 0,
            },
          }),
        ]),
      })[0],
    ).toMatch(/reported more than once/);
  });

  it('pins the manifest bounds as literals: 64 manifests and 4 MiB pass, one more of either is refused', () => {
    const own = manifest('Exclusive corpora', [group([KNOWN_TEST])]);
    const sized = (bytes: number) => {
      const text = JSON.stringify(own);
      return `${text}${' '.repeat(bytes - Buffer.byteLength(text))}`;
    };
    const FOUR_MIB = 4_194_304;
    expect(reasons(JOBS(exclusive), { a: sized(FOUR_MIB) })).toEqual([]);
    expect(reasons(JOBS(exclusive), { a: sized(FOUR_MIB + 1) })[0]).toMatch(
      /manifest exceeds 4194304 bytes/,
    );
    const fill = (count: number) => {
      const directory = makeTempDir('station-manifest-count-');
      for (let index = 0; index < count; index++) {
        mkdirSync(join(directory, `m${index}`));
        writeFileSync(
          join(directory, `m${index}`, JOB_MANIFEST_FILE),
          JSON.stringify(manifest(`Job ${index}`, [group([])])),
        );
      }
      return readJobManifests(directory);
    };
    expect(fill(64).filter((item) => item.error)).toEqual([]);
    expect(
      fill(65)
        .filter((item) => item.error)
        .map((item) => item.error),
    ).toEqual(['too many manifests']);
  });

  it('enforces only on the exact word', () => {
    for (const value of [' enforce', 'enforce ', 'ENFORCE', 'enforce\n'])
      expect(signalMode(value), JSON.stringify(value)).toBe('report');
  });

  it('names exactly the workflow steps that write a manifest', () => {
    const { jobs } = load(
      readFileSync(join(repo, '.github/workflows/full-regression.yml'), 'utf8'),
    ) as any;
    const writers = Object.values(jobs).flatMap((entry: any) =>
      (entry.steps ?? [])
        .filter((step: any) => step.env?.STATION_QUALIFICATION_MANIFEST_DIR)
        .map((step: any) => step.name),
    );
    expect([...new Set(writers)].sort()).toEqual(
      [...MANIFEST_PHASE_STEPS].sort(),
    );
  });
});

describe('workflow wiring', () => {
  const workflow = (name: string) =>
    load(readFileSync(join(repo, '.github/workflows', name), 'utf8')) as any;

  it('passes the enforcement variable, unset by default, to both trackers and downloads manifests read-only', () => {
    const repair = workflow('qualification-repair.yml');
    const prepareSteps = repair.jobs.prepare.steps;
    const download = prepareSteps.find(
      (step: any) =>
        step.name === 'Download the qualification failure manifests',
    );
    expect(download).toMatchObject({
      'continue-on-error': true,
      with: {
        'run-id': '${{ github.event.workflow_run.id || inputs.run_id }}',
        pattern: 'qualification-manifest-*',
      },
    });
    expect(download.uses).toMatch(/^actions\/download-artifact@[0-9a-f]{40}$/);
    const prepare = prepareSteps.find((step: any) => step.id === 'prepare');
    expect(prepare.env.STATION_QUALIFICATION_SIGNAL).toBe(
      '${{ vars.STATION_QUALIFICATION_SIGNAL }}',
    );
    expect(prepare.env.QUALIFICATION_MANIFEST_DIR).toBe(download.with.path);
    expect(repair.jobs.prepare.permissions).toEqual({
      contents: 'read',
      actions: 'read',
      issues: 'write',
    });
    const healthSteps = workflow('qualification-health.yml').jobs.health.steps;
    const check = healthSteps.at(-1);
    expect(check.env.STATION_QUALIFICATION_SIGNAL).toBe(
      '${{ vars.STATION_QUALIFICATION_SIGNAL }}',
    );
    expect(check.env.QUALIFICATION_CLASSIFY_RUN).toBe(
      '${{ steps.select.outputs.run_id }}',
    );
    expect(workflow('qualification-health.yml').permissions).toEqual({
      contents: 'read',
      actions: 'read',
      issues: 'write',
    });
    // Nothing else may set the variable's value.
    for (const name of ['qualification-repair.yml', 'qualification-health.yml'])
      expect(
        readFileSync(join(repo, '.github/workflows', name), 'utf8'),
      ).not.toMatch(
        /STATION_QUALIFICATION_SIGNAL: (?!\$\{\{ vars\.STATION_QUALIFICATION_SIGNAL \}\})/,
      );
  });

  it('writes a labelled manifest from every driver job and uploads it on failure', () => {
    const { jobs } = workflow('full-regression.yml');
    for (const id of [
      'static',
      'ordinary',
      'process-heavy',
      'exclusive',
      'android-viewport',
    ]) {
      const steps = jobs[id].steps;
      const run = steps.find(
        (step: any) =>
          step.name === 'Run full-regression phases' ||
          step.name === 'Run Android viewport tests',
      );
      expect(run.env.STATION_QUALIFICATION_JOB_LABEL, id).toBe(jobs[id].name);
      expect(run.env.STATION_QUALIFICATION_MANIFEST_DIR, id).toBe(
        '${{ runner.temp }}/qualification-manifest',
      );
      const upload = steps.find(
        (step: any) =>
          step.name === 'Retain the qualification failure manifest',
      );
      expect(upload, id).toMatchObject({
        if: 'failure()',
        'continue-on-error': true,
        with: {
          name: 'qualification-manifest-${{ github.job }}-${{ strategy.job-index }}-${{ github.run_attempt }}',
          path: `\${{ runner.temp }}/qualification-manifest/${JOB_MANIFEST_FILE}`,
        },
      });
    }
  });
});
