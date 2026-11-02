#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { checkPrMergeability } from './pr-mergeability-admission.mjs';

const SHA = /^[0-9a-f]{40}$/;
const POSITIVE = /^[1-9][0-9]*$/;
const ATTEMPTS = 5;
const RETRY_MS = 6_000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Decide whether a same-repository pull request should spend runner time.
 *
 * Only a confirmed conflict defers: two consecutive observations, `retryMs`
 * apart, each reporting `mergeable: false` for an unchanged owner while main
 * stayed put (see checkPrMergeability). A conflicted candidate cannot merge,
 * so the plan, shards and statics would be discarded work. Every other
 * outcome, including GitHub still computing mergeability and API failures,
 * admits the run: deferral exists to save cost, so uncertainty must never
 * block a candidate from getting feedback.
 */
export async function admitPullRequest({
  env,
  check = checkPrMergeability,
  sleep = wait,
  attempts = ATTEMPTS,
  retryMs = RETRY_MS,
}) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const pr = event.pull_request;
  if (
    env.GITHUB_EVENT_NAME !== 'pull_request_target' ||
    env.GITHUB_REF !== 'refs/heads/main' ||
    !POSITIVE.test(String(pr?.number ?? '')) ||
    !SHA.test(pr?.head?.sha ?? '') ||
    pr?.base?.ref !== 'main' ||
    pr?.base?.repo?.full_name !== env.GITHUB_REPOSITORY ||
    pr?.head?.repo?.full_name !== env.GITHUB_REPOSITORY
  )
    throw new Error('untrusted PR admission event');
  let last = { reason: 'unobserved' };
  let conflicts = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      last = await check({
        number: pr.number,
        head: pr.head.sha,
        repository: env.GITHUB_REPOSITORY,
        env,
      });
    } catch (error) {
      last = { eligible: false, reason: `api-unavailable: ${error.message}` };
    }
    if (last.eligible) return { admitted: true, reason: last.reason };
    conflicts = last.reason === 'conflict' ? conflicts + 1 : 0;
    if (conflicts >= 2)
      return { admitted: false, reason: 'conflict', base: last.base };
    if (attempt < attempts) await sleep(retryMs);
  }
  return { admitted: true, reason: `inconclusive: ${last.reason}` };
}

async function main() {
  let result;
  try {
    result = await admitPullRequest({ env: process.env });
  } catch (error) {
    // Nothing is published, and the workflow gate defers only on an explicit
    // `admitted=false`, so an unreadable event cannot block a candidate.
    console.log(`::warning::PR admission unavailable: ${error.message}`);
    return;
  }
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `admitted=${result.admitted}\nreason=${result.reason}\n`,
    );
  if (!result.admitted) {
    console.log(
      `::error::This pull request conflicts with main (${result.base}); no source checks ran. Merge or rebase main, or re-run the failed jobs once the conflict is gone.`,
    );
    process.exitCode = 1;
  }
}

if (invokedDirectly(import.meta.url)) await main();
