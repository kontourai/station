import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  classifyRunEvidence,
  collectFromApi,
  evaluateWorkflowFreshness,
  fetchJson,
  parseArgs,
  parseInstant,
  renderVerdict,
} from '../check-workflow-freshness.mjs';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-06T18:00:00Z');

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    html_url: 'https://github.com/kontourai/station/actions/runs/1',
    updated_at: new Date(NOW - 2 * HOUR).toISOString(),
    ...overrides,
  };
}

const EXECUTED = [{ conclusion: 'success' }];

/**
 * The measured #1645 history: six consecutive scheduled runs that never
 * reached a runner, closed either by GitHub's 24h queue timeout or by the next
 * night's run. This is the exact shape the gate has to call stale — a run list
 * that is entirely non-empty, entirely `completed`, and entirely worthless.
 */
const CANCELLED_WEEK = [
  { id: 33407304116, updated_at: '2026-09-01T12:39:05Z' },
  { id: 33508848371, updated_at: '2026-09-02T12:12:07Z' },
  { id: 33628621476, updated_at: '2026-09-03T12:11:08Z' },
  { id: 33753769653, updated_at: '2026-09-04T12:11:09Z' },
  { id: 33871581920, updated_at: '2026-09-05T11:20:17Z' },
  { id: 33963058252, updated_at: '2026-09-06T11:20:18Z' },
].map((entry) =>
  run({ ...entry, conclusion: 'cancelled', html_url: undefined }),
);

describe('workflow freshness derivation', () => {
  test('a recent success carrying job evidence is fresh', () => {
    const verdict = evaluateWorkflowFreshness({
      runs: [run()],
      jobsByRunId: { '1': EXECUTED },
      maxAgeMs: 36 * HOUR,
      now: NOW,
    });
    expect(verdict).toMatchObject({ fresh: true, reason: 'fresh' });
    expect(verdict.ageMs).toBe(2 * HOUR);
  });

  // The defect this module exists for. Every run is `completed`; none is a
  // verdict. Before #1645 this history read as "nothing to worry about".
  test('a week of cancelled runs is stale, not silent', () => {
    const verdict = evaluateWorkflowFreshness({
      runs: CANCELLED_WEEK,
      jobsByRunId: {},
      maxAgeMs: 36 * HOUR,
      now: NOW,
    });
    expect(verdict.fresh).toBe(false);
    expect(verdict.reason).toBe('no-qualifying-success');
    expect(verdict.run).toBeNull();
    expect(verdict.rejected).toHaveLength(6);
    expect(new Set(verdict.rejected.map((entry) => entry.reason))).toEqual(
      new Set(['conclusion-cancelled']),
    );
  });

  test('an empty history is stale and says so distinctly', () => {
    const verdict = evaluateWorkflowFreshness({
      runs: [],
      maxAgeMs: 36 * HOUR,
      now: NOW,
    });
    expect(verdict).toMatchObject({ fresh: false, reason: 'no-runs' });
  });

  test('a success older than the window is stale', () => {
    const verdict = evaluateWorkflowFreshness({
      runs: [run({ updated_at: new Date(NOW - 37 * HOUR).toISOString() })],
      jobsByRunId: { '1': EXECUTED },
      maxAgeMs: 36 * HOUR,
      now: NOW,
    });
    expect(verdict).toMatchObject({ fresh: false, reason: 'too-old' });
    expect(verdict.run?.id).toBe(1);
  });

  // main-health.yml's measured lesson, applied here: a run conclusion of
  // `success` is not evidence the gate ran.
  test('a green run whose job was skipped is not evidence it executed', () => {
    const verdict = evaluateWorkflowFreshness({
      runs: [run()],
      jobsByRunId: { '1': [{ conclusion: 'skipped' }] },
      maxAgeMs: 36 * HOUR,
      now: NOW,
    });
    expect(verdict.fresh).toBe(false);
    expect(verdict.rejected).toEqual([{ id: 1, reason: 'job-skipped' }]);
  });

  test('a green run with no successful job is not evidence it executed', () => {
    const verdict = evaluateWorkflowFreshness({
      runs: [run()],
      jobsByRunId: { '1': [] },
      maxAgeMs: 36 * HOUR,
      now: NOW,
    });
    expect(verdict.fresh).toBe(false);
    expect(verdict.rejected).toEqual([{ id: 1, reason: 'no-successful-job' }]);
  });

  // Fail closed: absence of job data is not evidence the gate ran. The
  // alternative reading — "we could not check, so assume it was fine" — is the
  // fail-open shape the whole module is written against.
  test('a green run with no job evidence supplied is not eligible', () => {
    const verdict = evaluateWorkflowFreshness({
      runs: [run()],
      maxAgeMs: 36 * HOUR,
      now: NOW,
    });
    expect(verdict.fresh).toBe(false);
    expect(verdict.rejected).toEqual([
      { id: 1, reason: 'job-evidence-missing' },
    ]);
  });

  test('a still-queued run is not a success', () => {
    const verdict = evaluateWorkflowFreshness({
      runs: [run({ status: 'queued', conclusion: null })],
      jobsByRunId: { '1': EXECUTED },
      maxAgeMs: 36 * HOUR,
      now: NOW,
    });
    expect(verdict.fresh).toBe(false);
    expect(verdict.rejected).toEqual([{ id: 1, reason: 'not-completed' }]);
  });

  // False-positive control. Ordinary scheduler lag must not raise an alarm:
  // the gallery's observed lag reaches ~5.1h on a daily cron, so consecutive
  // successes can legitimately sit ~30h apart.
  test('a success 30h old is fresh inside the 36h window', () => {
    const verdict = evaluateWorkflowFreshness({
      runs: [run({ updated_at: new Date(NOW - 30 * HOUR).toISOString() })],
      jobsByRunId: { '1': EXECUTED },
      maxAgeMs: 36 * HOUR,
      now: NOW,
    });
    expect(verdict.fresh).toBe(true);
  });

  test('the window boundary is inclusive', () => {
    const at = evaluateWorkflowFreshness({
      runs: [run({ updated_at: new Date(NOW - 36 * HOUR).toISOString() })],
      jobsByRunId: { '1': EXECUTED },
      maxAgeMs: 36 * HOUR,
      now: NOW,
    });
    expect(at.fresh).toBe(true);
    const past = evaluateWorkflowFreshness({
      runs: [
        run({ updated_at: new Date(NOW - 36 * HOUR - 1_000).toISOString() }),
      ],
      jobsByRunId: { '1': EXECUTED },
      maxAgeMs: 36 * HOUR,
      now: NOW,
    });
    expect(past.fresh).toBe(false);
  });

  // False-positive control: a branch filter must not discard the real signal.
  test('a main success is found past newer runs on other branches', () => {
    const verdict = evaluateWorkflowFreshness({
      runs: [
        run({
          id: 2,
          head_branch: 'some-lane',
          updated_at: new Date(NOW).toISOString(),
        }),
        run({ id: 3, updated_at: new Date(NOW - 4 * HOUR).toISOString() }),
      ],
      jobsByRunId: { '2': EXECUTED, '3': EXECUTED },
      maxAgeMs: 36 * HOUR,
      now: NOW,
    });
    expect(verdict.fresh).toBe(true);
    expect(verdict.run?.id).toBe(3);
    expect(verdict.rejected).toEqual([{ id: 2, reason: 'other-branch' }]);
  });

  test('the newest qualifying success wins regardless of list order', () => {
    const verdict = evaluateWorkflowFreshness({
      runs: [
        run({ id: 4, updated_at: new Date(NOW - 20 * HOUR).toISOString() }),
        run({ id: 5, updated_at: new Date(NOW - 1 * HOUR).toISOString() }),
        run({ id: 6, updated_at: new Date(NOW - 10 * HOUR).toISOString() }),
      ],
      jobsByRunId: { '4': EXECUTED, '5': EXECUTED, '6': EXECUTED },
      maxAgeMs: 36 * HOUR,
      now: NOW,
    });
    expect(verdict.run?.id).toBe(5);
  });

  test('a Map of job evidence is accepted as well as a record', () => {
    const verdict = evaluateWorkflowFreshness({
      runs: [run()],
      jobsByRunId: new Map([[1, EXECUTED]]),
      maxAgeMs: 36 * HOUR,
      now: NOW,
    });
    expect(verdict.fresh).toBe(true);
  });
});

describe('fail-closed input handling', () => {
  test('malformed inputs throw rather than resolving to fresh', () => {
    expect(() =>
      evaluateWorkflowFreshness({
        runs: 'nope' as never,
        maxAgeMs: HOUR,
        now: NOW,
      }),
    ).toThrow(/runs is not an array/);
    expect(() =>
      evaluateWorkflowFreshness({ runs: [], maxAgeMs: 0, now: NOW }),
    ).toThrow(/positive number/);
    expect(() =>
      evaluateWorkflowFreshness({
        runs: [],
        maxAgeMs: HOUR,
        now: Number.NaN,
      }),
    ).toThrow(/epoch milliseconds/);
  });

  test('an unparseable conclusion time throws instead of counting as recent', () => {
    expect(() =>
      evaluateWorkflowFreshness({
        runs: [run({ updated_at: 'yesterday' })],
        jobsByRunId: { '1': EXECUTED },
        maxAgeMs: 36 * HOUR,
        now: NOW,
      }),
    ).toThrow(/not an ISO-8601 instant/);
  });

  /**
   * The malformed run must abort the whole evaluation, not be quietly skipped
   * while a healthy sibling carries the verdict. Skipping would be the
   * plausible-looking behaviour and the wrong one: it reports `fresh` off a
   * history it could not fully read, which is the shape that lets a real
   * problem hide behind one good row.
   */
  test('a malformed run aborts even when an eligible success is present', () => {
    expect(() =>
      evaluateWorkflowFreshness({
        runs: [
          run({ id: 7, updated_at: new Date(NOW - 1 * HOUR).toISOString() }),
          run({ id: 8, updated_at: 'sometime last week' }),
        ],
        jobsByRunId: { '7': EXECUTED, '8': EXECUTED },
        maxAgeMs: 36 * HOUR,
        now: NOW,
      }),
    ).toThrow(/run 8 updated_at is not an ISO-8601 instant/);
  });

  test('--runs-file with an empty value is refused, not silently sent live', () => {
    expect(() => parseArgs(['--workflow=a.yml', '--runs-file='])).toThrow(
      /--runs-file requires a value/,
    );
  });

  test('job evidence of the wrong shape throws', () => {
    expect(() =>
      classifyRunEvidence(run(), 'success' as never, 'main'),
    ).toThrow(/not an array/);
  });

  test('parseInstant rejects a missing value', () => {
    expect(() => parseInstant(undefined, 'updated_at')).toThrow(/is missing/);
  });
});

describe('verdict rendering', () => {
  test('the stale line names the age, the window and the run', () => {
    const verdict = evaluateWorkflowFreshness({
      runs: [run({ updated_at: new Date(NOW - 48 * HOUR).toISOString() })],
      jobsByRunId: { '1': EXECUTED },
      maxAgeMs: 36 * HOUR,
      now: NOW,
    });
    const line = renderVerdict('nightly-gallery.yml', verdict);
    expect(line).toContain('FAIL:');
    expect(line).toContain('48.0h');
    expect(line).toContain('36.0h');
    expect(line).toContain('run 1');
  });

  test('the no-success line lists why each run was rejected', () => {
    const verdict = evaluateWorkflowFreshness({
      runs: CANCELLED_WEEK,
      maxAgeMs: 36 * HOUR,
      now: NOW,
    });
    const line = renderVerdict('nightly-gallery.yml', verdict);
    expect(line).toContain('FAIL:');
    expect(line).toContain('33963058252=conclusion-cancelled');
  });

  test('the fresh line reports the age it accepted', () => {
    const verdict = evaluateWorkflowFreshness({
      runs: [run()],
      jobsByRunId: { '1': EXECUTED },
      maxAgeMs: 36 * HOUR,
      now: NOW,
    });
    expect(renderVerdict('nightly-gallery.yml', verdict)).toContain('OK:');
  });
});

describe('argument parsing', () => {
  test('--workflow is required', () => {
    expect(() => parseArgs([])).toThrow(/--workflow is required/);
  });

  test('an unknown flag is refused rather than ignored', () => {
    expect(() => parseArgs(['--workflow=a.yml', '--max-age-days=2'])).toThrow(
      /Unrecognized option '--max-age-days'/,
    );
    expect(() => parseArgs(['--workflow=a.yml', 'bare'])).toThrow(
      /Unrecognized option 'bare'/,
    );
  });

  test('a non-positive window is refused', () => {
    expect(() => parseArgs(['--workflow=a.yml', '--max-age-hours=0'])).toThrow(
      /positive number/,
    );
    expect(() =>
      parseArgs(['--workflow=a.yml', '--max-age-hours=soon']),
    ).toThrow(/positive number/);
  });

  test('defaults are the 36h main window', () => {
    expect(parseArgs(['--workflow=a.yml'])).toMatchObject({
      maxAgeHours: 36,
      branch: 'main',
      json: false,
    });
  });
});

/**
 * The network path. Every other test here supplies `--runs-file`, so without
 * these the code that actually runs in CI — the preconditions, the URL shapes,
 * and which runs get their jobs fetched — would be the one uncovered part of a
 * watchdog. `fetch` and `process.env` are injected rather than stubbed
 * globally.
 */
describe('GitHub API collection', () => {
  const options = { workflow: 'nightly-gallery.yml', branch: 'main' };
  const env = {
    GITHUB_TOKEN: 'tok',
    GITHUB_REPOSITORY: 'kontourai/station',
  };

  function stubFetch(routes: Record<string, unknown>) {
    const calls: string[] = [];
    const impl = async (url: string) => {
      calls.push(url);
      const body = Object.entries(routes).find(([fragment]) =>
        url.includes(fragment),
      )?.[1];
      if (body === undefined) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => body };
    };
    return { impl, calls };
  }

  test('a missing token or repository refuses before any request', async () => {
    const { impl, calls } = stubFetch({});
    await expect(
      collectFromApi(options, { GITHUB_REPOSITORY: 'a/b' }, impl),
    ).rejects.toThrow(/GITHUB_TOKEN is required/);
    await expect(
      collectFromApi(options, { GITHUB_TOKEN: 'tok' }, impl),
    ).rejects.toThrow(/GITHUB_REPOSITORY is required/);
    expect(calls).toEqual([]);
  });

  test('requests the workflow runs scoped to the branch, and jobs only for successes', async () => {
    const runs = [
      run({ id: 11, conclusion: 'cancelled' }),
      run({ id: 12 }),
      run({ id: 13, status: 'queued', conclusion: null }),
    ];
    const { impl, calls } = stubFetch({
      '/actions/workflows/': { workflow_runs: runs },
      '/actions/runs/12/jobs': { jobs: EXECUTED },
    });

    const collected = await collectFromApi(options, env, impl);

    expect(calls[0]).toBe(
      'https://api.github.com/repos/kontourai/station/actions/workflows/nightly-gallery.yml/runs?branch=main&per_page=20',
    );
    // Only run 12 qualified, so only its jobs were fetched: a cancelled or
    // still-queued run is rejected before its jobs are ever consulted.
    expect(calls.slice(1)).toEqual([
      'https://api.github.com/repos/kontourai/station/actions/runs/12/jobs?per_page=100',
    ]);
    expect(collected.runs).toHaveLength(3);
    expect(Object.keys(collected.jobsByRunId)).toEqual(['12']);

    // And the collected shape feeds the evaluator directly.
    expect(
      evaluateWorkflowFreshness({
        ...collected,
        maxAgeMs: 36 * HOUR,
        now: NOW,
      }).fresh,
    ).toBe(true);
  });

  test('GITHUB_API_URL is honoured for a non-dotcom host', async () => {
    const { impl, calls } = stubFetch({
      '/actions/workflows/': { workflow_runs: [] },
    });
    await collectFromApi(
      options,
      { ...env, GITHUB_API_URL: 'https://ghe.example/api/v3' },
      impl,
    );
    expect(calls[0]).toBe(
      'https://ghe.example/api/v3/repos/kontourai/station/actions/workflows/nightly-gallery.yml/runs?branch=main&per_page=20',
    );
  });

  test('a non-ok response throws rather than yielding an empty history', async () => {
    const { impl } = stubFetch({});
    await expect(
      fetchJson('https://api.github.com/nope', 'tok', impl),
    ).rejects.toThrow(/GitHub API 404/);
    // An empty history would evaluate to `no-runs`, which is stale — but a
    // transport failure must not be reported as a verdict about the gate at
    // all, so it propagates instead.
    await expect(collectFromApi(options, env, impl)).rejects.toThrow(
      /GitHub API 404/,
    );
  });

  test('the request carries the API version and bearer token', async () => {
    const seen: Record<string, unknown>[] = [];
    const impl = async (
      _url: string,
      init: { headers: Record<string, string> },
    ) => {
      seen.push(init.headers);
      return { ok: true, status: 200, json: async () => ({}) };
    };
    await fetchJson('https://api.github.com/x', 'secret-token', impl);
    expect(seen[0]).toMatchObject({
      accept: 'application/vnd.github+json',
      authorization: 'Bearer secret-token',
      'x-github-api-version': '2022-11-28',
    });
  });
});

/**
 * The exported evaluator being right is not the same as the gate exiting
 * non-zero. This drives the real CLI as a child process, because the exit
 * status is the entire contract main-health.yml consumes and nothing above
 * this point executes it.
 */
describe('CLI exit status', () => {
  function invoke(document: unknown, args: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'freshness-'));
    const file = join(dir, 'runs.json');
    writeFileSync(file, JSON.stringify(document));
    return spawnSync(
      process.execPath,
      [
        'scripts/check-workflow-freshness.mjs',
        '--workflow=nightly-gallery.yml',
        `--runs-file=${file}`,
        ...args,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
  }

  test('exits 0 and prints OK for a fresh gate', () => {
    const result = invoke(
      {
        runs: [run({ updated_at: new Date().toISOString() })],
        jobsByRunId: { '1': EXECUTED },
      },
      [],
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK:');
  });

  test('exits 1 and prints FAIL on the measured cancelled-week history', () => {
    const result = invoke({ runs: CANCELLED_WEEK, jobsByRunId: {} }, []);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FAIL:');
    expect(result.stderr).toContain('conclusion-cancelled');
  });

  test('exits 1 when a success has aged out', () => {
    const result = invoke(
      {
        runs: [
          run({
            updated_at: new Date(Date.now() - 40 * HOUR).toISOString(),
          }),
        ],
        jobsByRunId: { '1': EXECUTED },
      },
      [],
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FAIL:');
  });

  test('a thrown error exits 1 rather than 0', () => {
    const result = invoke({ runs: 'nope' }, []);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FAIL:');
  });
});

/**
 * Wiring, not behaviour. These assert the check is actually invoked with the
 * window and on the runner class the design requires; they cannot tell you the
 * derivation is correct, which is what every test above is for.
 */
describe('workflow wiring', () => {
  /**
   * Read the runner off the `runs-on:` lines rather than searching the whole
   * file: both workflows discuss the fleet in prose, and a substring check
   * over comments would report a self-hosted runner that is not configured
   * anywhere — or, worse, pass once someone deleted the explanation.
   */
  function runnerLines(workflow: string): string[] {
    return workflow
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('runs-on:'));
  }

  test('the freshness check runs hosted, daily, against nightly-gallery', async () => {
    const { readFileSync } = await import('node:fs');
    const workflow = readFileSync(
      '.github/workflows/gallery-freshness.yml',
      'utf8',
    );
    expect(workflow).toContain('node scripts/check-workflow-freshness.mjs');
    expect(workflow).toContain('--workflow=nightly-gallery.yml');
    expect(workflow).toContain('--max-age-hours=36');
    expect(workflow).toContain("cron: '0 18 * * *'");
    expect(workflow).toContain('runs-on: ubuntu-22.04');
    expect(workflow).toContain('actions: read');
    // It must not run on the fleet whose silence it exists to notice.
    expect(runnerLines(workflow)).toEqual(['runs-on: ubuntu-22.04']);
    expect(workflow).not.toContain('physical-host-capacity@');
  });

  /**
   * That main-health.yml actually watches this workflow is asserted by
   * `ci-workflow-contract.test.ts` ("tracks and closes one attributed issue per
   * red main-only workflow"), which derives each watched NAME from its target
   * workflow file and compares the sets for equality. That is the right home
   * and the stronger check, so this file deliberately does not restate it — an
   * earlier draft here did, as `toContain('- Gallery freshness')`, and a fault
   * injection walked straight through it: `- Gallery freshnesss` contains that
   * substring, so a typo that would leave main-health watching nothing passed.
   * A second copy of a governance assertion is a drift risk on top of being
   * weaker; `actionlint-gate.mjs` carries the same warning about a constant
   * that was restated in two test files and diverged.
   */

  test('the gallery gate keeps a stalled run visible and pins its renderer by digest', async () => {
    const { readFileSync } = await import('node:fs');
    const gallery = readFileSync(
      '.github/workflows/nightly-gallery.yml',
      'utf8',
    );
    expect(gallery).toContain('cancel-in-progress: false');
    expect(gallery).toMatch(
      /image: mcr\.microsoft\.com\/playwright:v[\d.]+-\w+@sha256:[0-9a-f]{64}/,
    );
    expect(runnerLines(gallery)).toEqual(['runs-on: ubuntu-22.04']);
    expect(gallery).not.toContain('physical-host-capacity@');
  });
});
