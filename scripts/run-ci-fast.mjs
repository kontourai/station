#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { ciFastStepMarker } from './lib/ci-fast-step-marker.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { npmInvocation } from './lib/npm-cli.mjs';
import { PRODUCT_LAW_TIMEOUT_EXIT_CODE } from './lib/product-laws.mjs';
import { CI_FAST_TIMEOUT_MS } from './verification-lanes.mjs';

export const FAST_FEEDBACK_TIMEOUT_MS = CI_FAST_TIMEOUT_MS;
/**
 * The owner-final cause this runner prints when it stops the lane at its
 * budget. Exported so the receipt/reporter tests that model that line derive
 * it rather than restating a minute count that drifts with the budget.
 */
export const CI_FAST_BUDGET_EXCEEDED_CAUSE = `ci:fast exceeded its ${FAST_FEEDBACK_TIMEOUT_MS / 60_000}-minute feedback budget`;
export const FAST_BASE_ENV = 'STATION_CI_FAST_BASE';
/**
 * Mirrors CHANGED_DEADLINE_ENV in run-changed-verification.mjs, which this
 * runner must not import (it loads Vitest); run-ci-fast.test.ts pins them equal.
 */
export const CHANGED_DEADLINE_ENV = 'STATION_TEST_CHANGED_DEADLINE_AT';
/**
 * #2855: the share of the selector's allowance related discovery may use, so
 * a slow discovery cannot starve the tests it selects. Discovery is a fixed
 * graph build: 27-38s on hosted runners, up to 66s on a dev host at load
 * 47-93. A quarter of the 680s allowance is 170s; after the selector's 30s
 * reserve that is a 140s discovery timeout, ~3.7x the worst hosted and ~2x
 * the worst loaded measurement, while the tests keep at least 510s.
 */
export const FAST_SELECTOR_DISCOVERY_SHARE = 0.25;
/**
 * #2709: the required `fast-checks` check is an aggregator over a sharded
 * affected-test selection (scripts/fast-checks-shard.mjs) and a statics job.
 * The statics job runs this lane with the scope set to `statics`, which drops
 * the selector because the shards own it. Unset keeps the whole lane: local
 * `npm run ci:fast` and fork-smoke still run the selection here.
 */
export const FAST_SCOPE_ENV = 'STATION_CI_FAST_SCOPE';
export const FAST_SCOPE_STATICS = 'statics';
export const SELECTOR_DEFERRED_EXIT_CODE = 3;
export const CI_FAST_INFRASTRUCTURE_EXIT_CODE = PRODUCT_LAW_TIMEOUT_EXIT_CODE;
/** Emitted only by this owner after its nested command has settled. */
export const CI_FAST_OWNER_INFRASTRUCTURE_PREFIX =
  '[station-ci-fast-owner-final] ';
export const CI_FAST_NESTED_INFRASTRUCTURE_CAUSE =
  'ci:fast nested infrastructure exit';
export const SELECTOR_DEFERRED_MESSAGE =
  'ci:fast: affected-test selection deferred; full-regression remains the required completion gate.\n';
// Reserve enough headroom for ALL the static invariants so an affected-test
// selection cannot consume the whole feedback window before they run.
//
// Raised 30s -> 150s by station#4273, which added the typecheck aggregate.
// The pre-existing invariants remain well below 10 seconds cold; the new
// pair is what needs the room. Measured on a dev host under load ~20:
// `build:connect` 7s, `typecheck-aggregate` 82s for all 13 lanes (it runs
// them with bounded concurrency, so it is CHEAPER than the 72s three of
// those lanes cost run sequentially). 150s left ~9.5min of the then
// twelve-minute budget for affected-test selection, including the observed
// 385-test hosted selection that exhausted the previous seven-minute budget.
// If a real runner disagrees, the scoped fallback is `typecheck:server-tests`
// alone (27s, and the only lane of the thirteen that needs no build) — that
// covers where both of #4273's motivating breaks actually landed.
//
// Raised 150s -> 220s on 2026-09-14 when `proof:repo-governance` (4s),
// `lint:check` (7s) and `veritas:readiness` (15s idle, 35s typical, 75s on
// this host at load 48) joined the list. The whole list was then timed end
// to end on this branch, every command real and green: 114s wall at load
// ~25. 220s is ~1.9x that, which is deliberately more headroom than the
// ~1.5x #4273 left, because a hosted runner has two cores and this host's
// concurrency is doing some of the work (the typecheck aggregate alone runs
// at 447% CPU here).
//
// What that spent under the then twelve-minute budget: 720s - 220s = 500s
// (8.3min) for affected-test selection, down from 570s (9.5min). Under the
// current fifteen-minute budget (#2577) it is 900s - 220s = 680s (11.3min).
// The selection budget observed to be too small was the seven-minute one
// #4273 replaced, and the 385-test hosted selection that exhausted it fits
// inside either. If a real selection ever
// needs more than this, raise the lane budget rather than
// dropping an invariant back out of the list — the gap this list closes is
// that a violation was unobservable before merge, and a shorter static set
// restores exactly that.
//
// Hosted evidence, 2026-09-22 (2-4 vCPU ubuntu-22.04): the static set alone
// takes longer than this reserve. In fast-checks run 35784946947 the whole
// ci:fast step took 365s, and the statics AFTER verification:policy:gate's
// focused Vitest (which printed "Start at 21:13:41") ran 232s to the step's
// end at 21:17:33; run 35778933422 took 311s and 178s. The earlier statics
// and a small selection share the remainder, so the hosted static set is
// roughly 250-330s.
//
// Deliberately NOT raised to match (re-checked by #2577, whose 88 hosted
// runs put the tail from verification:policy:gate onward at 165-315s). The
// reserve does not add time; it only decides where an overrun of the 900s
// budget is cut. A selection allowed 680s whose statics then need 315s dies
// at 900s inside the statics; a reserve of 315s would kill that selection at
// 585s instead, which is just as red, and would ALSO fail selections of
// 585-680s that pass because their statics happened to be quick. Raising
// the reserve therefore only converts passes into infrastructure errors (its
// one gain is a doomed run failing a few minutes sooner). The real levers
// are the policy-pinned lane budget (verification-policy-gate.test.ts pins
// it) and a shorter static set (the typecheck aggregate is its largest
// member). #2577 pulled both as far as the data supported: the budget went
// from twelve to fifteen minutes (see CI_FAST_TIMEOUT_MS in
// verification-lanes.mjs) and the typecheck aggregate starts its longest
// lanes first.
export const FAST_STATIC_RESERVE_MS = 220_000;
export const CONTENT_INTEGRITY_FAST_COMMAND = Object.freeze([
  'npm',
  Object.freeze(['run', 'content:integrity']),
]);
export const CHANGESET_STATUS_FAST_COMMAND = Object.freeze([
  process.execPath,
  Object.freeze(['scripts/check-changesets.mjs']),
]);
export const FAST_STATIC_COMMANDS = Object.freeze([
  Object.freeze([
    process.execPath,
    Object.freeze(['scripts/node-runtime-contract.mjs']),
  ]),
  // Lifecycle verification also checks nearest workspace resolution. A copied
  // root node_modules can otherwise make this lane green while a workspace's
  // required nested version is absent and TypeScript resolves a wrong parent.
  Object.freeze(['npm', Object.freeze(['run', 'dependencies:verify'])]),
  Object.freeze(['npm', Object.freeze(['run', 'lockfile-sync:gate'])]),
  CHANGESET_STATUS_FAST_COMMAND,
  // Attribute new code-health debt while its author still owns the change.
  // Only unused exports/types block; statistical scores remain review evidence.
  Object.freeze([
    process.execPath,
    Object.freeze(['scripts/code-health-gate.mjs']),
  ]),
  // A fixed real-time wait added to a test passes once in the queue and
  // reds Nightly later under load (four did on 2026-09-23). Flag the added
  // line while its author still owns it; a `real-time: <reason>` waives it.
  Object.freeze([
    process.execPath,
    Object.freeze(['scripts/test-realtime-wait-gate.mjs']),
  ]),
  Object.freeze(['npm', Object.freeze(['run', 'channel-ports:check'])]),
  Object.freeze(['npm', Object.freeze(['run', 'gate:workflows'])]),
  // #2922: verify:static gates that were composed only by the merge queue and
  // Nightly, so their failures dequeued PRs about 30 minutes after queueing.
  // The evidence-check gate rejected #2886's unregistered documentation-truth
  // check. Source reads with no build: 3-4s for the evidence-check gate, well
  // under 1s for the rest (measured at load ~15; #2621 tracks the budget).
  Object.freeze([
    'npm',
    Object.freeze(['run', 'gate:evidence-check-execution']),
  ]),
  Object.freeze(['npm', Object.freeze(['run', 'install-script:check'])]),
  Object.freeze(['npm', Object.freeze(['run', 'mobile:permissions:gate'])]),
  Object.freeze([
    'npm',
    Object.freeze(['run', 'agent-plugin:validators:gate']),
  ]),
  Object.freeze(['npm', Object.freeze(['run', 'settings:registry:gate'])]),
  CONTENT_INTEGRITY_FAST_COMMAND,
  // Names Station must not reference, in any tracked file.
  Object.freeze(['npm', Object.freeze(['run', 'content:excluded-names'])]),
  // CLI help topics must have a `###` heading in docs/reference/cli.md
  // (scripts/cli-doc-parity.mjs). Pure source read, no build, ~50ms. Until
  // this joined the lane, the CLI↔docs contract was enforced ONLY by the
  // nightly full-regression gate, so #1795 could register the `open` verb
  // and land red on main, discovered by the next Nightly a day later.
  Object.freeze(['npm', Object.freeze(['run', 'docs:cli-parity:check'])]),
  // #2803: docs are no longer a whole-diff deferral, and these two were
  // composed only by verify:static (the merge queue and Nightly), which is
  // how #2797 reached the queue with a broken doc reference. Both read every
  // live doc against the repository, so a code change that breaks a doc
  // fails here too. ~1s each (measured at load ~65).
  Object.freeze(['npm', Object.freeze(['run', 'docs:reference:gate'])]),
  Object.freeze(['npm', Object.freeze(['run', 'docs:links:check'])]),
  // #2803 review: once docs/** paths complete in fast-checks, these three
  // docs:truth:gate members must run here too, or a doc edit they reject
  // (a vendor name in the public pages, a hand-edited generated reference)
  // reports completed and fails only in the queue. Node builtins and
  // `git ls-files`, no build; ~0.2-2.7s each (measured at load ~80).
  Object.freeze(['npm', Object.freeze(['run', 'docs:public:hygiene'])]),
  Object.freeze(['npm', Object.freeze(['run', 'docs:issue-lifecycle:check'])]),
  Object.freeze([
    'npm',
    Object.freeze(['run', 'docs:public:contract-examples']),
  ]),
  // PRECONDITION for the typecheck aggregate below, same shape as
  // `build:connect`: the Basis MCP app bundles are git-ignored build output
  // that `typecheck:basis-pane`, `typecheck:server-tests`, and `typecheck:ui`
  // resolve as ordinary modules. Generating here (~2s) makes the lane
  // self-sufficient rather than dependent on an earlier install having run
  // in the same tree. Nothing is tracked, so there is nothing to be stale.
  Object.freeze([
    process.execPath,
    Object.freeze(['scripts/generate-basis-mcp-apps.mjs']),
  ]),
  Object.freeze(['npm', Object.freeze(['run', 'verification:policy:gate'])]),
  // ~4s of source reads through scripts/proof-family-lane.mjs. Until this
  // joined the lane the governance proof was composed ONLY by
  // `full:regression:raw`, and full-regression.yml declares no push,
  // pull_request, merge_group or schedule trigger — it is reachable from
  // nightly.yml, release.yml and ci.yml's workflow_dispatch job alone. So a
  // governance violation could not be observed before merge at all, and after
  // merge only by the next Nightly. Two reached main that way on 2026-09-14
  // (the unreviewed `.message` egress from #2061's Boards create conflict, and
  // #2080's third argument breaking a support-services guardrail literal), and
  // the Nightly that was supposed to find them had itself been red since
  // 2026-09-12 on an unrelated stale test, so nothing surfaced either one.
  Object.freeze(['npm', Object.freeze(['run', 'proof:repo-governance'])]),
  // ~7s: biome over every source root. The pre-push hook has run this since
  // #3141, but a hook is per-machine — it requires `core.hooksPath` to be
  // configured, `--no-verify` bypasses it, and nothing in a pull request or a
  // merge-queue candidate re-runs it. So formatting and organized imports were
  // enforced pre-merge only by whoever's checkout happened to be armed, and
  // otherwise first by `verify:static` inside the nightly full-regression
  // gate — where, as that hook's own header says, the cost is a whole gate
  // cycle for whoever finds it instead of three seconds for whoever wrote it.
  Object.freeze(['npm', Object.freeze(['run', 'lint:check'])]),
  // ~35s (15s on an idle host, 75s on this one at load 48). Repository
  // governance readiness: required artifacts, the AI instruction-file sync,
  // the protected-standards attestation, and the evidence-checks it routes.
  // Nothing enforced it anywhere before this — not ci:fast, not the pre-push
  // hook, and not full:regression either, so the "run `veritas readiness` and
  // address any FAIL lines" instruction every AGENTS.md carries rested
  // entirely on the contributor remembering.
  //
  // Last of the three, and after `verification:policy:gate`, because it
  // re-executes both as routed evidence-checks. When one of those is what
  // broke, the direct gate above reports it in seconds under its own name
  // rather than half a minute later inside a readiness report.
  //
  // Not redundant with the proof above, measured rather than assumed:
  // `proof:repo-governance` evaluates three of the nine repo-standards rules
  // (REPO_GOVERNANCE_RULE_IDS in scripts/proof-family-lane.mjs), readiness
  // evaluates all nine plus the protected-standards attestation. Deleting
  // docs/strategy/multi-agent-delivery-protocol.md leaves the proof, the
  // policy gate and lint green and reds readiness alone, on
  // `verification-conduct-sentinels-and-fault-injection`.
  //
  // `--working-tree` does NOT narrow this to the diff, which matters because
  // a CI checkout has no diff. Measured both ways: a forbidden shared-root
  // import reds the run whether it is uncommitted or committed with a clean
  // tree, so the file-matched rules evaluate the repository's files here
  // exactly as they do locally. The "0 files changed -> no matched nodes"
  // line printed on a clean tree reports changed-node routing, not these
  // rules — reading it as "nothing was checked" is the trap.
  Object.freeze([
    'npm',
    Object.freeze(['run', 'veritas:readiness', '--', '--format', 'json']),
  ]),
  // PRECONDITION for the aggregate below, not a build step for its own sake
  // (station#4273). `typecheck:ui` resolves `@kontourai/station-connect`
  // through `packages/connect/dist`; without it that lane reports a bogus
  // `Cannot find module` — verified by removing the directory and re-running.
  // The workflow builds connect anyway, but LATER in the same job, so
  // relying on that ordering would make this gate silently depend on an
  // invisible step and degrade to noise the day someone reorders it. 7s.
  Object.freeze(['npm', Object.freeze(['run', 'build:connect'])]),
  // The coverage station#4273 exists to add: `ci:fast` ran NO typecheck, so
  // `typecheck:*` was invisible to `pull_request` and a red main showed
  // green on every PR — twice in 24 hours, each break assembled from
  // several independently-green merges. Runs the aggregate directly rather
  // than `npm run typecheck`, because that script chains `dist:freshness`
  // ahead of it and would fail here on an unbuilt `packages/cli/dist`
  // before any lane ran — hiding every diagnostic behind a precondition
  // this gate does not need. The aggregate reports EVERY failing lane
  // (station#4249 slice 2), so one run names all contributors' errors.
  Object.freeze([
    process.execPath,
    Object.freeze(['scripts/typecheck-aggregate.mjs']),
  ]),
]);

export function fastBase(env = process.env) {
  const base = env[FAST_BASE_ENV] || 'origin/main';
  if (typeof base !== 'string' || !base || base.startsWith('-'))
    throw new Error(`${FAST_BASE_ENV} must be a Git ref, not an option`);
  return base;
}

/**
 * `all` unless the scope names exactly `statics`. Any other value is refused:
 * a misspelled scope must not quietly run a different set of checks.
 */
export function fastScope(env = process.env) {
  const scope = env[FAST_SCOPE_ENV];
  if (scope === undefined || scope === '') return 'all';
  if (scope === FAST_SCOPE_STATICS) return FAST_SCOPE_STATICS;
  throw new Error(
    `${FAST_SCOPE_ENV} must be unset or '${FAST_SCOPE_STATICS}', not '${String(scope).slice(0, 64)}'`,
  );
}

/** A bounded execution fault, distinct from an invalid policy/configuration. */
export class CiFastInfrastructureError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'CiFastInfrastructureError';
  }
}

function remaining(startedAt, now = Date.now) {
  return FAST_FEEDBACK_TIMEOUT_MS - (now() - startedAt);
}

/**
 * Human-readable label for a `[command, args]` pair, e.g.
 * `node scripts/typecheck-aggregate.mjs` or `npm run veritas:readiness`.
 * Used only for the per-step timing line below; never parsed back.
 */
export function describeCiFastCommand(command, args) {
  return [command, ...args].join(' ');
}

/** One decimal place is enough resolution to answer "where did the time go". */
export function formatCiFastElapsedSeconds(elapsedMs) {
  return (elapsedMs / 1000).toFixed(1);
}

export function classifyCiFastCommandResult(result) {
  if (result?.error?.code === 'ETIMEDOUT')
    throw new CiFastInfrastructureError(CI_FAST_BUDGET_EXCEEDED_CAUSE);
  if (result?.error)
    throw new CiFastInfrastructureError(
      `ci:fast command could not start: ${result.error.message}`,
      { cause: result.error },
    );
  if (typeof result?.signal === 'string' && result.signal.length > 0)
    throw new CiFastInfrastructureError(
      `ci:fast command terminated by signal ${result.signal.slice(0, 32)}`,
    );
  if (result?.status == null)
    throw new CiFastInfrastructureError(
      'ci:fast command ended without an exit status',
    );
  return result.status;
}

function run(command, args, { cwd, timeout, env }) {
  let invocation = { command, args };
  if (command === 'npm') {
    try {
      invocation = npmInvocation(args, { env });
    } catch (cause) {
      throw new CiFastInfrastructureError(
        `ci:fast npm launcher could not resolve: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  }
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    ...(env ? { env } : {}),
    stdio: 'inherit',
    timeout,
    windowsHide: true,
  });
  return classifyCiFastCommandResult(result);
}

/**
 * Run the exact affected Vitest selection before a short fixed invariant set.
 * The broad static chain and full corpus are intentionally absent:
 * `full-regression` owns both completion-only checks.
 */
export function runCiFast({
  cwd = process.cwd(),
  env = process.env,
  now = Date.now,
  execute = run,
  report = (message) => process.stdout.write(message),
} = {}) {
  const startedAt = now();
  const base = fastBase(env);
  const selector = fastScope(env) === 'all';
  const commands = [
    ...(selector
      ? [
          [
            process.execPath,
            ['scripts/run-changed-verification.mjs', `--base=${base}`],
          ],
        ]
      : []),
    ...FAST_STATIC_COMMANDS,
  ];
  for (const [position, [command, args]] of commands.entries()) {
    // `index === 0` names the selector; a statics-only lane has none.
    const index = selector ? position : position + 1;
    const iterationStartedAt = now();
    // Name the step before it starts: a direct `node` step prints no npm
    // header, and the reporter attributes a failure to the last boundary.
    report(ciFastStepMarker(command, args));
    const timeout =
      remaining(startedAt, now) - (index === 0 ? FAST_STATIC_RESERVE_MS : 0);
    if (timeout <= 0)
      throw new CiFastInfrastructureError(CI_FAST_BUDGET_EXCEEDED_CAUSE);
    // #2855: the selector learns when its related discovery must end: a
    // pinned share of its allowance, instead of a fixed 60s. The statics need
    // no deadline of their own.
    const status = execute(command, args, {
      cwd,
      timeout,
      ...(index === 0
        ? {
            env: {
              ...env,
              [CHANGED_DEADLINE_ENV]: String(
                iterationStartedAt +
                  Math.floor(timeout * FAST_SELECTOR_DISCOVERY_SHARE),
              ),
            },
          }
        : {}),
    });
    // station#2621: the timed-out receipt for a candidate merge_group run
    // showed no evidence at all of which step consumed the ~6 extra
    // minutes -- every command's own stdout is buffered by its own tooling
    // (npm-lane-aggregate.mjs prints nothing until every lane finishes) and
    // this runner never stamped a boundary between commands. Printing one
    // line per step, independent of whether the step's own tool prints
    // anything, makes the next timeout receipt answer "where did the time
    // go" without needing a bespoke reproduction.
    report(
      `[ci:fast] ${describeCiFastCommand(command, args)} ${formatCiFastElapsedSeconds(now() - iterationStartedAt)}s\n`,
    );
    if (index === 0 && status === SELECTOR_DEFERRED_EXIT_CODE) {
      report(SELECTOR_DEFERRED_MESSAGE);
      continue;
    }
    if (status !== 0) return status;
  }
  return 0;
}

export function runCiFastCli({
  run = runCiFast,
  error = (message) => process.stderr.write(message),
} = {}) {
  try {
    const status = run();
    if (status === CI_FAST_INFRASTRUCTURE_EXIT_CODE)
      error(
        `${CI_FAST_OWNER_INFRASTRUCTURE_PREFIX}${CI_FAST_NESTED_INFRASTRUCTURE_CAUSE}\n`,
      );
    return status;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (caught instanceof CiFastInfrastructureError) {
      error(`${CI_FAST_OWNER_INFRASTRUCTURE_PREFIX}${message}\n`);
      return CI_FAST_INFRASTRUCTURE_EXIT_CODE;
    }
    error(`${message}\n`);
    return 2;
  }
}

if (invokedDirectly(import.meta.url)) process.exitCode = runCiFastCli();
