#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { github, listGithub } from './qualification-evidence.mjs';
import { QUALIFICATION_GATE_JOB } from './qualification-repair.mjs';

const TITLE = 'Main qualification health';
const HOUR = 60 * 60_000;

/** Observe qualification without starting a run or retrying a repair. */
export async function checkQualificationHealth(
  env = process.env,
  now = Date.now(),
) {
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
  const since = new Date(now - 48 * HOUR).toISOString();
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
    const gates = jobs.filter((job) => job.name === QUALIFICATION_GATE_JOB);
    const gate = gates.length === 1 ? gates[0] : null;
    const starts = jobs
      .filter(
        (job) => job.name.startsWith('qualification / ') && job.started_at,
      )
      .map((job) => Date.parse(job.started_at));
    if (starts.some((at) => !Number.isFinite(at) || at > now))
      throw new Error('Invalid qualification job start');
    const passed =
      gate?.conclusion === 'success' && gate.status === 'completed';
    const completed = passed ? Date.parse(gate.completed_at) : null;
    if (passed && (!Number.isFinite(completed) || completed > now))
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
  const failures = observed
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
  const manualRuns = await listGithub(
    `actions/workflows/nightly.yml/runs?branch=main&created=${encodeURIComponent(`>=${since}`)}`,
    'workflow_runs',
    options,
  );
  const recoveries = [];
  for (const run of manualRuns.filter(
    (run) =>
      run.path === '.github/workflows/nightly.yml' &&
      run.head_repository?.full_name === env.GITHUB_REPOSITORY &&
      run.head_branch === 'main' &&
      run.event === 'workflow_dispatch' &&
      run.status === 'completed',
  )) {
    const jobs = await listGithub(
      `actions/runs/${run.id}/jobs`,
      'jobs',
      options,
    );
    recoveries.push({ run, jobs });
  }
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
        item.jobs.some((job) =>
          leg === 'native'
            ? job.name.endsWith(
                '3 · Publish native cohort / Record ledger and markers',
              ) && job.conclusion === 'success'
            : job.name.endsWith('3 · Publish CLI to npm nightly') &&
              job.conclusion === 'success' &&
              job.steps?.some(
                (step) =>
                  step.name ===
                    'Bind the published CLI receipt to npm registry provenance' &&
                  step.conclusion === 'success',
              ),
        ),
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
  if (pendingDelivery)
    reasons.push(
      'Source qualification passed, but its Nightly decision or publication did not complete successfully.',
    );
  if (env.STATION_QUALIFIED_NIGHTLY !== 'enabled')
    reasons.push(
      'Qualification-driven Nightly delivery is disabled (STATION_QUALIFIED_NIGHTLY must be enabled).',
    );

  const lines = [
    'Owner: repository release maintainers; failed-source repair remains in the **Main qualification repair** episode.',
    '',
    ...reasons.map((reason) => `- ${reason}`),
    '',
    latest
      ? `Latest run: ${latest.run.html_url} (${latest.run.status}; ${latest.run.conclusion || 'pending'}), source \`${latest.run.head_sha}\`.`
      : 'No canonical main qualification run found in the last 48 hours.',
    green
      ? `Latest passing gate: ${green.run.html_url}, source \`${green.run.head_sha}\`, completed ${new Date(green.completed).toISOString()}.`
      : 'No passing qualification gate found in the last 48 hours.',
    pendingDelivery
      ? `Unresolved qualified delivery: ${pendingDelivery.failures.map((failure) => `${failure.legs[0]} https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${failure.id}`).join('; ')}. A later skipped publication does not resolve it.`
      : 'No failed qualified delivery run found in the last 48 hours.',
    '',
    'Inspect runner availability, schedule delays, failing jobs and the existing repair episode. Review its previous attempt before authorizing another repair. Manual recovery: `gh workflow run ' +
      (pendingDelivery ? 'nightly.yml' : 'main-qualification.yml') +
      ' --repo ' +
      env.GITHUB_REPOSITORY +
      (pendingDelivery ? ' --ref main`.' : ' --ref main -F force=true`.'),
    'This watchdog launches no tests, dispatches no runs and changes no publication authority. Nightly remains bound to an exact qualified source.',
  ];
  if (reasons.length) {
    const body =
      lines.join('\n') +
      (pendingDelivery
        ? `\n\n<!-- station-qualification-health:${JSON.stringify(pendingDelivery)} -->`
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
    : `Main qualification is fresh: ${green.run.html_url}, source \`${green.run.head_sha}\`.`;
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
