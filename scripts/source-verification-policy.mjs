import { readFileSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';

const SOURCE_VERIFICATION_CONTEXT = 'Source verification policy';
const CI_PATH = '.github/workflows/ci.yml';
const METADATA_RUN_NAME =
  "run-name: ${{ github.event_name == 'pull_request_target' && github.event.action == 'edited' && !github.event.changes.base && 'PR metadata' || 'Source verification' }}";
const SHA = /^[a-f0-9]{40}$/;
const pending = (description) => ({ state: 'pending', description });
const failure = (description) => ({ state: 'failure', description });

function ownerIdentity(pr) {
  return JSON.stringify([
    pr.number,
    pr.base?.ref,
    pr.base?.sha,
    pr.base?.repo?.id,
    pr.head?.sha,
    pr.head?.ref,
    pr.head?.repo?.id,
  ]);
}

function associatedOwner(run, owner) {
  return (
    Array.isArray(run.pull_requests) &&
    run.pull_requests.find(
      (pr) =>
        pr.number === owner.number &&
        pr.base?.ref === owner.base?.ref &&
        pr.base?.repo?.id === owner.base?.repo?.id &&
        pr.head?.sha === owner.head?.sha &&
        pr.head?.ref === owner.head?.ref &&
        pr.head?.repo?.id === owner.head?.repo?.id &&
        SHA.test(pr.base?.sha ?? ''),
    )
  );
}

function proofJob(jobs, name) {
  const names = Array.isArray(name) ? name : [name];
  const matches = jobs.filter((job) => names.includes(job.name));
  if (matches.length > 1) throw new Error(`Ambiguous source proof: ${name}`);
  return matches[0];
}

function proofRows(jobs) {
  return jobs
    .filter((job) =>
      [
        'fast-checks plan',
        'fast-checks statics',
        'fast-checks',
        'Fast checks execution',
        'Fork pull-request smoke',
      ].includes(job.name),
    )
    .map((job) => [job.id, job.name, job.status, job.conclusion]);
}

function jobState(job) {
  if (job?.status !== 'completed') return 'pending';
  if (job.conclusion === 'success') return 'success';
  if (job.conclusion === 'skipped') return 'skipped';
  if (
    [
      'failure',
      'cancelled',
      'timed_out',
      'action_required',
      'startup_failure',
      'stale',
    ].includes(job.conclusion)
  )
    return 'failure';
  return 'pending';
}

const METADATA_AGGREGATE_NAMES = [
  'fast-checks (metadata only)',
  "github.event_name == 'pull_request_target' && github.event.action == 'edited' && !github.event.changes.base && 'fast-checks (metadata only)' || 'fast-checks'",
];

function isCompletedMetadata(jobs, run, trustedCancelledMetadata) {
  if (new Set(jobs.map((job) => job.name)).size !== jobs.length) return false;
  if (
    run.status !== 'completed' ||
    !(
      ['success', 'failure'].includes(run.conclusion) ||
      (trustedCancelledMetadata && run.conclusion === 'cancelled')
    )
  )
    return false;
  const aggregate = jobs.filter((job) =>
    METADATA_AGGREGATE_NAMES.includes(job.name),
  );
  const title = jobs.filter((job) =>
    ['PR title', 'PR title status publisher'].includes(job.name),
  );
  if (
    aggregate.length !== 1 ||
    jobState(aggregate[0]) !== 'skipped' ||
    title.length !== 1 ||
    title[0].status !== 'completed' ||
    (run.conclusion === 'cancelled' && title[0].conclusion !== 'cancelled') ||
    !(
      ['success', 'failure'].includes(title[0].conclusion) ||
      (trustedCancelledMetadata && title[0].conclusion === 'cancelled')
    )
  )
    return false;
  return jobs.every((job) => job === title[0] || jobState(job) === 'skipped');
}

function sourceVerdict(jobs, fork, run, trustedCancelledMetadata = false) {
  const plan = jobState(proofJob(jobs, 'fast-checks plan'));
  const statics = jobState(proofJob(jobs, 'fast-checks statics'));
  const forkSmoke = jobState(proofJob(jobs, 'Fork pull-request smoke'));
  // Skipped check names may be literal GitHub expressions. Discriminate by
  // the actual producer jobs, never the aggregate's display-name expression.
  if (plan === 'skipped' && statics === 'skipped' && forkSmoke === 'skipped') {
    if (isCompletedMetadata(jobs, run, trustedCancelledMetadata)) return null;
    const aggregate = jobState(
      proofJob(jobs, ['fast-checks', 'Fast checks execution']),
    );
    if (
      aggregate === 'failure' ||
      (run.status === 'completed' &&
        [
          'failure',
          'cancelled',
          'timed_out',
          'action_required',
          'startup_failure',
          'stale',
        ].includes(run.conclusion))
    )
      return failure('Newest skipped source run failed or was cancelled');
    return pending(
      'Skipped source run is not a completed successful metadata run',
    );
  }
  const required = fork
    ? [forkSmoke]
    : [
        plan,
        statics,
        jobState(proofJob(jobs, ['fast-checks', 'Fast checks execution'])),
      ];
  if (required.includes('failure'))
    return failure('Newest source proof failed or was cancelled');
  if (required.every((state) => state === 'success'))
    return {
      state: 'success',
      description: 'Newest exact-owner source proof succeeded',
    };
  if (run.status === 'completed' && run.conclusion === 'cancelled')
    return failure('Newest source proof failed or was cancelled');
  return pending('Newest source proof is incomplete or unavailable');
}

export async function reconcileSourceVerification({
  repository,
  sourceSha,
  callerRunId,
  dryRun = false,
  event,
  eventName,
  apiUrl = 'https://api.github.com',
  token,
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? ''))
    throw new Error('Invalid repository');
  const sha =
    eventName === 'workflow_run' ? event?.workflow_run?.head_sha : sourceSha;
  if (!SHA.test(sha ?? '')) throw new Error('Missing exact source head');
  let wrote = false;
  const request = async (path, body) => {
    const response = await fetch(
      `${apiUrl}/repos/${repository}${path ? `/${path}` : ''}`,
      {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${path}`);
    return response.json();
  };
  const publish = async (verdict) => {
    const status = { context: SOURCE_VERIFICATION_CONTEXT, ...verdict };
    if (dryRun)
      console.log(
        JSON.stringify({ dryRun: true, sourceSha: sha, wouldPublish: status }),
      );
    else await request(`statuses/${sha}`, status);
    wrote = true;
    return verdict;
  };
  const pages = async (path, field) => {
    const result = [];
    let total;
    for (let page = 1; page <= 10; page += 1) {
      const response = await request(
        `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
      );
      const items = field ? response?.[field] : response;
      if (!Array.isArray(items) || items.length > 100)
        throw new Error('Malformed paginated evidence');
      if (field) {
        if (
          !Number.isSafeInteger(response.total_count) ||
          response.total_count < 0 ||
          response.total_count > 1000 ||
          (total !== undefined && total !== response.total_count)
        )
          throw new Error('Incomplete or changing evidence inventory');
        total = response.total_count;
      }
      result.push(...items);
      const identities = result.map((item) =>
        field ? item?.id : item?.number,
      );
      if (
        identities.some((id) => !Number.isSafeInteger(id)) ||
        new Set(identities).size !== identities.length
      )
        throw new Error('Duplicate or missing paginated evidence identity');
      if (items.length < 100) {
        if (total !== undefined && total !== result.length)
          throw new Error('Truncated evidence inventory');
        return result;
      }
    }
    throw new Error('Evidence pagination exceeded bound');
  };
  try {
    const workflow = await request('actions/workflows/ci.yml');
    const repo = await request('');
    if (
      eventName === 'workflow_run' &&
      !Number.isSafeInteger(event?.workflow_run?.id)
    )
      throw new Error('Missing triggering run ID');
    if (
      workflow.path !== CI_PATH ||
      workflow.name !== 'PR: CI' ||
      !Number.isSafeInteger(workflow.id) ||
      !Number.isSafeInteger(repo.id)
    )
      throw new Error('Untrusted source workflow identity');
    if (
      ['workflow_run', 'pull_request_target', 'merge_group'].includes(eventName)
    ) {
      const triggerId =
        eventName === 'workflow_run'
          ? event.workflow_run.id
          : Number(callerRunId);
      if (!Number.isSafeInteger(triggerId) || triggerId < 1)
        throw new Error('Missing trusted calling run ID');
      const trigger = await request(`actions/runs/${triggerId}`);
      if (
        trigger.head_sha !== sha ||
        trigger.workflow_id !== workflow.id ||
        trigger.path !== CI_PATH ||
        !['pull_request_target', 'merge_group'].includes(trigger.event)
      )
        throw new Error('Untrusted triggering run');
    } else if (eventName !== 'workflow_dispatch')
      throw new Error('Unsupported reconciliation event');

    const metadataWorkflows = new Map();
    const trustedCancelledMetadata = async (run, sourceBase) => {
      if (
        run.status !== 'completed' ||
        run.conclusion !== 'cancelled' ||
        run.event !== 'pull_request_target' ||
        run.name !== 'PR metadata' ||
        run.display_title !== 'PR metadata'
      )
        return false;
      const refs = (run.referenced_workflows ?? []).filter(
        (ref) =>
          ref.path ===
            `${repository}/.github/workflows/source-verification-policy.yml@${sourceBase}` &&
          ref.sha === sourceBase &&
          ref.ref === 'refs/heads/main',
      );
      if (refs.length !== 1) return false;
      if (!metadataWorkflows.has(sourceBase)) {
        const file = await request(`contents/${CI_PATH}?ref=${sourceBase}`);
        if (
          file.path !== CI_PATH ||
          file.encoding !== 'base64' ||
          typeof file.content !== 'string'
        )
          throw new Error('Unavailable immutable metadata workflow');
        const header = Buffer.from(file.content, 'base64')
          .toString('utf8')
          .split(/\r?\n/);
        metadataWorkflows.set(
          sourceBase,
          header[0] === 'name: "PR: CI"' && header[1] === METADATA_RUN_NAME,
        );
      }
      return metadataWorkflows.get(sourceBase);
    };

    const snapshot = async () => {
      const associated = await pages(`commits/${sha}/pulls`);
      const owners = associated.filter(
        (pr) =>
          pr.state === 'open' &&
          pr.base?.ref === 'main' &&
          pr.head?.sha === sha,
      );
      for (const owner of owners) {
        if (
          !SHA.test(owner.base?.sha ?? '') ||
          !owner.head?.ref ||
          !Number.isSafeInteger(owner.head?.repo?.id) ||
          owner.base?.repo?.id !== repo.id
        )
          throw new Error('Incomplete source owner identity');
      }
      const runs = await pages(
        `actions/workflows/${workflow.id}/runs?head_sha=${sha}`,
        'workflow_runs',
      );
      const eligible = runs.filter(
        (run) =>
          run.workflow_id === workflow.id &&
          run.path === CI_PATH &&
          run.head_sha === sha &&
          ['pull_request_target', 'merge_group'].includes(run.event),
      );
      // Run IDs order initial runs, not reruns. Resolve the current attempt's
      // own start time so an old run's later rerun cannot borrow a newer ID's
      // prior success. Missing attempt identity/timestamps fail closed.
      const attempts = [];
      for (const summary of eligible) {
        const current = await request(`actions/runs/${summary.id}`);
        if (
          !Number.isSafeInteger(current.run_attempt) ||
          current.run_attempt < 1
        )
          throw new Error('Missing source attempt');
        const attempt = await request(
          `actions/runs/${summary.id}/attempts/${current.run_attempt}`,
        );
        if (
          attempt.id !== summary.id ||
          attempt.workflow_id !== workflow.id ||
          attempt.path !== CI_PATH ||
          attempt.head_sha !== sha ||
          attempt.event !== summary.event ||
          attempt.run_attempt !== current.run_attempt ||
          !Number.isFinite(Date.parse(attempt.run_started_at))
        )
          throw new Error('Untrusted source attempt identity');
        attempts.push(attempt);
      }
      attempts.sort(
        (left, right) =>
          Date.parse(right.run_started_at) - Date.parse(left.run_started_at) ||
          right.id - left.id,
      );
      const examined = [];
      const verdicts = [];
      for (const owner of owners) {
        let verdict = pending('No source proof for an open exact-head owner');
        let selectedTime;
        const tiedProofs = [];
        for (const run of attempts.filter(
          (run) =>
            run.event === 'pull_request_target' && associatedOwner(run, owner),
        )) {
          const started = Date.parse(run.run_started_at);
          if (selectedTime !== undefined && started < selectedTime) break;
          const sourceBase = associatedOwner(run, owner).base.sha;
          const liveBase = owner.base.sha;
          let compatibleBase = sourceBase === liveBase;
          if (!compatibleBase) {
            const comparison = await request(
              `compare/${sourceBase}...${liveBase}`,
            );
            compatibleBase =
              ['ahead', 'identical'].includes(comparison.status) &&
              comparison.merge_base_commit?.sha === sourceBase;
          }
          const jobs = await pages(
            `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
            'jobs',
          );
          const verifiedMetadata = await trustedCancelledMetadata(
            run,
            sourceBase,
          );
          const classified = sourceVerdict(
            jobs,
            owner.head.repo.id !== repo.id,
            run,
            verifiedMetadata,
          );
          const proof = classified;
          examined.push([
            run.id,
            run.run_attempt,
            run.run_started_at,
            sourceBase,
            liveBase,
            compatibleBase,
            classified === null ? run.status : null,
            proofRows(jobs),
            verifiedMetadata ? sourceBase : null,
          ]);
          if (proof) {
            selectedTime = started;
            tiedProofs.push(
              compatibleBase
                ? proof
                : pending('Source base diverged from the live main target'),
            );
          }
        }
        if (tiedProofs.length)
          verdict =
            tiedProofs.find((proof) => proof.state === 'failure') ??
            tiedProofs.find((proof) => proof.state === 'pending') ??
            tiedProofs[0];
        verdicts.push(verdict);
      }
      // Merge-group heads do not own live PR heads. Only a genuine synthesized
      // main-queue run can certify that separate identity.
      if (owners.length === 0) {
        const summary = attempts.find((run) => run.event === 'merge_group');
        if (
          !summary ||
          !/^gh-readonly-queue\/main\//.test(summary.head_branch ?? '')
        )
          return {
            verdict: pending('No live source owner or main merge-group proof'),
            fingerprint: JSON.stringify([
              owners,
              attempts.map((run) => [
                run.id,
                run.run_attempt,
                run.run_started_at,
              ]),
            ]),
          };
        const run = summary;
        if (
          run.workflow_id !== workflow.id ||
          run.path !== CI_PATH ||
          run.head_sha !== sha ||
          run.event !== 'merge_group' ||
          !/^gh-readonly-queue\/main\//.test(run.head_branch ?? '') ||
          !Number.isSafeInteger(run.run_attempt)
        )
          throw new Error('Untrusted merge-group identity');
        const jobs = await pages(
          `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
          'jobs',
        );
        verdicts.push(
          sourceVerdict(jobs, false, run) ??
            pending('Merge-group source proof was skipped'),
        );
        examined.push([run.id, run.run_attempt, proofRows(jobs)]);
      }
      const verdict = verdicts.find((value) => value.state === 'failure') ??
        verdicts.find((value) => value.state === 'pending') ?? {
          state: 'success',
          description: 'All exact-owner source proofs succeeded',
        };
      return {
        verdict,
        fingerprint: JSON.stringify([
          owners.map(ownerIdentity).sort(),
          attempts.map((run) => [run.id, run.run_attempt, run.run_started_at]),
          examined,
        ]),
      };
    };
    const initial = await snapshot();
    const current = await snapshot();
    console.log(
      JSON.stringify({
        sourceSha: sha,
        evidence: JSON.parse(current.fingerprint),
        verdict: current.verdict,
      }),
    );
    if (initial.fingerprint !== current.fingerprint)
      return await publish(
        pending('Source owners or evidence changed during reconciliation'),
      );
    return await publish(current.verdict);
  } catch (error) {
    // A failed inventory or API read must invalidate an older success. If the
    // status API itself is unavailable, fail the publisher instead of claiming
    // the old status was replaced.
    if (!wrote)
      await publish(
        pending('Source evidence unavailable; reconciliation failed'),
      );
    throw error;
  }
}

if (invokedDirectly(import.meta.url)) {
  try {
    const arguments_ = process.argv.slice(2);
    if (arguments_.some((argument) => argument !== '--dry-run'))
      throw new Error('Usage: source-verification-policy.mjs [--dry-run]');
    const dryRun = arguments_.includes('--dry-run');
    await reconcileSourceVerification({
      dryRun,
      repository: process.env.GITHUB_REPOSITORY,
      sourceSha: process.env.SOURCE_SHA,
      callerRunId: process.env.GITHUB_RUN_ID,
      event: process.env.GITHUB_EVENT_PATH
        ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
        : {},
      eventName:
        process.env.GITHUB_EVENT_NAME || (dryRun ? 'workflow_dispatch' : ''),
      apiUrl: process.env.GITHUB_API_URL,
      token: process.env.GH_TOKEN,
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
