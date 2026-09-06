#!/usr/bin/env node
/**
 * Assert that a scheduled workflow has actually CONCLUDED SUCCESS recently.
 *
 * ## Why a derivation and not a listener
 *
 * `nightly-gallery.yml` produced no signal for eight days (#1645). Its job
 * could not reach a runner at all — every cancelled run carries
 * `runner_name: ""` and `steps: 0`, so not one step ever executed — and the
 * runs were then closed either by GitHub's 24h queue timeout or by the next
 * night's run. `cancelled` is not `failure`: it renders neutral, notifies
 * nobody, and `main-health.yml`'s `workflow_run` listener (which keys on
 * `conclusion == 'failure'`) never fires for it. The gate was unenforceable
 * and looked exactly like a gate nobody had needed to think about.
 *
 * A listener cannot close that hole, because the hole is the ABSENCE of a
 * verdict. Every silence mode — queued until timeout, cancelled, the workflow
 * disabled, the schedule dropped, a runner-group allow-list that stops
 * admitting the job — produces no event this repository would act on. So the
 * check has to be a derivation over observed state: read the run history and
 * decide whether a real success is recent enough.
 *
 * ## What counts as a success
 *
 * Not the run's own conclusion. `main-health.yml` already learned that a run
 * conclusion of `success` is not evidence the gate ran, because a skipped
 * conditional job leaves the RUN green; closing a tracker on that asserts a
 * green that never happened. The same reasoning applies in reverse here, so a
 * candidate run qualifies only with job evidence attached: at least one job
 * concluded `success` and no job was `skipped`. A run whose jobs were not
 * supplied is NOT eligible — absence of job data is not evidence the gate ran,
 * and the alternative (assume the run was fine) is the fail-open this module
 * exists to prevent.
 *
 * ## Exit codes
 *
 * 0 fresh, 1 stale. Stale is a real failure: this workflow is watched by
 * `main-health.yml`, which files and later closes the P1 tracker, so the
 * reporting machinery is the one the repository already uses rather than a
 * second implementation of it.
 *
 * The remaining gap, stated rather than papered over: nothing detects THIS
 * check going silent the way the gallery did. A third layer would have the
 * same gap one level up. It runs on a hosted runner precisely so that it
 * cannot be silenced by the fleet-side conditions it exists to notice.
 */

import { readFileSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';

const DEFAULT_MAX_AGE_HOURS = 36;
const DEFAULT_RUN_PAGE_SIZE = 20;

/**
 * Parse an ISO-8601 instant, fail-closed.
 * @param {unknown} value
 * @param {string} label
 * @returns {number} epoch milliseconds
 */
export function parseInstant(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is missing`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} is not an ISO-8601 instant: '${value}'`);
  }
  return parsed;
}

/**
 * Does this run carry evidence that the gate actually executed?
 *
 * `jobs` is the run's job list, or `undefined` when it was not fetched.
 * @param {{status?: unknown, conclusion?: unknown, head_branch?: unknown}} run
 * @param {{conclusion?: unknown}[] | undefined} jobs
 * @param {string} branch
 * @returns {{eligible: boolean, reason: string}}
 */
export function classifyRunEvidence(run, jobs, branch) {
  if (!run || typeof run !== 'object') {
    throw new Error('run is not an object');
  }
  if (run.head_branch !== branch) {
    return { eligible: false, reason: 'other-branch' };
  }
  if (run.status !== 'completed') {
    return { eligible: false, reason: 'not-completed' };
  }
  if (run.conclusion !== 'success') {
    return { eligible: false, reason: `conclusion-${String(run.conclusion)}` };
  }
  if (jobs === undefined) {
    return { eligible: false, reason: 'job-evidence-missing' };
  }
  if (!Array.isArray(jobs)) {
    throw new Error('run job evidence is not an array');
  }
  if (jobs.some((job) => job?.conclusion === 'skipped')) {
    return { eligible: false, reason: 'job-skipped' };
  }
  if (!jobs.some((job) => job?.conclusion === 'success')) {
    return { eligible: false, reason: 'no-successful-job' };
  }
  return { eligible: true, reason: 'executed' };
}

/**
 * @param {{
 *   runs: unknown[],
 *   jobsByRunId?: Map<number, {conclusion?: unknown}[]> | Record<string, {conclusion?: unknown}[]>,
 *   maxAgeMs: number,
 *   now: number,
 *   branch?: string,
 * }} input
 */
export function evaluateWorkflowFreshness({
  runs,
  jobsByRunId,
  maxAgeMs,
  now,
  branch = 'main',
}) {
  if (!Array.isArray(runs)) throw new Error('runs is not an array');
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error('maxAgeMs must be a positive number of milliseconds');
  }
  if (!Number.isFinite(now)) throw new Error('now must be epoch milliseconds');

  const jobsFor = (runId) => {
    if (!jobsByRunId) return undefined;
    if (jobsByRunId instanceof Map) return jobsByRunId.get(runId);
    return jobsByRunId[String(runId)];
  };

  const rejected = [];
  let newest = null;
  for (const run of runs) {
    const { eligible, reason } = classifyRunEvidence(
      run,
      jobsFor(run?.id),
      branch,
    );
    if (!eligible) {
      rejected.push({ id: run?.id, reason });
      continue;
    }
    const concludedAt = parseInstant(
      run.updated_at,
      `run ${run.id} updated_at`,
    );
    if (!newest || concludedAt > newest.concludedAt) {
      newest = { id: run.id, url: run.html_url, concludedAt };
    }
  }

  if (!newest) {
    return {
      fresh: false,
      reason: runs.length === 0 ? 'no-runs' : 'no-qualifying-success',
      run: null,
      ageMs: null,
      maxAgeMs,
      rejected,
    };
  }

  const ageMs = now - newest.concludedAt;
  return {
    fresh: ageMs <= maxAgeMs,
    reason: ageMs <= maxAgeMs ? 'fresh' : 'too-old',
    run: newest,
    ageMs,
    maxAgeMs,
    rejected,
  };
}

/** Human-readable one-liner for the job log. */
export function renderVerdict(workflow, verdict) {
  const hours = (ms) => (ms / 3_600_000).toFixed(1);
  if (verdict.fresh) {
    return `OK: ${workflow} last concluded success ${hours(verdict.ageMs)}h ago (window ${hours(verdict.maxAgeMs)}h), run ${verdict.run.id}.`;
  }
  if (verdict.run) {
    return `FAIL: ${workflow} last concluded success ${hours(verdict.ageMs)}h ago, older than the ${hours(verdict.maxAgeMs)}h window (run ${verdict.run.id}). The schedule is not producing verdicts; a cancelled or perpetually queued run is silence, not a pass.`;
  }
  return `FAIL: ${workflow} has no run in the inspected history that both concluded success and carries job evidence it executed (${verdict.reason}). Inspected ${verdict.rejected.length} run(s): ${verdict.rejected.map((entry) => `${entry.id}=${entry.reason}`).join(', ') || 'none'}.`;
}

// --- CLI -------------------------------------------------------------------

export function parseArgs(argv) {
  const options = {
    workflow: null,
    maxAgeHours: DEFAULT_MAX_AGE_HOURS,
    branch: 'main',
    runsFile: null,
    json: false,
  };
  for (const arg of argv) {
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    const eq = arg.indexOf('=');
    if (!arg.startsWith('--') || eq === -1) {
      throw new Error(`Unrecognized option '${arg}'.`);
    }
    const flag = arg.slice(0, eq);
    const value = arg.slice(eq + 1);
    switch (flag) {
      case '--workflow':
        if (!value) throw new Error('--workflow requires a value.');
        options.workflow = value;
        break;
      case '--max-age-hours': {
        const hours = Number(value);
        if (!Number.isFinite(hours) || hours <= 0) {
          throw new Error('--max-age-hours must be a positive number.');
        }
        options.maxAgeHours = hours;
        break;
      }
      case '--branch':
        if (!value) throw new Error('--branch requires a value.');
        options.branch = value;
        break;
      case '--runs-file':
        // Offline path: a pre-fetched `{runs, jobsByRunId}` document. Used by
        // the tests and available for reproducing a verdict by hand.
        options.runsFile = value;
        break;
      default:
        throw new Error(`Unrecognized option '${flag}'.`);
    }
  }
  if (!options.workflow) throw new Error('--workflow is required.');
  return options;
}

async function fetchJson(url, token) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${url}`);
  }
  return response.json();
}

async function collectFromApi(options) {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  if (!token) throw new Error('GITHUB_TOKEN is required to read run history.');
  if (!repository) throw new Error('GITHUB_REPOSITORY is required.');

  const runsUrl = `${apiUrl}/repos/${repository}/actions/workflows/${encodeURIComponent(options.workflow)}/runs?branch=${encodeURIComponent(options.branch)}&per_page=${DEFAULT_RUN_PAGE_SIZE}`;
  const { workflow_runs: runs = [] } = await fetchJson(runsUrl, token);

  // Job evidence is only needed for runs that could qualify; a cancelled or
  // failed run is rejected before its jobs are ever consulted.
  const jobsByRunId = {};
  for (const run of runs) {
    if (run?.status !== 'completed' || run?.conclusion !== 'success') continue;
    const { jobs = [] } = await fetchJson(
      `${apiUrl}/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`,
      token,
    );
    jobsByRunId[String(run.id)] = jobs;
  }
  return { runs, jobsByRunId };
}

async function main(argv) {
  const options = parseArgs(argv);
  const { runs, jobsByRunId } = options.runsFile
    ? JSON.parse(readFileSync(options.runsFile, 'utf8'))
    : await collectFromApi(options);

  const verdict = evaluateWorkflowFreshness({
    runs,
    jobsByRunId,
    maxAgeMs: options.maxAgeHours * 3_600_000,
    now: Date.now(),
    branch: options.branch,
  });

  if (options.json) console.log(JSON.stringify(verdict, null, 2));
  const line = renderVerdict(options.workflow, verdict);
  if (verdict.fresh) {
    console.log(line);
    return 0;
  }
  console.error(line);
  return 1;
}

if (invokedDirectly(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((error) => {
      console.error(`FAIL: ${error.message}`);
      process.exit(1);
    });
}
