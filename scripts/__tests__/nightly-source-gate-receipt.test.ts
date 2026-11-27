import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  findSourceGateReceipt,
  RECEIPT_STEPS,
  runReceiptStep,
  STATICS_JOB,
} from '../nightly-source-gate-receipt.mjs';
import { FAST_SCOPE_STATICS, FAST_STATIC_COMMANDS } from '../run-ci-fast.mjs';

const exec = promisify(execFile);
const makeTempDir = trackTempDirs();
const root = resolve(import.meta.dirname, '../..');
const fixtures = resolve(
  import.meta.dirname,
  'fixtures/nightly-source-gate-receipt',
);

type Json = Record<string, any>;
// Trimmed from the real Actions API responses (2026-11-16) for the six most
// recent Nightly sources: each one's merge_group ci.yml run listing and that
// run's attempt-1 job listing (steps kept for fast-checks statics only).
const realSources = (): Record<string, { runs: Json; jobs: Json }> =>
  JSON.parse(
    readFileSync(join(fixtures, 'recent-nightly-sources.json'), 'utf8'),
  );
// The real listing for dfdfb17c, a deploy-ledger-only bot commit on main.
const ledgerOnlyRuns = (): Json =>
  JSON.parse(readFileSync(join(fixtures, 'ledger-only-runs.json'), 'utf8'));

// Literals pinned independently of the fixture files.
const SHA = 'd25dc082385145dcdf133590bd49d12e02f4198f';
const RUN_ID = 43855881824;
const LEDGER_ONLY_SHA = 'dfdfb17cda142ceb2ad5e540ab3d6c83742e4e99';
const REPOSITORY = 'kontourai/station';
const runsPath = (sha: string) =>
  `repos/${REPOSITORY}/actions/workflows/ci.yml/runs?event=merge_group&head_sha=${sha}&per_page=100`;
const jobsPath = (id: number, attempt = 1) =>
  `repos/${REPOSITORY}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`;

type Routes = Record<string, Json | number>;

function decide(routes: Routes, sha = SHA) {
  const seen: string[] = [];
  return findSourceGateReceipt({
    sha,
    repository: REPOSITORY,
    request: async (path: string) => {
      seen.push(path);
      const route = routes[path];
      if (route === undefined) throw new Error(`unexpected request ${path}`);
      if (typeof route === 'number')
        throw new Error(`GitHub ${path} responded ${route}`);
      return route;
    },
  }).then((result) => ({ ...result, seen }));
}

function source(
  mutate: (
    run: Json,
    jobs: Json[],
    statics: Json,
    listing: Json,
    jobListing: Json,
  ) => void = () => {},
) {
  const { runs, jobs } = realSources()[SHA];
  const statics = jobs.jobs.find(
    (job: Json) => job.name === 'fast-checks statics',
  );
  mutate(runs.workflow_runs[0], jobs.jobs, statics, runs, jobs);
  return {
    [runsPath(SHA)]: runs,
    [jobsPath(RUN_ID)]: jobs,
  } as Routes;
}

describe('findSourceGateReceipt on real listings', () => {
  it('accepts the merge queue run of each of the six recent Nightly sources', async () => {
    const sources = realSources();
    expect(Object.keys(sources)).toHaveLength(6);
    for (const [sha, { runs, jobs }] of Object.entries(sources)) {
      const id = runs.workflow_runs[0].id;
      const result = await decide(
        { [runsPath(sha)]: runs, [jobsPath(id)]: jobs },
        sha,
      );
      expect(result, sha).toMatchObject({
        accepted: true,
        reason: `merge-group-run:${id}/attempt:1`,
      });
    }
  });

  it('reads exactly the workflow-scoped merge_group listing and that attempt’s jobs', async () => {
    const result = await decide(source());
    expect(result.accepted).toBe(true);
    expect(result.seen).toEqual([
      `repos/kontourai/station/actions/workflows/ci.yml/runs?event=merge_group&head_sha=${SHA}&per_page=100`,
      `repos/kontourai/station/actions/runs/${RUN_ID}/attempts/1/jobs?per_page=100`,
    ]);
  });

  it('refuses a deploy-ledger-only commit, which has no merge queue run of its own', async () => {
    const result = await decide(
      { [runsPath(LEDGER_ONLY_SHA)]: ledgerOnlyRuns() },
      LEDGER_ONLY_SHA,
    );
    expect(result).toMatchObject({
      accepted: false,
      reason: 'no-merge-group-run',
    });
  });
});

describe('findSourceGateReceipt refusals', () => {
  const refusal = async (routes: Routes, sha = SHA) => {
    const result = await decide(routes, sha);
    expect(result.accepted).toBe(false);
    return result.reason;
  };

  it('refuses a passing run for a different SHA', async () => {
    // Another Nightly source's real, passing run and jobs served for this
    // SHA, as an API that ignored the head_sha filter would.
    const other = realSources()['e54d5784edda09dc704955455b4fe000547231ca'];
    expect(
      await refusal({
        [runsPath(SHA)]: other.runs,
        [jobsPath(other.runs.workflow_runs[0].id)]: other.jobs,
      }),
    ).toBe('unexpected-run-in-listing');
    expect(
      await refusal(
        source((_run, jobs) => {
          for (const job of jobs)
            job.head_sha = 'e54d5784edda09dc704955455b4fe000547231ca';
        }),
      ),
    ).toBe('statics-job-identity');
  });

  it('refuses a failed, cancelled or unfinished merge queue run', async () => {
    for (const [status, conclusion] of [
      ['completed', 'failure'],
      ['completed', 'cancelled'],
      ['in_progress', null],
    ])
      expect(
        await refusal(
          source((run) => {
            run.status = status;
            run.conclusion = conclusion;
          }),
        ),
      ).toBe(`merge-group-run-${status}-${conclusion}`);
  });

  it('refuses any event but merge_group, a fork, another repository or a non-queue branch', async () => {
    for (const event of ['pull_request_target', 'push', 'workflow_dispatch'])
      expect(
        await refusal(
          source((run) => {
            run.event = event;
          }),
        ),
      ).toBe('unexpected-run-in-listing');
    expect(
      await refusal(
        source((run) => {
          run.head_repository.full_name = 'someone/station';
        }),
      ),
    ).toBe('unexpected-run-in-listing');
    expect(
      await refusal(
        source((run) => {
          run.path = '.github/workflows/other.yml';
        }),
      ),
    ).toBe('unexpected-run-in-listing');
    for (const branch of [
      'main',
      'gh-readonly-queue/release/pr-5032-08c590b6bcadc0782907426953064ae7ab5a85a6',
      'feature/gh-readonly-queue/main/pr-5032-08c590b6bcadc0782907426953064ae7ab5a85a6',
    ])
      expect(
        await refusal(
          source((run) => {
            run.head_branch = branch;
          }),
        ),
      ).toBe('unrecognized-queue-branch');
  });

  it('refuses several runs for one SHA, even when both passed', async () => {
    expect(
      await refusal(
        source((run, _jobs, _statics, listing) => {
          listing.workflow_runs.push({ ...run, id: run.id + 1 });
          listing.total_count = 2;
        }),
      ),
    ).toBe('merge-group-runs-2');
  });

  it('refuses a listing it cannot see the end of', async () => {
    expect(
      await refusal(
        source((_run, _jobs, _statics, listing) => {
          listing.total_count = 101;
        }),
      ),
    ).toBe('run-listing-truncated');
  });

  it('refuses statics that failed, was skipped, is missing, is doubled or belongs to another attempt', async () => {
    for (const conclusion of ['failure', 'skipped', 'cancelled'])
      expect(
        await refusal(
          source((_run, _jobs, statics) => {
            statics.conclusion = conclusion;
          }),
        ),
      ).toBe(`statics-job-completed-${conclusion}`);
    expect(
      await refusal(
        source((_run, _jobs, statics) => {
          statics.name = 'fast-checks statics (renamed)';
        }),
      ),
    ).toBe('statics-job-count-0');
    expect(
      await refusal(
        source((_run, jobs, statics, _listing, jobListing) => {
          jobs.push({ ...statics, id: statics.id + 1 });
          jobListing.total_count = jobs.length;
        }),
      ),
    ).toBe('statics-job-count-2');
    expect(
      await refusal(
        source((_run, _jobs, _statics, _listing, jobListing) => {
          jobListing.total_count += 1;
        }),
      ),
    ).toBe('job-listing-truncated');
    expect(
      await refusal(
        source((_run, _jobs, statics) => {
          statics.run_attempt = 2;
        }),
      ),
    ).toBe('statics-job-identity');
  });

  it('refuses statics whose browser journey or ci:fast step did not run', async () => {
    for (const name of RECEIPT_STEPS)
      for (const conclusion of ['skipped', 'failure'])
        expect(
          await refusal(
            source((_run, _jobs, statics) => {
              const step = statics.steps.find(
                (item: Json) => item.name === name,
              );
              step.conclusion = conclusion;
            }),
          ),
        ).toBe(`statics-step-${conclusion}:${name}`);
    expect(
      await refusal(
        source((_run, _jobs, statics) => {
          statics.steps = statics.steps.filter(
            (item: Json) => item.name !== RECEIPT_STEPS[1],
          );
        }),
      ),
    ).toBe(`statics-step-count-0:${RECEIPT_STEPS[1]}`);
  });

  it('propagates an API error to its caller rather than answering', async () => {
    await expect(decide({ [runsPath(SHA)]: 502 })).rejects.toThrow('502');
  });
});

describe('runReceiptStep (fails toward running the gate)', () => {
  const env = (output: string, overrides: Record<string, string> = {}) => ({
    GITHUB_EVENT_NAME: 'schedule',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: SHA,
    SOURCE_SHA: SHA,
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_API_URL: 'https://api.example.test',
    GITHUB_SERVER_URL: 'https://github.com',
    GH_TOKEN: 'token',
    GITHUB_OUTPUT: output,
    ...overrides,
  });
  const files = () => {
    const directory = makeTempDir('nightly-source-gate-receipt-');
    const output = join(directory, 'output');
    const summary = join(directory, 'summary');
    writeFileSync(output, '');
    writeFileSync(summary, '');
    return { output, summary };
  };
  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const serve = (routes: Routes) => async (url: string | URL | Request) => {
    const route = routes[String(url).replace('https://api.example.test/', '')];
    return route === undefined
      ? respond({}, 404)
      : typeof route === 'number'
        ? respond({}, route)
        : respond(route);
  };

  it('writes accepted=true, the accepted run and a visible notice only for a real receipt', async () => {
    const { output, summary } = files();
    const lines: string[] = [];
    const result = await runReceiptStep({
      env: { ...env(output), GITHUB_STEP_SUMMARY: summary },
      log: (line: string) => lines.push(line),
      fetchImpl: serve(source()),
    });
    expect(result.accepted).toBe(true);
    const url = `https://github.com/kontourai/station/actions/runs/${RUN_ID}/attempts/1`;
    expect(readFileSync(output, 'utf8')).toBe(
      `accepted=true\nreason=merge-group-run:${RUN_ID}/attempt:1\nrun_url=${url}\n`,
    );
    expect(lines.join('\n')).toContain(`::notice title=Nightly source gate::`);
    expect(readFileSync(summary, 'utf8')).toContain(url);
  });

  it('treats an API error as no receipt, never as a pass', async () => {
    for (const status of [401, 403, 404, 500]) {
      const { output } = files();
      const result = await runReceiptStep({
        env: env(output),
        log: () => {},
        fetchImpl: serve({ [runsPath(SHA)]: status }),
      });
      expect(result.accepted).toBe(false);
      expect(readFileSync(output, 'utf8')).toMatch(
        new RegExp(
          `^accepted=false\\nreason=lookup-failed: GitHub [^\\n]+ responded ${status}\\n$`,
        ),
      );
    }
    const { output } = files();
    await runReceiptStep({
      env: env(output),
      log: () => {},
      fetchImpl: async () => {
        throw new Error('network\ndown');
      },
    });
    expect(readFileSync(output, 'utf8')).toBe(
      'accepted=false\nreason=lookup-failed: network down\n',
    );
  });

  it('refuses outside a main Nightly or when the source is not the event SHA', async () => {
    for (const [overrides, reason] of [
      [{ GITHUB_EVENT_NAME: 'pull_request_target' }, 'not-a-main-nightly'],
      [{ GITHUB_REF: 'refs/heads/feature' }, 'not-a-main-nightly'],
      [
        { SOURCE_SHA: 'e54d5784edda09dc704955455b4fe000547231ca' },
        'source-is-not-the-event-sha',
      ],
    ] as const) {
      const { output } = files();
      const result = await runReceiptStep({
        env: env(output, overrides),
        log: () => {},
        fetchImpl: serve(source()),
      });
      expect(result).toEqual({ accepted: false, reason });
    }
  });
});

type Step = {
  id?: string;
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  'continue-on-error'?: boolean;
};
type Job = {
  name?: string;
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: Step[];
};
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };
const workflow = (name: string) =>
  load(readFileSync(join(root, '.github/workflows', name), 'utf8')) as Workflow;
const RECEIPT_GUARD = "steps.receipt.outputs.accepted != 'true'";

describe('the Nightly source gate workflow', () => {
  const nightly = workflow('nightly.yml');
  const gate = nightly.jobs['test-gate'];
  const steps = gate.steps ?? [];
  const receiptIndex = steps.findIndex((step) => step.id === 'receipt');
  const receipt = steps[receiptIndex];
  // The checks the gate runs itself, identified by their commands.
  const isCheck = (step: Step) =>
    /npm run (native-platform:ratchet|lint:check|build:connect|test:e2e:pr-smoke)$|node scripts\/typecheck-aggregate\.mjs$/.test(
      step.run?.trim() ?? '',
    );
  const checks = steps.filter(isCheck);

  it('keeps the job name, result and source_sha every consumer reads', () => {
    expect(gate.name).toBe('1 · Source gate (lint, typecheck, browser smoke)');
    expect(gate.outputs).toEqual({
      source_sha: '$' + '{{ steps.source.outputs.sha }}',
    });
    expect(gate.permissions).toEqual({ contents: 'read', actions: 'read' });
  });

  it('looks up the receipt after binding the source and before any check', () => {
    expect(receipt).toMatchObject({
      name: "Accept the merge queue's source gate for this exact SHA",
      run: 'node scripts/nightly-source-gate-receipt.mjs',
      'continue-on-error': true,
      env: {
        GH_TOKEN: '$' + '{{ github.token }}',
        SOURCE_SHA: '$' + '{{ steps.source.outputs.sha }}',
      },
    });
    expect(receipt.if).toBeUndefined();
    expect(steps.findIndex((step) => step.id === 'source')).toBeLessThan(
      receiptIndex,
    );
    expect(checks.map((step) => step.run?.trim())).toEqual([
      'npm run native-platform:ratchet',
      'npm run lint:check',
      'npm run build:connect',
      'node scripts/typecheck-aggregate.mjs',
      'npm run test:e2e:pr-smoke',
    ]);
    for (const step of checks)
      expect(steps.indexOf(step)).toBeGreaterThan(receiptIndex);
  });

  it('skips exactly its own checks, and only on accepted=true', () => {
    for (const step of steps)
      expect(step.if, step.name ?? step.run).toBe(
        isCheck(step)
          ? RECEIPT_GUARD
          : step.name === 'Upload test-gate diagnostics'
            ? 'always()'
            : undefined,
      );
    // Installation and the Chromium cache it alone writes still run.
    for (const name of ['Cache Chromium', 'Install Chromium'])
      expect(steps.find((step) => step.name === name)?.if).toBeUndefined();
  });

  it('accepts only checks the merge queue’s statics job runs on the same tree with the same settings', () => {
    const ci = workflow('ci.yml');
    expect(ci.on).toHaveProperty('merge_group');
    const statics = ci.jobs['fast-checks-statics'];
    expect(statics.name).toBe(STATICS_JOB);
    const ciSteps = statics.steps ?? [];
    const named = (name: string) => ciSteps.find((step) => step.name === name);
    const [lane, journeys] = RECEIPT_STEPS.map(named);
    expect(lane?.run).toBe('npm run ci:fast');
    expect(lane?.env?.STATION_CI_FAST_SCOPE).toBe(FAST_SCOPE_STATICS);
    const typecheck = checks.find((step) =>
      step.run?.includes('typecheck-aggregate'),
    );
    expect(lane?.env?.STATION_TYPECHECK_SLOTS).toBe(
      typecheck?.env?.STATION_TYPECHECK_SLOTS,
    );
    expect(journeys?.run).toBe('npm run test:e2e:pr-smoke');
    expect(journeys?.env).toMatchObject({
      STATION_UI_BUNDLE_BUDGET: 'enforce',
      STATION_REQUIRED_SOURCE_SHA: expect.stringContaining(
        'github.event.merge_group.head_sha',
      ),
    });
    // Chromium is installed before either step, as in the Nightly gate.
    const install = ciSteps.findIndex((step) =>
      step.name?.startsWith('Install Chromium'),
    );
    expect(install).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(ciSteps.indexOf(lane as Step));
    const staticsCommands = FAST_STATIC_COMMANDS.map(
      ([command, args]) =>
        `${command === process.execPath ? 'node' : command} ${[args].flat().join(' ')}`,
    );
    // Readiness owns the lint verdict that Nightly reuses on this exact tree.
    expect(staticsCommands).toContain(
      'npm run veritas:readiness -- --format json',
    );
    const { evidence } = JSON.parse(
      readFileSync(join(root, '.veritas/repo-map.json'), 'utf8'),
    );
    const style = evidence.evidenceChecks.find(
      (check: { id: string }) => check.id === 'style-standard',
    );
    expect(evidence.requiredEvidenceCheckIds).toContain('style-standard');
    expect(style?.runner ?? 'bash').toBe('bash');
    expect(style?.command).toBe('npm run lint:check');
    const verifiedCommands = [...staticsCommands, style.command];
    for (const step of checks) {
      const command = step.run?.trim() ?? '';
      if (command === journeys?.run) continue;
      expect(verifiedCommands, command).toContain(command);
    }
  });

  it('starts nothing downstream before the gate’s verdict', () => {
    const needsOf = (job: Job) =>
      Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
    const closure = (id: string, seen = new Set<string>()) => {
      for (const parent of needsOf(nightly.jobs[id])) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        closure(parent, seen);
      }
      return seen;
    };
    for (const [id, job] of Object.entries(nightly.jobs)) {
      if (id === 'delivery-decide' || id === 'test-gate') continue;
      expect([...closure(id)], id).toContain('test-gate');
      expect(job.if, id).toMatch(
        /needs(\['test-gate'\]|\.test-gate)\.result == 'success'/,
      );
    }
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

  // The command the workflow step runs, read from nightly.yml.
  const command =
    workflow('nightly.yml')
      .jobs['test-gate'].steps?.find((step) => step.id === 'receipt')
      ?.run?.split(' ') ?? [];

  async function step(apiUrl: string) {
    const output = join(
      makeTempDir('nightly-source-gate-receipt-child-'),
      'output',
    );
    writeFileSync(output, '');
    expect(command[0]).toBe('node');
    const child = await exec(process.execPath, command.slice(1), {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        GITHUB_EVENT_NAME: 'schedule',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_SHA: SHA,
        SOURCE_SHA: SHA,
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

  it('exits 0 with accepted=false when the API errors', async () => {
    await withApi(
      () => ({ status: 500, body: { message: 'boom' } }),
      async (url) => {
        const { stdout, output } = await step(url);
        expect(output).toMatch(
          /^accepted=false\nreason=lookup-failed: GitHub [^\n]+ responded 500\n$/,
        );
        expect(stdout).toContain('the source gate runs in full');
      },
    );
  });

  it('exits 0 with accepted=true for a real queue landing', async () => {
    const routes = source();
    await withApi(
      (path) =>
        routes[path] === undefined
          ? { status: 404, body: {} }
          : { status: 200, body: routes[path] },
      async (url) => {
        const { output } = await step(url);
        expect(output).toMatch(
          new RegExp(
            `^accepted=true\\nreason=merge-group-run:${RUN_ID}/attempt:1\\nrun_url=`,
          ),
        );
      },
    );
  });
});
