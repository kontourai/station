#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { spawnSyncBounded } from './lib/bounded-capture.mjs';
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
    pr.mergeable_state !== 'dirty'
  );
}
function inspectAdmission(pr, repository) {
  const [owner, name] = repository.split('/');
  const result = spawnSyncBounded(
    'gh',
    [
      'api',
      'graphql',
      '-f',
      'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid isInMergeQueue autoMergeRequest{enabledAt}}}}',
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-F',
      `number=${pr.number}`,
    ],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true },
  );
  if (result.status !== 0 || result.error)
    throw new Error(`Could not verify queue admission for #${pr.number}`);
  const response = JSON.parse(result.stdout);
  const current = response?.data?.repository?.pullRequest;
  if (
    response.errors?.length ||
    !current ||
    typeof current.isInMergeQueue !== 'boolean'
  )
    throw new Error(`GitHub did not return queue admission for #${pr.number}`);
  if (current.headRefOid !== pr.head.sha)
    throw new Error(
      `#${pr.number} changed head while queue admission was checked`,
    );
  if (current.isInMergeQueue) return 'queued';
  if (current.autoMergeRequest?.enabledAt) return 'armed_waiting_for_queue';
  return 'not_armed';
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
    if (inspectAdmission(pr, process.env.GITHUB_REPOSITORY) === 'queued') {
      console.log(`landing: #${pr.number} already queued at ${pr.head.sha}`);
      continue;
    }
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
    const admission = inspectAdmission(pr, process.env.GITHUB_REPOSITORY);
    if (admission === 'not_armed')
      throw new Error(
        `GitHub accepted the command but #${pr.number} is neither armed nor queued`,
      );
    console.log(`landing: #${pr.number} ${admission} at ${pr.head.sha}`);
  }
}
if (invokedDirectly(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
