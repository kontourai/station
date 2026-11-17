#!/usr/bin/env node
/**
 * Whether one `PR: CI` run spends the heavy pull-request checks (the selected
 * test shards, the critical browser journeys, repository source scans, the
 * UI bundle delta report and optional delivery validation) or only the cheap
 * ones (the plan and the `ci:fast` statics).
 *
 * The repository variable STATION_PR_HEAVY_CHECKS is the switch. Unset or
 * `every-push` keeps today's behaviour: every run is heavy. `when-armed` makes
 * a same-repository pull request run the heavy part only once it is armed for
 * auto-merge, or when its author asks for a full run with the
 * HEAVY_CHECKS_OPT_IN_LABEL label. Anything this cannot read decides heavy:
 * a wrong `heavy` only costs runner minutes, while admission never depends on
 * this answer (the source verification policy reports a cheap-only head as
 * pending, so a cheap-only head cannot enter the merge queue).
 *
 *   node scripts/pr-heavy-checks-decision.mjs
 *
 * Reads GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_RUN_ATTEMPT,
 * GITHUB_REPOSITORY, GITHUB_API_URL, GH_TOKEN and STATION_PR_HEAVY_CHECKS;
 * writes `heavy=true|false` to GITHUB_OUTPUT and prints the reason.
 * Workflows other than ci.yml can run it as a step and gate their own heavy
 * job on `heavy != 'false'`, but only once their required check cannot pass
 * as `skipped` before arming: GitHub counts a skipped required check as
 * passing, and today only `Source verification policy` holds an unarmed head.
 * Such an adopter also needs the source policy to wait for its check on the
 * head (a non-skipped success of that check name) and to be re-run when the
 * adopter's run completes.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';

export const HEAVY_CHECKS_VARIABLE = 'STATION_PR_HEAVY_CHECKS';
export const HEAVY_CHECKS_MODES = Object.freeze(['every-push', 'when-armed']);
/** Adding this label and re-running (or pushing) asks for a full run. */
export const HEAVY_CHECKS_OPT_IN_LABEL = 'full-checks';

const POSITIVE = /^[1-9][0-9]*$/;

const heavy = (reason) => ({ heavy: true, reason });
const cheap = (reason) => ({ heavy: false, reason });

function labelNames(labels) {
  if (!Array.isArray(labels)) return undefined;
  const names = labels.map((label) =>
    typeof label === 'string' ? label : label?.name,
  );
  return names.every((name) => typeof name === 'string') ? names : undefined;
}

/**
 * The decision for one event. `live` is the pull request as read from the
 * API when this job ran, or null when that read failed; it is consulted for
 * the opt-in label and, on a re-run attempt (whose payload is the original
 * event's), for the current auto-merge state.
 */
export function decideHeavyChecks({
  mode,
  eventName,
  action,
  runAttempt,
  pullRequest,
  repository,
  live,
}) {
  if (mode === undefined || mode === '' || mode === 'every-push')
    return heavy(
      `${HEAVY_CHECKS_VARIABLE} is ${mode ? `'${mode}'` : 'unset'}: every push runs the heavy checks`,
    );
  if (mode !== 'when-armed')
    return heavy(
      `${HEAVY_CHECKS_VARIABLE} has the unknown value ${JSON.stringify(String(mode).slice(0, 64))}: failing towards the heavy checks`,
    );
  if (eventName !== 'pull_request_target')
    return heavy(`${eventName || 'unknown'} event: heavy checks always run`);
  if (
    !pullRequest ||
    typeof pullRequest !== 'object' ||
    !POSITIVE.test(String(pullRequest.number ?? ''))
  )
    return heavy('pull request unreadable: failing towards the heavy checks');
  if (pullRequest.head?.repo?.full_name !== repository)
    return heavy('fork pull request: its isolated smoke is not split');
  if (action === 'auto_merge_enabled')
    return heavy('the pull request was armed for auto-merge');
  if (!Object.hasOwn(pullRequest, 'auto_merge'))
    return heavy(
      'event payload has no auto-merge state: failing towards the heavy checks',
    );
  if (pullRequest.auto_merge !== null)
    return heavy('the pull request was armed when this event fired');
  const attempt = Number(runAttempt ?? 1);
  if (!Number.isSafeInteger(attempt) || attempt < 1)
    return heavy('run attempt unreadable: failing towards the heavy checks');
  if (attempt > 1) {
    // A re-run keeps the original payload, so only a live read can say
    // whether the pull request has since been armed.
    if (!live || !Object.hasOwn(live, 'auto_merge'))
      return heavy(
        `re-run attempt ${attempt} could not read the live auto-merge state: failing towards the heavy checks`,
      );
    if (live.auto_merge !== null)
      return heavy(`re-run attempt ${attempt}: the pull request is now armed`);
  }
  const labels = labelNames(live?.labels) ?? labelNames(pullRequest.labels);
  if (labels === undefined)
    return heavy('labels unreadable: failing towards the heavy checks');
  if (labels.includes(HEAVY_CHECKS_OPT_IN_LABEL))
    return heavy(
      `the pull request carries the ${HEAVY_CHECKS_OPT_IN_LABEL} label`,
    );
  return cheap(
    `${HEAVY_CHECKS_VARIABLE} is 'when-armed' and the pull request is not armed: heavy checks run once it is armed (gh pr merge --auto) or with the ${HEAVY_CHECKS_OPT_IN_LABEL} label and a re-run`,
  );
}

async function readLivePullRequest(env, number) {
  const response = await fetch(
    `${env.GITHUB_API_URL || 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}/pulls/${number}`,
    {
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);
  const pr = await response.json();
  if (pr?.number !== number) throw new Error('live pull request mismatch');
  return pr;
}

export async function main(env = process.env, read = readLivePullRequest) {
  let decision;
  try {
    const event = env.GITHUB_EVENT_PATH
      ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
      : {};
    const mode = env[HEAVY_CHECKS_VARIABLE];
    let live = null;
    if (
      mode === 'when-armed' &&
      env.GITHUB_EVENT_NAME === 'pull_request_target' &&
      Number.isSafeInteger(event.pull_request?.number)
    ) {
      try {
        live = await read(env, event.pull_request.number);
      } catch (error) {
        console.log(
          `::warning::live pull request unreadable (${error.message}); using the event payload`,
        );
      }
    }
    decision = decideHeavyChecks({
      mode,
      eventName: env.GITHUB_EVENT_NAME,
      action: event.action,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
      pullRequest: event.pull_request,
      repository: env.GITHUB_REPOSITORY,
      live,
    });
  } catch (error) {
    decision = heavy(
      `decision failed (${error.message}): failing towards the heavy checks`,
    );
  }
  console.log(
    `Heavy pull-request checks: ${decision.heavy ? 'run' : 'deferred'} (${decision.reason})`,
  );
  if (env.GITHUB_OUTPUT)
    appendFileSync(env.GITHUB_OUTPUT, `heavy=${decision.heavy}\n`);
  return decision;
}

if (invokedDirectly(import.meta.url)) await main();
