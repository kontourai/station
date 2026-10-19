import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import { checkQualificationHealth } from '../qualification-health.mjs';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();
const run = (id = 1, hours = 1, extra = {}) => ({
  id,
  path: '.github/workflows/main-qualification.yml',
  head_repository: { full_name: 'owner/repo' },
  head_branch: 'main',
  head_sha: 'a'.repeat(40),
  event: 'schedule',
  status: 'completed',
  conclusion: 'success',
  created_at: ago(hours),
  updated_at: ago(hours - 0.2),
  html_url: `https://example.test/runs/${id}`,
  run_attempt: 1,
  ...extra,
});
const gate = (extra = {}) => ({
  name: 'qualification / Full source qualification',
  status: 'completed',
  conclusion: 'success',
  started_at: ago(1),
  completed_at: ago(0.5),
  ...extra,
});
const issue = {
  number: 42,
  title: 'Main qualification health',
  state: 'open',
  body: 'previous observation',
  user: { login: 'github-actions[bot]' },
};

async function observe({
  runs = [run()],
  jobs = { 1: [gate()] },
  issues = [issue],
  manualRuns = [] as ReturnType<typeof run>[],
  liveRuns = [] as ReturnType<typeof run>[],
  retainedRuns = [] as ReturnType<typeof run>[],
  scheduledRuns = [run(900, 1, { path: '.github/workflows/nightly.yml' })],
  failJobs = false,
  failLiveInventory = false,
  enabled = true,
  productionClock = false,
  onRead = (_path: string) => {},
}: {
  runs?: ReturnType<typeof run>[];
  jobs?: Record<
    number,
    (ReturnType<typeof gate> & {
      steps?: { name: string; conclusion: string; status?: string }[];
      run_id?: number;
      run_attempt?: number;
      head_sha?: string;
    })[]
  >;
  issues?: (typeof issue)[];
  manualRuns?: ReturnType<typeof run>[];
  scheduledRuns?: ReturnType<typeof run>[];
  liveRuns?: ReturnType<typeof run>[];
  retainedRuns?: ReturnType<typeof run>[];
  failJobs?: boolean;
  failLiveInventory?: boolean;
  enabled?: boolean;
  productionClock?: boolean;
  onRead?: (path: string) => void;
} = {}) {
  const writes: {
    method: string;
    path: string;
    body: Record<string, unknown>;
  }[] = [];
  const reads: string[] = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    response.setHeader('Content-Type', 'application/json');
    if (request.method !== 'GET') {
      let input = '';
      for await (const chunk of request) input += chunk;
      writes.push({
        method: request.method ?? '',
        path,
        body: JSON.parse(input),
      });
      response.end(JSON.stringify({ number: 42 }));
      return;
    }
    reads.push(path);
    onRead(path);
    if (path.endsWith('/runs')) {
      const status = new URL(
        request.url ?? '/',
        'http://localhost',
      ).searchParams.get('status');
      if (status && failLiveInventory) {
        response.writeHead(503);
        response.end('{}');
        return;
      }
      response.end(
        JSON.stringify({
          workflow_runs: path.includes('/nightly.yml/')
            ? status
              ? liveRuns.filter((item) => item.status === status)
              : [...scheduledRuns, ...manualRuns]
            : runs,
        }),
      );
    } else if (path.endsWith('/jobs')) {
      if (failJobs) {
        response.writeHead(503);
        response.end('{}');
        return;
      }
      const id = Number(/\/runs\/(\d+)\//.exec(path)?.[1]);
      const nightly = [
        ...scheduledRuns,
        ...manualRuns,
        ...liveRuns,
        ...retainedRuns,
      ].find((item) => item.id === id);
      response.end(
        JSON.stringify({
          jobs: (jobs[id] ?? []).map((job) =>
            nightly
              ? {
                  run_id: id,
                  run_attempt: nightly.run_attempt,
                  head_sha: nightly.head_sha,
                  ...job,
                }
              : job,
          ),
        }),
      );
    } else if (/\/runs\/\d+$/.test(path)) {
      const current = retainedRuns.find((item) =>
        path.endsWith(`/runs/${item.id}`),
      );
      if (!current) {
        response.writeHead(404);
        response.end('{}');
      } else response.end(JSON.stringify(current));
    } else if (path.endsWith('/issues')) response.end(JSON.stringify(issues));
    else {
      response.writeHead(404);
      response.end('{}');
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('HTTP fixture did not listen');
  try {
    const result = await checkQualificationHealth(
      {
        GITHUB_REPOSITORY: 'owner/repo',
        STATION_QUALIFIED_NIGHTLY: enabled ? 'enabled' : '',
        GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
      },
      productionClock ? undefined : NOW,
    );
    return { result, writes, reads };
  } finally {
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
}

describe('qualification health through the GitHub API', () => {
  it('accepts a Nightly created during API observation instead of treating invocation time as a future-data fence', async () => {
    let observed = NOW;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => observed);
    try {
      const { result } = await observe({
        productionClock: true,
        scheduledRuns: [
          run(900, 0, {
            path: '.github/workflows/nightly.yml',
            created_at: new Date(NOW + 30_000).toISOString(),
            updated_at: new Date(NOW + 40_000).toISOString(),
          }),
        ],
        onRead: (path) => {
          if (path.includes('/nightly.yml/runs')) observed = NOW + 60_000;
        },
      });
      expect(result.healthy).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it('accepts qualification and Nightly gates completing during their job reads', async () => {
    let observed = NOW;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => observed);
    try {
      const completed = new Date(NOW + 30_000).toISOString();
      const { result } = await observe({
        productionClock: true,
        jobs: {
          1: [gate({ completed_at: completed })],
          900: [
            gate({
              name: '1 · Source gate (lint, typecheck, browser smoke)',
              completed_at: completed,
            }),
          ],
        },
        onRead: (path) => {
          if (path.endsWith('/jobs')) observed = NOW + 60_000;
        },
      });
      expect(result.healthy).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it('uses the final observation clock when a scheduled request ages beyond its threshold during reads', async () => {
    let observed = NOW;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => observed);
    try {
      const { result } = await observe({
        productionClock: true,
        scheduledRuns: [run(900, 4, { path: '.github/workflows/nightly.yml' })],
        onRead: (path) => {
          if (path.includes('/runs/900/attempts/1/jobs'))
            observed = NOW + 60_000;
        },
      });
      expect(result.healthy).toBe(false);
      expect(result.reasons).toContain(
        'No scheduled Nightly request within 4 hours (schedule freshness bound; manual runs do not establish scheduled liveness).',
      );
    } finally {
      clock.mockRestore();
    }
  });

  it('still refuses timestamps beyond the actual observation clock', async () => {
    let observed = NOW;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => observed);
    try {
      await expect(
        observe({
          productionClock: true,
          scheduledRuns: [
            run(900, 0, {
              path: '.github/workflows/nightly.yml',
              created_at: new Date(NOW + 120_000).toISOString(),
              updated_at: new Date(NOW + 120_000).toISOString(),
            }),
          ],
          onRead: (path) => {
            if (path.includes('/nightly.yml/runs')) observed = NOW + 60_000;
          },
        }),
      ).rejects.toThrow('Invalid canonical Nightly run');
    } finally {
      clock.mockRestore();
    }
  });

  it('reports a missing scheduled Nightly request even when source qualification is healthy', async () => {
    const { result, writes } = await observe({
      manualRuns: [],
      scheduledRuns: [],
    });
    expect(result.healthy).toBe(false);
    expect(result.reasons).toContain(
      'No scheduled Nightly request within 4 hours (schedule freshness bound; manual runs do not establish scheduled liveness).',
    );
    expect(writes[0].body.state).toBe('open');
  });

  it('reports a six-hour delivery wait after a successful source gate', async () => {
    const { result } = await observe({
      manualRuns: [
        run(2, 7, {
          path: '.github/workflows/nightly.yml',
          status: 'pending',
          conclusion: null,
        }),
      ],
      jobs: {
        1: [gate()],
        2: [gate({ name: '1 · Source gate (lint, typecheck, browser smoke)' })],
      },
    });
    expect(result.healthy).toBe(false);
    expect(result.summary).toContain('Nightly delivery wait exceeds 6 hours');
    expect(result.summary).toContain('a'.repeat(40));
    expect(result.summary).toContain('/actions/runs/2');
  });

  it('keeps a missing schedule visible despite fresh manual recovery', async () => {
    const { result } = await observe({
      scheduledRuns: [run(900, 5, { path: '.github/workflows/nightly.yml' })],
      manualRuns: [
        run(2, 0.1, {
          path: '.github/workflows/nightly.yml',
          event: 'workflow_dispatch',
          updated_at: ago(0.05),
        }),
      ],
    });
    expect(result.reasons).toEqual([
      'No scheduled Nightly request within 4 hours (schedule freshness bound; manual runs do not establish scheduled liveness).',
    ]);
    expect(result.summary).toContain('/actions/runs/900');
  });

  it('accepts completed cadence skips and the exact four-hour schedule boundary', async () => {
    const { result } = await observe({
      scheduledRuns: [run(900, 4, { path: '.github/workflows/nightly.yml' })],
    });
    expect(result.healthy).toBe(true);
  });

  it.each(['queued', 'pending', 'waiting', 'requested', 'in_progress'])(
    'reports aged %s source work without requiring source success',
    async (status) => {
      const waiting = run(2, 7, {
        path: '.github/workflows/nightly.yml',
        status,
        conclusion: null,
      });
      const { result, reads } = await observe({ liveRuns: [waiting] });
      expect(result.reasons).toHaveLength(1);
      expect(result.reasons[0]).toContain(
        'Nightly source admission/execution wait exceeds 6 hours',
      );
      expect(result.reasons[0]).toContain(`/actions/runs/2`);
      expect(result.reasons[0]).toContain('a'.repeat(40));
      expect(result.summary).toContain(
        'resolve the existing Nightly run owner before considering a manual dispatch',
      );
      expect(
        reads.some((path) => path.includes('/runs/2/attempts/1/jobs')),
      ).toBe(true);
    },
  );

  it('keeps an older live delivery visible beyond the history lookback despite fresh schedule activity', async () => {
    const waiting = run(2, 50, {
      path: '.github/workflows/nightly.yml',
      status: 'in_progress',
      conclusion: null,
    });
    const { result } = await observe({
      liveRuns: [waiting],
      jobs: {
        1: [gate()],
        2: [
          gate({
            name: '1 · Source gate (lint, typecheck, browser smoke)',
            started_at: ago(49),
            completed_at: ago(48),
          }),
        ],
      },
    });
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain(
      'Nightly delivery wait exceeds 6 hours',
    );
  });

  it('does not alert before the six-hour bound and clears only after the old run is terminal', async () => {
    const waiting = run(2, 6, {
      path: '.github/workflows/nightly.yml',
      status: 'pending',
      conclusion: null,
    });
    expect((await observe({ liveRuns: [waiting] })).result.healthy).toBe(true);
    const completed = {
      ...waiting,
      status: 'completed',
      conclusion: 'success',
      updated_at: ago(0.1),
    };
    const { result, writes } = await observe({ manualRuns: [completed] });
    expect(result.healthy).toBe(true);
    expect(writes[0].body).toEqual({
      state: 'closed',
      state_reason: 'completed',
    });
  });

  it('deduplicates consistent recent and live snapshots', async () => {
    const waiting = run(2, 7, {
      path: '.github/workflows/nightly.yml',
      status: 'pending',
      conclusion: null,
    });
    const { result } = await observe({
      manualRuns: [waiting],
      liveRuns: [waiting],
    });
    expect(result.reasons).toHaveLength(1);
  });

  it('refuses changed attempt identities between recent and live inventory', async () => {
    const waiting = run(2, 7, {
      path: '.github/workflows/nightly.yml',
      status: 'pending',
      conclusion: null,
    });
    await expect(
      observe({
        manualRuns: [waiting],
        liveRuns: [{ ...waiting, run_attempt: 2 }],
      }),
    ).rejects.toThrow('Inconsistent Nightly run inventory');
  });

  it('ignores noncanonical schedule lookalikes without declaring schedule health', async () => {
    for (const override of [
      { path: '.github/workflows/ci.yml' },
      { head_branch: 'feature' },
      { event: 'push' },
      { head_repository: { full_name: 'foreign/repo' } },
    ]) {
      const { result } = await observe({
        scheduledRuns: [
          run(900, 1, { path: '.github/workflows/nightly.yml', ...override }),
        ],
      });
      expect(result.reasons).toHaveLength(1);
      expect(result.reasons[0]).toContain(
        'No scheduled Nightly request within 4 hours',
      );
    }
  });

  it('refuses malformed canonical Nightly metadata or an unknown state instead of closing the tracker', async () => {
    for (const override of [
      { id: 0 },
      { run_attempt: 0 },
      { head_sha: 'invalid' },
      { created_at: 'invalid' },
      { created_at: ago(-1) },
      { updated_at: ago(-1) },
      { status: 'future-state', conclusion: null },
      { status: 'pending', conclusion: 'success' },
      { status: 'completed', conclusion: null },
    ]) {
      await expect(
        observe({
          scheduledRuns: [
            run(900, 1, { path: '.github/workflows/nightly.yml', ...override }),
          ],
        }),
      ).rejects.toThrow('Invalid canonical Nightly run');
    }
  });

  it('refuses source proof from a different run, attempt or source', async () => {
    for (const override of [
      { run_id: 99 },
      { run_attempt: 2 },
      { head_sha: 'b'.repeat(40) },
    ]) {
      await expect(
        observe({
          jobs: {
            1: [gate()],
            900: [
              {
                ...gate({
                  name: '1 · Source gate (lint, typecheck, browser smoke)',
                }),
                ...override,
              },
            ],
          },
        }),
      ).rejects.toThrow('Invalid Nightly current-attempt job identity');
    }
  });

  it('does not close the tracker when live inventory lookup is unavailable', async () => {
    await expect(observe({ failLiveInventory: true })).rejects.toThrow(
      'HTTP 503',
    );
  });

  it.each([true, false])(
    'retains a fifty-hour run through terminal failure after source passed=%s',
    async (passed) => {
      const old = run(2, 50, {
        path: '.github/workflows/nightly.yml',
        status: 'in_progress',
        conclusion: null,
      });
      const sourceJobs = passed
        ? [
            gate({
              name: '1 · Source gate (lint, typecheck, browser smoke)',
              started_at: ago(49),
              completed_at: ago(48),
            }),
          ]
        : [];
      const first = await observe({
        liveRuns: [old],
        jobs: { 1: [gate()], 2: sourceJobs },
      });
      expect(first.result.healthy).toBe(false);
      const completed = {
        ...old,
        status: 'completed',
        conclusion: 'failure',
        updated_at: ago(0.1),
      };
      const second = await observe({
        issues: [{ ...issue, body: String(first.writes[0].body.body) }],
        retainedRuns: [completed],
        jobs: { 1: [gate()], 2: sourceJobs },
      });
      expect(second.result.healthy).toBe(false);
      expect(second.writes[0].body.state).toBe('open');
      expect(second.result.summary).toContain('/actions/runs/2');
      const after = String(second.writes[0].body.body);
      const third = await observe({
        issues: [{ ...issue, body: after }],
        retainedRuns: passed ? [] : [completed],
        jobs: { 1: [gate()], 2: sourceJobs },
      });
      expect(third.result.healthy).toBe(false);
      expect(third.result.summary).toContain('/actions/runs/2');
      if (!passed) {
        for (const scenario of [
          'published-native',
          'published-cli',
          'skip',
          'source-only',
          'running',
          'older',
          'failed-publication',
        ]) {
          const repaired = run(3, scenario === 'older' ? 0.2 : 0.05, {
            path: '.github/workflows/nightly.yml',
            event: 'workflow_dispatch',
            head_sha: 'b'.repeat(40),
            status: scenario === 'running' ? 'in_progress' : 'completed',
            conclusion:
              scenario === 'running'
                ? null
                : scenario === 'failed-publication'
                  ? 'failure'
                  : 'success',
            updated_at: ago(0.01),
          });
          const proof =
            scenario === 'skip'
              ? []
              : [
                  gate({
                    name: '1 · Source gate (lint, typecheck, browser smoke)',
                    started_at: ago(0.04),
                    completed_at: ago(0.02),
                  }),
                ];
          if (
            scenario === 'published-native' ||
            scenario === 'older' ||
            scenario === 'failed-publication'
          )
            proof.push(
              gate({
                name: '3 · Publish native cohort / Record ledger and markers',
                completed_at: ago(0.01),
              }),
            );
          const repairJobs =
            scenario === 'published-cli'
              ? [
                  ...proof,
                  {
                    ...gate({ name: '3 · Publish CLI to npm nightly' }),
                    steps: [
                      {
                        name: 'Bind the published CLI receipt to npm registry provenance',
                        conclusion: 'success',
                        status: 'completed',
                      },
                    ],
                  },
                ]
              : proof;
          const recovered = await observe({
            issues: [{ ...issue, body: after }],
            retainedRuns: [completed],
            manualRuns: [repaired],
            jobs: { 1: [gate()], 2: sourceJobs, 3: repairJobs },
          });
          const success = ['published-native', 'published-cli'].includes(
            scenario,
          );
          expect(recovered.result.healthy, scenario).toBe(success);
          if (success) {
            expect(recovered.result.summary).toContain('/actions/runs/2');
            expect(recovered.result.summary).toContain('/actions/runs/3');
            expect(recovered.writes[0].body.state).toBe('closed');
          }
        }
      }
    },
  );

  it('resolves a retained overdue run only after observing its terminal success', async () => {
    const completed = run(2, 50, {
      path: '.github/workflows/nightly.yml',
      updated_at: ago(0.1),
    });
    const body = `<!-- station-qualification-health:${JSON.stringify({ failures: [], stalled: [{ id: 2, sourceSha: completed.head_sha, attempt: 1 }] })} -->`;
    const { result, writes } = await observe({
      issues: [{ ...issue, body }],
      retainedRuns: [completed],
    });
    expect(result.healthy).toBe(true);
    expect(writes[0].body).toEqual({
      state: 'closed',
      state_reason: 'completed',
    });
    await expect(
      observe({
        issues: [{ ...issue, body }],
        retainedRuns: [{ ...completed, run_attempt: 2 }],
      }),
    ).rejects.toThrow('Retained Nightly identity changed');
    await expect(
      observe({ issues: [{ ...issue, body }], retainedRuns: [] }),
    ).rejects.toThrow('HTTP 404');
  });

  it('closes the incident only after a fresh gate and recent actual job start', async () => {
    const { result, writes } = await observe();
    expect(result.healthy).toBe(true);
    expect(writes).toEqual([
      {
        method: 'PATCH',
        path: '/repos/owner/repo/issues/42',
        body: { state: 'closed', state_reason: 'completed' },
      },
    ]);
  });

  it('opens a P1 when schedules never start, including an empty history', async () => {
    const { result, writes } = await observe({ runs: [], issues: [] });
    expect(result.reasons).toHaveLength(2);
    expect(writes[0]).toMatchObject({
      method: 'POST',
      body: { state: 'open', labels: ['bug', 'P1'] },
    });
    expect(writes[0].body.body).toContain(
      'No qualification job has started within 8 hours',
    );
  });

  it('does not let a green run with a skipped gate close stale-success reporting', async () => {
    const { result, writes } = await observe({
      jobs: { 1: [gate({ conclusion: 'skipped' })] },
    });
    expect(result.healthy).toBe(false);
    expect(writes[0].body.state).toBe('open');
    expect(result.reasons[0]).toContain(
      'No successful source qualification within 14 hours',
    );
  });

  it('alerts on a stuck queue even when an earlier gate passed recently', async () => {
    const { result } = await observe({
      runs: [run(2, 4, { status: 'queued', conclusion: null }), run(1, 5)],
      jobs: { 1: [gate({ started_at: ago(5), completed_at: ago(4.5) })] },
    });
    expect(result.reasons).toEqual([
      'The latest qualification has remained queued or running for more than 3 hours.',
    ]);
  });

  it('keeps publication failure separate from passed source qualification', async () => {
    const { result } = await observe({
      runs: [run(1, 1, { conclusion: 'failure' })],
    });
    expect(result.reasons).toEqual([
      'A source gate passed, but its Nightly decision or publication did not complete successfully.',
    ]);
    expect(result.summary).toContain('Latest passing gate:');
  });

  it('does not mistake a long native build after a green gate for stuck qualification', async () => {
    const { result } = await observe({
      runs: [run(1, 4, { status: 'in_progress', conclusion: null })],
    });
    expect(result.healthy).toBe(true);
  });

  it('requires recent success even when failing jobs keep starting', async () => {
    const { result } = await observe({
      runs: [run(2, 1, { conclusion: 'failure' }), run(1, 16)],
      jobs: {
        1: [gate({ started_at: ago(16), completed_at: ago(15) })],
        2: [gate({ conclusion: 'failure', completed_at: ago(0.5) })],
      },
    });
    expect(result.reasons).toEqual([
      'No successful source qualification within 14 hours (conservative successful-source freshness bound).',
    ]);
  });

  it('keeps a publication incident open while a newer qualification is pending', async () => {
    const { result } = await observe({
      runs: [
        run(2, 0.25, { status: 'queued', conclusion: null }),
        run(1, 1, { conclusion: 'failure' }),
      ],
    });
    expect(result.reasons).toEqual([
      'A source gate passed, but its Nightly decision or publication did not complete successfully.',
    ]);
  });

  it('keeps a scheduled Nightly delivery failure separate from healthy full qualification', async () => {
    const { result } = await observe({
      manualRuns: [
        run(2, 1, {
          path: '.github/workflows/nightly.yml',
          event: 'schedule',
          conclusion: 'failure',
        }),
      ],
      jobs: {
        1: [gate()],
        2: [
          gate({ name: '1 · Source gate (lint, typecheck, browser smoke)' }),
          gate({
            name: '3 · Publish CLI to npm nightly',
            conclusion: 'failure',
          }),
        ],
      },
    });
    expect(result.healthy).toBe(false);
    expect(result.summary).toContain(
      'cli https://github.com/owner/repo/actions/runs/2',
    );
  });

  it('does not require the retired qualification-driven delivery setting', async () => {
    const { result } = await observe({ enabled: false });
    expect(result.reasons).toEqual([]);
  });

  it('does not clear a failed reservation when newer green qualification skips delivery', async () => {
    const { result } = await observe({
      runs: [run(2, 0.25), run(1, 1, { conclusion: 'failure' })],
      jobs: { 1: [gate()], 2: [gate()] },
    });
    expect(result.reasons).toEqual([
      'A source gate passed, but its Nightly decision or publication did not complete successfully.',
    ]);
  });

  it('resolves a failed native delivery only after a later successful native ledger job', async () => {
    const { result } = await observe({
      runs: [run(2, 0.25), run(1, 1, { conclusion: 'failure' })],
      jobs: {
        1: [gate()],
        2: [
          gate(),
          gate({
            name: 'nightly / 3 · Publish native cohort / Record ledger and markers',
          }),
        ],
      },
    });
    expect(result.healthy).toBe(true);
  });

  it('retains an unresolved delivery past the run lookback until actual publication', async () => {
    const { result } = await observe({
      issues: [
        {
          ...issue,
          body: '<!-- station-qualification-health:{"failures":[{"id":99,"at":"2026-10-01T01:00:00Z","legs":["native"]}]} -->',
        },
      ],
    });
    expect(result.healthy).toBe(false);
    expect(result.summary).toContain('/actions/runs/99');
  });

  it('allows a successful manual recovery to resolve the retained delivery', async () => {
    const { result } = await observe({
      issues: [
        {
          ...issue,
          body: '<!-- station-qualification-health:{"failures":[{"id":99,"at":"2026-10-01T01:00:00Z","legs":["native"]}]} -->',
        },
      ],
      manualRuns: [
        run(2, 1, {
          path: '.github/workflows/nightly.yml',
          event: 'workflow_dispatch',
        }),
      ],
      jobs: {
        1: [gate()],
        2: [
          gate({
            name: '3 · Publish native cohort / Record ledger and markers',
          }),
        ],
      },
    });
    expect(result.healthy).toBe(true);
  });

  it('resolves CLI-only failure with registry-bound CLI recovery while native is skipped', async () => {
    const { result } = await observe({
      runs: [run(1, 2, { conclusion: 'failure' })],
      manualRuns: [
        run(2, 1, {
          path: '.github/workflows/nightly.yml',
          event: 'workflow_dispatch',
        }),
      ],
      jobs: {
        1: [
          gate(),
          gate({
            name: 'nightly / 3 · Publish CLI to npm nightly',
            conclusion: 'failure',
          }),
        ],
        2: [
          {
            ...gate({ name: '3 · Publish CLI to npm nightly' }),
            steps: [
              {
                name: 'Bind the published CLI receipt to npm registry provenance',
                conclusion: 'success',
                status: 'completed',
              },
            ],
          },
        ],
      },
    });
    expect(result.healthy).toBe(true);
  });

  it('retains an older CLI failure when newer native failure alone recovers', async () => {
    const { result, writes } = await observe({
      issues: [
        {
          ...issue,
          body: '<!-- station-qualification-health:{"failures":[{"id":99,"at":"2026-10-01T01:00:00Z","legs":["cli"]}]} -->',
        },
      ],
      runs: [run(1, 2, { conclusion: 'failure' })],
      manualRuns: [
        run(2, 1, {
          path: '.github/workflows/nightly.yml',
          event: 'workflow_dispatch',
        }),
      ],
      jobs: {
        1: [gate()],
        2: [
          gate({
            name: '3 · Publish native cohort / Record ledger and markers',
          }),
        ],
      },
    });
    expect(result.healthy).toBe(false);
    expect(writes[0].body.body).toContain(
      'cli https://github.com/owner/repo/actions/runs/99',
    );
    expect(writes[0].body.body).not.toContain(
      'native https://github.com/owner/repo/actions/runs/1',
    );
  });

  it('accepts native terminal recovery from a run whose CLI leg failed', async () => {
    const { result, writes } = await observe({
      issues: [
        {
          ...issue,
          body: '<!-- station-qualification-health:{"failures":[{"id":99,"at":"2026-10-01T01:00:00Z","legs":["native"]}]} -->',
        },
      ],
      runs: [run(1, 1, { conclusion: 'failure' })],
      jobs: {
        1: [
          gate(),
          gate({
            name: 'nightly / 3 · Publish native cohort / Record ledger and markers',
          }),
          gate({
            name: 'nightly / 3 · Publish CLI to npm nightly',
            conclusion: 'failure',
          }),
        ],
      },
    });
    expect(result.healthy).toBe(false);
    expect(writes[0].body.body).toContain(
      'cli https://github.com/owner/repo/actions/runs/1',
    );
    expect(writes[0].body.body).not.toContain(
      'native https://github.com/owner/repo/actions/runs/99',
    );
  });

  it('accepts CLI terminal recovery from a manual run whose native leg failed', async () => {
    const { result } = await observe({
      issues: [
        {
          ...issue,
          body: '<!-- station-qualification-health:{"failures":[{"id":99,"at":"2026-10-01T01:00:00Z","legs":["cli"]}]} -->',
        },
      ],
      manualRuns: [
        run(2, 1, {
          path: '.github/workflows/nightly.yml',
          event: 'workflow_dispatch',
          conclusion: 'failure',
        }),
      ],
      jobs: {
        1: [gate()],
        2: [
          {
            ...gate({ name: '3 · Publish CLI to npm nightly' }),
            steps: [
              {
                name: 'Bind the published CLI receipt to npm registry provenance',
                conclusion: 'success',
                status: 'completed',
              },
            ],
          },
          gate({
            name: '3 · Publish native cohort / Record ledger and markers',
            conclusion: 'failure',
          }),
        ],
      },
    });
    expect(result.healthy).toBe(true);
  });

  it('ignores foreign repositories and green events outside canonical main', async () => {
    const { result, reads } = await observe({
      runs: [run(2, 1, { head_repository: { full_name: 'fork/repo' } })],
    });
    expect(result.healthy).toBe(false);
    expect(reads.some((path) => path.includes('/runs/2/'))).toBe(false);
  });

  it('fails a GitHub lookup without closing or replacing the tracker', async () => {
    await expect(observe({ failJobs: true })).rejects.toThrow('HTTP 503');
  });

  it('fails malformed success timestamps rather than reporting fresh evidence', async () => {
    await expect(
      observe({ jobs: { 1: [gate({ completed_at: 'invalid' })] } }),
    ).rejects.toThrow('Invalid qualification completion');
  });
});

describe('qualification watchdog workflow authority', () => {
  it('runs independently each hour, after qualification, and manually with read-only Actions access', () => {
    const workflow = load(
      readFileSync(
        resolve(
          import.meta.dirname,
          '../../.github/workflows/qualification-health.yml',
        ),
        'utf8',
      ),
    ) as {
      on: Record<string, unknown>;
      permissions: Record<string, string>;
      jobs: Record<
        string,
        { steps: { run?: string; with?: Record<string, unknown> }[] }
      >;
    };
    expect(workflow.on.schedule).toEqual([{ cron: '43 * * * *' }]);
    expect(workflow.on.workflow_run).toEqual({
      workflows: ['Main: Qualification'],
      types: ['completed'],
    });
    expect(Object.keys(workflow.on)).toContain('workflow_dispatch');
    expect(workflow.permissions).toEqual({
      contents: 'read',
      actions: 'read',
      issues: 'write',
    });
    expect(workflow.jobs.health.steps[0].with).toMatchObject({
      ref: `\${{ github.event.repository.default_branch }}`,
      'persist-credentials': false,
    });
    expect(
      workflow.jobs.health.steps
        .filter((step) => step.run)
        .map((step) => step.run),
    ).toEqual(['node scripts/qualification-health.mjs']);
  });
});
