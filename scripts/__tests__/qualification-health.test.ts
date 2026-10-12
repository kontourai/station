import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
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
  failJobs = false,
  enabled = true,
}: {
  runs?: ReturnType<typeof run>[];
  jobs?: Record<
    number,
    (ReturnType<typeof gate> & {
      steps?: { name: string; conclusion: string }[];
    })[]
  >;
  issues?: (typeof issue)[];
  manualRuns?: ReturnType<typeof run>[];
  failJobs?: boolean;
  enabled?: boolean;
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
    if (path.endsWith('/runs'))
      response.end(
        JSON.stringify({
          workflow_runs: path.includes('/nightly.yml/') ? manualRuns : runs,
        }),
      );
    else if (path.endsWith('/jobs')) {
      if (failJobs) {
        response.writeHead(503);
        response.end('{}');
        return;
      }
      const id = Number(path.split('/').at(-2));
      response.end(JSON.stringify({ jobs: jobs[id] ?? [] }));
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
      NOW,
    );
    return { result, writes, reads };
  } finally {
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
}

describe('qualification health through the GitHub API', () => {
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
      'Source qualification passed, but its Nightly decision or publication did not complete successfully.',
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
      'Source qualification passed, but its Nightly decision or publication did not complete successfully.',
    ]);
  });

  it('reports disabled delivery even when source qualification is healthy', async () => {
    const { result } = await observe({ enabled: false });
    expect(result.reasons).toEqual([
      'Qualification-driven Nightly delivery is disabled (STATION_QUALIFIED_NIGHTLY must be enabled).',
    ]);
  });

  it('does not clear a failed reservation when newer green qualification skips delivery', async () => {
    const { result } = await observe({
      runs: [run(2, 0.25), run(1, 1, { conclusion: 'failure' })],
      jobs: { 1: [gate()], 2: [gate()] },
    });
    expect(result.reasons).toEqual([
      'Source qualification passed, but its Nightly decision or publication did not complete successfully.',
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
    expect(reads.some((path) => path.endsWith('/jobs'))).toBe(false);
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
