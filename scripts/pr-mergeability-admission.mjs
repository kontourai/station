#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { github } from './qualification-evidence.mjs';

const SHA = /^[0-9a-f]{40}$/;

function identity(pr) {
  return JSON.stringify([
    pr.number,
    pr.state,
    pr.base?.ref,
    pr.base?.sha,
    pr.base?.repo?.full_name,
    pr.base?.repo?.id,
    pr.head?.ref,
    pr.head?.sha,
    pr.head?.repo?.full_name,
    pr.head?.repo?.id,
    pr.mergeable,
    pr.merge_commit_sha,
  ]);
}

/** Read the live owner and main before and after the mergeability observation. */
export async function checkPrMergeability({ number, head, repository, env }) {
  if (
    !Number.isSafeInteger(number) ||
    number < 1 ||
    !SHA.test(head ?? '') ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')
  )
    throw new Error('invalid PR admission identity');
  const options = { env: { ...env, GITHUB_REPOSITORY: repository } };
  const firstRef = await github('git/ref/heads/main', options);
  const first = await github(`pulls/${number}`, options);
  const merge =
    first.mergeable === true && SHA.test(first.merge_commit_sha ?? '')
      ? await github(`git/commits/${first.merge_commit_sha}`, options)
      : null;
  const second = await github(`pulls/${number}`, options);
  const lastRef = await github('git/ref/heads/main', options);
  const base = firstRef?.object?.sha;
  if (
    !SHA.test(base ?? '') ||
    firstRef?.ref !== 'refs/heads/main' ||
    lastRef?.ref !== 'refs/heads/main' ||
    firstRef?.object?.type !== 'commit' ||
    lastRef?.object?.type !== 'commit' ||
    lastRef?.object?.sha !== base ||
    identity(first) !== identity(second) ||
    first.number !== number ||
    first.state !== 'open' ||
    first.base?.ref !== 'main' ||
    first.base?.sha !== base ||
    first.base?.repo?.full_name !== repository ||
    first.head?.repo?.full_name !== repository ||
    !Number.isSafeInteger(first.base?.repo?.id) ||
    first.base.repo.id < 1 ||
    first.head?.repo?.id !== first.base.repo.id ||
    first.head?.sha !== head ||
    typeof first.head?.ref !== 'string' ||
    !first.head.ref
  )
    return { eligible: false, reason: 'identity-or-base-changed' };
  if (first.mergeable === false)
    return { eligible: false, reason: 'conflict', head, base };
  if (first.mergeable !== true)
    return { eligible: false, reason: 'mergeability-unknown', head, base };
  if (
    !merge ||
    merge.sha !== first.merge_commit_sha ||
    !Array.isArray(merge.parents) ||
    merge.parents.length !== 2 ||
    merge.parents[0]?.sha !== base ||
    merge.parents[1]?.sha !== head
  )
    return { eligible: false, reason: 'merge-identity-unknown', head, base };
  return { eligible: true, reason: 'mergeable', head, base };
}

/** Emit a diagnostic only; this receipt cannot qualify a source revision. */
export async function runDiagnostic(env) {
  if (
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_REF !== 'refs/heads/main' ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ||
    !SHA.test(env.GITHUB_WORKFLOW_SHA ?? '') ||
    env.GITHUB_SHA !== env.GITHUB_WORKFLOW_SHA ||
    !/^[1-9][0-9]*$/.test(env.STATION_DIAGNOSTIC_PR ?? '') ||
    !Number.isSafeInteger(Number(env.STATION_DIAGNOSTIC_PR)) ||
    !env.STATION_CONFLICT_RECEIPT_PATH
  )
    throw new Error('untrusted diagnostic event');
  const number = Number(env.STATION_DIAGNOSTIC_PR);
  const pr = await github(`pulls/${number}`, { env });
  const result = await checkPrMergeability({
    number,
    head: pr.head?.sha,
    repository: env.GITHUB_REPOSITORY,
    env,
  });
  if (result.reason !== 'conflict' || result.base !== env.GITHUB_WORKFLOW_SHA)
    throw new Error('current conflict unavailable');
  writeFileSync(
    env.STATION_CONFLICT_RECEIPT_PATH,
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'station-pr-conflict-signer-diagnostic',
      repository: env.GITHUB_REPOSITORY,
      pr: number,
      head: result.head,
      base: result.base,
      workflowSha: env.GITHUB_WORKFLOW_SHA,
      runId: env.GITHUB_RUN_ID,
      attempt: Number(env.GITHUB_RUN_ATTEMPT),
    })}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  return result;
}

async function main() {
  const env = process.env;
  const result = await runDiagnostic(env);
  console.log(JSON.stringify(result));
}

if (invokedDirectly(import.meta.url))
  main().catch((error) => {
    console.error(`Signer diagnostic unavailable: ${error.message}`);
    process.exitCode = 1;
  });
