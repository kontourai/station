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
 *
 * A phase passes here only when the canonical lane would also pass it:
 * - exit status 0, no runner error, no surviving owned process tree;
 * - output that is valid UTF-8 and within the canonical per-stream capture
 *   cap (the canonical runner captures through the same
 *   `captureOwnedProcessOutput` and fails either condition);
 * - an unchanged workspace. The canonical lane fails a phase whose before and
 *   after request keys differ, so this driver compares HEAD, the workspace
 *   digest (`git diff --binary HEAD` plus untracked non-ignored file content),
 *   the dependency digest, and the porcelain status before and after each
 *   phase, and names what changed.
 * Not mirrored: the environment/toolchain parts of the request key, which a
 * phase cannot change from inside its own process tree.
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  captureOwnedProcessOutput,
  executeOwnedProcess,
  registerProcessSignal,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './lib/owned-process.mjs';
import {
  collectWorkspaceProvenance,
  digestVerificationDependencies,
} from './lib/test-reliability.mjs';
import { bindVerificationRequestEnvironment } from './lib/verification-request-environment.mjs';
import { FULL_REGRESSION_PHASES } from './verification-lanes.mjs';

const PROCESS_HEAVY_PHASE_ID = 'test-full-process-heavy';
const SETTLEMENT_MS = 5_000;
const USAGE =
  'usage: node scripts/run-full-regression-phases.mjs --phase=<id> [--phase=<id>...] [--process-heavy-shard=<k>/<n>]';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GIT_STATUS_MAX_BUFFER = 64 * 1024 * 1024;

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    maxBuffer: GIT_STATUS_MAX_BUFFER,
    windowsHide: true,
  });
}

/** Porcelain status entries (`XY path`, renames as `XY new <- old`). */
function statusEntries(root) {
  const tokens = git(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    root,
  )
    .toString('utf8')
    .split('\0');
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const code = token.slice(0, 2);
    const path = token.slice(3);
    if (code.includes('R') || code.includes('C')) {
      entries.push(`${code} ${path} <- ${tokens[index + 1]}`);
      index += 1;
    } else entries.push(`${code} ${path}`);
  }
  return entries.sort();
}

/** The workspace identity the canonical request key derives from. */
export function snapshotWorkspace(cwd = repoRoot) {
  const root = git(['rev-parse', '--show-toplevel'], cwd)
    .toString('utf8')
    .trim();
  const workspace = collectWorkspaceProvenance({ cwd: root });
  return {
    headSha: workspace.headSha,
    workspaceDigest: workspace.workspaceDigest,
    dependencyDigest: digestVerificationDependencies(root),
    status: statusEntries(root),
  };
}

/** Human-readable differences; an empty list means the workspace is unchanged. */
export function workspaceChanges(before, after) {
  const changes = [];
  if (before.headSha !== after.headSha)
    changes.push(`HEAD moved from ${before.headSha} to ${after.headSha}`);
  const beforeStatus = new Set(before.status);
  const afterStatus = new Set(after.status);
  const changedEntries = [
    ...after.status.filter((entry) => !beforeStatus.has(entry)),
    ...before.status
      .filter((entry) => !afterStatus.has(entry))
      .map((entry) => `${entry} (no longer reported)`),
  ];
  if (changedEntries.length > 0)
    changes.push(`changed paths: ${changedEntries.join(', ')}`);
  else if (before.workspaceDigest !== after.workspaceDigest)
    changes.push(
      `content changed under already-modified paths: ${after.status.join(', ') || '<none reported>'}`,
    );
  if (before.dependencyDigest !== after.dependencyDigest)
    changes.push('dependency digest changed');
  return changes;
}

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
  {
    cwd = repoRoot,
    signal = /** @type {AbortSignal | undefined} */ (undefined),
    spawnProcess = spawn,
    // Where the child's bytes are forwarded. Tests pass their own sinks: a
    // child's raw bytes written into a Vitest worker's stdout become the
    // Vitest run's output, and a deliberately invalid UTF-8 child then makes
    // that whole run unsafe for any capture that validates it.
    forward = {
      stdout: (/** @type {Buffer} */ chunk) => process.stdout.write(chunk),
      stderr: (/** @type {Buffer} */ chunk) => process.stderr.write(chunk),
    },
  } = {},
) {
  const { executable, prefix } = npmInvocation();
  const label = `full-regression phase ${step.id}`;
  // The canonical lane binds STATION_VERIFICATION_HISTORY_REF to the request's
  // HEAD, so history-reading tests (commit-message corpora) inspect the
  // candidate rather than origin/main. The binding overwrites inheritance.
  const env = bindVerificationRequestEnvironment(process.env, {
    headSha: git(['rev-parse', 'HEAD'], cwd).toString('utf8').trim(),
  });
  const execution = executeOwnedProcess(
    executable,
    [...prefix, ...step.args],
    spawnProcess,
    label,
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  // Stream the child's bytes to this job log as they arrive, and validate
  // them through the same capture the canonical runner uses.
  execution.child.stdout?.on('data', (chunk) => forward.stdout(chunk));
  execution.child.stderr?.on('data', (chunk) => forward.stderr(chunk));
  const capture = captureOwnedProcessOutput(execution);
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
    const captured = capture.finish();
    if (captured.invalidUtf8)
      return {
        status: outcome.result.status,
        error: `${label} output was not valid UTF-8`,
      };
    if (captured.truncated)
      return {
        status: outcome.result.status,
        error: `${label} output exceeded the canonical per-stream capture limit`,
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
    snapshot = snapshotWorkspace,
    cwd = repoRoot,
    signal = /** @type {AbortSignal | undefined} */ (undefined),
    now = () => Date.now(),
    log = (line) => {
      process.stdout.write(`${line}\n`);
    },
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
      const before = snapshot(cwd);
      outcome = await runPhase(step, { signal, cwd });
      const changes = workspaceChanges(before, snapshot(cwd));
      if (changes.length > 0)
        outcome = {
          ...outcome,
          error: [
            outcome.error,
            `phase mutated the workspace (the canonical lane fails this): ${changes.join('; ')}`,
          ]
            .filter(Boolean)
            .join('; '),
        };
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
