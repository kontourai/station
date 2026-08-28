import {
  CI_FAST_INFRASTRUCTURE_EXIT_CODE,
  CI_FAST_OWNER_INFRASTRUCTURE_PREFIX,
} from '../run-ci-fast.mjs';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './owned-process.mjs';

// Keep the deadline waiter aligned with the exact owned-tree terminator: TERM
// dispatch + settlement, then KILL dispatch + settlement. A lane must not
// publish or release its output lock while any part of that sequence remains
// unresolved.
export const OWNED_TERMINATION_GRACE_MS = 5_000;
export const OWNED_TERMINATION_FORCE_MS = 5_000;
export const OWNED_CLEANUP_SETTLE_MS =
  OWNED_TERMINATION_GRACE_MS * 2 + OWNED_TERMINATION_FORCE_MS * 2 + 1_000;

function ciFastInfrastructureCause(output) {
  const lines = String(output?.stderr?.text ?? '').split(/\r?\n/);
  const line = lines.findLast((entry) =>
    entry.startsWith(CI_FAST_OWNER_INFRASTRUCTURE_PREFIX),
  );
  const cause = line?.slice(CI_FAST_OWNER_INFRASTRUCTURE_PREFIX.length).trim();
  return cause || undefined;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits for an execution deadline and fences output if the owned child stays live. */
export async function runWithinDeadline({
  execute,
  lane,
  request,
  signal,
  canceled,
  deadline,
  now,
  fence,
  cleanupSettleMs = OWNED_CLEANUP_SETTLE_MS,
}) {
  let raw;
  let timedOut = false;
  const timeoutController = new AbortController();
  const abort = () => timeoutController.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    if (canceled || signal?.aborted) raw = { status: null, signal: 'SIGTERM' };
    else {
      let timer;
      const run = Promise.resolve(
        execute({ lane, request, signal: timeoutController.signal }),
      ).then(
        (value) => ({ settled: true, value }),
        (error) => ({ settled: true, error }),
      );
      raw = await Promise.race([
        run.then(
          (outcome) => outcome.value ?? { status: null, error: outcome.error },
        ),
        new Promise((resolveTimeout) => {
          timer = setTimeout(
            () => {
              timedOut = true;
              timeoutController.abort();
              resolveTimeout({
                status: null,
                error: new Error('verification timed out'),
              });
            },
            Math.max(0, deadline - now()),
          );
        }),
      ]);
      clearTimeout(timer);
      if (timedOut) {
        const settled = await Promise.race([
          run,
          sleep(cleanupSettleMs).then(() => ({ settled: false })),
        ]);
        if (!settled.settled) {
          fence();
          throw new Error(
            'timed-out verification did not settle; output is fenced',
          );
        }
        raw = settled.value ?? { status: null, error: settled.error };
      }
    }
  } catch (error) {
    if (
      error?.message ===
      'timed-out verification did not settle; output is fenced'
    )
      throw error;
    raw =
      signal?.aborted || error?.name === 'AbortError'
        ? { status: null, signal: 'SIGTERM' }
        : { status: null, error };
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  return { raw, timedOut };
}

/** Creates the default exact-child runner while keeping lease ownership local. */
export function createOwnedRunner({
  lane,
  worktree,
  outputLock,
  owner,
  outputOwned,
  now,
  currentLease,
  updateLease,
  privateCommand,
  processIdentity,
  writeOwnedLease,
  env,
  executeCommand = executeOwnedCommand,
  terminationGraceMs = OWNED_TERMINATION_GRACE_MS,
  terminationForceMs = OWNED_TERMINATION_FORCE_MS,
}) {
  return async ({ signal: abortSignal } = {}) => {
    if (abortSignal?.aborted) return { status: null, signal: 'SIGTERM' };
    const [executable, args] = privateCommand(lane);
    const label = `verification ${lane.id}`;
    const execution = executeCommand(executable, args, undefined, label, {
      cwd: worktree,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      onSpawn: (child, identity) => {
        const childPid = identity.pid ?? child.pid;
        const exact = processIdentity(childPid);
        if (identity.jobBound !== undefined && identity.jobBound !== true)
          throw new Error(
            'Windows verification command started without Job binding',
          );
        const lease = {
          ...currentLease(),
          child: {
            pid: childPid ?? null,
            pgid: identity.pgid,
            processStart: identity.processStart ?? exact?.start ?? null,
            ...(identity.jobBound === true ? { jobBound: true } : {}),
            ...(identity.guard?.pid && identity.guard?.start
              ? {
                  guard: {
                    pid: identity.guard.pid,
                    processStart: identity.guard.start,
                  },
                }
              : {}),
          },
          heartbeatAt: now(),
        };
        const requestWritten = updateLease(lease);
        const outputWritten = outputOwned
          ? writeOwnedLease(outputLock, owner, { ...lease, state: 'output' })
          : true;
        if (!requestWritten || !outputWritten)
          throw new Error(
            'lost verification lease while recording child identity',
          );
      },
    });
    const output = captureOwnedProcessOutput(execution);
    let cleanupPromise;
    const cancel = () =>
      (cleanupPromise ??= terminateSuiteExecution(execution, {
        processLabel: label,
        waitForSuiteSettlement,
        terminationGraceMs,
        terminationForceMs,
      }));
    abortSignal?.addEventListener('abort', () => void cancel(), { once: true });
    const result = await execution.promise;
    const captured = output.finish();
    if (captured.invalidUtf8)
      return {
        status: null,
        error: new Error('verification output was not valid UTF-8'),
        output: captured,
        cleanup: { status: 'failed', survivingOwnedChildren: 0 },
      };
    const cleanup = cleanupPromise
      ? await cleanupPromise
      : execution.isAlive()
        ? await cancel()
        : null;
    if (cleanup?.settled === false)
      return {
        status: null,
        error: new Error('owned verification process survived cleanup'),
        output: captured,
        cleanup: { status: 'failed', survivingOwnedChildren: 1 },
      };
    if (cleanup?.errors.length)
      return {
        ...result,
        output: captured,
        cleanup: { status: 'failed', survivingOwnedChildren: 0 },
      };
    const ciFastInfrastructure =
      lane.id === 'ci-fast' &&
      result.status === CI_FAST_INFRASTRUCTURE_EXIT_CODE;
    const infrastructureCause = ciFastInfrastructure
      ? ciFastInfrastructureCause(captured)
      : undefined;
    return {
      ...result,
      ...(ciFastInfrastructure
        ? {
            infrastructureError: true,
            ...(infrastructureCause ? { infrastructureCause } : {}),
          }
        : {}),
      output: captured,
      cleanup: {
        status: cleanup ? 'passed' : 'not_required',
        survivingOwnedChildren: 0,
      },
    };
  };
}
