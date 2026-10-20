#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
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
  const response = await fetch(`${base}/repos/${repository}/${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      ...(env.GH_TOKEN ? { Authorization: `Bearer ${env.GH_TOKEN}` } : {}),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
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
const FULL_QUALIFICATION_JOB_NAMES = [
  'resolve',
  'Static and app builds',
  'Ordinary corpus 1-2 of 8',
  'Ordinary corpus 3-4 of 8',
  'Ordinary corpus 5-6 of 8',
  'Ordinary corpus 7-8 of 8',
  'Process-heavy corpus 1 of 2',
  'Process-heavy corpus 2 of 2',
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
    if (!process.env.GITHUB_OUTPUT)
      throw new Error('GITHUB_OUTPUT is required');
    appendFileSync(process.env.GITHUB_OUTPUT, `reuse_run=${reuseRun}\n`);
    console.log(
      reuseRun
        ? `Reusing exact-source qualification from run ${reuseRun}`
        : 'Fresh full qualification required',
    );
  } else if (process.argv[2] === 'attest') {
    const needs = JSON.parse(process.env.NEEDS || '{}');
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
