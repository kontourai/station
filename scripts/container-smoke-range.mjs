#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { githubRequest } from './ci-merge-group-verdict.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

/**
 * The start of the range a cadence-run container smoke must cover: the head
 * SHA of the newest `Main: Container smoke` run whose `smoke` job itself
 * succeeded. A run that skipped the smoke (nothing container-relevant) proves
 * nothing and is passed over, so a skip never moves the baseline forward.
 *
 * The answer is a starting point for scripts/classify-ci-change.mjs, which
 * fails closed (runs the smoke) on the zero SHA, so every way of not knowing
 * — no green smoke in the newest MAX_RUNS runs, an unreadable listing — runs
 * the smoke rather than skipping it.
 */

export const ZERO_SHA = '0'.repeat(40);
export const MAX_RUNS = 50;
const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_PATH = '.github/workflows/container-smoke.yml';

/**
 * @param {{repository: string, currentRunId?: number, request: (path: string) => Promise<any>, maxRuns?: number}} input
 * @returns {Promise<{sha: string, reason: string}>}
 */
export async function lastSmokedSha({
  repository,
  currentRunId,
  request,
  maxRuns = MAX_RUNS,
}) {
  if (!REPOSITORY.test(repository ?? ''))
    return { sha: ZERO_SHA, reason: 'invalid-repository' };
  const listing = await request(
    `repos/${repository}/actions/workflows/container-smoke.yml/runs?branch=main&status=success&per_page=${maxRuns}`,
  );
  const runs = listing?.workflow_runs;
  if (!Array.isArray(runs))
    return { sha: ZERO_SHA, reason: 'malformed-run-listing' };
  const candidates = runs
    .filter(
      (run) =>
        run?.id !== currentRunId &&
        run?.path === WORKFLOW_PATH &&
        run?.head_branch === 'main' &&
        run?.conclusion === 'success' &&
        SHA.test(run?.head_sha ?? ''),
    )
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  for (const run of candidates) {
    const attempt = await request(
      `repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
    );
    const smoke = (attempt?.jobs ?? []).filter((job) => job?.name === 'smoke');
    if (smoke.length === 1 && smoke[0].conclusion === 'success')
      return { sha: run.head_sha, reason: `last-green-smoke:${run.id}` };
  }
  return { sha: ZERO_SHA, reason: `no-green-smoke-in-${runs.length}-runs` };
}

/** Workflow step: writes `before=<sha>`; any lookup failure becomes the zero SHA. */
export async function runRangeStep({
  env = process.env,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  let result;
  try {
    result = await lastSmokedSha({
      repository: env.GITHUB_REPOSITORY,
      currentRunId: Number(env.GITHUB_RUN_ID),
      request: githubRequest({
        token: env.GH_TOKEN,
        fetchImpl,
        apiUrl: env.GITHUB_API_URL,
      }),
    });
  } catch (error) {
    result = {
      sha: ZERO_SHA,
      reason: `lookup-failed: ${String(error?.message ?? error).replace(/[\r\n]+/g, ' ')}`,
    };
  }
  log(
    result.sha === ZERO_SHA
      ? `::warning title=Container smoke baseline unknown::${result.reason}; the smoke runs.`
      : `::notice::Container smoke covers ${result.sha}..HEAD (${result.reason}).`,
  );
  if (env.GITHUB_OUTPUT)
    appendFileSync(env.GITHUB_OUTPUT, `before=${result.sha}\n`);
  return result;
}

if (invokedDirectly(import.meta.url)) await runRangeStep();
