#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { fetchGitHubEvidence } from './lib/github-evidence-fetch.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

export const QUALIFICATION_JOBS = Object.freeze([
  'static',
  'ordinary',
  'process-heavy',
  'exclusive',
  'android-viewport',
]);
const TRUSTED_WORKFLOWS = new Map([
  [
    '.github/workflows/main-qualification.yml',
    ['push', 'schedule', 'workflow_dispatch'],
  ],
  ['.github/workflows/nightly.yml', ['push', 'schedule', 'workflow_dispatch']],
  ['.github/workflows/release.yml', ['push']],
  ['.github/workflows/ci.yml', ['workflow_dispatch']],
  ['.github/workflows/publish-release.yml', ['workflow_dispatch']],
  ['.github/workflows/publish-packages.yml', ['workflow_dispatch']],
]);
const MAX_AGE_MS = 24 * 60 * 60_000;

export function validateSource(source, actual) {
  if (!/^[0-9a-f]{40}$/.test(source ?? '') || source !== actual)
    throw new Error(
      'qualification source must match the exact checked-out commit',
    );
}

export function reusableRun(
  run,
  { source, repository, currentRun, now = Date.now() },
) {
  const age = now - Date.parse(run.updated_at);
  const events = TRUSTED_WORKFLOWS.get(run.path);
  return (
    run.id !== Number(currentRun) &&
    run.head_sha === source &&
    run.head_repository?.full_name === repository &&
    run.status === 'completed' &&
    run.conclusion === 'success' &&
    (events?.includes(run.event) ?? false) &&
    (run.path === '.github/workflows/release.yml' ||
      run.head_branch === 'main') &&
    Number.isFinite(age) &&
    age >= 0 &&
    age <= MAX_AGE_MS
  );
}

export function qualificationVerdict(needs, reuseRun) {
  const expected = ['resolve', ...QUALIFICATION_JOBS].sort();
  if (
    JSON.stringify(Object.keys(needs).sort()) !== JSON.stringify(expected) ||
    needs.resolve?.result !== 'success'
  )
    return false;
  if (reuseRun)
    return (
      /^[1-9][0-9]*$/.test(reuseRun) &&
      needs.resolve.outputs?.reuse_run === reuseRun &&
      QUALIFICATION_JOBS.every((id) => needs[id]?.result === 'skipped')
    );
  return (
    !needs.resolve.outputs?.reuse_run &&
    QUALIFICATION_JOBS.every((id) => needs[id]?.result === 'success')
  );
}

export async function github(
  path,
  { method = 'GET', body, env = process.env, responseBody = 'json' } = {},
) {
  const repository = env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? ''))
    throw new Error('GITHUB_REPOSITORY must be owner/repository');
  const base = env.GITHUB_API_URL || 'https://api.github.com';
  const url = new URL(base);
  if (
    url.protocol !== 'https:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new Error('GitHub API must use HTTPS');
  const response = await fetchGitHubEvidence(
    `${base}/repos/${repository}/${path}`,
    {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        ...(env.GH_TOKEN ? { Authorization: `Bearer ${env.GH_TOKEN}` } : {}),
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
    },
  );
  if (!response.ok)
    throw new Error(
      `GitHub ${method} ${path.split('?')[0]}: HTTP ${response.status}`,
    );
  return response.status === 204 || responseBody === 'none'
    ? null
    : response.json();
}

export async function listGithub(path, key, options) {
  const result = [];
  for (let page = 1; page <= 20; page++) {
    const data = await github(
      `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
      options,
    );
    const items = key ? data[key] : data;
    if (!Array.isArray(items))
      throw new Error(`Incomplete GitHub listing: ${path}`);
    result.push(...items);
    if (items.length < 100) return result;
  }
  throw new Error(`GitHub listing exceeded bounded pagination: ${path}`);
}

const SEPARATE_DELIVERY_WORKFLOWS = new Set([
  '.github/workflows/main-qualification.yml',
  '.github/workflows/nightly.yml',
]);
const NONTERMINAL_RUN_STATES = new Set([
  'queued',
  'pending',
  'waiting',
  'requested',
  'in_progress',
]);
/**
 * Every job a reusable full qualification run must have completed
 * successfully, by its displayed name. Pinned against full-regression.yml's
 * jobs and matrix slices, so a slice cannot drop out of reuse unnoticed.
 */
export const FULL_QUALIFICATION_JOB_NAMES = [
  'resolve',
  'Static and app builds',
  'Ordinary corpus 1-2 of 8',
  'Ordinary corpus 3-4 of 8',
  'Ordinary corpus 5-6 of 8',
  'Ordinary corpus 7-8 of 8',
  'Process-heavy corpus 1 of 3',
  'Process-heavy corpus 2 of 3',
  'Process-heavy corpus 3 of 3',
  'Exclusive corpora',
  'Mobile Playwright (Android viewport)',
  'Full source qualification',
];

function qualificationCandidate(run, source, env) {
  const separateDelivery = SEPARATE_DELIVERY_WORKFLOWS.has(run.path);
  return (
    Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt > 0 &&
    reusableRun(
      {
        ...run,
        // This only admits inspection of the source gate. The parent's actual
        // status/conclusion is retained and never becomes qualification proof.
        conclusion: 'success',
        status:
          separateDelivery && NONTERMINAL_RUN_STATES.has(run.status)
            ? 'completed'
            : run.status,
      },
      {
        source,
        repository: env.GITHUB_REPOSITORY,
        currentRun: env.GITHUB_RUN_ID,
      },
    )
  );
}

export async function findQualification(source, env = process.env) {
  const runs = await listGithub(
    `actions/runs?head_sha=${source}`,
    'workflow_runs',
    { env },
  );
  const observations = [];
  for (const run of runs.filter((item) =>
    qualificationCandidate(item, source, env),
  )) {
    const jobs = await listGithub(
      `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
      'jobs',
      { env },
    );
    if (
      jobs.some(
        (job) =>
          job.run_id !== run.id ||
          job.run_attempt !== run.run_attempt ||
          job.head_sha !== source,
      )
    )
      return '';
    const gates = jobs.filter(
      (job) => job.name.split(' / ').at(-1) === 'Full source qualification',
    );
    if (gates.length !== 1) continue;
    const gate = gates[0];
    if (gate.status !== 'completed') return '';
    const completed = Date.parse(gate.completed_at);
    if (!Number.isFinite(completed) || completed > Date.now()) return '';
    observations.push({ run, jobs, gate, completed });
  }
  observations.sort((a, b) => b.completed - a.completed);
  for (const { run, jobs, gate, completed } of observations) {
    if (['failure', 'timed_out', 'cancelled'].includes(gate.conclusion))
      return '';
    if (gate.conclusion !== 'success' || Date.now() - completed > MAX_AGE_MS)
      continue;
    if (
      run.conclusion !== 'success' &&
      !SEPARATE_DELIVERY_WORKFLOWS.has(run.path)
    )
      continue;
    const prefix = gate.name.slice(0, -'Full source qualification'.length);
    if (
      !FULL_QUALIFICATION_JOB_NAMES.every((name) => {
        const matches = jobs.filter((job) => job.name === `${prefix}${name}`);
        return (
          matches.length === 1 &&
          matches[0].status === 'completed' &&
          matches[0].conclusion === 'success'
        );
      })
    )
      return '';
    const artifacts = await listGithub(
      `actions/runs/${run.id}/artifacts`,
      'artifacts',
      { env },
    );
    if (
      !artifacts.some(
        (artifact) =>
          artifact.name === `source-qualification-${source}-${run.id}` &&
          !artifact.expired,
      )
    )
      continue;
    const current = await github(`actions/runs/${run.id}`, { env });
    if (
      current.id !== run.id ||
      current.run_attempt !== run.run_attempt ||
      current.path !== run.path ||
      current.event !== run.event ||
      current.head_branch !== run.head_branch ||
      !qualificationCandidate(current, source, env) ||
      (current.conclusion !== 'success' &&
        !SEPARATE_DELIVERY_WORKFLOWS.has(current.path))
    )
      return '';
    return String(run.id);
  }
  return '';
}

const MAIN_QUALIFICATION_WORKFLOW = '.github/workflows/main-qualification.yml';
const MAIN_QUALIFICATION_GATE = 'qualification / Full source qualification';
/** How long a test failure on an unchanged source excuses a scheduled re-run. */
export const FAILED_SOURCE_WINDOW_MS = MAX_AGE_MS;
// A corpus job counts as a test failure only when the step that failed is
// the one that runs tests. A failed checkout, install, browser download or
// prerequisite build is infrastructure, and the source deserves a re-run.
const TEST_STEPS = new Set([
  'Run full-regression phases',
  'Run Android viewport tests',
]);

/**
 * Classify one canonical main qualification attempt for the scheduled
 * re-run decision. Only `test-failure` lets a scheduled run skip the corpus:
 * the gate failed within the window, every corpus job finished, at least one
 * failed, and each failure is in a test step. A run whose corpus never
 * executed (a reuse or an earlier skip) is `not-executed` and carries no
 * evidence either way.
 * @returns {'foreign'|'incomplete'|'not-executed'|'passed'|'expired'|'infrastructure'|'test-failure'}
 */
export function failedSourceObservation(
  run,
  jobs,
  { source, repository, now = Date.now() },
) {
  if (
    run.path !== MAIN_QUALIFICATION_WORKFLOW ||
    run.head_sha !== source ||
    run.head_repository?.full_name !== repository ||
    run.head_branch !== 'main' ||
    !['push', 'schedule', 'workflow_dispatch'].includes(run.event) ||
    jobs.some(
      (job) =>
        job.run_id !== run.id ||
        job.run_attempt !== run.run_attempt ||
        job.head_sha !== source,
    )
  )
    return 'foreign';
  const gates = jobs.filter((job) => job.name === MAIN_QUALIFICATION_GATE);
  if (
    run.status !== 'completed' ||
    gates.length !== 1 ||
    gates[0].status !== 'completed'
  )
    return 'incomplete';
  const corpus = jobs.filter(
    (job) =>
      job.name.startsWith('qualification / ') &&
      job.name !== 'qualification / resolve' &&
      job.name !== MAIN_QUALIFICATION_GATE,
  );
  if (corpus.every((job) => job.conclusion === 'skipped'))
    return 'not-executed';
  if (gates[0].conclusion === 'success') return 'passed';
  const completed = Date.parse(gates[0].completed_at);
  if (
    !Number.isFinite(completed) ||
    completed > now ||
    now - completed > FAILED_SOURCE_WINDOW_MS
  )
    return 'expired';
  if (
    gates[0].conclusion !== 'failure' ||
    corpus.some(
      (job) =>
        job.status !== 'completed' ||
        !['success', 'failure', 'skipped'].includes(job.conclusion),
    )
  )
    return 'infrastructure';
  const failed = corpus.filter((job) => job.conclusion === 'failure');
  if (
    !failed.length ||
    failed.some((job) => {
      const steps = (job.steps ?? []).filter(
        (step) => step.conclusion === 'failure',
      );
      return !steps.length || steps.some((step) => !TEST_STEPS.has(step.name));
    })
  )
    return 'infrastructure';
  return 'test-failure';
}

/**
 * The deploy-ledger files the release bot commits to main after each ship.
 * main-qualification.yml's push trigger ignores them (paths-ignore), so a
 * push that changes only these files starts no qualification run.
 */
export const DEPLOY_LEDGER_PATHS = Object.freeze([
  'docs/reference/deploy-ledger.json',
  'docs/reference/deploy-ledger.md',
]);
/** First-parent commits walked when looking for a ledger-equivalent source. */
export const LEDGER_WALK_LIMIT = 30;

/**
 * Whether one commit's `git diff-tree --no-renames --name-status` output
 * changes only deploy-ledger files by adding or modifying them. An empty
 * diff, a deletion, or any other path is not ledger-only.
 */
export function ledgerOnlyChange(nameStatus) {
  const entries = nameStatus
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));
  return (
    entries.length > 0 &&
    entries.every(
      ([status, file, extra]) =>
        ['A', 'M'].includes(status) &&
        extra === undefined &&
        DEPLOY_LEDGER_PATHS.includes(file),
    )
  );
}

/**
 * The source followed by its first-parent ancestors whose trees differ from
 * it only in deploy-ledger files, newest first. The walk stops at a commit
 * that changes anything else, a merge, the root, or the limit, and throws at
 * a shallow-clone boundary. Callers may treat a test failure on any of these as a failure on
 * the source; they must not treat a pass as one, because tests read the
 * ledger (for example the release platform matrix's ledger evidence).
 */
export function ledgerEquivalentSources(
  source,
  { cwd = process.cwd(), limit = LEDGER_WALK_LIMIT } = {},
) {
  const git = (...args) =>
    execFileSyncBounded('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  const sources = [source];
  let current = source;
  for (let step = 0; step < limit; step++) {
    const [, ...parents] = git('rev-list', '--parents', '-n', '1', current)
      .split(' ')
      .filter(Boolean);
    // A shallow clone shows its boundary commit with no parents. Stopping
    // there would quietly treat the clone depth as the walk's end, so refuse;
    // the caller then runs the corpus.
    if (
      parents.length === 0 &&
      git('rev-parse', '--is-shallow-repository') === 'true'
    )
      throw new Error(
        `ledger walk reached the shallow clone boundary at ${current}; fetch more history`,
      );
    if (parents.length !== 1) break;
    const change = git(
      'diff-tree',
      '--no-commit-id',
      '--no-renames',
      '--name-status',
      '-r',
      parents[0],
      current,
    );
    if (!ledgerOnlyChange(change)) break;
    sources.push(parents[0]);
    current = parents[0];
  }
  return sources;
}

/**
 * The newest canonical main qualification run that executed the corpus on
 * these sources (the exact source first, then its ledger-equivalent
 * ancestors), when it failed tests within the window; otherwise ''. Runs
 * that did not execute are passed over, so a chain of skips still points at
 * the run that produced the evidence and expires with it. The first source
 * with an executed run decides: a pass or an infrastructure failure there
 * means the corpus runs fresh.
 */
async function findFailedSource(sources, env = process.env, now = Date.now()) {
  for (const source of sources) {
    const runs = (
      await listGithub(`actions/runs?head_sha=${source}`, 'workflow_runs', {
        env,
      })
    )
      .filter(
        (run) =>
          run.path === MAIN_QUALIFICATION_WORKFLOW &&
          run.id !== Number(env.GITHUB_RUN_ID) &&
          Number.isSafeInteger(run.run_attempt) &&
          run.run_attempt > 0,
      )
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    for (const run of runs) {
      const jobs = await listGithub(
        `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
        'jobs',
        { env },
      );
      const observation = failedSourceObservation(run, jobs, {
        source,
        repository: env.GITHUB_REPOSITORY,
        now,
      });
      if (['foreign', 'incomplete', 'not-executed'].includes(observation))
        continue;
      return observation === 'test-failure' ? String(run.id) : '';
    }
  }
  return '';
}

async function main() {
  const source = process.env.SOURCE_SHA;
  validateSource(
    source,
    execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim(),
  );
  if (process.argv[2] === 'resolve') {
    let reuseRun = '';
    if (process.env.ALLOW_REUSE === 'true') {
      try {
        reuseRun = await findQualification(source);
      } catch (error) {
        process.stderr.write(
          `Qualification lookup unavailable; executing fresh qualification: ${error.message}\n`,
        );
      }
    }
    // Only main qualification's scheduled runs ask for this; release and
    // other callers never set it, so their output and behavior are unchanged.
    const skipFailed = process.env.SKIP_FAILED_SOURCE === 'true';
    let failedRun = '';
    if (skipFailed && !reuseRun) {
      try {
        failedRun = await findFailedSource(ledgerEquivalentSources(source));
      } catch (error) {
        process.stderr.write(
          `Failed-source lookup unavailable; executing fresh qualification: ${error.message}\n`,
        );
      }
    }
    if (!process.env.GITHUB_OUTPUT)
      throw new Error('GITHUB_OUTPUT is required');
    appendFileSync(process.env.GITHUB_OUTPUT, `reuse_run=${reuseRun}\n`);
    if (skipFailed)
      appendFileSync(process.env.GITHUB_OUTPUT, `failed_run=${failedRun}\n`);
    console.log(
      reuseRun
        ? `Reusing exact-source qualification from run ${reuseRun}`
        : failedRun
          ? `Run ${failedRun} already failed tests on this source or a ledger-equivalent ancestor; not repeating the corpus`
          : 'Fresh full qualification required',
    );
  } else if (process.argv[2] === 'attest') {
    const needs = JSON.parse(process.env.NEEDS || '{}');
    if (process.env.FAILED_RUN)
      throw new Error(
        `Not re-run: run ${process.env.FAILED_RUN} already failed tests on this exact source, or on an ancestor that differs from it only in the deploy ledger, within ${FAILED_SOURCE_WINDOW_MS / 3_600_000} hours. The source stays unqualified; push a change, or dispatch with force=true to run the corpus again.`,
      );
    if (!qualificationVerdict(needs, process.env.REUSE_RUN || ''))
      throw new Error(
        `Incomplete or failed qualification: ${JSON.stringify(needs)}`,
      );
    const receipt = {
      schemaVersion: 1,
      kind: 'station.source-qualification',
      sourceSha: source,
      runId: process.env.GITHUB_RUN_ID,
      reusedRunId: process.env.REUSE_RUN || null,
      environment: { runner: 'ubuntu-22.04', node: process.version },
      results: Object.fromEntries(
        Object.entries(needs).map(([id, value]) => [id, value.result]),
      ),
    };
    writeFileSync(
      'source-qualification.json',
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `Full source qualification passed for \`${source}\`. ${receipt.reusedRunId ? `Reused run ${receipt.reusedRunId}.` : 'Every planned job succeeded.'}\n`,
      );
  } else throw new Error('Usage: qualification-evidence.mjs resolve|attest');
}
if (invokedDirectly(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
