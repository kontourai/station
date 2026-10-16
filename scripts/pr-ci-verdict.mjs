import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { validatePullRequestTitle } from './commit-message-gate.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

/**
 * The required PR verdict runs only trusted base policy. Source jobs keep
 * their own immutable check name; a metadata run cannot replace them with a
 * skipped check or reuse another PR/head's success. Base SHA remains in the
 * run identity, but advancing main does not invalidate existing PR evidence
 * (the ruleset is non-strict). A base retarget creates fresh source work.
 */
export async function requirePullRequestVerdict({
  repository,
  event,
  request,
  wait = delay,
  now = Date.now,
  timeoutMs = 80 * 60_000,
}) {
  const number = event.pull_request?.number;
  const head = event.pull_request?.head?.sha;
  if (!/^[1-9]\d*$/.test(String(number)) || !/^[a-f0-9]{40}$/.test(head))
    throw new Error('Missing exact pull-request source identity');
  const prefix = `repos/${repository}`;
  const deadline = now() + timeoutMs;
  const livePullRequest = () => request(`${prefix}/pulls/${number}`);
  const checkLive = (pr) => {
    if (pr.head?.sha !== head || pr.base?.ref !== 'main')
      throw new Error('Pull request moved to another head or target');
    const verdict = validatePullRequestTitle(pr.title, number);
    if (!verdict.ok) throw new Error(`Pull-request title: ${verdict.reason}`);
  };
  const sourceRun = async () => {
    const identity = `ci-pr-${number}-${head}-main-`;
    // The Actions run title is emitted by base-controlled YAML, not an
    // artifact or candidate script. Keep pagination bounded and fail closed.
    for (let page = 1; page <= 10; page++) {
      const result = await request(
        `${prefix}/actions/workflows/ci.yml/runs?event=pull_request_target&per_page=100&page=${page}`,
      );
      const runs = result.workflow_runs;
      if (!Array.isArray(runs))
        throw new Error('Missing workflow run inventory');
      const run = runs.find(
        (entry) =>
          entry.display_title?.startsWith(identity) &&
          /^[a-f0-9]{40}-source$/.test(
            entry.display_title.slice(identity.length),
          ),
      );
      if (run) return run;
      if (runs.length < 100) return undefined;
    }
    throw new Error('Source run search exceeded its bounded inventory');
  };
  while (now() < deadline) {
    const pr = await livePullRequest();
    checkLive(pr);
    const run = await sourceRun();
    if (run) {
      const jobs = [];
      for (let page = 1; page <= 10; page++) {
        const result = await request(
          `${prefix}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
        );
        if (!Array.isArray(result.jobs))
          throw new Error('Missing source job inventory');
        jobs.push(...result.jobs);
        if (result.jobs.length < 100) break;
        if (page === 10)
          throw new Error('Source job search exceeded its bounded inventory');
      }
      const name =
        pr.head.repo.full_name === repository
          ? 'fast-checks source'
          : 'Fork pull-request smoke';
      const source = jobs.filter((job) => job.name === name);
      if (source.length > 1) throw new Error('Ambiguous source aggregate');
      if (source[0]?.status === 'completed') {
        if (source[0].conclusion !== 'success')
          throw new Error(
            `Source aggregate ${run.id}/${run.run_attempt}: ${source[0].conclusion}`,
          );
        // A correction or a delayed old event must validate the current title.
        // Also refuse success from an old attempt if a newer source run began.
        checkLive(await livePullRequest());
        const latest = await sourceRun();
        if (latest?.id === run.id && latest.run_attempt === run.run_attempt)
          return { runId: run.id, runAttempt: run.run_attempt, head };
      } else if (run.status === 'completed') {
        throw new Error(
          'Completed source run has no successful source aggregate',
        );
      }
    }
    await wait(15_000);
  }
  throw new Error(
    'Timed out waiting for exact source checks; no success inferred',
  );
}

if (invokedDirectly(import.meta.url)) {
  const env = process.env;
  const api = env.GITHUB_API_URL || 'https://api.github.com';
  const request = async (path) => {
    const response = await fetch(`${api}/${path}`, {
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${path}`);
    return response.json();
  };
  try {
    const result = await requirePullRequestVerdict({
      repository: env.GITHUB_REPOSITORY,
      event: JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')),
      request,
    });
    console.log(
      `Live title and source aggregate ${result.runId}/${result.runAttempt} verified for ${result.head}`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
