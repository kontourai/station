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
// those lanes cost run sequentially). 150s leaves ~9.5min of the twelve-minute
// budget for affected-test selection, including the observed 385-test hosted
// selection that exhausted the previous seven-minute budget.
// If a real runner disagrees, the scoped fallback is `typecheck:server-tests`
// alone (27s, and the only lane of the thirteen that needs no build) — that
// covers where both of #4273's motivating breaks actually landed.
export const FAST_STATIC_RESERVE_MS = 150_000;
export const CONTENT_INTEGRITY_FAST_COMMAND = Object.freeze([
  'npm',
  Object.freeze(['run', 'content:integrity']),
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
  Object.freeze(['npm', Object.freeze(['run', 'channel-ports:check'])]),
  Object.freeze(['npm', Object.freeze(['run', 'gate:workflows'])]),
  CONTENT_INTEGRITY_FAST_COMMAND,
  Object.freeze([
    process.execPath,
    Object.freeze(['scripts/check-basis-mcp-apps.mjs']),
  ]),
  Object.freeze(['npm', Object.freeze(['run', 'verification:policy:gate'])]),
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
