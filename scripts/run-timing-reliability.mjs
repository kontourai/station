#!/usr/bin/env node

import { availableParallelism as nodeAvailableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  executeOwnedCommand,
  registerProcessSignal,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './lib/owned-process.mjs';

export const TIMING_RELIABILITY_TEST_FILES = Object.freeze([
  'scripts/__tests__/station-dogfood-launch-path.test.ts',
  'packages/shared/src/__tests__/lifecycle-events.test.ts',
  'src-ui/src/contexts/__tests__/ApiBaseContext.test.tsx',
]);

const ABSOLUTE_MAX_WORKERS = 128;
const WORKERS_PER_PARALLELISM = 16;
const DEFAULT_REPEAT = 3;
const DEFAULT_WORKERS = 4;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 120_000;
const DEFAULT_WORKER_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_WORKER_TERMINATION_TIMEOUT_MS = 5_000;
const DEFAULT_SUITE_TERMINATION_GRACE_MS = 5_000;
const DEFAULT_SUITE_TERMINATION_FORCE_MS = 5_000;
const REPEAT_BOUNDS = [1, 100];

function errorDetails(error) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    ...(error && typeof error === 'object' && 'code' in error && error.code
      ? { code: error.code }
      : {}),
  };
}

export function maximumTimingReliabilityWorkers(
  availableParallelism = nodeAvailableParallelism,
) {
  const parallelism = availableParallelism();
  if (!Number.isSafeInteger(parallelism) || parallelism < 1) {
    throw new Error('availableParallelism must report a positive integer');
  }
  return Math.min(ABSOLUTE_MAX_WORKERS, parallelism * WORKERS_PER_PARALLELISM);
}

function parseBoundedInteger(arg, option, [minimum, maximum]) {
  const text = arg.slice(`${option}=`.length);
  if (!/^\d+$/.test(text)) {
    throw new Error(
      `${option} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${option} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value;
}

export function parseTimingReliabilityOptions(
  args,
  { availableParallelism = nodeAvailableParallelism } = {},
) {
  const workerMaximum = maximumTimingReliabilityWorkers(availableParallelism);
  const options = {
    repeat: DEFAULT_REPEAT,
    workers: Math.min(DEFAULT_WORKERS, workerMaximum),
  };
  const seen = new Set();
  for (const arg of args) {
    const option = ['--repeat', '--workers'].find((name) =>
      arg.startsWith(`${name}=`),
    );
    if (!option) throw new Error(`unknown argument: ${arg}`);
    if (seen.has(option)) throw new Error(`duplicate argument: ${option}`);
    seen.add(option);
    options[option.slice(2)] = parseBoundedInteger(
      arg,
      option,
      option === '--repeat' ? REPEAT_BOUNDS : [1, workerMaximum],
    );
  }
  return options;
}

export function buildTimingReliabilityVitestArgs(cwd = process.cwd()) {
  return [
    resolve(cwd, 'node_modules/vitest/vitest.mjs'),
    'run',
    ...TIMING_RELIABILITY_TEST_FILES,
    '--maxWorkers=1',
    '--no-file-parallelism',
  ];
}

function createCpuLoadWorker({ index }) {
  const worker = new Worker(
    'let value = 0; for (;;) value = Math.imul(value + 1, 1103515245) + 12345;',
    { eval: true },
  );
  let online = false;
  let failureSettled = false;
  let resolveFailure;
  const failure = new Promise((resolveFailurePromise) => {
    resolveFailure = resolveFailurePromise;
  });
  const onlinePromise = new Promise((resolveOnline, rejectOnline) => {
    worker.once('online', () => {
      online = true;
      resolveOnline();
    });
    worker.once('error', (error) => {
      if (!online) rejectOnline(error);
      if (!failureSettled) {
        failureSettled = true;
        resolveFailure({
          classification: 'infrastructure_error',
          worker: index,
          error: errorDetails(error),
        });
      }
    });
    worker.once('exit', (code) => {
      const failureDetails = {
        classification: 'stress_not_achieved',
        worker: index,
        exitCode: code,
        message: `CPU load worker ${index} exited prematurely with status ${code}`,
      };
      if (!online) rejectOnline(new Error(failureDetails.message));
      if (!failureSettled) {
        failureSettled = true;
        resolveFailure(failureDetails);
      }
    });
  });
  return { index, worker, online: onlinePromise, failure };
}

function terminateCpuLoadWorker(descriptor) {
  return descriptor.worker.terminate();
}

export function executeTimingReliabilityVitest(
  { args },
  spawnProcess,
  runtime = { platform: process.platform },
) {
  return executeOwnedCommand(
    process.execPath,
    args,
    spawnProcess,
    'timing-reliability Vitest',
    {},
    runtime,
  );
}

function registerTimingSignals(signalRegistrar) {
  let received = null;
  let resolveSignal;
  const promise = new Promise((resolve) => {
    resolveSignal = resolve;
  });
  const unregister = ['SIGINT', 'SIGTERM'].map((signal) =>
    signalRegistrar(signal, () => {
      if (received) return;
      received = signal;
      resolveSignal({ kind: 'signal', signal });
    }),
  );
  return {
    get received() {
      return received;
    },
    promise,
    close() {
      for (const remove of unregister) remove?.();
    },
  };
}

async function raceWithDeadline(
  entries,
  timeoutMs,
  timeoutResult,
  setTimer,
  clearTimer,
) {
  let timer;
  try {
    return await Promise.race([
      ...entries,
      new Promise((resolveTimeout) => {
        timer = setTimer(() => resolveTimeout(timeoutResult), timeoutMs);
      }),
    ]);
  } finally {
    clearTimer(timer);
  }
}

async function runBoundedAction(action, timeoutMs, setTimer, clearTimer) {
  const result = await raceWithDeadline(
    [
      Promise.resolve()
        .then(action)
        .then(
          (value) => ({ kind: 'settled', value }),
          (error) => ({ kind: 'error', error }),
        ),
    ],
    timeoutMs,
    { kind: 'timeout' },
    setTimer,
    clearTimer,
  );
  if (result.kind === 'timeout') {
    throw new Error(`action did not settle within ${timeoutMs}ms`);
  }
  if (result.kind === 'error') throw result.error;
  return result.value;
}

function classifyProcessResult(attempt, result, durationMs) {
  const infrastructureError = result?.error || result?.status == null;
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
  };
}

function summarizeAttempts(attempts) {
  return {
    attempts: attempts.length,
    passed: attempts.filter((attempt) => attempt.status === 'passed').length,
    failed: attempts.filter((attempt) => attempt.status === 'failed').length,
    infrastructureErrors: attempts.filter(
      (attempt) => attempt.status === 'infrastructure_error',
    ).length,
  };
}

async function terminateSuite(execution, options) {
  return terminateSuiteExecution(execution, {
    processLabel: 'timing-reliability Vitest',
    waitForSuiteSettlement: options.waitForSuiteSettlement,
    terminationGraceMs: options.suiteTerminationGraceMs,
    terminationForceMs: options.suiteTerminationForceMs,
  });
}

async function awaitWorkersOnline(workers, signals, options) {
  const startup = Promise.all(workers.map((worker) => worker.online)).then(
    () => ({ kind: 'online' }),
    (error) => ({ kind: 'startup_error', error }),
  );
  return raceWithDeadline(
    [startup, signals.promise],
    options.workerStartupTimeoutMs,
    { kind: 'startup_timeout' },
    options.setTimer,
    options.clearTimer,
  );
}

function monitorWorkerFailures(workers) {
  return Promise.race(
    workers.map((worker) =>
      worker.failure.then((failure) => ({ kind: 'worker_failure', failure })),
    ),
  );
}

function earlyAttemptResult(attempt, startedAt, error, stop, options) {
  return {
    result: {
      attempt: classifyProcessResult(
        attempt,
        { status: null, error },
        options.now() - startedAt,
      ),
      stop,
    },
  };
}

async function launchAttempt(attempt, args, startedAt, options) {
  let execution;
  try {
    execution = await options.suiteRunner({ attempt, args });
  } catch (error) {
    return earlyAttemptResult(attempt, startedAt, error, false, options);
  }
  if (
    !execution ||
    typeof execution.isAlive !== 'function' ||
    !execution.promise
  ) {
    return earlyAttemptResult(
      attempt,
      startedAt,
      new Error('suite runner did not return an owned execution'),
      true,
      options,
    );
  }
  return { execution };
}

async function awaitAttemptOutcome(execution, workers, signals, options) {
  return raceWithDeadline(
    [
      Promise.resolve(execution.promise).then(
        (result) => ({ kind: 'result', result }),
        (error) => ({ kind: 'result', result: { status: null, error } }),
      ),
      signals.promise,
      monitorWorkerFailures(workers),
    ],
    options.attemptTimeoutMs,
    { kind: 'deadline' },
    options.setTimer,
    options.clearTimer,
  );
}

function completedAttempt(attempt, outcome, startedAt, options) {
  return {
    attempt: classifyProcessResult(
      attempt,
      outcome.result,
      options.now() - startedAt,
    ),
    stop: false,
  };
}

function terminatedAttempt(attempt, outcome, termination, startedAt, options) {
  if (outcome.kind === 'result') {
    return {
      attempt: {
        attempt,
        status: 'infrastructure_error',
        exitCode: outcome.result?.status ?? null,
        durationMs: Math.max(0, options.now() - startedAt),
        error: {
          name: 'Error',
          message:
            'suite wrapper exited while its owned process tree remained alive',
        },
        termination,
      },
      stop: true,
    };
  }
  if (outcome.kind === 'worker_failure') {
    return {
      attempt: {
        attempt,
        status: outcome.failure.classification,
        exitCode: null,
        durationMs: Math.max(0, options.now() - startedAt),
        workerFailure: outcome.failure,
        termination,
      },
      stop: true,
    };
  }
  const message =
    outcome.kind === 'signal'
      ? `received ${outcome.signal}`
      : `attempt exceeded ${options.attemptTimeoutMs}ms deadline`;
  return {
    attempt: {
      attempt,
      status:
        outcome.kind === 'signal' ? 'interrupted' : 'infrastructure_error',
      exitCode: null,
      durationMs: Math.max(0, options.now() - startedAt),
      error: { name: 'Error', message },
      termination,
    },
    stop: true,
  };
}

async function runAttempt(attempt, args, workers, signals, options) {
  const startedAt = options.now();
  const launch = await launchAttempt(attempt, args, startedAt, options);
  if (launch.result) return launch.result;
  const { execution } = launch;
  const outcome = await awaitAttemptOutcome(
    execution,
    workers,
    signals,
    options,
  );
  if (outcome.kind === 'result' && !execution.isAlive()) {
    return completedAttempt(attempt, outcome, startedAt, options);
  }
  const termination = await terminateSuite(execution, options);
  if (
    outcome.kind === 'result' &&
    execution.completionRequiresCleanup === true &&
    termination.settled === true &&
    termination.errors.length === 0
  ) {
    return completedAttempt(attempt, outcome, startedAt, options);
  }
  return terminatedAttempt(attempt, outcome, termination, startedAt, options);
}

async function cleanupWorkers(workers, options) {
  const results = await Promise.all(
    workers.map(async (worker, index) => {
      try {
        await runBoundedAction(
          () => options.workerTerminator(worker),
          options.workerTerminationTimeoutMs,
          options.setTimer,
          options.clearTimer,
        );
        return { index, status: 'terminated' };
      } catch (error) {
        return {
          index,
          status: 'failed',
          error: errorDetails(error),
        };
      }
    }),
  );
  return {
    workers: results,
    errors: results.filter((result) => result.status === 'failed'),
  };
}

function classifyRun(attempts, runFailure, cleanup, signal) {
  if (cleanup.errors.length > 0) return 'cleanup_failed';
  if (signal) return 'interrupted';
  if (runFailure) return runFailure.classification;
  if (attempts.some((attempt) => attempt.status === 'stress_not_achieved')) {
    return 'stress_not_achieved';
  }
  if (
    attempts.some(
      (attempt) =>
        attempt.status === 'infrastructure_error' ||
        attempt.status === 'interrupted',
    )
  ) {
    return 'infrastructure_error';
  }
  if (attempts.some((attempt) => attempt.status === 'failed')) {
    return 'suite_failed';
  }
  return 'passed';
}

function buildLifecycleOptions(dependencies) {
  return {
    workerTerminator: dependencies.workerTerminator,
    suiteRunner: dependencies.suiteRunner,
    waitForSuiteSettlement: dependencies.waitForSuiteSettlement,
    now: dependencies.now,
    setTimer: dependencies.setTimer,
    clearTimer: dependencies.clearTimer,
    attemptTimeoutMs: dependencies.attemptTimeoutMs,
    workerStartupTimeoutMs: dependencies.workerStartupTimeoutMs,
    workerTerminationTimeoutMs: dependencies.workerTerminationTimeoutMs,
    suiteTerminationGraceMs: dependencies.suiteTerminationGraceMs,
    suiteTerminationForceMs: dependencies.suiteTerminationForceMs,
  };
}

async function startWorkers(workerCount, workerFactory, workers) {
  for (let index = 0; index < workerCount; index += 1) {
    workers.push(await workerFactory({ index }));
  }
}

function startupFailure(startup, timeoutMs) {
  if (startup.kind === 'signal') {
    return {
      classification: 'interrupted',
      message: `received ${startup.signal}`,
    };
  }
  return {
    classification: 'infrastructure_error',
    message:
      startup.kind === 'startup_timeout'
        ? `CPU load workers did not come online within ${timeoutMs}ms`
        : 'CPU load worker failed during startup',
    ...(startup.error ? { error: errorDetails(startup.error) } : {}),
  };
}

async function executeAttempts(
  options,
  args,
  workers,
  signals,
  lifecycleOptions,
  attempts,
  output,
) {
  for (let attempt = 1; attempt <= options.repeat; attempt += 1) {
    output(`[timing-reliability] attempt ${attempt}/${options.repeat}`);
    const result = await runAttempt(
      attempt,
      args,
      workers,
      signals,
      lifecycleOptions,
    );
    attempts.push(result.attempt);
    if (result.stop) break;
  }
}

async function executeTimingLifecycle(context) {
  const {
    options,
    args,
    workers,
    attempts,
    signals,
    lifecycleOptions,
    workerFactory,
    output,
  } = context;
  await startWorkers(options.workers, workerFactory, workers);
  const startup = await awaitWorkersOnline(workers, signals, lifecycleOptions);
  if (startup.kind !== 'online') {
    return startupFailure(startup, lifecycleOptions.workerStartupTimeoutMs);
  }
  await executeAttempts(
    options,
    args,
    workers,
    signals,
    lifecycleOptions,
    attempts,
    output,
  );
  return null;
}

function suiteTerminationCleanupErrors(attempts) {
  return attempts.flatMap((attempt) => {
    const termination = attempt.termination;
    if (
      !termination ||
      (termination.settled !== false && termination.errors.length === 0)
    ) {
      return [];
    }
    const errors = termination.errors.map((error) => ({
      scope: 'suite',
      attempt: attempt.attempt,
      ...error,
    }));
    if (termination.settled === false && errors.length === 0) {
      errors.push({
        scope: 'suite',
        attempt: attempt.attempt,
        name: 'Error',
        message: 'timing-reliability Vitest process tree did not settle',
      });
    }
    return errors;
  });
}

function mergeCleanup(workerCleanup, attempts) {
  const suiteErrors = suiteTerminationCleanupErrors(attempts);
  return {
    workers: workerCleanup.workers,
    errors: [...workerCleanup.errors, ...suiteErrors],
  };
}

function finalizeTimingRun(context) {
  const { options, attempts, runFailure, cleanup, signals, output, args } =
    context;
  const summary = summarizeAttempts(attempts);
  const classification = classifyRun(
    attempts,
    runFailure,
    cleanup,
    signals.received,
  );
  const exitCode =
    classification === 'passed' && summary.passed === options.repeat ? 0 : 1;
  output(
    `[timing-reliability] ${summary.passed}/${options.repeat} passed; ` +
      `${cleanup.errors.length} cleanup error(s); ${classification}`,
  );
  return {
    exitCode,
    classification,
    attempts,
    summary,
    ...(runFailure ? { runFailure } : {}),
    cleanup,
    args,
  };
}

/**
 * Repeats the known timing-sensitive tests under monitored CPU contention.
 * Lifecycle dependencies are injected so unit tests do not spawn processes or
 * consume CPU.
 */
export async function runTimingReliability(
  options,
  {
    workerFactory = createCpuLoadWorker,
    workerTerminator = terminateCpuLoadWorker,
    suiteRunner = executeTimingReliabilityVitest,
    signalRegistrar = registerProcessSignal,
    waitForSuiteSettlement: waitForSuiteSettlementImpl = waitForSuiteSettlement,
    buildArgs = buildTimingReliabilityVitestArgs,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
    workerStartupTimeoutMs = DEFAULT_WORKER_STARTUP_TIMEOUT_MS,
    workerTerminationTimeoutMs = DEFAULT_WORKER_TERMINATION_TIMEOUT_MS,
    suiteTerminationGraceMs = DEFAULT_SUITE_TERMINATION_GRACE_MS,
    suiteTerminationForceMs = DEFAULT_SUITE_TERMINATION_FORCE_MS,
    output = (line) => process.stdout.write(`${line}\n`),
  } = {},
) {
  const workers = [];
  const attempts = [];
  const args = buildArgs();
  const signals = registerTimingSignals(signalRegistrar);
  let runFailure = null;
  let cleanup = { workers: [], errors: [] };
  const lifecycleOptions = buildLifecycleOptions({
    workerTerminator,
    suiteRunner,
    waitForSuiteSettlement: waitForSuiteSettlementImpl,
    now,
    setTimer,
    clearTimer,
    attemptTimeoutMs,
    workerStartupTimeoutMs,
    workerTerminationTimeoutMs,
    suiteTerminationGraceMs,
    suiteTerminationForceMs,
  });

  try {
    runFailure = await executeTimingLifecycle({
      options,
      args,
      workers,
      attempts,
      signals,
      lifecycleOptions,
      workerFactory,
      output,
    });
  } catch (error) {
    runFailure = {
      classification: 'infrastructure_error',
      message: 'timing reliability lifecycle failed',
      error: errorDetails(error),
    };
  } finally {
    const workerCleanup = await cleanupWorkers(workers, lifecycleOptions);
    cleanup = mergeCleanup(workerCleanup, attempts);
    signals.close();
  }

  return finalizeTimingRun({
    options,
    attempts,
    runFailure,
    cleanup,
    signals,
    output,
    args,
  });
}

async function main() {
  try {
    const options = parseTimingReliabilityOptions(process.argv.slice(2));
    const result = await runTimingReliability(options);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(
      `[timing-reliability] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  void main();
}
