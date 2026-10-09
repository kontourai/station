#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { github, listGithub } from './qualification-evidence.mjs';

const TITLE = 'Main qualification repair';
const MARKER = /<!-- station-qualification:(\{[^\n]*\}) -->/;
export function repairState(body) {
  const match = MARKER.exec(body || '');
  if (!match) return null;
  const state = JSON.parse(match[1]);
  if (
    !Number.isSafeInteger(state.episode) ||
    !Number.isSafeInteger(state.failedRun) ||
    !/^[0-9a-f]{40}$/.test(state.failedSha) ||
    !Number.isFinite(Date.parse(state.openedAt)) ||
    !Number.isFinite(Date.parse(state.lastStartedAt))
  )
    throw new Error('Invalid repair episode');
  return state;
}
const REPAIR_AGENTS = ['codex'];
export const NO_AGENT_REASON =
  'No automated repair agent is configured (QUALIFICATION_REPAIR_AGENT); a person or a Station agent repairs this.';
/**
 * Resolve the QUALIFICATION_REPAIR_AGENT selector. Unset or blank means no
 * automated agent (null); anything but a known agent fails closed.
 */
export function repairAgent(value) {
  const agent = (value ?? '').trim();
  if (!agent) return null;
  if (!REPAIR_AGENTS.includes(agent))
    throw new Error(
      `Unknown QUALIFICATION_REPAIR_AGENT "${agent}"; expected one of: ${REPAIR_AGENTS.join(', ')} (or unset for no automated agent)`,
    );
  return agent;
}
export function nextRepairState(
  previous,
  run,
  { retry = false, agent = true, capacityDeferred = false } = {},
) {
  if (
    previous &&
    Date.parse(run.run_started_at) < Date.parse(previous.lastStartedAt)
  )
    return { state: previous, action: 'stale' };
  if (run.conclusion === 'success') return { state: previous, action: 'close' };
  if (!['failure', 'timed_out', 'cancelled'].includes(run.conclusion))
    return { state: previous, action: 'ignore' };
  const state = {
    ...(previous || { episode: run.id, openedAt: run.created_at }),
    failedRun: run.id,
    failedSha: run.head_sha,
    lastStartedAt: run.run_started_at,
    repairState: previous?.repairState || 'claimed',
  };
  if (capacityDeferred) {
    state.repairState = 'capacity-deferred';
    return { state, action: 'update' };
  }
  // Without an agent nothing owns the episode: record needs-owner, never a claim.
  if (!agent) {
    state.repairState = 'needs-owner';
    return { state, action: 'update' };
  }
  const claim = !previous || retry;
  if (claim) state.repairState = 'claimed';
  return { state, action: claim ? 'claim' : 'update' };
}
/**
 * The job that decides qualification inside a Main qualification run: the
 * `qualification` caller job's full-regression aggregate.
 */
export const QUALIFICATION_GATE_JOB =
  'qualification / Full source qualification';

/**
 * The run's conclusion as far as source qualification is concerned. A Main
 * qualification run also publishes the Nightly from the commit it qualified;
 * when that publication fails or is cancelled the run is red, but the source
 * passed, so it is not a repair episode. Only a successful gate job overrides
 * the run conclusion; a missing, skipped or failed gate keeps it.
 */
export function qualificationConclusion(run, jobs) {
  if (run.conclusion === 'success') return run.conclusion;
  const gates = jobs.filter((job) => job.name === QUALIFICATION_GATE_JOB);
  return gates.length === 1 && gates[0].conclusion === 'success'
    ? 'success'
    : run.conclusion;
}

export function validateRepairRun(run, repository) {
  if (
    run.path !== '.github/workflows/main-qualification.yml' ||
    run.head_repository?.full_name !== repository ||
    run.head_branch !== 'main' ||
    !['push', 'schedule', 'workflow_dispatch'].includes(run.event) ||
    run.status !== 'completed' ||
    !/^[0-9a-f]{40}$/.test(run.head_sha) ||
    !Number.isSafeInteger(run.id)
  )
    throw new Error(
      'Repair requires a completed canonical main qualification run',
    );
}
export function validateRepairPaths(paths) {
  if (!paths.length || paths.length > 40)
    throw new Error('Repair must change 1–40 paths');
  for (const path of paths) {
    if (
      !/^[\w./-]+$/.test(path) ||
      path.split('/').includes('..') ||
      /^(\.github\/|\.veritas\/|\.githooks\/|\.husky\/|\.gitmodules$|AGENTS\.md$|CLAUDE\.md$|veritas\.claims\.json$)/.test(
        path,
      ) ||
      /(^|\/)(AGENTS|CLAUDE)\.md$/.test(path) ||
      /^scripts\/(qualification-|actionlint-gate|verification-lanes|vitest-resource-manifest|dependency-lifecycle)/.test(
        path,
      )
    )
      throw new Error(
        `Repair requires owner review for protected path: ${path}`,
      );
  }
}
function issueBody(state, run, jobs, agent) {
  const failures = jobs
    .filter(
      (job) => job.conclusion !== 'success' && job.conclusion !== 'skipped',
    )
    .map(
      (job) =>
        `- ${job.name}: ${job.conclusion || job.status} (${job.html_url})`,
    )
    .join('\n');
  return (
    `Scheduled full qualification is red or incomplete. Release promotion remains blocked.\n\n` +
    (agent
      ? `Owner: automated qualification repair; state: **${state.repairState}**.\n`
      : `Owner: none assigned; state: **${state.repairState}**. ${NO_AGENT_REASON}\n`) +
    `Repair deadline: ${new Date(Date.parse(state.openedAt) + 24 * 60 * 60_000).toISOString()}.\n` +
    `Latest failed source: \`${state.failedSha}\`.\nRun: ${run.html_url}\n\n${failures}\n\n` +
    (agent
      ? `One bounded sweep owns this episode. Repeated runs update this report without starting another agent. ` +
        `Escalate startup, build, authentication, or data-integrity regressions immediately. ` +
        `Use the manual repair workflow with retry=true only after reviewing the previous attempt.\n\n`
      : `Repeated runs update this report. Escalate startup, build, authentication, or data-integrity regressions immediately.\n\n`) +
    `<!-- station-qualification:${JSON.stringify(state)} -->\n`
  );
}
function output(name, value) {
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
async function prepare() {
  const agent = repairAgent(process.env.QUALIFICATION_REPAIR_AGENT);
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const id = event.workflow_run?.id || Number(process.env.QUALIFICATION_RUN);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new Error('Qualification run ID required');
  const run = await github(`actions/runs/${id}`);
  validateRepairRun(run, process.env.GITHUB_REPOSITORY);
  const issues = await listGithub('issues?state=all&labels=bug,P1', null);
  const issue = issues.find(
    (item) =>
      !item.pull_request &&
      item.title === TITLE &&
      item.user?.login === 'github-actions[bot]',
  );
  const previous = issue?.state === 'open' ? repairState(issue.body) : null;
  if (issue?.state === 'open' && !previous)
    throw new Error('Open repair issue has no valid episode');
  const jobs = await listGithub(`actions/runs/${id}/jobs`, 'jobs');
  if (
    run.conclusion === 'cancelled' &&
    !jobs.some((job) => job.name.endsWith('Full source qualification'))
  ) {
    output('claim', 'false');
    return;
  }
  const capacityDeferred = jobs.some(
    (job) =>
      job.conclusion === 'failure' &&
      job.steps?.some(
        (step) =>
          step.name === 'Admit fresh qualification before expensive fanout' &&
          step.conclusion === 'failure',
      ),
  );
  const decision = nextRepairState(
    previous,
    { ...run, conclusion: qualificationConclusion(run, jobs) },
    {
      retry: process.env.RETRY === 'true',
      agent: Boolean(agent),
      capacityDeferred,
    },
  );
  output('claim', 'false');
  if (['ignore', 'stale'].includes(decision.action)) return;
  if (decision.action === 'close') {
    if (issue?.state === 'open')
      await github(`issues/${issue.number}`, {
        method: 'PATCH',
        body: { state: 'closed', state_reason: 'completed' },
      });
    return;
  }
  const body =
    (capacityDeferred
      ? 'Capacity admission deferred before corpus execution. No automated source-repair attempt is launched; source remains unqualified.\n\n'
      : '') + issueBody(decision.state, run, jobs, agent);
  const saved = await github(issue ? `issues/${issue.number}` : 'issues', {
    method: issue ? 'PATCH' : 'POST',
    body: { title: TITLE, body, state: 'open', labels: ['bug', 'P1'] },
  });
  output('issue', saved.number);
  if (decision.action !== 'claim') return;
  output('claim', 'true');
  const attempt = `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`;
  if (!/^[1-9][0-9]*-[1-9][0-9]*$/.test(attempt))
    throw new Error('Invalid repair attempt identity');
  const base = await github('branches/main');
  const context = {
    episode: decision.state.episode,
    issue: saved.number,
    failedRun: id,
    failedSha: run.head_sha,
    baseSha: base.commit.sha,
    attempt,
    branch: `repair/qualification-${decision.state.episode}-${attempt}`,
    runUrl: run.html_url,
    failures: jobs
      .filter((job) => job.conclusion !== 'success')
      .map((job) => ({
        name: job.name,
        conclusion: job.conclusion,
        url: job.html_url,
      })),
  };
  writeFileSync('repair-context.json', `${JSON.stringify(context, null, 2)}\n`);
  // The failed run is trusted main evidence. gh masks credentials and only
  // this read-only step has a GitHub token; the agent receives the log as data.
  const log = execFileSync(
    'gh',
    [
      'run',
      'view',
      String(id),
      '--repo',
      process.env.GITHUB_REPOSITORY,
      '--log-failed',
    ],
    {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 90_000,
      windowsHide: true,
    },
  );
  writeFileSync('qualification-failures.log', log);
  output('base_sha', context.baseSha);
  output('branch', context.branch);
  output('claim', 'true');
}
async function publish() {
  const context = JSON.parse(readFileSync(process.env.REPAIR_CONTEXT, 'utf8'));
  if (
    !Number.isSafeInteger(context.issue) ||
    !Number.isSafeInteger(context.episode) ||
    !/^[0-9a-f]{40}$/.test(context.baseSha) ||
    !/^\d+-\d+$/.test(context.attempt) ||
    context.branch !==
      `repair/qualification-${context.episode}-${context.attempt}`
  )
    throw new Error('Invalid repair context');
  const issueOptions = {
    env: {
      ...process.env,
      GH_TOKEN: process.env.ISSUE_TOKEN || process.env.GH_TOKEN,
    },
  };
  const issue = await github(`issues/${context.issue}`, issueOptions);
  const state = repairState(issue.body);
  if (issue.state !== 'open' || state?.episode !== context.episode) {
    console.log('Repair episode already resolved or superseded');
    return;
  }
  const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8', windowsHide: true });
  if (git('rev-parse', 'HEAD').trim() !== context.baseSha)
    throw new Error('Repair base does not match checkout');
  git('apply', '--check', process.env.REPAIR_PATCH);
  git('apply', '--index', process.env.REPAIR_PATCH);
  const paths = git('diff', '--name-only', 'HEAD')
    .trim()
    .split('\n')
    .filter(Boolean);
  validateRepairPaths(paths);
  git('diff', '--check');
  for (const line of git('diff', '--raw', 'HEAD').trim().split('\n')) {
    const mode = line.split(' ')[1];
    if (!['100644', '100755', '000000'].includes(mode))
      throw new Error('Repair cannot introduce symlinks or submodules');
  }
  git('config', 'user.name', 'github-actions[bot]');
  git(
    'config',
    'user.email',
    '41898282+github-actions[bot]@users.noreply.github.com',
  );
  git('add', '--', ...paths);
  git(
    'commit',
    '-m',
    `fix: repair scheduled qualification episode ${context.episode}`,
  );
  // Token exists only in this publishing job, never in the agent job or Git config.
  const auth = Buffer.from(`x-access-token:${process.env.GH_TOKEN}`).toString(
    'base64',
  );
  execFileSync('git', ['push', 'origin', `HEAD:refs/heads/${context.branch}`], {
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}`,
    },
    stdio: 'pipe',
    timeout: 90_000,
    windowsHide: true,
  });
  const pr = await github('pulls', {
    method: 'POST',
    body: {
      title: 'fix: repair scheduled main qualification',
      head: context.branch,
      base: 'main',
      body:
        `Repairs failures collected by ${context.runUrl}.\n\nQualification episode: #${context.issue}. ` +
        `Failed source: \`${context.failedSha}\`; repair base: \`${context.baseSha}\`.\n\n` +
        `The agent was bounded to one sweep. Required PR checks and independent review decide readiness. ` +
        `Fresh full qualification must pass after landing before release promotion.`,
    },
  });
  await github(`issues/${pr.number}/labels`, {
    ...issueOptions,
    method: 'POST',
    body: { labels: ['station-autoland'] },
  });
  state.repairState = 'pr-open';
  await github(`issues/${context.issue}`, {
    ...issueOptions,
    method: 'PATCH',
    body: {
      body: `${issue.body.replace(
        MARKER,
        `<!-- station-qualification:${JSON.stringify(state)} -->`,
      )}\nRepair PR: ${pr.html_url}\n`,
    },
  });
  console.log(pr.html_url);
}
async function settle() {
  const issueNumber = Number(process.env.REPAIR_ISSUE);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) return;
  const issue = await github(`issues/${issueNumber}`);
  const state = repairState(issue.body);
  if (issue.state !== 'open' || !state || state.repairState !== 'claimed')
    return;
  state.repairState = 'needs-owner';
  await github(`issues/${issueNumber}`, {
    method: 'PATCH',
    body: {
      body:
        issue.body.replace(
          MARKER,
          `<!-- station-qualification:${JSON.stringify(state)} -->`,
        ) +
        `\nBounded attempt finished without a repair PR. Inspect repair workflow run ${process.env.GITHUB_RUN_ID}; manual retry requires explicit retry=true.\n`,
    },
  });
}
async function afterMerge() {
  const { workflow_run: run } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'),
  );
  if (
    run?.event !== 'push' ||
    run.conclusion !== 'success' ||
    run.head_branch !== 'main' ||
    run.head_repository?.full_name !== process.env.GITHUB_REPOSITORY ||
    !/^[0-9a-f]{40}$/.test(run.head_sha)
  )
    return;
  const prs = await listGithub(`commits/${run.head_sha}/pulls`, null);
  if (
    !prs.some(
      (pr) =>
        pr.merged_at &&
        pr.merge_commit_sha === run.head_sha &&
        pr.head?.repo?.full_name === process.env.GITHUB_REPOSITORY &&
        /^repair\/qualification-[0-9]+-[0-9]+-[0-9]+$/.test(pr.head?.ref || ''),
    )
  )
    return;
  await github('actions/workflows/main-qualification.yml/dispatches', {
    method: 'POST',
    body: { ref: 'main', inputs: { force: true } },
  });
}
async function main() {
  if (process.argv[2] === 'prepare') await prepare();
  else if (process.argv[2] === 'publish') await publish();
  else if (process.argv[2] === 'settle') await settle();
  else if (process.argv[2] === 'after-merge') await afterMerge();
  else
    throw new Error(
      'Usage: qualification-repair.mjs prepare|publish|settle|after-merge',
    );
}
if (invokedDirectly(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
