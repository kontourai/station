import { describe, expect, it } from 'vitest';
import { readWorkflowDocuments } from '../actionlint-gate.mjs';
import {
  lastSmokedSha,
  runRangeStep,
  ZERO_SHA,
} from '../container-smoke-range.mjs';

const REPO = 'kontourai/station';
const sha = (c: string) => c.repeat(40);

/** Real-shaped `actions/workflows/.../runs` entries. */
function run(id: number, headSha: string, createdAt: string) {
  return {
    id,
    run_attempt: 1,
    path: '.github/workflows/container-smoke.yml',
    head_branch: 'main',
    head_sha: headSha,
    status: 'completed',
    conclusion: 'success',
    created_at: createdAt,
  };
}

function api(runs: ReturnType<typeof run>[], smoke: Record<number, string>) {
  const paths: string[] = [];
  const request = async (path: string) => {
    paths.push(path);
    if (path.includes('/workflows/container-smoke.yml/runs'))
      return { total_count: runs.length, workflow_runs: runs };
    const id = Number(/runs\/(\d+)\/attempts/.exec(path)?.[1]);
    return {
      total_count: 2,
      jobs: [
        { name: 'Exact full-diff classification', conclusion: 'success' },
        { name: 'smoke', conclusion: smoke[id] ?? 'skipped' },
      ],
    };
  };
  return { request, paths };
}

describe('container smoke range', () => {
  it('starts from the newest run whose smoke job passed, passing over skipped smokes', async () => {
    const { request } = api(
      [
        run(3, sha('c'), '2026-11-16T18:07:00Z'),
        run(2, sha('b'), '2026-11-16T12:07:00Z'),
        run(1, sha('a'), '2026-11-16T06:07:00Z'),
      ],
      { 2: 'success', 1: 'success' },
    );
    expect(await lastSmokedSha({ repository: REPO, request })).toEqual({
      sha: sha('b'),
      reason: 'last-green-smoke:2',
    });
  });

  it('ignores the run asking', async () => {
    const { request } = api([run(5, sha('e'), '2026-11-16T18:07:00Z')], {
      5: 'success',
    });
    expect(
      (await lastSmokedSha({ repository: REPO, currentRunId: 5, request })).sha,
    ).toBe(ZERO_SHA);
  });

  it('fails closed to the zero SHA, which the classifier turns into a smoke run', async () => {
    const { request } = api([run(1, sha('a'), '2026-11-16T06:07:00Z')], {});
    expect((await lastSmokedSha({ repository: REPO, request })).sha).toBe(
      ZERO_SHA,
    );
    const lines: string[] = [];
    const result = await runRangeStep({
      env: { GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: '9' },
      fetchImpl: (async () => ({
        ok: false,
        status: 502,
      })) as unknown as typeof fetch,
      log: (line: string) => lines.push(line),
    });
    expect(result.sha).toBe(ZERO_SHA);
    expect(lines.join('\n')).toContain('the smoke runs');
  });

  it('runs on a six-hour cadence over the range since the last green smoke, never per push', () => {
    const document = readWorkflowDocuments().find(
      ({ file }) => file === '.github/workflows/container-smoke.yml',
    )?.document as {
      on: Record<string, unknown>;
      jobs: Record<
        string,
        {
          permissions?: unknown;
          steps?: { id?: string; run?: string; env?: Record<string, string> }[];
        }
      >;
    };
    expect(Object.keys(document.on).sort()).toEqual([
      'schedule',
      'workflow_dispatch',
    ]);
    expect(document.on.schedule).toEqual([{ cron: '7 */6 * * *' }]);
    const steps = document.jobs.classify.steps ?? [];
    const range = steps.find((step) => step.id === 'range');
    const classify = steps.find((step) => step.id === 'classify');
    expect(range?.run).toBe('node scripts/container-smoke-range.mjs');
    expect(classify?.env?.BEFORE).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      '${{ steps.range.outputs.before }}',
    );
    expect(document.jobs.classify.permissions).toEqual({
      contents: 'read',
      actions: 'read',
    });
  });
});
