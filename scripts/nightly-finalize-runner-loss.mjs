#!/usr/bin/env node
/**
 * Decides whether the native cohort's protected verifier may get a second
 * attempt in the same run: only when GitHub never gave its first attempt a
 * runner.
 *
 *     node scripts/nightly-finalize-runner-loss.mjs <jobs.json> <first-result>
 *
 * `<jobs.json>` is this run attempt's job list exactly as
 * `gh api --paginate --slurp repos/<repo>/actions/runs/<id>/attempts/<n>/jobs`
 * writes it (an array of pages, each `{ total_count, jobs }`), and
 * `<first-result>` is `needs.protected-finalize.result`. Writes
 * `runner_lost=true|false` to `$GITHUB_OUTPUT`.
 *
 * A first attempt that never started is one GitHub concluded `cancelled` with
 * no runner assigned and no step executed: the shape GitHub leaves when a
 * hosted job is "not acquired by Runner of type hosted even after multiple
 * attempts". Anything else — a verifier that ran and failed, ran and timed
 * out, or succeeded — is `runner_lost=false`, so a real verification verdict
 * is never retried. An answer this script cannot read (no such job, more than
 * one, a job still running) exits 1, and no second attempt runs.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';

/** The verifier job's display name; the Nightly caller prefixes `<caller> / `. */
export const FIRST_ATTEMPT_JOB_NAME = 'Verify providers and finalize';

const fail = (message) => {
  throw new Error(message);
};

/**
 * Flattens `gh api --paginate --slurp` pages of the run-attempt jobs listing,
 * refusing a listing that is not the whole attempt: every page must state the
 * same `total_count`, and the jobs read must number exactly that many.
 */
export function jobsFromPages(pages) {
  if (!Array.isArray(pages) || pages.length < 1)
    fail('jobs listing must be a non-empty array of pages');
  const totals = new Set(pages.map((page) => page?.total_count));
  const [total] = totals;
  if (totals.size !== 1 || !Number.isInteger(total) || total < 0)
    fail('jobs listing pages do not state one total_count');
  const jobs = pages.flatMap((page) => {
    if (!Array.isArray(page?.jobs)) fail('jobs listing page has no jobs array');
    return page.jobs;
  });
  if (jobs.length !== total)
    fail(
      `jobs listing holds ${jobs.length} job(s) but states total_count ${total}`,
    );
  return jobs;
}

/** True when `name` is the verifier job's name, alone or under its caller's prefix. */
function isFirstAttempt(name) {
  if (typeof name !== 'string') return false;
  if (name === FIRST_ATTEMPT_JOB_NAME) return true;
  const separator = name.lastIndexOf(' / ');
  return (
    separator > 0 &&
    name.slice(separator + 3) === FIRST_ATTEMPT_JOB_NAME &&
    !name.slice(0, separator).includes(' / ')
  );
}

/**
 * @param {{ jobs: unknown[], firstResult: string }} input
 * @returns {{ runnerLost: boolean, reason: string }}
 */
export function decideRunnerLoss({ jobs, firstResult }) {
  if (!Array.isArray(jobs)) fail('jobs must be an array');
  const matches = jobs.filter((job) => isFirstAttempt(job?.name));
  if (matches.length !== 1)
    fail(
      `expected exactly one "${FIRST_ATTEMPT_JOB_NAME}" job in this run attempt, found ${matches.length}`,
    );
  const [job] = matches;
  if (job.status !== 'completed')
    fail(`the first verifier attempt is ${job.status}, not completed`);
  if (firstResult !== job.conclusion)
    fail(
      `needs result ${firstResult} disagrees with the job's conclusion ${job.conclusion}`,
    );
  if (job.conclusion !== 'cancelled')
    return {
      runnerLost: false,
      reason: `the first verifier attempt concluded ${job.conclusion}`,
    };
  if (!Array.isArray(job.steps))
    fail('the first verifier attempt has no steps array');
  const runnerAssigned =
    (job.runner_id !== 0 && job.runner_id !== null) ||
    (typeof job.runner_name === 'string' && job.runner_name !== '');
  if (runnerAssigned || job.steps.length > 0)
    return {
      runnerLost: false,
      reason: `the first verifier attempt ran on runner ${JSON.stringify(job.runner_name)} with ${job.steps.length} step(s) before it was cancelled`,
    };
  return {
    runnerLost: true,
    reason: `GitHub cancelled job ${job.id} without assigning a runner or running a step`,
  };
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2)
    fail(
      'usage: nightly-finalize-runner-loss.mjs <jobs.json> <first-attempt-result>',
    );
  const [jobsPath, firstResult] = argv;
  const decision = decideRunnerLoss({
    jobs: jobsFromPages(JSON.parse(readFileSync(jobsPath, 'utf8'))),
    firstResult,
  });
  const output = process.env.GITHUB_OUTPUT;
  if (!output) fail('GITHUB_OUTPUT is required');
  appendFileSync(output, `runner_lost=${decision.runnerLost}\n`);
  process.stdout.write(
    `${decision.runnerLost ? '' : '::notice::No second verifier attempt: '}${decision.reason}\n`,
  );
}

if (invokedDirectly(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 1;
  }
}
