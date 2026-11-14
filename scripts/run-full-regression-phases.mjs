#!/usr/bin/env node
/**
 * Runs canonical phase commands with their deadlines and workspace/process
 * integrity checks. Continues after failure so one qualification reports all
 * available failures. The hosted workflow, not an individual driver call,
 * owns the completion receipt after every required shard succeeds.
 * Explicit diagnostic callers may exclude quarantined files; hosted source
 * qualification never does. The local full:regression coordinator is unchanged.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokedDirectly } from './lib/module-entry.mjs';
import { npmInvocation } from './lib/npm-cli.mjs';
import {
  captureOwnedProcessOutput,
  executeOwnedProcess,
  registerProcessSignal,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './lib/owned-process.mjs';
import {
  buildJobManifest,
  clipText,
  JOB_LABEL_ENV,
  JOB_MANIFEST_FILE,
  MANIFEST_DIR_ENV,
} from './lib/qualification-failure-manifest.mjs';
import {
  collectWorkspaceProvenance,
  digestVerificationDependencies,
} from './lib/test-reliability.mjs';
import { bindVerificationRequestEnvironment } from './lib/verification-request-environment.mjs';
import { FULL_REGRESSION_PHASES } from './verification-lanes.mjs';

const PROCESS_HEAVY_PHASE_ID = 'test-full-process-heavy';
// Vitest corpus phases: the only phases a quarantine can apply to.
const CORPUS_PHASE_PREFIX = 'test-full-';
const EXCLUDE_QUARANTINED = '--exclude-quarantined';
const SETTLEMENT_MS = 5_000;
const USAGE =
  'usage: node scripts/run-full-regression-phases.mjs --phase=<id> [--phase=<id>...] [--process-heavy-shard=<k>/<n>] [--exclude-quarantined]';

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
  let excludeQuarantined = false;
  for (const argument of args) {
    if (argument === EXCLUDE_QUARANTINED && !excludeQuarantined) {
      excludeQuarantined = true;
      continue;
    }
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
  if (
    excludeQuarantined &&
    !phaseIds.some((id) => id.startsWith(CORPUS_PHASE_PREFIX))
  )
    throw new Error(
      `${EXCLUDE_QUARANTINED} requires at least one ${CORPUS_PHASE_PREFIX}* phase`,
    );
  return { phaseIds, processHeavyShard, excludeQuarantined };
}

/**
 * Resolve each requested phase to the npm script the canonical lane runs, in
 * canonical order (the order of FULL_REGRESSION_PHASES, not argument order),
 * so a later phase never runs before the phase it follows in full:regression.
 * A phase whose private script is missing from package.json fails here, before
 * anything runs.
 */
export function resolveFullRegressionPhasePlan(
  { phaseIds, processHeavyShard, excludeQuarantined = false },
  { phases = FULL_REGRESSION_PHASES, scripts = readPackageScripts() } = {},
) {
  return phases
    .filter((phase) => phaseIds.includes(phase.id))
    .map((phase) => {
      if (typeof scripts?.[phase.privateScript] !== 'string')
        throw new Error(
          `phase '${phase.id}' names package script '${phase.privateScript}', which package.json does not define`,
        );
      const forwarded = [
        ...(phase.id === PROCESS_HEAVY_PHASE_ID && processHeavyShard
          ? [`--shard=${processHeavyShard}`]
          : []),
        ...(excludeQuarantined && phase.id.startsWith(CORPUS_PHASE_PREFIX)
          ? [EXCLUDE_QUARANTINED]
          : []),
      ];
      const extra = forwarded.length > 0 ? ['--', ...forwarded] : [];
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

/** Run one phase as an owned process group bounded by its canonical deadline. */
export async function runPhaseProcess(
  step,
  {
    cwd = repoRoot,
    signal = /** @type {AbortSignal | undefined} */ (undefined),
    spawnProcess = spawn,
    extraEnv = {},
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
  const { command, args } = npmInvocation(step.args);
  const label = `full-regression phase ${step.id}`;
  // The canonical lane binds STATION_VERIFICATION_HISTORY_REF to the request's
  // HEAD, so history-reading tests (commit-message corpora) inspect the
  // candidate rather than origin/main. The binding overwrites inheritance.
  const env = {
    ...bindVerificationRequestEnvironment(process.env, {
      headSha: git(['rev-parse', 'HEAD'], cwd).toString('utf8').trim(),
    }),
    ...extraEnv,
  };
  const execution = executeOwnedProcess(command, args, spawnProcess, label, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
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
 * The group manifest entries a phase's corpus runner wrote. An unreadable
 * entry is reported as a phase error, which leaves the phase unexplained.
 */
export function readPhaseGroups(directory) {
  let names;
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    return { groups: [], errors: [] };
  }
  const groups = [];
  const errors = [];
  for (const name of names.sort()) {
    try {
      groups.push(JSON.parse(readFileSync(resolve(directory, name), 'utf8')));
    } catch (error) {
      errors.push(
        `group manifest ${name} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { groups, errors };
}

/**
 * The job's failure manifest: every planned phase, in order, with its own
 * verdict and its corpus groups. A phase that never ran is listed with an
 * error, and `complete` is false unless every planned phase reported.
 */
export function phaseJobManifest(plan, results, phaseGroups, identity) {
  return buildJobManifest({
    producer: 'full-regression-phases',
    identity,
    complete:
      results.length === plan.length &&
      plan.every((step) => results.some((entry) => entry.id === step.id)),
    phases: plan.map((step) => {
      const result = results.find((entry) => entry.id === step.id);
      const collected = phaseGroups.get(step.id) ?? { groups: [], errors: [] };
      const errors = [
        ...(result ? (result.error ? [result.error] : []) : ['not run']),
        ...collected.errors,
      ];
      return {
        phase: step.id,
        exitStatus: result?.status ?? null,
        error: errors.length ? clipText(errors.join('; ')) : null,
        corpus: step.id.startsWith(CORPUS_PHASE_PREFIX),
        groups: collected.groups,
      };
    }),
  });
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
    // Set in hosted qualification: each corpus phase writes its group
    // manifests under <directory>/groups/<phase>, outside the workspace.
    manifestDirectory,
    phaseGroups = new Map(),
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
      const groupDirectory = manifestDirectory
        ? resolve(manifestDirectory, 'groups', step.id)
        : null;
      outcome = await runPhase(step, {
        signal,
        cwd,
        ...(groupDirectory
          ? { extraEnv: { [MANIFEST_DIR_ENV]: groupDirectory } }
          : {}),
      });
      if (groupDirectory)
        phaseGroups.set(step.id, readPhaseGroups(groupDirectory));
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

/** Write the job manifest; called from the driver's `finally`. */
export function writeJobManifest(
  directory,
  plan,
  results,
  phaseGroups,
  { cwd = repoRoot, env = process.env } = {},
) {
  let sourceSha = '';
  try {
    sourceSha = git(['rev-parse', 'HEAD'], cwd).toString('utf8').trim();
  } catch {}
  const manifest = phaseJobManifest(plan, results, phaseGroups, {
    jobLabel: clipText(env[JOB_LABEL_ENV] ?? ''),
    sourceSha,
    runId: String(env.GITHUB_RUN_ID ?? ''),
    runAttempt: String(env.GITHUB_RUN_ATTEMPT ?? ''),
  });
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    resolve(directory, JOB_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

async function main() {
  const controller = new AbortController();
  const unregister = ['SIGINT', 'SIGTERM'].map((name) =>
    registerProcessSignal(name, () => controller.abort(name)),
  );
  const manifestDirectory = process.env[MANIFEST_DIR_ENV] || undefined;
  let plan = [];
  let results = [];
  const phaseGroups = new Map();
  try {
    plan = resolveFullRegressionPhasePlan(
      parseFullRegressionPhaseArguments(process.argv.slice(2)),
    );
    const result = await runFullRegressionPhases(plan, {
      signal: controller.signal,
      manifestDirectory,
      phaseGroups,
    });
    results = result.results;
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `[full-regression-phases] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  } finally {
    for (const remove of unregister) remove();
    if (manifestDirectory)
      try {
        writeJobManifest(manifestDirectory, plan, results, phaseGroups);
      } catch (error) {
        process.stderr.write(
          `[full-regression-phases] could not write the failure manifest: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
  }
}

if (invokedDirectly(import.meta.url)) void main();
