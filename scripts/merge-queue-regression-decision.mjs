#!/usr/bin/env node
/**
 * Validate the same-run affected-test plan for bounded merge integration.
 * Deferred broad coverage remains explicit; only main/release full regression
 * can produce a full-qualification receipt. Invalid or foreign evidence blocks
 * integration instead of launching an expensive fallback corpus.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import {
  FULL_REGRESSION_LANES,
  MERGE_QUEUE_REGRESSION_CHECK,
  validateFastChecksPlan,
} from './lib/fast-checks-shards.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const FAST_PATH_SUMMARY = 'no deferred lane: fast path';

const USAGE =
  'usage: node scripts/merge-queue-regression-decision.mjs --plan=<file> --head=<sha> --base=<base>';
const OPTIONS = ['plan', 'head', 'base'];
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function invalid(reason) {
  return { integrationReady: false, fullRegression: true, reason };
}

function deferred(reason) {
  return { integrationReady: true, fullRegression: true, reason };
}

/**
 * @param {string | undefined} planText the plan's bytes, or undefined when
 *   the file could not be read
 * @param {{ head: string, base: string }} expected
 * @returns {{ integrationReady: boolean, fullRegression: boolean, reason: string }}
 */
function decideMergeQueueRegression(planText, { head, base }) {
  if (planText === undefined)
    return invalid('fast-checks plan is missing or unreadable: fail closed');
  let plan;
  try {
    plan = JSON.parse(planText);
  } catch {
    return invalid('fast-checks plan is not valid JSON: fail closed');
  }
  const errors = validateFastChecksPlan(plan);
  if (errors.length)
    return invalid(
      `fast-checks plan is invalid (${errors.slice(0, 3).join('; ')}): fail closed`,
    );
  if (plan.headSha !== head)
    return invalid(
      `fast-checks plan is for ${String(plan.headSha).slice(0, 12)}, not this candidate ${head.slice(0, 12)}: fail closed`,
    );
  if (plan.base !== base)
    return invalid(
      `fast-checks plan diffs against ${String(plan.base).slice(0, 40)}, not the queue base ${base.slice(0, 40)}: fail closed`,
    );
  if (!Array.isArray(plan.mergeQueueRegressionPaths))
    return invalid(
      'fast-checks plan does not record mergeQueueRegressionPaths: fail closed',
    );
  const covered = plan.deferredLanes.filter((lane) =>
    FULL_REGRESSION_LANES.includes(lane.id),
  );
  if (covered.length)
    return deferred(
      `plan defers to ${covered.map((lane) => lane.id).join(', ')}: full qualification deferred to main/release`,
    );
  if (plan.mergeQueueRegressionPaths.length)
    return deferred(
      `consumers of ${plan.mergeQueueRegressionPaths.slice(0, 5).join(', ')}${plan.mergeQueueRegressionPaths.length > 5 ? ', ...' : ''} remain deferred: full qualification deferred to main/release`,
    );
  return {
    integrationReady: true,
    fullRegression: false,
    reason: FAST_PATH_SUMMARY,
  };
}

export function parseDecisionArgs(args) {
  const options = {};
  for (const argument of args) {
    const match = /^--([a-z]+)=(.+)$/.exec(argument);
    if (!match || !OPTIONS.includes(match[1]) || match[1] in options)
      throw new Error(USAGE);
    options[match[1]] = match[2];
  }
  if (OPTIONS.some((name) => !(name in options))) throw new Error(USAGE);
  if (!SHA_PATTERN.test(options.head))
    throw new Error(`--head must be a full commit sha\n${USAGE}`);
  return options;
}

export function main(args = process.argv.slice(2), env = process.env) {
  let options;
  try {
    options = parseDecisionArgs(args);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  let planText;
  try {
    planText = readFileSync(options.plan, 'utf8');
  } catch {
    planText = undefined;
  }
  const decision = decideMergeQueueRegression(planText, options);
  const line = `[${MERGE_QUEUE_REGRESSION_CHECK}] ${decision.integrationReady ? 'bounded integration plan accepted' : 'integration blocked'}: ${decision.reason}`;
  console.log(line);
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  if (env.GITHUB_OUTPUT)
    appendFileSync(
      env.GITHUB_OUTPUT,
      `integration-ready=${decision.integrationReady}\nfull-regression=${decision.fullRegression}\n`,
    );
  return decision.integrationReady ? 0 : 1;
}

if (invokedDirectly(import.meta.url)) process.exitCode = main();
