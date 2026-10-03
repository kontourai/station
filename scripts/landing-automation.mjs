#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { github, listGithub } from './qualification-evidence.mjs';

export function eligibleLanding(pr, run, repository) {
  return (
    pr.state === 'open' &&
    !pr.draft &&
    pr.base?.ref === 'main' &&
    pr.head?.repo?.full_name === repository &&
    pr.head?.sha === run.head_sha &&
    pr.labels?.some((label) => label.name === 'station-autoland') &&
    !pr.auto_merge &&
    pr.mergeable_state !== 'dirty'
  );
}
async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  let run = event.workflow_run;
  let prs;
  if (event.pull_request) {
    const pr = await github(`pulls/${event.pull_request.number}`);
    const runs = await listGithub(
      `actions/workflows/ci.yml/runs?head_sha=${pr.head.sha}`,
      'workflow_runs',
      {
        env: { ...process.env, GH_TOKEN: process.env.ACTIONS_TOKEN },
      },
    );
    run = runs
      .filter(
        (item) =>
          item.event === 'pull_request_target' &&
          item.head_sha === pr.head.sha &&
          item.head_repository?.full_name === process.env.GITHUB_REPOSITORY,
      )
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    prs = [pr];
  } else prs = await listGithub('pulls?state=open', null);
  if (
    run?.conclusion !== 'success' ||
    run.event !== 'pull_request_target' ||
    run.head_repository?.full_name !== process.env.GITHUB_REPOSITORY
  )
    return;
  for (const candidate of prs.filter((pr) => pr.head?.sha === run.head_sha)) {
    const pr = await github(`pulls/${candidate.number}`);
    if (!eligibleLanding(pr, run, process.env.GITHUB_REPOSITORY)) continue;
    // A label is explicit standing landing intent. GitHub owns remaining
    // required checks and queue admission; this workflow never polls or bypasses.
    execFileSync(
      'gh',
      [
        'pr',
        'merge',
        String(pr.number),
        '--repo',
        process.env.GITHUB_REPOSITORY,
        '--auto',
      ],
      {
        stdio: 'inherit',
        timeout: 30_000,
        windowsHide: true,
      },
    );
  }
}
if (invokedDirectly(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
