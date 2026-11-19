#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { githubRequest } from './ci-merge-group-verdict.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

/**
 * May Nightly's source gate (`test-gate` in nightly.yml) accept the merge
 * queue's run of the same checks instead of repeating them?
 *
 * The merge queue fast-forwards main to the exact candidate it tested, and
 * that candidate's `merge_group` run of ci.yml runs `fast-checks statics`:
 * `npm run ci:fast` with STATION_CI_FAST_SCOPE=statics (whose fixed command
 * list includes the native platform ratchet, lint, build:connect and the
 * typecheck aggregate) and then `npm run test:e2e:pr-smoke` with the bundle
 * budget enforced. That is every check the Nightly gate runs, on the same
 * tree. The receipt is accepted only when every link holds:
 *
 * - exactly one `merge_group` run of .github/workflows/ci.yml exists for this
 *   exact head SHA, in this repository, from a `gh-readonly-queue/main/`
 *   branch, completed with `success`;
 * - in that run attempt, exactly one `fast-checks statics` job, bound to the
 *   same run, attempt and SHA, completed with `success`;
 * - in that job, the ci:fast lane step and the browser-journey step each
 *   completed with `success` (a skipped step is not a pass).
 *
 * A ledger-only commit on top of a tested commit is not accepted: tests read
 * the deploy ledger, so a pass on an ancestor that differs in it never counts
 * (see ledgerEquivalentSources in qualification-evidence.mjs). Anything else
 * (no queue run, several, an API error, a timeout, a truncated listing, an
 * unexpected shape) answers `accepted: false`, and the gate runs in full.
 */

const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const QUEUE_BRANCH = /^gh-readonly-queue\/main\/pr-[1-9][0-9]*-[0-9a-f]{40}$/;
const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';
const PAGE_SIZE = 100;
export const STATICS_JOB = 'fast-checks statics';
export const RECEIPT_STEPS = Object.freeze([
  'Run fast CI lane',
  'Verify critical browser journeys before merge',
]);

const refused = (reason) => ({ accepted: false, reason });

/**
 * The one merge-queue run a receipt may name, or the reason there is none.
 * The listing is filtered by the server; an entry that does not match the
 * filter means the response is not what this decision was written for.
 */
function queueRun(listing, { sha, repository }) {
  const runs = listing?.workflow_runs;
  if (!Array.isArray(runs) || !Number.isInteger(listing.total_count))
    return 'malformed-run-listing';
  if (listing.total_count !== runs.length) return 'run-listing-truncated';
  if (runs.length === 0) return 'no-merge-group-run';
  const foreign = (run) =>
    run?.head_sha !== sha ||
    run.event !== 'merge_group' ||
    run.path !== CI_WORKFLOW_PATH ||
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository;
  if (runs.some(foreign)) return 'unexpected-run-in-listing';
  // One merge group per SHA is the normal case; several cannot be reconciled
  // here, so the gate runs.
  if (runs.length !== 1) return `merge-group-runs-${runs.length}`;
  const [run] = runs;
  if (run.status !== 'completed' || run.conclusion !== 'success')
    return `merge-group-run-${run.status}-${run.conclusion}`;
  if (!QUEUE_BRANCH.test(run.head_branch ?? ''))
    return 'unrecognized-queue-branch';
  const identified =
    Number.isSafeInteger(run.id) &&
    Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt >= 1;
  return identified ? run : 'malformed-run-identity';
}

/** Why that attempt's statics job is not a receipt, or '' when it is. */
function staticsRefusal(attempt, run, sha) {
  const jobs = attempt?.jobs;
  if (!Array.isArray(jobs) || !Number.isInteger(attempt.total_count))
    return 'malformed-job-listing';
  if (attempt.total_count !== jobs.length) return 'job-listing-truncated';
  const statics = jobs.filter((job) => job?.name === STATICS_JOB);
  if (statics.length !== 1) return `statics-job-count-${statics.length}`;
  const [job] = statics;
  if (
    job.run_id !== run.id ||
    job.run_attempt !== run.run_attempt ||
    job.head_sha !== sha
  )
    return 'statics-job-identity';
  if (job.status !== 'completed' || job.conclusion !== 'success')
    return `statics-job-${job.status}-${job.conclusion}`;
  if (!Array.isArray(job.steps)) return 'malformed-statics-steps';
  for (const name of RECEIPT_STEPS) {
    const named = job.steps.filter((step) => step?.name === name);
    if (named.length !== 1) return `statics-step-count-${named.length}:${name}`;
    if (named[0].status !== 'completed' || named[0].conclusion !== 'success')
      return `statics-step-${named[0].conclusion}:${name}`;
  }
  return '';
}

/** Decide from the GitHub API; throws only through `request`. */
export async function findSourceGateReceipt({ sha, repository, request }) {
  if (!SHA.test(sha ?? '')) return refused('invalid-sha');
  if (!REPOSITORY.test(repository ?? '')) return refused('invalid-repository');
  const run = queueRun(
    await request(
      `repos/${repository}/actions/workflows/ci.yml/runs?event=merge_group&head_sha=${sha}&per_page=${PAGE_SIZE}`,
    ),
    { sha, repository },
  );
  if (typeof run === 'string') return refused(run);
  const refusal = staticsRefusal(
    await request(
      `repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=${PAGE_SIZE}`,
    ),
    run,
    sha,
  );
  if (refusal) return refused(refusal);
  return {
    accepted: true,
    reason: `merge-group-run:${run.id}/attempt:${run.run_attempt}`,
    runId: run.id,
    runAttempt: run.run_attempt,
  };
}

/**
 * The workflow step: never throws and never exits nonzero. It writes
 * `accepted` and `reason` to GITHUB_OUTPUT; only `accepted=true` lets the
 * gate skip its own checks. It also writes `run_url` when accepted.
 */
export async function runReceiptStep({
  env = process.env,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  let result;
  try {
    if (
      !['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) ||
      env.GITHUB_REF !== 'refs/heads/main'
    ) {
      result = refused('not-a-main-nightly');
    } else if (env.SOURCE_SHA !== env.GITHUB_SHA) {
      result = refused('source-is-not-the-event-sha');
    } else {
      result = await findSourceGateReceipt({
        sha: env.SOURCE_SHA,
        repository: env.GITHUB_REPOSITORY,
        request: githubRequest({
          token: env.GH_TOKEN,
          fetchImpl,
          apiUrl: env.GITHUB_API_URL,
        }),
      });
    }
  } catch (error) {
    result = refused(`lookup-failed: ${error?.message ?? String(error)}`);
  }
  // A step output is one line; a multi-line reason must not forge another key.
  const reason = result.reason.replace(/[\r\n]+/g, ' ');
  const server = (env.GITHUB_SERVER_URL || 'https://github.com').replace(
    /\/+$/,
    '',
  );
  const runUrl = result.accepted
    ? `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${result.runId}/attempts/${result.runAttempt}`
    : '';
  const message = result.accepted
    ? `Source gate accepted from the merge queue's fast-checks statics on this exact SHA: ${runUrl}. Lint, typecheck, the native platform ratchet and browser smoke are not repeated.`
    : `No merge-queue source gate receipt for this exact SHA (${reason}); the source gate runs in full.`;
  log(`::notice title=Nightly source gate::${message.replaceAll('%', '%25')}`);
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${message}\n`);
  if (env.GITHUB_OUTPUT)
    appendFileSync(
      env.GITHUB_OUTPUT,
      `accepted=${result.accepted}\nreason=${reason}\n${result.accepted ? `run_url=${runUrl}\n` : ''}`,
    );
  return { accepted: result.accepted, reason };
}

if (invokedDirectly(import.meta.url)) await runReceiptStep();
