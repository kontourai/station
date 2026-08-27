import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../../lib/owned-process.mjs';

export const FIXTURE_COMMAND_TIMEOUT_MS = 10_000;
export const FIXTURE_TEST_TIMEOUT_MS = 15_000;
const FIXTURE_TERMINATION_GRACE_MS = 250;
const FIXTURE_TERMINATION_FORCE_MS = 250;
const FIXTURE_COMPLETION_SETTLE_MS = 2_000;

function timedOutError(timeoutMs) {
  return Object.assign(
    new Error(`fixture process exceeded its ${timeoutMs}ms deadline`),
    { code: 'ETIMEDOUT' },
  );
}

function fixtureFailure(error, { status, signal, stdout, stderr }) {
  return Object.assign(error, { status, signal, stdout, stderr });
}

async function cleanupFixtureExecution(execution) {
  return terminateSuiteExecution(execution, {
    processLabel: 'fixture',
    terminationForceMs: FIXTURE_TERMINATION_FORCE_MS,
    terminationGraceMs: FIXTURE_TERMINATION_GRACE_MS,
    waitForSuiteSettlement,
  });
}

async function waitForFixtureCompletion(execution) {
  let timer;
  try {
    return await Promise.race([
      execution.promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error('fixture process did not complete after cleanup')),
          FIXTURE_COMPLETION_SETTLE_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function diagnostics(result, captured) {
  return {
    status: result.status ?? null,
    signal: result.signal ?? null,
    error: result.error,
    stdout: captured.stdout.text,
    stderr: captured.stderr.text,
  };
}

function assertCleanCleanup(cleanup, result) {
  if (cleanup.settled === false) {
    throw fixtureFailure(
      new Error('fixture process tree survived timeout cleanup'),
      result,
    );
  }
  if (cleanup.errors.length > 0) {
    throw fixtureFailure(
      new Error('fixture process cleanup reported an error'),
      result,
    );
  }
}

function assertCompleteCapture(captured, result) {
  if (captured.invalidUtf8) {
    throw fixtureFailure(
      new Error('fixture process output was not valid UTF-8'),
      result,
    );
  }
  if (captured.truncated) {
    throw fixtureFailure(
      new Error('fixture process output was truncated'),
      result,
    );
  }
}

/**
 * Execute a test-owned fixture process with a bounded owned-tree lifetime.
 *
 * The affected release fixtures exercise real shell transactions, but their
 * fake commands must never let a saturated static lane wait indefinitely.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; allowTimeoutResult?: boolean; maxOutputBytes?: number }} options
 */
export async function runBoundedFixture(
  command,
  args,
  {
    cwd,
    env,
    timeoutMs = FIXTURE_COMMAND_TIMEOUT_MS,
    allowTimeoutResult = false,
    maxOutputBytes,
  } = {},
) {
  // executeOwnedCommand gives POSIX fixtures a private process group and uses
  // the Windows Job-backed owned-command route, so the timeout reclaims exact
  // descendants rather than only the shell launcher.
  const execution = executeOwnedCommand(command, args, undefined, 'fixture', {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = captureOwnedProcessOutput(execution, {
    ...(maxOutputBytes === undefined ? {} : { maxBytes: maxOutputBytes }),
  });
  let timer;
  const outcome = await Promise.race([
    execution.promise.then((result) => ({ kind: 'result', result })),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (outcome.kind === 'timeout') {
    const cleanup = await cleanupFixtureExecution(execution);
    let completion;
    try {
      completion = await waitForFixtureCompletion(execution);
    } catch (error) {
      throw fixtureFailure(
        error instanceof Error ? error : new Error('fixture completion failed'),
        { status: null, signal: null, stderr: '', stdout: '' },
      );
    }
    const captured = output.finish();
    const result = {
      status: completion.status ?? null,
      signal: cleanup.escalated ? 'SIGKILL' : 'SIGTERM',
      error: timedOutError(timeoutMs),
      stdout: captured.stdout.text,
      stderr: captured.stderr.text,
    };
    assertCleanCleanup(cleanup, result);
    assertCompleteCapture(captured, result);
    if (allowTimeoutResult) return result;
    throw fixtureFailure(result.error, result);
  }

  const cleanup = execution.isAlive()
    ? await cleanupFixtureExecution(execution)
    : undefined;
  const captured = output.finish();
  const result = diagnostics(outcome.result, captured);
  if (cleanup) assertCleanCleanup(cleanup, result);
  assertCompleteCapture(captured, result);
  if (outcome.result.error) throw fixtureFailure(outcome.result.error, result);
  return result;
}
