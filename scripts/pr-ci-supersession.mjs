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
      await github(`actions/runs/${run.id}/cancel`, { method: 'POST' });
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
