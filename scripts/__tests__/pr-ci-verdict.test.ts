import { describe, expect, test } from 'vitest';
import { requirePullRequestVerdict } from '../pr-ci-verdict.mjs';

const repository = 'kontourai/station';
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const event = { pull_request: { number: 42, head: { sha: head } } };
const live = {
  title: 'fix(ci): preserve source checks',
  head: { sha: head, repo: { full_name: repository } },
  base: { ref: 'main', sha: base },
};
const source = {
  id: 100,
  run_attempt: 1,
  status: 'completed',
  display_title: `ci-pr-42-${head}-main-${base}-source`,
};
const success = {
  name: 'fast-checks source',
  status: 'completed',
  conclusion: 'success',
};

function api({
  pulls = [live],
  runs = [[source]],
  jobs = [[success]],
}: {
  pulls?: unknown[];
  runs?: unknown[][];
  jobs?: unknown[][];
} = {}) {
  const calls: string[] = [];
  const read = (values: unknown[]) =>
    values.length > 1 ? values.shift() : values[0];
  const request = async (path: string) => {
    calls.push(path);
    if (path.endsWith('/pulls/42')) return read(pulls);
    if (path.includes('/workflows/ci.yml/runs?'))
      return { workflow_runs: read(runs) };
    if (path.includes('/attempts/')) return { jobs: read(jobs) };
    throw new Error(`Unexpected API path: ${path}`);
  };
  let clock = 0;
  return {
    calls,
    options: {
      repository,
      event,
      request,
      now: () => clock,
      wait: async (ms: number) => {
        clock += ms;
      },
      timeoutMs: 30_000,
    },
  };
}

describe('required PR metadata verdict', () => {
  test('title correction uses live metadata and exact source work without re-executing it', async () => {
    const fixture = api();
    const result = await requirePullRequestVerdict({
      ...fixture.options,
      event: {
        ...event,
        pull_request: {
          ...event.pull_request,
          title: 'invalid delayed event title',
        },
      },
    });
    expect(result).toEqual({ runId: 100, runAttempt: 1, head });
    expect(fixture.calls).toContain(
      'repos/kontourai/station/actions/runs/100/attempts/1/jobs?per_page=100&page=1',
    );
    expect(fixture.calls.every((path) => !path.includes('artifacts'))).toBe(
      true,
    );
  });

  test.each(['failure', 'cancelled', 'skipped', 'timed_out'])(
    'metadata cannot clear a %s source aggregate',
    async (conclusion) => {
      const fixture = api({ jobs: [[{ ...success, conclusion }]] });
      await expect(requirePullRequestVerdict(fixture.options)).rejects.toThrow(
        `Source aggregate 100/1: ${conclusion}`,
      );
    },
  );

  test.each([
    `ci-pr-43-${head}-main-${base}-source`,
    `ci-pr-42-${'c'.repeat(40)}-main-${base}-source`,
    `ci-pr-42-${head}-release-${base}-source`,
    `ci-pr-42-${head}-main-${base}-metadata`,
    `ci-pr-42-${head}-main-forged-source`,
  ])(
    'refuses evidence with another routing identity: %s',
    async (display_title) => {
      const fixture = api({ runs: [[{ ...source, display_title }]] });
      await expect(requirePullRequestVerdict(fixture.options)).rejects.toThrow(
        'Timed out waiting for exact source checks',
      );
      expect(fixture.calls.some((path) => path.includes('/attempts/'))).toBe(
        false,
      );
    },
  );

  test('waits for active source checks rather than treating absence as success', async () => {
    const fixture = api({
      runs: [[{ ...source, status: 'in_progress' }], [source]],
      jobs: [
        [{ ...success, status: 'in_progress', conclusion: null }],
        [success],
      ],
    });
    await expect(
      requirePullRequestVerdict(fixture.options),
    ).resolves.toMatchObject({ runId: 100 });
  });

  test('does not reuse older green work when a newer source run fails', async () => {
    const fixture = api({
      runs: [[{ ...source, id: 101 }, source]],
      jobs: [[{ ...success, conclusion: 'failure' }]],
    });
    await expect(requirePullRequestVerdict(fixture.options)).rejects.toThrow(
      'Source aggregate 101/1: failure',
    );
  });

  test('rechecks the current attempt when a rerun overtakes a green observation', async () => {
    const fixture = api({
      runs: [[source], [{ ...source, run_attempt: 2 }]],
      jobs: [[success], [{ ...success, conclusion: 'failure' }]],
    });
    await expect(requirePullRequestVerdict(fixture.options)).rejects.toThrow(
      'Source aggregate 100/2: failure',
    );
  });

  test('a title made invalid while source work completes cannot pass', async () => {
    const fixture = api({ pulls: [live, { ...live, title: 'invalid' }] });
    await expect(requirePullRequestVerdict(fixture.options)).rejects.toThrow(
      'Pull-request title:',
    );
  });

  test.each([
    { ...live, head: { ...live.head, sha: 'c'.repeat(40) } },
    { ...live, base: { ...live.base, ref: 'release' } },
  ])('rejects a moved live head or target', async (pr) => {
    const fixture = api({ pulls: [pr] });
    await expect(requirePullRequestVerdict(fixture.options)).rejects.toThrow(
      'another head or target',
    );
  });

  test('advancing main preserves exact source evidence under the non-strict ruleset', async () => {
    const fixture = api({
      pulls: [{ ...live, base: { ...live.base, sha: 'c'.repeat(40) } }],
    });
    await expect(
      requirePullRequestVerdict(fixture.options),
    ).resolves.toMatchObject({ runId: 100 });
  });

  test('fork title correction requires successful isolated fork source work', async () => {
    const fixture = api({
      pulls: [
        {
          ...live,
          head: { ...live.head, repo: { full_name: 'fork/station' } },
        },
      ],
      jobs: [[{ ...success, name: 'Fork pull-request smoke' }]],
    });
    await expect(
      requirePullRequestVerdict(fixture.options),
    ).resolves.toMatchObject({ runId: 100 });
  });

  test('missing and ambiguous source aggregates fail closed', async () => {
    for (const jobs of [[], [success, success]]) {
      const fixture = api({ jobs: [jobs] });
      await expect(requirePullRequestVerdict(fixture.options)).rejects.toThrow(
        /no successful source aggregate|Ambiguous/,
      );
    }
  });
});
