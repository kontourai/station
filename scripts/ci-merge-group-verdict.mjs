#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';

/**
 * Should a push to main skip the heavy `PR: CI` lane because the merge queue
 * already verified this exact commit?
 *
 * The merge queue fast-forwards main to the candidate it tested, so a queue
 * landing's push re-runs fast-checks on a SHA whose merge-group run already
 * passed (about 4 of 105 runner-hours in a measured busy six-hour window).
 * A push is treated as verified only when every link holds:
 *
 * - the newest `merge_group` run of ci.yml for this exact head SHA, in this
 *   repository, completed with `success`;
 * - its queue branch names the push's `before` as its base, so the push
 *   diff is exactly the diff that run planned and tested (a push carrying
 *   several queue entries falls back to the full run);
 * - in that run attempt, the `fast-checks` aggregate and the required
 *   `Merge-queue regression` job each concluded `success`.
 *
 * Anything else (direct or admin pushes, batches, an API error, a timeout,
 * pagination it cannot see past, an unexpected shape) answers `verified:
 * false`, which keeps the classifier's verdict and runs the full lane. Skipping
 * is only a cost saving, so uncertainty must never skip verification.
 */

const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const QUEUE_BRANCH =
  /^gh-readonly-queue\/main\/pr-([1-9][0-9]*)-([0-9a-f]{40})$/;
const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
export const VERDICT_JOBS = Object.freeze([
  'fast-checks',
  'Merge-queue regression',
]);

const unverified = (reason) => ({ verified: false, reason });

/** A bounded, authenticated GitHub REST GET; any non-2xx response throws. */
export function githubRequest({
  token,
  fetchImpl = fetch,
  apiUrl,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const base = (apiUrl || 'https://api.github.com').replace(/\/+$/, '');
  return async (path) => {
    const response = await fetchImpl(`${base}/${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
      throw new Error(`GitHub ${path} responded ${response.status}`);
    return response.json();
  };
}

function newestFirst(left, right) {
  const byTime = Date.parse(right.created_at) - Date.parse(left.created_at);
  return byTime !== 0 && Number.isFinite(byTime)
    ? byTime
    : Number(right.id) - Number(left.id);
}

/** Decide from the GitHub API; throws only through `request`. */
export async function findMergeGroupVerdict({
  sha,
  before,
  repository,
  request,
}) {
  if (!SHA.test(sha ?? '')) return unverified('invalid-sha');
  if (!SHA.test(before ?? '')) return unverified('invalid-before');
  if (!REPOSITORY.test(repository ?? ''))
    return unverified('invalid-repository');

  const listing = await request(
    `repos/${repository}/actions/workflows/ci.yml/runs?event=merge_group&head_sha=${sha}&per_page=${PAGE_SIZE}`,
  );
  const runs = listing?.workflow_runs;
  if (!Array.isArray(runs) || !Number.isInteger(listing.total_count))
    return unverified('malformed-run-listing');
  if (listing.total_count > runs.length)
    return unverified('run-listing-truncated');
  const candidates = runs.filter(
    (run) =>
      run?.head_sha === sha &&
      run.event === 'merge_group' &&
      run.path === CI_WORKFLOW_PATH &&
      run.repository?.full_name === repository &&
      run.head_repository?.full_name === repository,
  );
  if (candidates.length === 0) return unverified('no-merge-group-run');
  const [run] = [...candidates].sort(newestFirst);
  if (run.status !== 'completed' || run.conclusion !== 'success')
    return unverified(`merge-group-run-${run.status}-${run.conclusion}`);

  const queue = QUEUE_BRANCH.exec(run.head_branch ?? '');
  if (!queue) return unverified('unrecognized-queue-branch');
  if (queue[2] !== before)
    return unverified('queue-base-differs-from-push-before');

  if (
    !Number.isInteger(run.id) ||
    !Number.isInteger(run.run_attempt) ||
    run.run_attempt < 1
  )
    return unverified('malformed-run-identity');
  const attempt = await request(
    `repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=${PAGE_SIZE}`,
  );
  const jobs = attempt?.jobs;
  if (!Array.isArray(jobs) || !Number.isInteger(attempt.total_count))
    return unverified('malformed-job-listing');
  if (attempt.total_count > jobs.length)
    return unverified('job-listing-truncated');
  for (const name of VERDICT_JOBS) {
    const named = jobs.filter((job) => job?.name === name);
    if (named.length !== 1)
      return unverified(`required-job-count-${named.length}:${name}`);
    if (named[0].status !== 'completed' || named[0].conclusion !== 'success')
      return unverified(`required-job-not-success:${name}`);
  }
  return {
    verified: true,
    reason: `merge-group-run:${run.id}/attempt:${run.run_attempt}`,
  };
}

/**
 * The workflow step: never throws and never exits nonzero. It writes
 * `verified` and `reason` to GITHUB_OUTPUT; only `verified=true` skips work.
 */
export async function runVerdictStep({
  env = process.env,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  let result;
  try {
    if (
      env.GITHUB_EVENT_NAME !== 'push' ||
      env.GITHUB_REF !== 'refs/heads/main'
    ) {
      result = unverified('not-a-main-push');
    } else {
      result = await findMergeGroupVerdict({
        sha: env.GITHUB_SHA,
        before: env.PUSH_BEFORE,
        repository: env.GITHUB_REPOSITORY,
        request: githubRequest({
          token: env.GH_TOKEN,
          fetchImpl,
          apiUrl: env.GITHUB_API_URL,
        }),
      });
    }
  } catch (error) {
    result = unverified(`lookup-failed: ${error?.message ?? String(error)}`);
  }
  // A step output is one line; a multi-line reason must not forge another key.
  const reason = result.reason.replace(/[\r\n]+/g, ' ');
  // Only the answers an ordinary push can produce stay a notice: a direct or
  // bot push with no queue run, a queue run that did not succeed, a queue
  // base that is not this push's parent. Every other reason (a refused or
  // unreadable lookup, an unexpected body, a truncated listing, a renamed
  // required job) would repeat on every push and end the saving unnoticed,
  // so it still fails closed but as a warning.
  const lookupBroken =
    !result.verified &&
    !/^(?:not-a-main-push$|no-merge-group-run$|queue-base-differs-from-push-before$|merge-group-run-|required-job-not-success:)/.test(
      reason,
    );
  log(
    result.verified
      ? `::notice::Merge queue already verified this exact SHA (${reason}); the heavy push lane is skipped.`
      : lookupBroken
        ? `::warning title=Merge-queue verdict lookup failed::Could not read the merge-queue verdict (${reason.replaceAll('%', '%25')}); the push runs the classifier's full lane.`
        : `::notice::No reusable merge-queue verdict (${reason}); the push runs the classifier's full lane.`,
  );
  if (env.GITHUB_OUTPUT)
    appendFileSync(
      env.GITHUB_OUTPUT,
      `verified=${result.verified}\nreason=${reason}\n`,
    );
  return { verified: result.verified, reason };
}

if (invokedDirectly(import.meta.url)) await runVerdictStep();
