#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { github, listGithub } from './qualification-evidence.mjs';

// Only read-only PR verification is disposable. Publishers, merge candidates,
// manual diagnostics and landing/repair automation retain their own lifetimes.
const WORKFLOWS = new Set([
  '.github/workflows/ci.yml',
  '.github/workflows/build-ios.yml',
  '.github/workflows/windows-pr-verification.yml',
  '.github/workflows/security-analysis.yml',
  '.github/workflows/gallery-pr-check.yml',
  '.github/workflows/docs-kit.yml',
]);

const SHA = /^[0-9a-f]{40}$/;
const LIVE_RUN_STATES = new Set([
  'queued',
  'in_progress',
  'pending',
  'waiting',
  'requested',
]);
const SOURCE_JOBS = new Set([
  'Repository source scans',
  'fast-checks plan',
  'fast-checks statics',
  'PR title status publisher',
  'UI entry bundle delta (report only)',
  'Fork pull-request smoke',
  'Exact full-diff classification',
  'diff',
  'merge-integration-full-regression',
  'fast-checks',
  'Publish source admission / reconcile',
  'Merge-queue regression',
  'full-regression',
  'manual-completion-diagnostics',
  `fast-checks shard \${{ matrix.shard }}`,
]);
const CORE_JOBS = [
  'fast-checks plan',
  'fast-checks statics',
  'fast-checks',
  'Publish source admission / reconcile',
];
const optionalJob = (job) =>
  typeof job.name === 'string' &&
  (job.name === 'Plan affected delivery checks' ||
    job.name.startsWith('delivery-validation / '));
const successful = (job) =>
  job.status === 'completed' && job.conclusion === 'success';
const mergedIdentity = (pr) =>
  JSON.stringify([
    pr.number,
    pr.head?.sha,
    pr.head?.ref,
    pr.head?.repo?.full_name,
    pr.base?.ref,
    pr.base?.repo?.full_name,
    pr.merge_commit_sha,
    pr.merged_at,
  ]);
function mergedOwner(pr, number, repository) {
  return (
    pr.number === number &&
    pr.state === 'closed' &&
    pr.merged === true &&
    Number.isFinite(Date.parse(pr.merged_at)) &&
    SHA.test(pr.merge_commit_sha ?? '') &&
    pr.base?.ref === 'main' &&
    pr.base?.repo?.full_name === repository &&
    pr.head?.repo?.full_name === repository &&
    SHA.test(pr.head?.sha ?? '') &&
    Boolean(pr.head?.ref)
  );
}

// These inventories authorize cancellation, so truncation, duplicate identities
// and changing total counts are errors rather than an incomplete success.
async function completeListing(path, key) {
  const result = [];
  let total;
  for (let page = 1; page <= 20; page++) {
    const data = await github(
      `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
    );
    const items = key ? data?.[key] : data;
    if (!Array.isArray(items) || items.length > 100)
      throw new Error('Incomplete retirement inventory');
    if (key) {
      if (
        !Number.isSafeInteger(data.total_count) ||
        data.total_count < 0 ||
        (total !== undefined && total !== data.total_count)
      )
        throw new Error('Changing retirement inventory');
      total = data.total_count;
    }
    result.push(...items);
    const ids = result.map((item) => (key ? item.id : item.number));
    if (
      ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(ids).size !== ids.length
    )
      throw new Error('Ambiguous retirement inventory');
    if (items.length < 100) {
      if (total !== undefined && total !== result.length)
        throw new Error('Truncated retirement inventory');
      return result;
    }
  }
  throw new Error('Retirement inventory pagination exceeded bound');
}

function qualifiedOptionalTail(jobs, run) {
  if (
    !jobs.every(
      (job) =>
        job.run_id === run.id &&
        job.run_attempt === run.run_attempt &&
        job.head_sha === run.head_sha,
    )
  )
    return false;
  const skipped = [
    'Fork pull-request smoke',
    'Exact full-diff classification',
    'diff',
    'merge-integration-full-regression',
    'Merge-queue regression',
    'full-regression',
    'manual-completion-diagnostics',
  ];
  if (
    !skipped.every((name) =>
      jobs.some(
        (job) =>
          job.name === name &&
          job.status === 'completed' &&
          job.conclusion === 'skipped',
      ),
    )
  )
    return false;
  const advisory = [
    'Repository source scans',
    'PR title status publisher',
    'UI entry bundle delta (report only)',
  ];
  if (
    !advisory.every((name) =>
      jobs.some((job) => job.name === name && successful(job)),
    )
  )
    return false;
  if (!jobs.length || new Set(jobs.map((job) => job.name)).size !== jobs.length)
    return false;
  if (
    !CORE_JOBS.every(
      (name) =>
        jobs.filter((job) => job.name === name && successful(job)).length === 1,
    )
  )
    return false;
  if (!jobs.some(optionalJob)) return false;
  return jobs.every((job) => {
    if (optionalJob(job))
      return job.status === 'completed'
        ? [
            'success',
            'failure',
            'cancelled',
            'timed_out',
            'skipped',
            'neutral',
            'action_required',
            'startup_failure',
            'stale',
          ].includes(job.conclusion)
        : LIVE_RUN_STATES.has(job.status) && job.conclusion === null;
    if (
      !SOURCE_JOBS.has(job.name) &&
      !/^fast-checks shard [1-4]$/.test(job.name)
    )
      return false;
    return (
      job.status === 'completed' &&
      ['success', 'skipped'].includes(job.conclusion)
    );
  });
}

async function exclusiveOwner(pr, number) {
  const owners = await completeListing(`commits/${pr.head.sha}/pulls`);
  return (
    owners.every(
      (owner) =>
        ['open', 'closed'].includes(owner.state) &&
        SHA.test(owner.head?.sha ?? ''),
    ) &&
    owners.some(
      (owner) => owner.number === number && owner.head?.sha === pr.head.sha,
    ) &&
    !owners.some(
      (owner) =>
        owner.number !== number &&
        owner.state === 'open' &&
        owner.head?.sha === pr.head.sha,
    )
  );
}

function knownDeliveryGraph(run, repository) {
  const names = new Set([
    'source-verification-policy.yml',
    'full-regression.yml',
    'delivery-validation.yml',
    'install-smoke.yml',
    'portable-server-archives.yml',
    'desktop-rust.yml',
    'desktop-clean-checkout.yml',
    'ecosystem-packaging.yml',
  ]);
  const references = run.referenced_workflows;
  if (!Array.isArray(references) || !references.length) return false;
  const found = new Set();
  const revisions = new Set();
  for (const reference of references) {
    const prefix = `${repository}/.github/workflows/`;
    if (
      typeof reference.path !== 'string' ||
      !reference.path.startsWith(prefix) ||
      !SHA.test(reference.sha ?? '') ||
      reference.ref !== 'refs/heads/main'
    )
      return false;
    const [name, revision, extra] = reference.path
      .slice(prefix.length)
      .split('@');
    if (
      extra !== undefined ||
      !names.has(name) ||
      revision !== reference.sha ||
      found.has(name)
    )
      return false;
    found.add(name);
    revisions.add(revision);
  }
  return (
    revisions.size === 1 &&
    found.has('source-verification-policy.yml') &&
    found.has('delivery-validation.yml')
  );
}

async function retireMergedDelivery(pr, number, repository) {
  const workflow = await github('actions/workflows/ci.yml');
  if (
    workflow.path !== '.github/workflows/ci.yml' ||
    workflow.name !== 'PR: CI' ||
    !Number.isSafeInteger(workflow.id)
  )
    throw new Error('Untrusted retirement workflow');
  if (!(await exclusiveOwner(pr, number))) return;
  const runs = await completeListing(
    `actions/workflows/${workflow.id}/runs?event=pull_request_target&head_sha=${pr.head.sha}`,
    'workflow_runs',
  );
  const bound = (run) =>
    run.workflow_id === workflow.id &&
    run.path === workflow.path &&
    run.event === 'pull_request_target' &&
    run.head_sha === pr.head.sha &&
    run.head_branch === pr.head.ref &&
    run.head_repository?.full_name === repository &&
    Array.isArray(run.pull_requests) &&
    run.pull_requests.every((owner) => owner.number === number) &&
    Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt > 0 &&
    LIVE_RUN_STATES.has(run.status);
  for (const run of runs.filter(bound)) {
    const live = await github(`actions/runs/${run.id}`);
    if (
      !bound(live) ||
      !knownDeliveryGraph(live, repository) ||
      live.run_attempt !== run.run_attempt ||
      live.id !== run.id
    )
      continue;
    const jobs = await completeListing(
      `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
      'jobs',
    );
    if (!qualifiedOptionalTail(jobs, live)) continue;
    const finalRun = await github(`actions/runs/${run.id}`);
    if (
      !bound(finalRun) ||
      !knownDeliveryGraph(finalRun, repository) ||
      finalRun.run_attempt !== run.run_attempt ||
      finalRun.id !== run.id
    )
      continue;
    const finalJobs = await completeListing(
      `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
      'jobs',
    );
    if (!qualifiedOptionalTail(finalJobs, finalRun)) continue;
    const ownerAtEffect = await github(`pulls/${number}`);
    if (
      !mergedOwner(ownerAtEffect, number, repository) ||
      mergedIdentity(ownerAtEffect) !== mergedIdentity(pr) ||
      !(await exclusiveOwner(ownerAtEffect, number))
    )
      return;
    const attemptAtEffect = await github(`actions/runs/${run.id}`);
    if (
      !bound(attemptAtEffect) ||
      !knownDeliveryGraph(attemptAtEffect, repository) ||
      attemptAtEffect.id !== run.id ||
      attemptAtEffect.run_attempt !== run.run_attempt
    )
      continue;
    await github(`actions/runs/${run.id}/cancel`, {
      method: 'POST',
      responseBody: 'none',
    });
    console.log(
      `Requested cancellation of merged PR #${number} optional delivery run ${run.id} attempt ${run.run_attempt}; terminal cancellation is not yet verified`,
    );
  }
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const repository = process.env.GITHUB_REPOSITORY;
  const numbers = event.pull_request
    ? [event.pull_request.number]
    : (event.workflow_run?.pull_requests ?? []).map((pr) => pr.number);
  for (const number of new Set(numbers)) {
    if (!Number.isSafeInteger(number) || number <= 0)
      throw new Error('Invalid pull request number');
    const pr = await github(`pulls/${number}`);
    if (mergedOwner(pr, number, repository)) {
      await retireMergedDelivery(pr, number, repository);
      continue;
    }
    if (
      pr.state !== 'open' ||
      pr.base?.ref !== 'main' ||
      pr.head?.repo?.full_name !== repository ||
      !/^[0-9a-f]{40}$/.test(pr.head?.sha ?? '')
    )
      continue;
    const runs = [];
    for (const status of ['queued', 'in_progress']) {
      runs.push(
        ...(await listGithub(
          `actions/runs?event=pull_request_target&branch=${encodeURIComponent(pr.head.ref)}&status=${status}`,
          'workflow_runs',
        )),
      );
    }
    for (const run of new Map(runs.map((run) => [run.id, run])).values()) {
      if (
        !WORKFLOWS.has(run.path) ||
        run.event !== 'pull_request_target' ||
        run.head_repository?.full_name !== repository ||
        run.head_branch !== pr.head.ref ||
        !run.pull_requests?.some((pull) => pull.number === number) ||
        !/^[0-9a-f]{40}$/.test(run.head_sha ?? '') ||
        run.head_sha === pr.head.sha ||
        !Number.isSafeInteger(run.id) ||
        run.id <= 0
      )
        continue;
      const live = await github(`actions/runs/${run.id}`);
      if (
        !['queued', 'in_progress'].includes(live.status) ||
        live.run_attempt !== run.run_attempt ||
        live.head_sha !== run.head_sha
      )
        continue;
      // Delayed requested events never supply cancellation authority.
      // Re-read the live head before each effect; stop if the snapshot changed.
      const current = await github(`pulls/${number}`);
      if (
        current.state !== 'open' ||
        current.head?.sha !== pr.head.sha ||
        current.head?.ref !== pr.head.ref ||
        current.head?.repo?.full_name !== repository
      )
        break;
      await github(`actions/runs/${run.id}/cancel`, {
        method: 'POST',
        responseBody: 'none',
      });
      console.log(
        `Requested cancellation of obsolete PR #${number} run ${run.id} (${run.head_sha}); current head ${pr.head.sha}`,
      );
    }
  }
}

if (invokedDirectly(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
