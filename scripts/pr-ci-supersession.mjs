#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { github, listGithub } from './qualification-evidence.mjs';

// Read-only verification is disposable after exact supersession. Merge candidates
// additionally require a live replacement and a destroyed/displaced old ref.
const WORKFLOWS = new Set([
  '.github/workflows/ci.yml',
  '.github/workflows/build-ios.yml',
  '.github/workflows/windows-pr-verification.yml',
  '.github/workflows/security-analysis.yml',
  '.github/workflows/gallery-pr-check.yml',
  '.github/workflows/docs-kit.yml',
]);

const SHA = /^[0-9a-f]{40}$/;

// A run whose cancellation GitHub has accepted but not yet carried out, or
// will not accept now (HTTP 409). These outcomes leave nothing unsafe
// behind: no run is cancelled on stale authority. For obsolete PR runs and
// replaced merge candidates the next event for the branch or PR retries;
// the merged-close path has no later event, so failing would retry nothing
// either. They are reported per target so one stuck run cannot stop the pass
// from reaching the others. Every other error (ambiguous metadata, changed
// identity, API failure) stays fatal.
class CancellationNotSettled extends Error {}
const LIVE_RUN_STATES = new Set([
  'queued',
  'in_progress',
  'pending',
  'waiting',
  'requested',
]);
const SOURCE_JOBS = new Set([
  'Repository source scans',
  'PR source admission',
  'Pinned actionlint artifact',
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
// InconsistentInventory marks a listing that disagreed with itself while runs
// were changing state; malformed listings are plain errors.
class InconsistentInventory extends Error {}
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
      if (!Number.isSafeInteger(data.total_count) || data.total_count < 0)
        throw new Error('Malformed retirement inventory count');
      if (total !== undefined && total !== data.total_count)
        throw new InconsistentInventory('Changing retirement inventory');
      total = data.total_count;
    }
    result.push(...items);
    checkInventoryIds(result.map((item) => (key ? item.id : item.number)));
    if (items.length < 100) {
      if (total !== undefined && total !== result.length)
        throw new InconsistentInventory('Truncated retirement inventory');
      return result;
    }
  }
  throw new Error('Retirement inventory pagination exceeded bound');
}

function checkInventoryIds(ids) {
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0))
    throw new Error('Ambiguous retirement inventory');
  if (new Set(ids).size !== ids.length)
    throw new InconsistentInventory('Duplicate retirement inventory');
}

const GROUP_LISTING_ATTEMPTS = 3;
function listingPauseMs() {
  const raw = process.env.PR_CI_SUPERSESSION_LISTING_PAUSE_MS;
  if (raw === undefined) return 2_000;
  const value = Number(raw);
  if (!/^[0-9]+$/.test(raw) || value > 10_000)
    throw new Error('PR_CI_SUPERSESSION_LISTING_PAUSE_MS must be 0-10000');
  return value;
}

// Live merge-group runs of every workflow. GitHub's counts disagree with the
// returned page while a new group's runs are being created, so an
// inconsistent listing is re-read a bounded number of times. If it stays
// inconsistent, this pass retires nothing (null): the next queue event retries,
// and a missed retirement only spends runner time.
async function liveGroupRuns(number) {
  const pause = listingPauseMs();
  let reason = '';
  for (let attempt = 1; attempt <= GROUP_LISTING_ATTEMPTS; attempt++) {
    try {
      const runs = [];
      for (const status of ['queued', 'pending', 'in_progress'])
        runs.push(
          ...(await completeListing(
            `actions/runs?event=merge_group&status=${status}`,
            'workflow_runs',
          )),
        );
      return runs;
    } catch (error) {
      if (!(error instanceof InconsistentInventory)) throw error;
      reason = error.message;
      if (attempt < GROUP_LISTING_ATTEMPTS)
        await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
  console.log(
    `::warning::Merge retirement skipped for #${number}: ${reason} on all ${GROUP_LISTING_ATTEMPTS} listing attempts; nothing was cancelled`,
  );
  return null;
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
  // The bounded queue topology omits this old job. If a legacy run has it,
  // it must still be completed/skipped: an executed corpus is not optional.
  if (
    jobs.some(
      (job) =>
        job.name === 'merge-integration-full-regression' &&
        (job.status !== 'completed' || job.conclusion !== 'skipped'),
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
    // A 409 cancels nothing; this one-shot close event never retries it, so
    // stopping would only leave the remaining holder runs uncancelled too.
    if (!(await requestOrWarn(run))) continue;
    console.log(
      `Requested cancellation of merged PR #${number} optional delivery run ${run.id} attempt ${run.run_attempt}; terminal cancellation is not yet verified`,
    );
  }
}

function sameObsoleteRun(live, run, pr, number, repository) {
  return (
    live.id === run.id &&
    live.run_attempt === run.run_attempt &&
    live.head_sha === run.head_sha &&
    live.head_sha !== pr.head.sha &&
    live.event === 'pull_request_target' &&
    live.path === run.path &&
    WORKFLOWS.has(live.path) &&
    live.head_branch === pr.head.ref &&
    live.head_repository?.full_name === repository &&
    live.pull_requests?.some((pull) => pull.number === number)
  );
}

async function settleObsoleteCancellation(run, pr, number, repository) {
  let live = await github(`actions/runs/${run.id}`);
  if (!sameObsoleteRun(live, run, pr, number, repository)) return;
  if (live.status !== 'completed') {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    live = await github(`actions/runs/${run.id}`);
    if (!sameObsoleteRun(live, run, pr, number, repository)) return;
  }
  if (live.status === 'completed') {
    console.log(`Obsolete run ${run.id} is terminal: ${live.conclusion}`);
    return;
  }
  if (!LIVE_RUN_STATES.has(live.status))
    throw new Error(`Unknown cancellation state for obsolete run ${run.id}`);
  const current = await github(`pulls/${number}`);
  if (
    current.state !== 'open' ||
    current.base?.ref !== 'main' ||
    current.head?.sha !== pr.head.sha ||
    current.head?.ref !== pr.head.ref ||
    current.head?.repo?.full_name !== repository
  )
    return;
  const jobs = await completeListing(`actions/runs/${run.id}/jobs`, 'jobs');
  if (
    !jobs.every(
      (job) =>
        job.run_id === run.id &&
        job.run_attempt === run.run_attempt &&
        job.head_sha === run.head_sha,
    )
  )
    throw new Error(`Obsolete run ${run.id} has mismatched job identity`);
  if (
    jobs.some(
      (job) =>
        (job.status !== 'completed' && !LIVE_RUN_STATES.has(job.status)) ||
        !Object.hasOwn(job, 'runner_id') ||
        (job.runner_id !== null &&
          (!Number.isSafeInteger(job.runner_id) || job.runner_id < 0)),
    )
  )
    throw new Error(`Obsolete run ${run.id} has ambiguous runner metadata`);
  if (jobs.some((job) => job.status !== 'completed' && job.runner_id))
    throw new CancellationNotSettled(
      `Obsolete run ${run.id} still has an assigned runner; force-cancel refused`,
    );
  live = await github(`actions/runs/${run.id}`);
  if (
    !sameObsoleteRun(live, run, pr, number, repository) ||
    live.status === 'completed'
  )
    return;
  const finalOwner = await github(`pulls/${number}`);
  if (
    finalOwner.state !== 'open' ||
    finalOwner.base?.ref !== 'main' ||
    finalOwner.head?.sha !== pr.head.sha ||
    finalOwner.head?.ref !== pr.head.ref ||
    finalOwner.head?.repo?.full_name !== repository
  )
    return;
  const forcePath = `actions/runs/${run.id}/force-cancel`;
  try {
    await github(forcePath, { method: 'POST', responseBody: 'none' });
  } catch (error) {
    if (error.message !== `GitHub POST ${forcePath}: HTTP 409`) throw error;
    // Observed when the normal cancellation finishes around this POST: the
    // run reads cancelled within a second of the refusal. GitHub documents
    // the status only as "Conflict", so the run's own state decides.
    live = await github(`actions/runs/${run.id}`);
    if (!sameObsoleteRun(live, run, pr, number, repository)) return;
    if (live.status === 'completed') {
      console.log(`Obsolete run ${run.id} is terminal: ${live.conclusion}`);
      return;
    }
    if (!LIVE_RUN_STATES.has(live.status))
      throw new Error(`Unknown cancellation state for obsolete run ${run.id}`);
    throw new CancellationNotSettled(
      `GitHub refused force cancellation of obsolete run ${run.id} (HTTP 409)`,
    );
  }
  live = await github(`actions/runs/${run.id}`);
  if (
    sameObsoleteRun(live, run, pr, number, repository) &&
    live.status !== 'completed'
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    live = await github(`actions/runs/${run.id}`);
  }
  if (
    !sameObsoleteRun(live, run, pr, number, repository) ||
    live.status !== 'completed'
  )
    throw new CancellationNotSettled(
      `Force cancellation of obsolete run ${run.id} is not terminal`,
    );
  console.log(
    `Obsolete run ${run.id} is terminal after force-cancel: ${live.conclusion}`,
  );
}

const GROUP_BRANCH = /^gh-readonly-queue\/main\/pr-([1-9][0-9]*)-[0-9a-f]{40}$/;

async function groupRef(branch) {
  const path = `git/ref/heads/${branch}`;
  try {
    const ref = await github(path);
    if (ref.ref !== `refs/heads/${branch}` || !SHA.test(ref.object?.sha ?? ''))
      throw new Error('Ambiguous merge candidate ref');
    return ref.object.sha;
  } catch (error) {
    // Only an authoritative 404 means destroyed. Auth/transport failures never do.
    if (error.message === `GitHub GET ${path}: HTTP 404`) return null;
    throw error;
  }
}

function sameGroupRun(live, run, workflow, repository) {
  return (
    Number.isSafeInteger(live.id) &&
    live.id > 0 &&
    live.id === run.id &&
    live.run_attempt === run.run_attempt &&
    Number.isSafeInteger(live.run_attempt) &&
    live.run_attempt > 0 &&
    live.workflow_id === workflow.id &&
    live.path === workflow.path &&
    live.event === 'merge_group' &&
    live.head_repository?.full_name === repository &&
    live.head_sha === run.head_sha &&
    SHA.test(live.head_sha ?? '') &&
    live.head_branch === run.head_branch &&
    GROUP_BRANCH.test(live.head_branch ?? '')
  );
}

// A listed run's own workflow identity, which every later read of that run
// must repeat.
function runWorkflow(run) {
  return Number.isSafeInteger(run.workflow_id) &&
    run.workflow_id > 0 &&
    typeof run.path === 'string' &&
    run.path
    ? { id: run.workflow_id, path: run.path }
    : null;
}

// Queue squash commits intentionally do not retain the original PR head ancestry.
// GitHub's live entry binds the current PR head to its synthetic commit instead.
async function queueSourceBinding(number, source, run, repository) {
  const endpoint =
    process.env.GITHUB_GRAPHQL_URL ||
    `${process.env.GITHUB_API_URL || 'https://api.github.com'}/graphql`;
  const url = new URL(endpoint);
  if (
    url.protocol !== 'https:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new Error('GitHub GraphQL must use HTTPS');
  const [owner, name] = repository.split('/');
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.GH_TOKEN
        ? { Authorization: `Bearer ${process.env.GH_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({
      query: `query($owner:String!,$name:String!,$number:Int!) {
      repository(owner:$owner,name:$name) { pullRequest(number:$number) {
        mergeQueueEntry { id state headCommit { oid } baseCommit { oid }
          pullRequest { number headRefOid baseRefName headRepository { nameWithOwner } }
        }
      } }
    }`,
      variables: { owner, name, number },
    }),
  });
  if (!response.ok)
    throw new Error(`GitHub queue authority: HTTP ${response.status}`);
  const result = await response.json();
  if (result.errors?.length)
    throw new Error('GitHub queue authority query failed');
  const pr = result.data?.repository?.pullRequest;
  if (pr === null) return null;
  if (!pr || !Object.hasOwn(pr, 'mergeQueueEntry'))
    throw new Error('Incomplete GitHub queue authority response');
  const entry = pr.mergeQueueEntry;
  const base = run.head_branch.slice(-40);
  if (
    !entry ||
    typeof entry.id !== 'string' ||
    !entry.id ||
    !['QUEUED', 'AWAITING_CHECKS', 'MERGEABLE', 'LOCKED'].includes(
      entry.state,
    ) ||
    entry.headCommit?.oid !== run.head_sha ||
    entry.baseCommit?.oid !== base ||
    entry.pullRequest?.number !== number ||
    entry.pullRequest.headRefOid !== source ||
    entry.pullRequest.baseRefName !== 'main' ||
    entry.pullRequest.headRepository?.nameWithOwner !== repository
  )
    return null;
  return JSON.stringify([
    entry.id,
    run.head_sha,
    base,
    number,
    source,
    repository,
  ]);
}

async function retireReplacedGroups(trigger, repository) {
  const workflow = await github('actions/workflows/ci.yml');
  if (
    workflow.path !== '.github/workflows/ci.yml' ||
    workflow.name !== 'PR: CI'
  )
    throw new Error('Untrusted merge-candidate workflow');
  const replacement = await github(`actions/runs/${trigger.id}`);
  if (!sameGroupRun(replacement, trigger, workflow, repository)) {
    console.log(
      'Merge retirement skipped: trigger no longer matches its live run attempt',
    );
    return;
  }
  const number = Number(GROUP_BRANCH.exec(replacement.head_branch)[1]);
  const owner = await github(`pulls/${number}`);
  if (
    owner.state !== 'open' ||
    owner.base?.ref !== 'main' ||
    owner.head?.repo?.full_name !== repository ||
    !SHA.test(owner.head?.sha ?? '')
  )
    return;
  if ((await groupRef(replacement.head_branch)) !== replacement.head_sha) {
    console.log(
      'Merge retirement skipped: replacement queue ref is absent or changed',
    );
    return;
  }
  const authority = await queueSourceBinding(
    number,
    owner.head.sha,
    replacement,
    repository,
  );
  if (!authority) {
    console.log(
      `Merge retirement skipped for #${number}: no live queue entry binds this candidate to the current PR head`,
    );
    return;
  }
  let requested = 0;
  let refused = 0;
  // Every workflow's merge-group runs, not only PR: CI: a superseded group's
  // other runs belong to the same dead candidate commit. The deadness proof
  // below is per candidate (PR number, commit, ref), never per workflow.
  const runs = await liveGroupRuns(number);
  if (!runs) return;
  for (const run of new Map(runs.map((run) => [run.id, run])).values()) {
    const own = runWorkflow(run);
    if (
      !own ||
      !sameGroupRun(run, run, own, repository) ||
      Number(GROUP_BRANCH.exec(run.head_branch)[1]) !== number ||
      run.head_sha === replacement.head_sha ||
      // Implied by the sha check: a run's head_sha never changes.
      run.id === replacement.id ||
      !(Date.parse(run.created_at) < Date.parse(replacement.created_at))
    )
      continue;
    const live = await github(`actions/runs/${run.id}`);
    if (
      !sameGroupRun(live, run, own, repository) ||
      !LIVE_RUN_STATES.has(live.status)
    )
      continue;
    const jobs = await completeListing(
      `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
      'jobs',
    );
    if (
      !jobs.every(
        (job) =>
          job.run_id === run.id &&
          job.run_attempt === run.run_attempt &&
          job.head_sha === run.head_sha &&
          Object.hasOwn(job, 'runner_id') &&
          (job.runner_id === null ||
            (Number.isSafeInteger(job.runner_id) && job.runner_id >= 0)),
      )
    )
      throw new Error('Ambiguous obsolete merge-candidate jobs');
    const latest = await github(`actions/runs/${replacement.id}`);
    const currentOwner = await github(`pulls/${number}`);
    const finalRun = await github(`actions/runs/${run.id}`);
    if (
      !sameGroupRun(latest, replacement, workflow, repository) ||
      !sameGroupRun(finalRun, run, own, repository) ||
      !LIVE_RUN_STATES.has(finalRun.status) ||
      currentOwner.state !== 'open' ||
      currentOwner.base?.ref !== 'main' ||
      currentOwner.head?.sha !== owner.head.sha ||
      currentOwner.head?.repo?.full_name !== repository
    )
      continue;
    if (
      (await groupRef(replacement.head_branch)) !== replacement.head_sha ||
      (await groupRef(run.head_branch)) === run.head_sha
    )
      continue;
    if (
      (await queueSourceBinding(number, owner.head.sha, latest, repository)) !==
      authority
    ) {
      console.log(
        `Merge retirement skipped for #${number}: queue entry changed during reconciliation`,
      );
      return;
    }
    // A 409 cancels nothing; the next queue event for this PR retries it.
    if (!(await requestOrWarn(run))) {
      refused++;
      continue;
    }
    requested++;
    const settled = await github(`actions/runs/${run.id}`);
    const terminal =
      sameGroupRun(settled, run, own, repository) &&
      settled.status === 'completed';
    console.log(
      `Replaced merge candidate #${number}: ${run.path} run ${run.id}/${run.run_attempt}, ${run.head_sha}; replacement ${replacement.id}/${replacement.run_attempt}, ${replacement.head_sha}; normal cancellation ${terminal ? `terminal ${settled.conclusion}` : 'requested, terminal state not verified'}`,
    );
  }
  console.log(
    `Merge retirement #${number}: ${requested} normal cancellation request(s), ${refused} refused (HTTP 409); candidates with live refs or mismatched identities were preserved`,
  );
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const repository = process.env.GITHUB_REPOSITORY;
  if (event.workflow_run?.event === 'merge_group') {
    await retireReplacedGroups(event.workflow_run, repository);
    return;
  }
  const unsettled = [];
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
    for (const status of ['queued', 'pending', 'in_progress']) {
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
        !['queued', 'pending', 'in_progress'].includes(live.status) ||
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
      try {
        await requestCancellation(run);
        console.log(
          `Requested cancellation of obsolete PR #${number} run ${run.id} (${run.head_sha}); current head ${pr.head.sha}`,
        );
        await settleObsoleteCancellation(run, pr, number, repository);
      } catch (error) {
        if (!(error instanceof CancellationNotSettled)) throw error;
        unsettled.push(error.message);
        console.log(`::warning::${error.message}`);
      }
    }
  }
  if (unsettled.length)
    console.log(
      `${unsettled.length} obsolete run(s) not yet terminal; the next PR: CI event for the branch retries them:\n${unsettled.join('\n')}`,
    );
}

/** Requests cancellation; a 409 refusal is warned about and returns false. */
async function requestOrWarn(run) {
  try {
    await requestCancellation(run);
    return true;
  } catch (error) {
    if (!(error instanceof CancellationNotSettled)) throw error;
    console.log(`::warning::${error.message}`);
    return false;
  }
}

async function requestCancellation(run) {
  const path = `actions/runs/${run.id}/cancel`;
  try {
    await github(path, { method: 'POST', responseBody: 'none' });
  } catch (error) {
    // GitHub answers 409 when it will not cancel the run in its current
    // state (observed on runs stuck queued with no jobs). Nothing was
    // cancelled, so there is nothing to settle.
    if (error.message === `GitHub POST ${path}: HTTP 409`)
      throw new CancellationNotSettled(
        `GitHub refused cancellation of run ${run.id} (HTTP 409)`,
      );
    throw error;
  }
}

if (invokedDirectly(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
