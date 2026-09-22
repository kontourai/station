#!/usr/bin/env node
/**
 * Runs a named subset of the canonical full-regression phases.
 *
 * The merge-queue regression workflow splits `full:regression` across several
 * hosted runners. Each runner calls this driver with the phase ids it owns;
 * the command for every phase is read from FULL_REGRESSION_PHASES, so the
 * workflow never spells a private `:raw` script and cannot drift from the
 * canonical phase list.
 *
 * This is diagnostic, not completion evidence: it writes no receipt, and the
 * canonical `npm run full:regression` lane is unchanged. Unlike that lane it
 * continues past a failed phase so one run names every red phase it owns,
 * then exits non-zero if any phase failed.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  executeOwnedProcess,
  registerProcessSignal,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './lib/owned-process.mjs';
import { FULL_REGRESSION_PHASES } from './verification-lanes.mjs';

const PROCESS_HEAVY_PHASE_ID = 'test-full-process-heavy';
const SETTLEMENT_MS = 5_000;
const USAGE =
  'usage: node scripts/run-full-regression-phases.mjs --phase=<id> [--phase=<id>...] [--process-heavy-shard=<k>/<n>]';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function parseFullRegressionPhaseArguments(
  args,
  phases = FULL_REGRESSION_PHASES,
) {
  const phaseIds = [];
  let processHeavyShard = null;
  for (const argument of args) {
    const phase = /^--phase=(.+)$/.exec(argument);
    const shard = /^--process-heavy-shard=(.+)$/.exec(argument);
    if (phase) {
      if (!phases.some((entry) => entry.id === phase[1]))
        throw new Error(
          `unknown full-regression phase '${phase[1]}'; known phases: ${phases.map((entry) => entry.id).join(', ')}`,
        );
      if (phaseIds.includes(phase[1]))
        throw new Error(`phase '${phase[1]}' was requested more than once`);
      phaseIds.push(phase[1]);
    } else if (shard && processHeavyShard === null) {
      if (!/^[1-9][0-9]*\/[1-9][0-9]*$/.test(shard[1]))
        throw new Error(`--process-heavy-shard must be <k>/<n>: ${shard[1]}`);
      processHeavyShard = shard[1];
    } else {
      throw new Error(USAGE);
    }
  }
  if (phaseIds.length === 0) throw new Error(USAGE);
  if (processHeavyShard !== null && !phaseIds.includes(PROCESS_HEAVY_PHASE_ID))
    throw new Error(
      `--process-heavy-shard requires --phase=${PROCESS_HEAVY_PHASE_ID}`,
    );
  return { phaseIds, processHeavyShard };
}

/**
 * Resolve each requested phase to the npm script the canonical lane runs, in
 * canonical order (the order of FULL_REGRESSION_PHASES, not argument order),
 * so a later phase never runs before the phase it follows in full:regression.
 * A phase whose private script is missing from package.json fails here, before
 * anything runs.
 */
export function resolveFullRegressionPhasePlan(
  { phaseIds, processHeavyShard },
  { phases = FULL_REGRESSION_PHASES, scripts = readPackageScripts() } = {},
) {
  return phases
    .filter((phase) => phaseIds.includes(phase.id))
    .map((phase) => {
      if (typeof scripts?.[phase.privateScript] !== 'string')
        throw new Error(
          `phase '${phase.id}' names package script '${phase.privateScript}', which package.json does not define`,
        );
      const extra =
        phase.id === PROCESS_HEAVY_PHASE_ID && processHeavyShard
          ? ['--', `--shard=${processHeavyShard}`]
          : [];
      return Object.freeze({
        id: phase.id,
        script: phase.privateScript,
        args: Object.freeze(['run', phase.privateScript, ...extra]),
        timeoutMs: phase.timeoutMs,
      });
    });
}

function readPackageScripts() {
  return JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))
    .scripts;
}

function npmInvocation() {
  const npmCli = process.env.npm_execpath;
  return npmCli
    ? { executable: process.execPath, prefix: [npmCli] }
    : {
        executable: process.platform === 'win32' ? 'npm.cmd' : 'npm',
        prefix: [],
      };
}

/** Run one phase as an owned process group bounded by its canonical deadline. */
export async function runPhaseProcess(
  step,
  { cwd = repoRoot, signal, spawnProcess = spawn } = {},
) {
  const { executable, prefix } = npmInvocation();
  const label = `full-regression phase ${step.id}`;
  const execution = executeOwnedProcess(
    executable,
    [...prefix, ...step.args],
    spawnProcess,
    label,
    { cwd, stdio: 'inherit', windowsHide: true },
  );
  let timer;
  let onAbort;
  const interrupted = new Promise((resolveInterrupt) => {
    timer = setTimeout(
      () => resolveInterrupt(`exceeded its ${step.timeoutMs} ms deadline`),
      step.timeoutMs,
    );
    onAbort = () => resolveInterrupt(`cancelled: ${signal?.reason}`);
    if (signal?.aborted) onAbort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
  try {
    const outcome = await Promise.race([
      execution.completion.then((result) => ({ kind: 'completed', result })),
      interrupted.then((reason) => ({ kind: 'interrupted', reason })),
    ]);
    const cleanup = await terminateSuiteExecution(execution, {
      processLabel: label,
      terminationGraceMs: SETTLEMENT_MS,
      terminationForceMs: SETTLEMENT_MS,
      waitForSuiteSettlement,
    });
    if (outcome.kind === 'interrupted')
      return { status: null, error: `${label} ${outcome.reason}` };
    if (outcome.result.error)
      return {
        status: null,
        error: String(outcome.result.error.message ?? outcome.result.error),
      };
    if (!cleanup.settled)
      return {
        status: outcome.result.status,
        error: `${label} left an owned process tree alive`,
      };
    return { status: outcome.result.status, error: null };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * Run every planned phase in order, continuing past failures. A phase passes
 * only on exit status 0 with no runner error; a cancellation stops the plan
 * and marks the remaining phases as not run, which is also a failure.
 */
export async function runFullRegressionPhases(
  plan,
  {
    runPhase = runPhaseProcess,
    signal,
    now = () => Date.now(),
    log = (line) => process.stdout.write(`${line}\n`),
  } = {},
) {
  const results = [];
  for (const step of plan) {
    if (signal?.aborted) {
      results.push({
        id: step.id,
        passed: false,
        status: null,
        error: 'not run: cancelled',
        durationMs: 0,
      });
      continue;
    }
    log(
      `[full-regression-phases] ${step.id}: START npm ${step.args.join(' ')}`,
    );
    const started = now();
    let outcome;
    try {
      outcome = await runPhase(step, { signal });
    } catch (error) {
      outcome = {
        status: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const durationMs = now() - started;
    const passed = outcome.status === 0 && !outcome.error;
    results.push({
      id: step.id,
      passed,
      status: outcome.status ?? null,
      error: outcome.error ?? null,
      durationMs,
    });
    log(
      `[full-regression-phases] ${step.id}: ${passed ? 'PASS' : 'FAIL'} in ${(durationMs / 1000).toFixed(1)}s${passed ? '' : ` (${outcome.error ?? `exit status ${outcome.status}`})`}`,
    );
  }
  log('[full-regression-phases] summary:');
  for (const result of results)
    log(
      `  ${result.passed ? 'PASS' : 'FAIL'}  ${result.id}  ${(result.durationMs / 1000).toFixed(1)}s${result.passed ? '' : `  ${result.error ?? `exit status ${result.status}`}`}`,
    );
  return {
    passed:
      results.length === plan.length &&
      results.length > 0 &&
      results.every((result) => result.passed),
    results,
  };
}

async function main() {
  const controller = new AbortController();
  const unregister = ['SIGINT', 'SIGTERM'].map((name) =>
    registerProcessSignal(name, () => controller.abort(name)),
  );
  try {
    const plan = resolveFullRegressionPhasePlan(
      parseFullRegressionPhaseArguments(process.argv.slice(2)),
    );
    const result = await runFullRegressionPhases(plan, {
      signal: controller.signal,
    });
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `[full-regression-phases] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  } finally {
    for (const remove of unregister) remove();
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href)
  void main();
