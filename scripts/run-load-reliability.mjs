#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { loadavg as nodeLoadavg } from 'node:os';
import { relative, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  executeOwnedCommand,
  registerProcessSignal,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './lib/owned-process.mjs';
import {
  collectWorkspaceProvenance,
  preflightReceiptDestination,
  summarizeAttempts,
  writeReceiptSecurely,
} from './lib/test-reliability.mjs';

export {
  executeOwnedProcess,
  registerProcessSignal,
  runWindowsTaskkill,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './lib/owned-process.mjs';

const DEFAULT_OUTPUT =
  '.kontourai/test-reliability/load-reliability-latest.json';
const RECEIPT_DIRECTORY = '.kontourai/test-reliability';
const ATTEMPT_COUNT = 3;
const TERMINATION_GRACE_MS = 5_000;
const TERMINATION_FORCE_MS = 5_000;
const DEFAULTS = {
  targetLoad: 50,
  workers: 4,
  warmupMs: 60_000,
  sampleIntervalMs: 5_000,
  deadlineMs: 90 * 60_000,
  output: DEFAULT_OUTPUT,
};
const BOUNDS = {
  targetLoad: [50, 100],
  workers: [1, 128],
  warmupMs: [1_000, 5 * 60_000],
  sampleIntervalMs: [1_000, 60_000],
  deadlineMs: [5 * 60_000, 2 * 60 * 60_000],
};

class LoadReliabilityError extends Error {
  constructor(classification, message) {
    super(message);
    this.name = 'LoadReliabilityError';
    this.classification = classification;
  }
}

function toOptionKey(name) {
  return name
    .slice(2)
    .replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function parseBoundedInteger(arg, name) {
  const text = arg.slice(`${name}=`.length);
  const [minimum, maximum] = BOUNDS[toOptionKey(name)];
  if (!/^\d+$/.test(text)) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function isLoadReceiptPath(output) {
  return (
    output.endsWith('.json') &&
    relative(RECEIPT_DIRECTORY, output) !== '..' &&
    !relative(RECEIPT_DIRECTORY, output).startsWith(`..${sep}`) &&
    output.startsWith(`${RECEIPT_DIRECTORY}/`) &&
    !output.split(/[\\/]/).includes('..')
  );
}

export function parseLoadReliabilityOptions(args) {
  const options = { ...DEFAULTS, run: false };
  for (const arg of args) {
    if (arg === '--run') {
      if (options.run) throw new Error('duplicate argument: --run');
      options.run = true;
      continue;
    }
    const bounded = [
      '--target-load',
      '--workers',
      '--warmup-ms',
      '--sample-interval-ms',
      '--deadline-ms',
    ].find((name) => arg.startsWith(`${name}=`));
    if (bounded) {
      options[toOptionKey(bounded)] = parseBoundedInteger(arg, bounded);
      continue;
    }
    if (arg.startsWith('--output=')) {
      options.output = arg.slice('--output='.length);
      if (!isLoadReceiptPath(options.output)) {
        throw new Error(
          `--output must be a .json receipt beneath ${RECEIPT_DIRECTORY}`,
        );
      }
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (options.warmupMs >= options.deadlineMs) {
    throw new Error('--warmup-ms must be less than --deadline-ms');
  }
  return options;
}

export function buildLoadReliabilityPlan(options) {
  return {
    lane: 'load-reliability',
    mode: options.run ? 'run' : 'dry',
    attempts: ATTEMPT_COUNT,
    requested: {
      targetLoad: options.targetLoad,
      workers: options.workers,
      warmupMs: options.warmupMs,
      sampleIntervalMs: options.sampleIntervalMs,
      deadlineMs: options.deadlineMs,
      output: options.output,
    },
    suiteCommand: [
      process.execPath,
      'scripts/run-verification.mjs',
      'request',
      'verify-local',
      '--force',
    ],
  };
}

/** Production samples the host's real one-minute load average. */
export function createDefaultLoadavg(os = { loadavg: nodeLoadavg }) {
  return () => os.loadavg();
}

const defaultLoadavg = createDefaultLoadavg();

function loadValue(loadavg) {
  const value = loadavg()[0];
  if (!Number.isFinite(value) || value < 0) {
    throw new LoadReliabilityError(
      'infrastructure_error',
      'loadavg returned an invalid one-minute load value',
    );
  }
  return value;
}

function errorDetails(error) {
  return {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    ...(error?.code ? { code: error.code } : {}),
  };
}

function sampleLoad(receipt, phase, attempt, loadavg, now) {
  const sample = {
    phase,
    ...(attempt ? { attempt } : {}),
    atMs: now(),
    oneMinute: loadValue(loadavg),
  };
  sample.aboveTarget = sample.oneMinute > receipt.requested.targetLoad;
  receipt.load.samples.push(sample);
  return sample;
}

function refreshReceipt(receipt) {
  receipt.summary = summarizeAttempts(receipt.attempts);
  receipt.load.summary = {
    samples: receipt.load.samples.length,
    maximumOneMinute: Math.max(
      0,
      ...receipt.load.samples.map((sample) => sample.oneMinute),
    ),
    samplesAboveTarget: receipt.load.samples.filter(
      (sample) => sample.aboveTarget,
    ).length,
  };
  receipt.stress.achieved =
    receipt.attempts.length === ATTEMPT_COUNT &&
    receipt.attempts.every((attempt) => attempt.loadAchieved === true);
}

export function buildLoadReliabilityReceipt(options, command, startedAt) {
  const plan = buildLoadReliabilityPlan(options);
  return {
    schemaVersion: 1,
    lane: 'load-reliability',
    phase: 'startup',
    complete: false,
    startedAt,
    command,
    requested: plan.requested,
    suite: { command: plan.suiteCommand, requiredAttempts: ATTEMPT_COUNT },
    provenance: { stable: null, before: null, after: null },
    load: {
      samples: [],
      summary: { samples: 0, maximumOneMinute: 0, samplesAboveTarget: 0 },
    },
    attempts: [],
    summary: summarizeAttempts([]),
    stress: { achieved: false },
    cleanup: { started: false, complete: false, workers: [], errors: [] },
    classification: null,
    primaryFailure: null,
    interruption: null,
    error: null,
  };
}

export function preflightLoadReceiptDestination(
  output,
  receiptRoot = process.cwd(),
  { isTracked = isTrackedPath } = {},
) {
  if (!isLoadReceiptPath(output)) {
    throw new Error(
      `receipt must be a .json file beneath ${RECEIPT_DIRECTORY}`,
    );
  }
  const destination = preflightReceiptDestination(output, receiptRoot);
  if (isTracked(output, receiptRoot)) {
    throw new Error(
      `receipt destination is tracked and cannot be replaced: ${output}`,
    );
  }
  return destination;
}

export function isTrackedPath(output, receiptRoot, runGit = spawnSync) {
  const result = runGit('git', ['ls-files', '--error-unmatch', '--', output], {
    cwd: receiptRoot,
    stdio: 'ignore',
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(
      `cannot verify receipt tracking status: ${result.error.message}`,
    );
  }
  if (result.signal || result.status === null || result.status === undefined) {
    throw new Error('cannot verify receipt tracking status: git did not exit');
  }
  if (result.status === 0) return true;
  // git ls-files --error-unmatch documents status 1 for an unmatched path.
  if (result.status === 1) return false;
  throw new Error(
    `cannot verify receipt tracking status: git exited with status ${result.status}`,
  );
}

function createNodeLoadWorker() {
  return new Worker(
    'let value = 0; for (;;) value = Math.imul(value + 1, 1103515245) + 12345;',
    { eval: true },
  );
}

function terminateNodeLoadWorker(worker) {
  return worker.terminate();
}

export function executeVerifyLocal(
  _attemptMetadata,
  spawnProcess = spawn,
  runtime = { platform: process.platform },
) {
  return executeOwnedCommand(
    process.execPath,
    ['scripts/run-verification.mjs', 'request', 'verify-local', '--force'],
    spawnProcess,
    process.execPath,
    {},
    runtime,
  );
}

function normalizeSuiteExecution(execution) {
  if (execution && typeof execution === 'object' && 'promise' in execution) {
    let settled = false;
    const completion = Promise.resolve(execution.promise).then(
      (result) => result,
      (error) => ({ status: null, error, signal: null }),
    );
    void completion.finally(() => {
      settled = true;
    });
    return {
      completion,
      completionRequiresCleanup: execution.completionRequiresCleanup === true,
      isAlive: execution.isAlive ?? (() => !settled),
      terminate: execution.terminate ?? (() => {}),
      forceTerminate:
        execution.forceTerminate ?? execution.terminate ?? (() => {}),
    };
  }
  return {
    completion: Promise.resolve(execution),
    isAlive: () => false,
    terminate: () => {},
    forceTerminate: () => {},
  };
}

function sleepFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function equalProvenance(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
}

function attemptResult(attempt, result, durationMs, samples, targetLoad) {
  const infrastructureError =
    result?.error || result?.status === null || !result;
  return {
    attempt,
    status: infrastructureError
      ? 'infrastructure_error'
      : result.status === 0
        ? 'passed'
        : 'failed',
    exitCode: result?.status ?? null,
    ...(result?.signal ? { signal: result.signal } : {}),
    ...(result?.error ? { error: errorDetails(result.error) } : {}),
    durationMs: Math.max(0, durationMs),
    loadSamples: samples,
    loadAchieved: samples.some((sample) => sample.aboveTarget),
    targetLoad,
  };
}

function classifyPrimary(receipt) {
  if (receipt.interruption) return 'interrupted';
  if (receipt.error?.classification === 'infrastructure_error') {
    return 'infrastructure_error';
  }
  if (receipt.provenance.stable === false) return 'provenance_drift';
  if (receipt.error?.classification) return receipt.error.classification;
  if (
    receipt.attempts.some(
      (attempt) => attempt.status === 'infrastructure_error',
    )
  ) {
    return 'infrastructure_error';
  }
  if (receipt.attempts.some((attempt) => attempt.status === 'failed')) {
    return 'suite_failed';
  }
  return receipt.stress.achieved ? 'passed' : 'stress_not_achieved';
}

async function waitForWarmup(context) {
  const { receipt, options, loadavg, now, sleep, isStopped } = context;
  const warmupEndsAt = now() + options.warmupMs;
  while (now() < warmupEndsAt) {
    if (isStopped()) return false;
    await sleep(Math.min(options.sampleIntervalMs, warmupEndsAt - now()));
    if (isStopped()) return false;
    if (sampleLoad(receipt, 'warmup', null, loadavg, now).aboveTarget)
      return true;
  }
  return false;
}

async function runAttempt(context) {
  const {
    attempt,
    receipt,
    options,
    loadavg,
    now,
    sleep,
    suiteExecutor,
    isStopped,
    setActiveSuite,
    terminateActiveSuite,
  } = context;
  const startedAt = now();
  const execution = normalizeSuiteExecution(
    suiteExecutor({
      attempt,
      command: [
        process.execPath,
        'scripts/run-verification.mjs',
        'request',
        'verify-local',
        '--force',
      ],
      windowsHide: true,
    }),
  );
  setActiveSuite(execution);
  const samples = [sampleLoad(receipt, 'attempt', attempt, loadavg, now)];
  let result;
  while (result === undefined) {
    const next = await Promise.race([
      execution.completion.then((value) => ({ kind: 'result', value })),
      sleep(options.sampleIntervalMs).then(() => ({ kind: 'sample' })),
    ]);
    if (next.kind === 'result') {
      result = next.value;
      break;
    }
    if (isStopped()) {
      await terminateActiveSuite();
      throw new LoadReliabilityError(
        'infrastructure_error',
        'overall deadline exceeded',
      );
    }
    samples.push(sampleLoad(receipt, 'attempt', attempt, loadavg, now));
  }
  if (execution.isAlive()) {
    const termination = await terminateActiveSuite();
    const expectedCleanupPassed =
      execution.completionRequiresCleanup &&
      termination?.settled === true &&
      termination.errors.length === 0;
    if (!expectedCleanupPassed) {
      const error = new LoadReliabilityError(
        'infrastructure_error',
        termination?.settled === false
          ? 'verify:local wrapper exited while its process tree remained alive'
          : 'verify:local wrapper exited before its process tree settled',
      );
      error.termination = termination;
      throw error;
    }
  }
  setActiveSuite(null);
  const finished = attemptResult(
    attempt,
    result,
    now() - startedAt,
    samples,
    options.targetLoad,
  );
  receipt.attempts.push(finished);
  return finished;
}

function createRunController({
  signalRegistrar,
  setTimer,
  clearTimer,
  deadlineMs,
  terminationOptions,
}) {
  let activeSuite = null;
  let activeTermination = null;
  let interrupted = null;
  let deadlineReached = false;
  const terminateActiveSuite = async () => {
    if (!activeSuite) return null;
    activeTermination ??= terminateSuiteExecution(
      activeSuite,
      terminationOptions,
    );
    return activeTermination;
  };
  const unregisterSignals = ['SIGINT', 'SIGTERM'].map((signal) =>
    signalRegistrar(signal, () => {
      interrupted ??= signal;
      void terminateActiveSuite().catch(() => {});
    }),
  );
  const deadlineTimer = setTimer(() => {
    deadlineReached = true;
    void terminateActiveSuite().catch(() => {});
  }, deadlineMs);
  return {
    get interrupted() {
      return interrupted;
    },
    get deadlineReached() {
      return deadlineReached;
    },
    isStopped: () => interrupted !== null || deadlineReached,
    setActiveSuite(suite) {
      activeSuite = suite;
      activeTermination = null;
    },
    terminateActiveSuite,
    close() {
      clearTimer(deadlineTimer);
      for (const unregister of unregisterSignals) unregister?.();
    },
  };
}

async function startLoadWorkers(context) {
  const { options, workers, workerFactory, controller, sleep } = context;
  for (let index = 0; index < options.workers; index += 1) {
    if (controller.isStopped()) break;
    workers.push(await workerFactory({ index }));
    // Yield after every creation so queued signals/deadlines can be observed.
    await sleep(0);
    if (controller.isStopped()) break;
  }
  if (controller.interrupted) {
    throw new LoadReliabilityError(
      'interrupted',
      `received ${controller.interrupted}`,
    );
  }
  if (controller.deadlineReached) {
    throw new LoadReliabilityError(
      'infrastructure_error',
      'overall deadline exceeded during worker startup',
    );
  }
}

async function executeLoadLifecycle(context) {
  const {
    receipt,
    options,
    provenance,
    checkpoint,
    controller,
    loadavg,
    now,
    sleep,
    suiteExecutor,
  } = context;
  receipt.provenance.before = provenance();
  await startLoadWorkers(context);
  checkpoint();
  const warmed = await waitForWarmup({
    receipt,
    options,
    loadavg,
    now,
    sleep,
    isStopped: controller.isStopped,
  });
  receipt.phase = 'warmup';
  checkpoint();
  if (controller.interrupted) {
    throw new LoadReliabilityError(
      'interrupted',
      `received ${controller.interrupted}`,
    );
  }
  if (controller.deadlineReached) {
    throw new LoadReliabilityError(
      'infrastructure_error',
      'overall deadline exceeded',
    );
  }
  if (!warmed) {
    throw new LoadReliabilityError(
      'stress_not_achieved',
      'warmup did not reach the requested one-minute load',
    );
  }
  receipt.phase = 'attempt';
  for (let attempt = 1; attempt <= ATTEMPT_COUNT; attempt += 1) {
    if (controller.isStopped()) {
      throw new LoadReliabilityError(
        controller.interrupted ? 'interrupted' : 'infrastructure_error',
        controller.interrupted
          ? `received ${controller.interrupted}`
          : 'overall deadline exceeded',
      );
    }
    await runAttempt({
      attempt,
      receipt,
      options,
      loadavg,
      now,
      sleep,
      suiteExecutor,
      isStopped: controller.isStopped,
      setActiveSuite: controller.setActiveSuite,
      terminateActiveSuite: controller.terminateActiveSuite,
    });
    checkpoint();
  }
  receipt.provenance.after = provenance();
  receipt.provenance.stable = equalProvenance(
    receipt.provenance.before,
    receipt.provenance.after,
  );
}

function recordLifecycleError(receipt, error, controller, now, checkpoint) {
  if (
    controller.interrupted ||
    (error instanceof LoadReliabilityError &&
      error.classification === 'interrupted')
  ) {
    receipt.interruption ??= {
      signal: controller.interrupted ?? 'unknown',
      atMs: now(),
    };
  } else {
    receipt.error = {
      classification:
        error instanceof LoadReliabilityError
          ? error.classification
          : 'infrastructure_error',
      ...errorDetails(error),
    };
  }
  receipt.phase = 'cleanup';
  checkpoint();
}

async function cleanupLoadLifecycle(context) {
  const { receipt, controller, workers, workerTerminator, checkpoint } =
    context;
  receipt.phase = 'cleanup';
  receipt.cleanup.started = true;
  const suiteOutcome = await controller.terminateActiveSuite();
  if (suiteOutcome) {
    receipt.cleanup.suite = suiteOutcome;
    for (const error of suiteOutcome.errors) {
      receipt.cleanup.errors.push({ scope: 'suite', ...error });
    }
  }
  for (let index = 0; index < workers.length; index += 1) {
    try {
      await workerTerminator(workers[index]);
      receipt.cleanup.workers.push({ index, status: 'terminated' });
    } catch (error) {
      const details = { index, ...errorDetails(error) };
      receipt.cleanup.workers.push({ index, status: 'failed', error: details });
      receipt.cleanup.errors.push(details);
    }
  }
  receipt.cleanup.complete = suiteOutcome?.settled !== false;
  checkpoint();
}

function finalizeLoadLifecycle(context) {
  const { receipt, provenance, controller, now, checkpoint } = context;
  if (controller.interrupted && !receipt.interruption) {
    receipt.interruption = { signal: controller.interrupted, atMs: now() };
  }
  if (receipt.provenance.before !== null && receipt.provenance.after === null) {
    try {
      receipt.provenance.after = provenance();
      receipt.provenance.stable = equalProvenance(
        receipt.provenance.before,
        receipt.provenance.after,
      );
    } catch (error) {
      receipt.error ??= {
        classification: 'infrastructure_error',
        ...errorDetails(error),
      };
    }
  }
  refreshReceipt(receipt);
  const primary = classifyPrimary(receipt);
  receipt.primaryFailure = primary === 'passed' ? null : primary;
  receipt.classification = receipt.cleanup.errors.length
    ? 'cleanup_failed'
    : primary;
  receipt.complete = receipt.cleanup.complete;
  receipt.phase = receipt.complete ? 'complete' : 'cleanup';
  checkpoint();
}

export async function runLoadReliability(
  options,
  {
    loadavg = defaultLoadavg,
    workerFactory = createNodeLoadWorker,
    workerTerminator = terminateNodeLoadWorker,
    suiteExecutor = executeVerifyLocal,
    signalRegistrar = registerProcessSignal,
    now = () => Date.now(),
    sleep = sleepFor,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    provenance = collectWorkspaceProvenance,
    writeReceipt = writeReceiptSecurely,
    preflightReceipt = preflightLoadReceiptDestination,
    waitForSuiteSettlement: waitForSuiteSettlementImpl = waitForSuiteSettlement,
    terminationGraceMs = TERMINATION_GRACE_MS,
    terminationForceMs = TERMINATION_FORCE_MS,
    receiptRoot = process.cwd(),
    command = process.argv.slice(),
  } = {},
) {
  const plan = buildLoadReliabilityPlan(options);
  if (!options.run) return { exitCode: 0, plan, receipt: null };

  // Validate the destination and persist an observable startup receipt before
  // creating workers or registering asynchronous lifecycle effects.
  preflightReceipt(options.output, receiptRoot);
  const receipt = buildLoadReliabilityReceipt(
    options,
    command,
    new Date(now()).toISOString(),
  );
  const workers = [];
  const terminationOptions = {
    waitForSuiteSettlement: waitForSuiteSettlementImpl,
    terminationGraceMs,
    terminationForceMs,
  };
  const checkpoint = () => {
    refreshReceipt(receipt);
    writeReceipt(
      options.output,
      `${JSON.stringify(receipt, null, 2)}\n`,
      receiptRoot,
    );
  };
  checkpoint();
  const controller = createRunController({
    signalRegistrar,
    setTimer,
    clearTimer,
    deadlineMs: options.deadlineMs,
    terminationOptions,
  });
  const context = {
    receipt,
    options,
    workers,
    workerFactory,
    workerTerminator,
    suiteExecutor,
    loadavg,
    now,
    sleep,
    provenance,
    checkpoint,
    controller,
  };

  try {
    await executeLoadLifecycle(context);
  } catch (error) {
    recordLifecycleError(receipt, error, controller, now, checkpoint);
  } finally {
    try {
      await cleanupLoadLifecycle(context);
      finalizeLoadLifecycle(context);
    } finally {
      // Keep signal handlers installed through worker cleanup and final receipt
      // persistence; only then release the process-level lifecycle hooks.
      controller.close();
    }
  }
  return {
    exitCode: receipt.classification === 'passed' ? 0 : 1,
    plan,
    receipt,
  };
}

async function main() {
  const options = parseLoadReliabilityOptions(process.argv.slice(2));
  const result = await runLoadReliability(options);
  if (!options.run)
    process.stdout.write(`${JSON.stringify(result.plan, null, 2)}\n`);
  process.exitCode = result.exitCode;
}

if (
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname
) {
  main().catch((error) => {
    process.stderr.write(`[load-reliability] ${error.message}\n`);
    process.exitCode = 1;
  });
}
