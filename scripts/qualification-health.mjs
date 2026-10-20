#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { github, listGithub } from './qualification-evidence.mjs';
import { QUALIFICATION_GATE_JOB } from './qualification-repair.mjs';

const TITLE = 'Main qualification health';
const HOUR = 60 * 60_000;
const NIGHTLY_LIVE_STATES = new Set([
  'queued',
  'pending',
  'waiting',
  'requested',
  'in_progress',
]);
const NIGHTLY_TERMINAL_RESULTS = new Set([
  'success',
  'failure',
  'cancelled',
  'timed_out',
  'skipped',
  'neutral',
  'action_required',
  'startup_failure',
  'stale',
]);

function publishedLeg(jobs, leg) {
  return jobs.some(
    (job) =>
      job.status === 'completed' &&
      job.conclusion === 'success' &&
      (leg === 'native'
        ? job.name.endsWith(
            '3 · Publish native cohort / Record ledger and markers',
          )
        : job.name.endsWith('3 · Publish CLI to npm nightly') &&
          job.steps?.some(
            (step) =>
              step.name ===
                'Bind the published CLI receipt to npm registry provenance' &&
              step.status === 'completed' &&
              step.conclusion === 'success',
          )),
  );
}

/**
 * Observe qualification without starting a run or retrying a repair.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {number | (() => number)} [clock] A live clock, or a fixed observation time.
 */
export async function checkQualificationHealth(
  env = process.env,
  clock = Date.now,
) {
  const currentTime = typeof clock === 'function' ? clock : () => clock;
  const options = { env };
  const issues = await listGithub(
    'issues?state=all&labels=bug,P1',
    null,
    options,
  );
  const issue = issues.find(
    (item) =>
      !item.pull_request &&
      item.title === TITLE &&
      item.user?.login === 'github-actions[bot]',
  );
  const marker = /<!-- station-qualification-health:(\{[^\n]*\}) -->/.exec(
    issue?.state === 'open' ? issue.body : '',
  );
  const retained = marker ? JSON.parse(marker[1]) : null;
  if (
    retained &&
    (!Array.isArray(retained.failures) ||
      retained.failures.some(
        (failure) =>
          !Number.isSafeInteger(failure.id) ||
          failure.id <= 0 ||
          !Number.isFinite(Date.parse(failure.at)) ||
          !Array.isArray(failure.legs) ||
          !failure.legs.length ||
          failure.legs.some((leg) => !['native', 'cli'].includes(leg)),
      ))
  )
    throw new Error('Invalid retained delivery incident');
  if (
    retained?.stalled !== undefined &&
    (!Array.isArray(retained.stalled) ||
      retained.stalled.some(
        (item) =>
          !Number.isSafeInteger(item.id) ||
          item.id <= 0 ||
          !Number.isSafeInteger(item.attempt) ||
          item.attempt <= 0 ||
          !/^[0-9a-f]{40}$/.test(item.sourceSha ?? ''),
      ) ||
      new Set(retained.stalled.map((item) => item.id)).size !==
        retained.stalled.length)
  )
    throw new Error('Invalid retained Nightly identity');

  const since = new Date(currentTime() - 48 * HOUR).toISOString();
  const runs = (
    await listGithub(
      `actions/workflows/main-qualification.yml/runs?branch=main&created=${encodeURIComponent(`>=${since}`)}`,
      'workflow_runs',
      options,
    )
  )
    .filter(
      (run) =>
        run.path === '.github/workflows/main-qualification.yml' &&
        run.head_repository?.full_name === env.GITHUB_REPOSITORY &&
        run.head_branch === 'main' &&
        ['push', 'schedule', 'workflow_dispatch'].includes(run.event),
    )
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const observed = [];
  for (const run of runs) {
    const now = currentTime();
    if (
      !Number.isSafeInteger(run.id) ||
      !/^[0-9a-f]{40}$/.test(run.head_sha) ||
      !Number.isFinite(Date.parse(run.created_at)) ||
      Date.parse(run.created_at) > now
    )
      throw new Error('Invalid canonical qualification run');
    const jobs = await listGithub(
      `actions/runs/${run.id}/jobs`,
      'jobs',
      options,
    );
    const observedAt = currentTime();
    const gates = jobs.filter((job) => job.name === QUALIFICATION_GATE_JOB);
    const gate = gates.length === 1 ? gates[0] : null;
    const starts = jobs
      .filter(
        (job) => job.name.startsWith('qualification / ') && job.started_at,
      )
      .map((job) => Date.parse(job.started_at));
    if (starts.some((at) => !Number.isFinite(at) || at > observedAt))
      throw new Error('Invalid qualification job start');
    const passed =
      gate?.conclusion === 'success' && gate.status === 'completed';
    const completed = passed ? Date.parse(gate.completed_at) : null;
    if (passed && (!Number.isFinite(completed) || completed > observedAt))
      throw new Error('Invalid qualification completion');
    observed.push({
      run,
      passed,
      completed,
      started: starts.length ? Math.min(...starts) : null,
      jobs,
    });
  }
  const latest = observed[0];
  const recentNightly = await listGithub(
    `actions/workflows/nightly.yml/runs?branch=main&created=${encodeURIComponent(`>=${since}`)}`,
    'workflow_runs',
    options,
  );
  // Live work must not age out of the completed-history lookback.
  const liveNightly = await Promise.all(
    [...NIGHTLY_LIVE_STATES].map((status) =>
      listGithub(
        `actions/workflows/nightly.yml/runs?branch=main&status=${status}`,
        'workflow_runs',
        options,
      ),
    ),
  );
  const retainedNightly = await Promise.all(
    (retained?.stalled ?? []).map(async (item) => {
      const current = await github(`actions/runs/${item.id}`, options);
      if (
        current.id !== item.id ||
        current.head_sha !== item.sourceSha ||
        current.run_attempt !== item.attempt ||
        current.path !== '.github/workflows/nightly.yml' ||
        current.head_repository?.full_name !== env.GITHUB_REPOSITORY ||
        current.head_branch !== 'main' ||
        !['schedule', 'workflow_dispatch'].includes(current.event)
      )
        throw new Error('Retained Nightly identity changed');
      return current;
    }),
  );
  const nightlyRuns = [
    ...recentNightly,
    ...liveNightly.flat(),
    ...retainedNightly,
  ].filter(
    (run) =>
      run.path === '.github/workflows/nightly.yml' &&
      run.head_repository?.full_name === env.GITHUB_REPOSITORY &&
      run.head_branch === 'main' &&
      ['schedule', 'workflow_dispatch'].includes(run.event),
  );
  const canonicalNightly = new Map();
  for (const run of nightlyRuns) {
    const now = currentTime();
    const created = Date.parse(run.created_at);
    const updated = Date.parse(run.updated_at);
    if (
      !Number.isSafeInteger(run.id) ||
      run.id <= 0 ||
      !/^[0-9a-f]{40}$/.test(run.head_sha ?? '') ||
      !Number.isSafeInteger(run.run_attempt) ||
      run.run_attempt <= 0 ||
      !Number.isFinite(created) ||
      created > now ||
      !Number.isFinite(updated) ||
      updated < created ||
      updated > now ||
      (run.status === 'completed'
        ? !NIGHTLY_TERMINAL_RESULTS.has(run.conclusion)
        : !NIGHTLY_LIVE_STATES.has(run.status) || run.conclusion !== null)
    )
      throw new Error('Invalid canonical Nightly run');
    const previous = canonicalNightly.get(run.id);
    if (previous) {
      const identity = (item) =>
        JSON.stringify([
          item.id,
          item.run_attempt,
          item.head_sha,
          item.head_repository?.full_name,
          item.head_branch,
          item.path,
          item.event,
          item.created_at,
        ]);
      if (
        identity(previous) !== identity(run) ||
        (previous.updated_at === run.updated_at &&
          (previous.status !== run.status ||
            previous.conclusion !== run.conclusion))
      )
        throw new Error('Inconsistent Nightly run inventory');
      if (Date.parse(previous.updated_at) >= updated) continue;
    }
    canonicalNightly.set(run.id, run);
  }
  const nightlyObserved = [];
  for (const run of canonicalNightly.values()) {
    const created = Date.parse(run.created_at);
    const jobs = await listGithub(
      `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
      'jobs',
      options,
    );
    if (
      jobs.some(
        (job) =>
          job.run_id !== run.id ||
          job.run_attempt !== run.run_attempt ||
          job.head_sha !== run.head_sha,
      )
    )
      throw new Error('Invalid Nightly current-attempt job identity');
    const observedAt = currentTime();
    const sourceGate = jobs.filter(
      (job) => job.name === '1 · Source gate (lint, typecheck, browser smoke)',
    );
    if (sourceGate.length > 1) throw new Error('Ambiguous Nightly source gate');
    const passed =
      sourceGate.length === 1 &&
      sourceGate[0].status === 'completed' &&
      sourceGate[0].conclusion === 'success';
    if (
      passed &&
      (!Number.isFinite(Date.parse(sourceGate[0].completed_at)) ||
        Date.parse(sourceGate[0].completed_at) > observedAt)
    )
      throw new Error('Invalid Nightly source completion');
    nightlyObserved.push({ run, jobs, passed, created });
  }
  const now = currentTime();
  const recoveries = nightlyObserved.filter(
    (item) => item.run.status === 'completed',
  );
  const latestScheduled = nightlyObserved
    .filter((item) => item.run.event === 'schedule')
    .sort((a, b) => b.created - a.created)[0];
  const overdueNightly = nightlyObserved.filter(
    (item) =>
      NIGHTLY_LIVE_STATES.has(item.run.status) && now - item.created > 6 * HOUR,
  );
  const retainedIds = new Set((retained?.stalled ?? []).map((item) => item.id));
  const terminalSourceCandidates = recoveries.filter(
    (item) =>
      retainedIds.has(item.run.id) &&
      item.run.conclusion !== 'success' &&
      !item.passed,
  );
  const sourceRecoveries = new Map();
  for (const item of terminalSourceCandidates) {
    const recovery = recoveries.find(
      (later) =>
        later.run.conclusion === 'success' &&
        later.passed &&
        later.created > Date.parse(item.run.updated_at) &&
        later.jobs.some(
          (job) =>
            job.name === '1 · Source gate (lint, typecheck, browser smoke)' &&
            Date.parse(job.completed_at) > Date.parse(item.run.updated_at),
        ) &&
        (publishedLeg(later.jobs, 'native') || publishedLeg(later.jobs, 'cli')),
    );
    if (recovery) sourceRecoveries.set(item.run.id, recovery);
  }
  const terminalSourceFailures = terminalSourceCandidates.filter(
    (item) => !sourceRecoveries.has(item.run.id),
  );
  const sourceRecoveryNotes = [...sourceRecoveries].map(
    ([id, recovery]) =>
      `Retained Nightly source failure https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${id} recovered by successful source verification and publication in https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${recovery.run.id}, source \`${recovery.run.head_sha}\`.`,
  );
  const stalled = [...overdueNightly, ...terminalSourceFailures].map(
    (item) => ({
      id: item.run.id,
      sourceSha: item.run.head_sha,
      attempt: item.run.run_attempt,
    }),
  );
  const failures = [...observed, ...recoveries]
    .filter(
      (item) =>
        item.passed &&
        item.run.status === 'completed' &&
        item.run.conclusion !== 'success',
    )
    .map((item) => {
      const failed = item.jobs.filter((job) =>
        ['failure', 'timed_out', 'cancelled'].includes(job.conclusion),
      );
      const cli = failed.some((job) =>
        job.name.endsWith('3 · Publish CLI to npm nightly'),
      );
      const native = failed.some(
        (job) => !job.name.endsWith('3 · Publish CLI to npm nightly'),
      );
      return {
        id: item.run.id,
        at: item.run.updated_at,
        legs: [...(native || !cli ? ['native'] : []), ...(cli ? ['cli'] : [])],
      };
    });
  if (failures.some((item) => !Number.isFinite(Date.parse(item.at))))
    throw new Error('Invalid failed delivery timestamp');
  const incidents = [...failures, ...(retained?.failures ?? [])];
  const successfulDeliveries = [...observed, ...recoveries].filter(
    (item) => item.run.status === 'completed',
  );
  const pending = [];
  for (const leg of ['native', 'cli']) {
    const failed = incidents
      .filter((failure) => failure.legs.includes(leg))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    if (!failed) continue;
    const recovered = successfulDeliveries.some(
      (item) =>
        Number.isFinite(Date.parse(item.run.updated_at)) &&
        Date.parse(item.run.updated_at) <= now &&
        Date.parse(item.run.updated_at) > Date.parse(failed.at) &&
        publishedLeg(item.jobs, leg),
    );
    if (!recovered) pending.push({ ...failed, legs: [leg] });
  }
  const pendingDelivery = pending.length ? { failures: pending } : null;
  const green = observed
    .filter((item) => item.passed)
    .sort((a, b) => b.completed - a.completed)[0];
  const started = observed
    .filter((item) => item.started !== null)
    .sort((a, b) => b.started - a.started)[0];
  const reasons = [];
  if (!started || now - started.started > 8 * HOUR)
    reasons.push(
      'No qualification job has started within 8 hours (conservative start freshness bound).',
    );
  if (!green || now - green.completed > 14 * HOUR)
    reasons.push(
      'No successful source qualification within 14 hours (conservative successful-source freshness bound).',
    );
  if (
    observed.some(
      (item) =>
        !item.passed &&
        item.run.status !== 'completed' &&
        now - Date.parse(item.run.created_at) > 3 * HOUR,
    )
  )
    reasons.push(
      'The latest qualification has remained queued or running for more than 3 hours.',
    );
  if (!latestScheduled || now - latestScheduled.created > 4 * HOUR)
    reasons.push(
      'No scheduled Nightly request within 4 hours (schedule freshness bound; manual runs do not establish scheduled liveness).',
    );
  for (const item of overdueNightly)
    reasons.push(
      `Nightly ${item.passed ? 'delivery wait' : 'source admission/execution wait'} exceeds 6 hours: https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${item.run.id}, source \`${item.run.head_sha}\`, attempt ${item.run.run_attempt}, status ${item.run.status}, requested ${item.run.created_at}, elapsed ${Math.floor((now - item.created) / 60_000)} minutes. This is an escalation bound, not a delivery guarantee.`,
    );
  for (const item of terminalSourceFailures)
    reasons.push(
      `Retained Nightly source attempt ended ${item.run.conclusion} without successful source verification: https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${item.run.id}, source \`${item.run.head_sha}\`, attempt ${item.run.run_attempt}. A later cadence skip does not resolve this failure.`,
    );
  if (pendingDelivery)
    reasons.push(
      'A source gate passed, but its Nightly decision or publication did not complete successfully.',
    );

  const nightlyNeedsAttention =
    pendingDelivery ||
    !latestScheduled ||
    now - latestScheduled.created > 4 * HOUR ||
    stalled.length > 0;
  const lines = [
    'Owner: repository release maintainers; failed-source repair remains in the **Main qualification repair** episode.',
    '',
    ...reasons.map((reason) => `- ${reason}`),
    ...sourceRecoveryNotes,
    '',
    latest
      ? `Latest run: ${latest.run.html_url} (${latest.run.status}; ${latest.run.conclusion || 'pending'}), source \`${latest.run.head_sha}\`.`
      : 'No canonical main qualification run found in the last 48 hours.',
    latestScheduled
      ? `Latest scheduled Nightly request: https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${latestScheduled.run.id}, source \`${latestScheduled.run.head_sha}\`, created ${latestScheduled.run.created_at}.`
      : 'No canonical scheduled Nightly request found in the last 48 hours.',
    green
      ? `Latest passing gate: ${green.run.html_url}, source \`${green.run.head_sha}\`, completed ${new Date(green.completed).toISOString()}.`
      : 'No passing qualification gate found in the last 48 hours.',
    pendingDelivery
      ? `Unresolved Nightly delivery: ${pendingDelivery.failures.map((failure) => `${failure.legs[0]} https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${failure.id}`).join('; ')}. A later skipped publication does not resolve it.`
      : 'No failed Nightly delivery run found in the last 48 hours.',
    '',
    overdueNightly.length
      ? 'Inspect and resolve the existing Nightly run owner before considering a manual dispatch; this observer neither cancels nor duplicates live work.'
      : 'Inspect runner availability, schedule delays, failing jobs and the existing repair episode. Review its previous attempt before authorizing another repair. Manual recovery: `gh workflow run ' +
        (nightlyNeedsAttention ? 'nightly.yml' : 'main-qualification.yml') +
        ' --repo ' +
        env.GITHUB_REPOSITORY +
        (nightlyNeedsAttention
          ? ' --ref main`.'
          : ' --ref main -F force=true`.'),
    'This watchdog launches no tests, dispatches no runs and changes no publication authority. Nightly requires its exact-source usability gate; Beta and stable require full qualification.',
  ];
  if (reasons.length) {
    const body =
      lines.join('\n') +
      (pendingDelivery || stalled.length
        ? `\n\n<!-- station-qualification-health:${JSON.stringify({ failures: pendingDelivery?.failures ?? [], ...(stalled.length ? { stalled } : {}) })} -->`
        : '');
    if (issue?.state !== 'open' || issue.body !== body)
      await github(issue ? `issues/${issue.number}` : 'issues', {
        env,
        method: issue ? 'PATCH' : 'POST',
        body: { title: TITLE, body, state: 'open', labels: ['bug', 'P1'] },
      });
  } else if (issue?.state === 'open') {
    await github(`issues/${issue.number}`, {
      env,
      method: 'PATCH',
      body: { state: 'closed', state_reason: 'completed' },
    });
  }
  const summary = reasons.length
    ? lines.join('\n')
    : [
        `Main qualification is fresh: ${green.run.html_url}, source \`${green.run.head_sha}\`.`,
        ...sourceRecoveryNotes,
      ].join('\n');
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  return { healthy: reasons.length === 0, reasons, summary };
}

if (invokedDirectly(import.meta.url)) {
  checkQualificationHealth()
    .then((result) => console.log(result.summary))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
