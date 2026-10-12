#!/usr/bin/env node
/**
 * Decides whether a merge-queue candidate needs the hosted full regression
 * (merge-queue-regression.yml, the required `Merge-queue regression` check).
 *
 * fast-checks runs only the affected tests its plan selects. When the plan
 * defers to a lane, `prepareChangedSelection` drops related discovery and
 * runs no explicit test above 32, so the suites a shared-package or
 * manifest change breaks never run before merge (#3200, #3251, #3114,
 * #3170, #3201). A path an impact edge marks `mergeQueueRegression` leaves
 * its consumers to the queue on purpose. Either way the candidate runs the
 * full regression; otherwise the queue keeps the fast path.
 *
 * Fail-closed: a missing, unreadable, invalid or foreign plan decides `full`,
 * never `fast`. Node alone; no dependencies, so it decides even when the
 * install or the planner failed.
 *
 *   node scripts/merge-queue-regression-decision.mjs \
 *     --plan=<file> --head=<sha> --base=<base>
 *
 * Writes `full-regression=true|false` to $GITHUB_OUTPUT and one summary line
 * to stdout and $GITHUB_STEP_SUMMARY. Exit 0 on any decision, 2 on a usage
 * fault (the workflow then runs the full regression anyway: its condition is
 * "unless the decision is exactly false").
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { validateFastChecksPlan } from './lib/fast-checks-shards.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

/** The required status context; ruleset 21782867 names it exactly. */
export const MERGE_QUEUE_REGRESSION_CHECK = 'Merge-queue regression';
export const FAST_PATH_SUMMARY = 'no deferred lane: fast path';
/**
 * The deferred lanes whose dropped tests the full regression stands in for.
 * Narrower lanes (an E2E or packaging leg) are not re-run here: the owner
 * chose this scope to keep the queue under the shared runner cap (#3149).
 */
export const FULL_REGRESSION_LANES = Object.freeze(['ci-fast', 'test-full']);

const USAGE =
  'usage: node scripts/merge-queue-regression-decision.mjs --plan=<file> --head=<sha> --base=<base>';
const OPTIONS = ['plan', 'head', 'base'];
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function full(reason) {
  return { fullRegression: true, reason };
}

/**
 * @param {string | undefined} planText the plan's bytes, or undefined when
 *   the file could not be read
 * @param {{ head: string, base: string }} expected
 * @returns {{ fullRegression: boolean, reason: string }}
 */
export function decideMergeQueueRegression(planText, { head, base }) {
  if (planText === undefined)
    return full('fast-checks plan is missing or unreadable: fail closed');
  let plan;
  try {
    plan = JSON.parse(planText);
  } catch {
    return full('fast-checks plan is not valid JSON: fail closed');
  }
  const errors = validateFastChecksPlan(plan);
  if (errors.length)
    return full(
      `fast-checks plan is invalid (${errors.slice(0, 3).join('; ')}): fail closed`,
    );
  if (plan.headSha !== head)
    return full(
      `fast-checks plan is for ${String(plan.headSha).slice(0, 12)}, not this candidate ${head.slice(0, 12)}: fail closed`,
    );
  if (plan.base !== base)
    return full(
      `fast-checks plan diffs against ${String(plan.base).slice(0, 40)}, not the queue base ${base.slice(0, 40)}: fail closed`,
    );
  if (!Array.isArray(plan.mergeQueueRegressionPaths))
    return full(
      'fast-checks plan does not record mergeQueueRegressionPaths: fail closed',
    );
  const covered = plan.deferredLanes.filter((lane) =>
    FULL_REGRESSION_LANES.includes(lane.id),
  );
  if (covered.length)
    return full(
      `plan defers to ${covered.map((lane) => lane.id).join(', ')}: full regression`,
    );
  if (plan.mergeQueueRegressionPaths.length)
    return full(
      `consumers of ${plan.mergeQueueRegressionPaths.slice(0, 5).join(', ')}${plan.mergeQueueRegressionPaths.length > 5 ? ', ...' : ''} run only in the merge queue: full regression`,
    );
  return { fullRegression: false, reason: FAST_PATH_SUMMARY };
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
  const line = `[${MERGE_QUEUE_REGRESSION_CHECK}] ${decision.fullRegression ? 'full regression' : 'fast path'}: ${decision.reason}`;
  console.log(line);
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  if (env.GITHUB_OUTPUT)
    appendFileSync(
      env.GITHUB_OUTPUT,
      `full-regression=${decision.fullRegression ? 'true' : 'false'}\n`,
    );
  return 0;
}

if (invokedDirectly(import.meta.url)) process.exitCode = main();
