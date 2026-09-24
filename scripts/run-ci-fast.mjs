#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT_LAW_TIMEOUT_EXIT_CODE } from './lib/product-laws.mjs';
import { CI_FAST_TIMEOUT_MS } from './verification-lanes.mjs';

export const FAST_FEEDBACK_TIMEOUT_MS = CI_FAST_TIMEOUT_MS;
export const FAST_BASE_ENV = 'STATION_CI_FAST_BASE';
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
// those lanes cost run sequentially). 150s left ~9.5min of the twelve-minute
// budget for affected-test selection, including the observed 385-test hosted
// selection that exhausted the previous seven-minute budget.
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
// What that spends: 720s - 220s = 500s (8.3min) is left for affected-test
// selection, down from 570s (9.5min). The selection budget observed to be too
// small was the seven-minute one #4273 replaced, and the 385-test hosted
// selection that exhausted it fits inside 500s. If a real selection ever
// needs more than this, raise the twelve-minute lane budget rather than
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
// Deliberately NOT raised to match. The reserve does not add time; it only
// decides where a 720s overrun is cut. A selection allowed 500s whose statics
// then need 330s dies at 720s inside the statics; a reserve of 360s would
// kill that selection at 360s instead, which is just as red, and would ALSO
// fail selections of 360-470s that pass today because their statics
// happened to fit. Raising the reserve therefore only converts passes into
// infrastructure errors. The real levers are the policy-pinned twelve-minute
// budget (an owner decision; verification-policy-gate.test.ts pins it) and a
// shorter static set (the typecheck aggregate is its largest member).
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
  CONTENT_INTEGRITY_FAST_COMMAND,
  // CLI help topics must have a `###` heading in docs/reference/cli.md
  // (scripts/cli-doc-parity.mjs). Pure source read, no build, ~50ms. Until
  // this joined the lane, the CLI↔docs contract was enforced ONLY by the
  // nightly full-regression gate, so #1795 could register the `open` verb
  // and land red on main, discovered by the next Nightly a day later.
  Object.freeze(['npm', Object.freeze(['run', 'docs:cli-parity:check'])]),
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
  Object.freeze(['npm', Object.freeze(['run', 'veritas:readiness'])]),
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

export function classifyCiFastCommandResult(result) {
  if (result?.error?.code === 'ETIMEDOUT')
    throw new CiFastInfrastructureError(
      `ci:fast exceeded its ${FAST_FEEDBACK_TIMEOUT_MS / 60_000}-minute feedback budget`,
    );
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

function run(command, args, { cwd, timeout }) {
  const result = spawnSync(command, args, {
    cwd,
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
  for (const [index, [command, args]] of [
    [
      process.execPath,
      ['scripts/run-changed-verification.mjs', `--base=${base}`],
    ],
    ...FAST_STATIC_COMMANDS,
  ].entries()) {
    const timeout =
      remaining(startedAt, now) - (index === 0 ? FAST_STATIC_RESERVE_MS : 0);
    if (timeout <= 0)
      throw new CiFastInfrastructureError(
        `ci:fast exceeded its ${FAST_FEEDBACK_TIMEOUT_MS / 60_000}-minute feedback budget`,
      );
    const status = execute(command, args, { cwd, timeout });
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

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  process.exitCode = runCiFastCli();
