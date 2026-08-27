import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { exactProcessIdentity } from '../../packages/shared/src/process-identity.mjs';
import { buildWindowsOwnedGuard } from './windows-owned-guard-build.mjs';

const TERMINATION_FORCE_MS = 5_000;
// Per-stream raw-output cap. Two streams consume at most 6MiB, reserving the
// remaining 2MiB of the reporter's aggregate 8MiB budget for attachments.
const DEFAULT_OUTPUT_CAP_BYTES = 3 * 1024 * 1024;
const WINDOWS_OUTPUT_EOF_TIMEOUT_MS = 5_000;
const WINDOWS_TREE_SETTLEMENT_TIMEOUT_MS = 5_000;
let coordinatorGuard;

function prepareCoordinatorGuard(prepareGuard) {
  if (prepareGuard) return prepareGuard();
  if (process.platform !== 'win32')
    return { path: 'station-windows-owned-guard.exe' };
  if (!coordinatorGuard) {
    coordinatorGuard = buildWindowsOwnedGuard();
    // The unique owner-private directory is removed on a normal coordinator
    // exit. A crash can leave it behind, but its randomized location is never
    // reused or trusted by a future run.
    process.once('exit', () => coordinatorGuard?.cleanup());
  }
  return coordinatorGuard;
}

function errorDetails(error) {
  return {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    ...(error?.code ? { code: error.code } : {}),
  };
}

/** Terminates exactly the supplied Windows process tree, never a name pattern. */
export function runWindowsTaskkill(
  pid,
  force,
  spawnProcess = spawn,
  timeoutMs = TERMINATION_FORCE_MS,
) {
  return new Promise((resolve, reject) => {
    const taskkill = spawnProcess(
      'taskkill',
      ['/pid', String(pid), '/t', ...(force ? ['/f'] : [])],
      { stdio: 'ignore', windowsHide: true },
    );
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      try {
        taskkill.kill('SIGKILL');
      } catch {
        // The bounded taskkill timeout remains authoritative.
      }
      finish(new Error(`taskkill did not settle within ${timeoutMs}ms`));
    }, timeoutMs);
    taskkill.once('error', finish);
    taskkill.once('close', (code) =>
      finish(
        code === 0
          ? undefined
          : new Error(`taskkill exited with status ${code ?? 'unknown'}`),
      ),
    );
  });
}

async function sendTreeSignal(
  child,
  signal,
  force,
  processLabel,
  runtime = { platform: process.platform },
) {
  if (child.pid === undefined)
    throw new Error(`${processLabel} child has no pid`);
  if (runtime.platform === 'win32') {
    await (runtime.runWindowsTaskkill ?? runWindowsTaskkill)(child.pid, force);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    if (!child.kill(signal))
      throw new Error(`failed to signal ${processLabel} with ${signal}`);
  }
}

/** Spawns and owns one process group. Callers must inspect isAlive after close. */
export function executeOwnedProcess(
  executable,
  args,
  spawnProcess = spawn,
  processLabel = executable,
  spawnOptions = {},
  runtime = { platform: process.platform },
) {
  const child = spawnProcess(executable, args, {
    ...spawnOptions,
    stdio: spawnOptions.stdio ?? 'inherit',
    windowsHide: spawnOptions.windowsHide ?? true,
    detached: runtime.platform !== 'win32',
  });
  let settled = false;
  let finish;
  const onChildError = (error) => finish({ status: null, error, signal: null });
  const onChildClose = (status, signal) => finish({ status, signal });
  const onStdoutError = () => {};
  const onStderrError = () => {};
  const completion = new Promise((resolve) => {
    finish = (result) => {
      if (settled) return;
      settled = true;
      child.removeListener('error', onChildError);
      child.removeListener('close', onChildClose);
      child.stdout?.removeListener('error', onStdoutError);
      child.stderr?.removeListener('error', onStderrError);
      resolve(result);
    };
    child.once('error', onChildError);
    child.once('close', onChildClose);
  });
  // Register pipe error ownership before publishing identity. Data remains in
  // the OS pipe until captureOwnedProcessOutput attaches immediately after the
  // return, so no raw bytes are printed or discarded by this lifecycle layer.
  child.stdout?.once('error', onStdoutError);
  child.stderr?.once('error', onStderrError);
  // Publish exact identity immediately, before awaiting a single lifecycle
  // event.  This lets a crash-recovery owner target this group rather than a
  // process-name or a recycled PID.
  try {
    spawnOptions.onSpawn?.(child, {
      pid: child.pid ?? null,
      pgid: runtime.platform === 'win32' ? null : (child.pid ?? null),
      processStart: child.pid ? undefined : null,
    });
  } catch (error) {
    // A failed identity publication cannot leave a detached process running.
    // Keep lifecycle listeners installed and resolve a nonpass outcome only
    // after dispatching exact-tree termination.
    const cleanup = spawnOptions.onSpawnFailureCleanup
      ? spawnOptions.onSpawnFailureCleanup(child, error)
      : sendTreeSignal(child, 'SIGTERM', false, processLabel, runtime);
    void Promise.resolve(cleanup)
      .catch(() => {
        // The identity-publication error remains the causal result. Cleanup
        // dispatch failure must not escape as an unhandled rejection.
      })
      .finally(() => {
        finish({ status: null, error, signal: null });
      });
  }
  return {
    child,
    completion,
    promise: completion,
    isAlive: () => {
      if (!settled) return true;
      // `close` only proves the launcher has exited on Windows.  It does not
      // prove that descendants have gone away, and treating it as settlement
      // would let a later lane reuse mutable output while a child still owns
      // it.  A native Job-object settlement probe may be supplied by a host;
      // absent that proof we deliberately retain the fence and fail closed.
      if (runtime.platform === 'win32')
        return spawnOptions.treeSettled?.(child.pid) !== true;
      if (child.pid === undefined) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return error?.code === 'EPERM';
      }
    },
    terminate: () =>
      sendTreeSignal(child, 'SIGTERM', false, processLabel, runtime),
    forceTerminate: () =>
      sendTreeSignal(child, 'SIGKILL', true, processLabel, runtime),
  };
}

function windowsOwnedStdio(stdio) {
  if (Array.isArray(stdio)) return [...stdio.slice(0, 3), 'ipc'];
  const mode = stdio ?? 'inherit';
  return [mode, mode, mode, 'ipc'];
}

function failedExecution(error) {
  const completion = Promise.resolve({ status: null, signal: null, error });
  return {
    child: { pid: undefined },
    completion,
    promise: completion,
    launcherCompletion: completion,
    completionRequiresCleanup: true,
    isAlive: () => false,
    terminate: async () => {},
    forceTerminate: async () => {},
  };
}

function deferred() {
  let resolveDeferred;
  const promise = new Promise((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

/** Attaches EOF/error listeners immediately; the caller starts the timeout. */
function observeOwnedOutputEOF(child) {
  const streams = [child?.stdout, child?.stderr].filter(Boolean);
  let pending = streams.length;
  let settled = false;
  let failed = false;
  let failure;
  let resolveSettled;
  const settledPromise = new Promise((resolve) => {
    resolveSettled = resolve;
  });
  const ended = new Set();
  const finish = (error) => {
    if (settled) return;
    settled = true;
    failed = Boolean(error);
    failure = error;
    for (const stream of streams) {
      stream.removeListener('end', onEnd);
      stream.removeListener('close', onClose);
      stream.removeListener('error', onError);
    }
    resolveSettled();
  };
  const onEnd = function () {
    ended.add(this);
    pending -= 1;
    if (pending === 0) finish();
  };
  const onClose = function () {
    if (!ended.has(this))
      finish(new Error('Windows owned output stream closed before EOF'));
  };
  const onError = (error) => finish(error);
  for (const stream of streams) {
    stream.once('end', onEnd);
    stream.once('close', onClose);
    stream.once('error', onError);
  }
  if (streams.length === 0) finish();
  return {
    wait(timeoutMs = WINDOWS_OUTPUT_EOF_TIMEOUT_MS) {
      if (settled) return failed ? Promise.reject(failure) : Promise.resolve();
      return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(
          () =>
            finish(new Error('Windows owned output streams did not reach EOF')),
          timeoutMs,
        );
        settledPromise.then(() => {
          clearTimeout(timer);
          if (failed) reject(failure);
          else resolvePromise();
        });
      });
    },
  };
}

/** Receiver-side barrier: IPC cannot outrun the captured pipe EOFs. */
export function waitForOwnedOutputEOF(
  child,
  timeoutMs = WINDOWS_OUTPUT_EOF_TIMEOUT_MS,
) {
  return observeOwnedOutputEOF(child).wait(timeoutMs);
}

/**
 * Cross-platform command ownership. On Windows, a live Node IPC wrapper stays
 * above the command tree after the command reports completion. The caller's
 * normal post-result cleanup requests a private abort acknowledgement from the
 * wrapper; only a completed guard Job (or normal COMPLETE plus raw EOF) makes
 * isAlive false.
 */
export function executeOwnedCommand(
  executable,
  args,
  spawnProcess = spawn,
  processLabel = executable,
  spawnOptions = {},
  runtime = { platform: process.platform },
) {
  if (runtime.platform !== 'win32')
    return executeOwnedProcess(
      executable,
      args,
      spawnProcess,
      processLabel,
      spawnOptions,
      runtime,
    );

  const treeSettlement = { proven: false, abortRequested: false };
  const abortSettlement = deferred();
  let completeSettledJob = false;
  let resolveInner;
  const innerCompletion = new Promise((resolveCompletion) => {
    resolveInner = resolveCompletion;
  });
  const callerOnSpawn = spawnOptions.onSpawn;
  const parent = (spawnOptions.resolveParentIdentity ?? exactProcessIdentity)(
    process.pid,
  );
  if (!parent)
    return failedExecution(
      new Error(
        'Windows owned command cannot start without an exact round-trip UTC coordinator CreationDate identity',
      ),
    );
  let guard;
  try {
    guard = spawnOptions.guardExecutable
      ? { path: spawnOptions.guardExecutable }
      : prepareCoordinatorGuard(spawnOptions.prepareGuard);
  } catch (error) {
    return failedExecution(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
  const envelope = Buffer.from(
    JSON.stringify({ executable, args, parent, guardPath: guard.path }),
  ).toString('base64url');
  const execution = executeOwnedProcess(
    process.execPath,
    [resolve(import.meta.dirname, '../windows-owned-launcher.mjs'), envelope],
    spawnProcess,
    processLabel,
    {
      ...spawnOptions,
      stdio: windowsOwnedStdio(spawnOptions.stdio),
      treeSettled: () => treeSettlement.proven,
      onSpawnFailureCleanup: (child) => {
        // `ChildProcess.kill` uses the handle opened for this wrapper. Do not
        // dispatch PID-based taskkill from the owned-command path.
        try {
          child.kill('SIGTERM');
        } catch {
          // The missing identity remains the causal failure and no Job proof
          // is claimed from an unsuccessful wrapper-handle termination.
        }
      },
      onSpawn: (child, _identity) => {
        child.on('message', (message) => {
          if (message?.type === 'owned-command-tree-settled') {
            treeSettlement.proven = true;
            abortSettlement.resolve();
            return;
          }
          if (message?.type === 'owned-command-bound') {
            if (
              !Number.isInteger(message.pid) ||
              message.pid < 1 ||
              typeof message.processStart !== 'string' ||
              !message.processStart ||
              message.jobBound !== true ||
              !Number.isInteger(message.guard?.pid) ||
              message.guard.pid < 1 ||
              typeof message.guard?.start !== 'string' ||
              !message.guard.start
            ) {
              child.send?.({ type: 'owned-command-abort' });
              resolveInner({
                status: null,
                signal: null,
                error: new Error(
                  'Windows owned launcher returned an incomplete Job binding',
                ),
              });
              return;
            }
            try {
              callerOnSpawn?.(child, {
                pid: message.pid,
                pgid: null,
                processStart: message.processStart,
                jobBound: true,
                guard: message.guard,
              });
              child.send?.({
                type: 'owned-command-resume',
                token: message.token,
              });
            } catch (error) {
              child.send?.({
                type: 'owned-command-abort',
                token: message.token,
              });
              resolveInner({
                status: null,
                signal: null,
                error:
                  error instanceof Error ? error : new Error(String(error)),
              });
            }
            return;
          }
          if (message?.type !== 'owned-command-complete') {
            resolveInner({
              status: null,
              signal: null,
              error: new Error(
                'Windows owned launcher returned an invalid result',
              ),
            });
            return;
          }
          completeSettledJob =
            Number.isInteger(message.status) &&
            !message.signal &&
            !message.error;
          resolveInner({
            status: Number.isInteger(message.status) ? message.status : null,
            signal: typeof message.signal === 'string' ? message.signal : null,
            ...(message.error
              ? { error: new Error(String(message.error)) }
              : {}),
          });
        });
      },
    },
    runtime,
  );
  // Observe pipes as soon as the launcher spawn returns, but reserve the EOF
  // allowance for trailing output after command or launcher completion.
  const outputEOF = observeOwnedOutputEOF(execution.child);
  const launcherCompletion = execution.completion;
  const completion = Promise.race([
    innerCompletion,
    launcherCompletion.then((launcher) => ({
      status: null,
      signal: launcher.signal,
      error:
        launcher.error ??
        new Error('Windows owned launcher exited before command completion'),
    })),
  ]).then(async (result) => {
    try {
      await outputEOF.wait(spawnOptions.outputEofTimeoutMs);
      if (completeSettledJob && !result.error) treeSettlement.proven = true;
      return result;
    } catch (error) {
      return {
        status: null,
        signal: null,
        error:
          error instanceof Error
            ? error
            : new Error('Windows owned output EOF barrier failed'),
      };
    }
  });
  const releaseLauncher = () => {
    if (execution.child.connected !== false) {
      try {
        execution.child.disconnect?.();
      } catch {
        // Job settlement is already proven; the wrapper's handle is only a
        // local resource and cannot upgrade or revoke that proof.
      }
    }
  };
  const settleTree = async (forceWrapper = false) => {
    if (treeSettlement.proven) {
      releaseLauncher();
      return;
    }
    if (!treeSettlement.abortRequested) {
      treeSettlement.abortRequested = true;
      if (execution.child.connected === false || !execution.child.send)
        throw new Error(
          'Windows owned launcher cannot acknowledge Job settlement',
        );
      try {
        const sent = execution.child.send({ type: 'owned-command-abort' });
        if (sent === false)
          throw new Error(
            'Windows owned launcher refused the Job settlement request',
          );
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    }
    try {
      await bounded(
        () => abortSettlement.promise,
        spawnOptions.treeSettlementTimeoutMs ??
          WINDOWS_TREE_SETTLEMENT_TIMEOUT_MS,
        'Windows owned launcher did not acknowledge Job settlement',
      );
    } catch (error) {
      if (forceWrapper) {
        try {
          // This is the Node ChildProcess's existing handle, never a numeric
          // PID dispatch. It cannot prove the guard Job was reclaimed.
          execution.child.kill('SIGKILL');
        } catch {
          // Preserve the missing-ack fence below.
        }
      }
      throw error;
    }
    treeSettlement.proven = true;
  };
  return {
    ...execution,
    completion,
    promise: completion,
    launcherCompletion,
    completionRequiresCleanup: true,
    terminate: () => settleTree(false),
    forceTerminate: () => settleTree(true),
  };
}

/**
 * Immediately drains an owned child's pipe streams while retaining an exact
 * bounded raw-byte prefix per stream for later redaction. Every source byte is
 * counted even after the cap so a truncated capture can never masquerade as a
 * complete one; the retained prefix is decoded exactly once at settlement with
 * a fatal UTF-8 decoder. Invalid UTF-8 is remembered as a parser failure and
 * fail-closes the retained text to an empty string rather than printing garbled
 * bytes; chunks are never decoded independently, so a multibyte sequence split
 * across `data` events reassembles before decoding.
 *
 * Each stream resolves to { text, sourceBytes, retainedBytes, truncated,
 * invalidUtf8 }. `truncated` is the nonpass signal existing callers
 * consume (e.g. a child that exits zero but overflowed its cap must not look
 * like a complete passing evidence capture).
 */
export function captureOwnedProcessOutput(
  execution,
  { maxBytes = DEFAULT_OUTPUT_CAP_BYTES, onOverflow } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error('output maxBytes must be a positive safe integer');
  let overflowNotified = false;
  const notifyOverflow = () => {
    if (overflowNotified) return;
    overflowNotified = true;
    try {
      // The owner decides how to terminate its exact process tree.  This hook
      // runs at the first overflow byte rather than after `close`, so a
      // noisy/hung child cannot hold the lane hostage indefinitely.
      void onOverflow?.();
    } catch {
      // Output capture must keep draining even if a caller's notification
      // hook throws; terminal classification remains fail-closed below.
    }
  };
  function capture(stream) {
    const retained = [];
    let probeBytes = 0;
    let sourceBytes = 0;
    let truncated = false;
    let invalidUtf8 = false;
    const validator = new TextDecoder('utf8', {
      fatal: true,
      ignoreBOM: true,
    });
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      try {
        validator.decode(buffer, { stream: true });
      } catch {
        invalidUtf8 = true;
      }
      sourceBytes += buffer.length;
      if (!truncated && sourceBytes > maxBytes) {
        truncated = true;
        // A single notification covers the whole capture: whichever stream
        // crosses its cap first alerts the owner once.
        notifyOverflow();
      }
      // Keep draining/counting every source byte after the cap, but retain
      // only the exact bounded prefix so redaction always sees real bytes.
      // Keep at most three look-ahead bytes beyond the persistence cap. UTF-8
      // code points are at most four bytes, so this is enough to distinguish a
      // valid code point crossing the cap from malformed source bytes.
      const probeLimit = maxBytes + 3;
      if (probeBytes < probeLimit) {
        const remaining = probeLimit - probeBytes;
        const slice =
          buffer.length <= remaining
            ? buffer
            : Buffer.from(buffer.subarray(0, remaining));
        retained.push(slice);
        probeBytes += slice.length;
      }
    };
    stream?.on('data', onData);
    return {
      finish() {
        stream?.removeListener('data', onData);
        try {
          validator.decode();
        } catch {
          invalidUtf8 = true;
        }
        const probe = Buffer.concat(retained);
        let text = '';
        if (probe.length > 0 && !invalidUtf8) {
          const minimum = Math.min(maxBytes, probe.length);
          let decoded = null;
          for (let length = probe.length; length >= minimum; length -= 1) {
            try {
              decoded = new TextDecoder('utf8', {
                fatal: true,
                ignoreBOM: true,
              }).decode(probe.subarray(0, length));
              break;
            } catch {
              // Try the preceding byte boundary. At most three look-ahead
              // bytes are discarded before a valid cap-crossing code point.
            }
          }
          if (decoded != null) {
            let bytes = 0;
            for (const point of decoded) {
              const pointBytes = Buffer.byteLength(point);
              if (bytes + pointBytes > maxBytes) break;
              text += point;
              bytes += pointBytes;
            }
          } else invalidUtf8 = true;
        }
        return {
          text,
          sourceBytes,
          retainedBytes: Buffer.byteLength(text),
          truncated: sourceBytes > maxBytes,
          invalidUtf8,
        };
      },
    };
  }
  const stdout = capture(execution.child.stdout);
  const stderr = capture(execution.child.stderr);
  return {
    finish() {
      const streams = { stdout: stdout.finish(), stderr: stderr.finish() };
      return {
        ...streams,
        invalidUtf8: streams.stdout.invalidUtf8 || streams.stderr.invalidUtf8,
        truncated: streams.stdout.truncated || streams.stderr.truncated,
      };
    },
  };
}

export function registerProcessSignal(signal, handler) {
  process.on(signal, handler);
  return () => process.off(signal, handler);
}

export async function waitForSuiteSettlement(execution, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (execution.isAlive()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    // `completion` may already be resolved while descendants are still being
    // reaped. Racing it here becomes a CPU-burning spin exactly when the host
    // is under the most process pressure.
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(25, remaining)),
    );
  }
  return true;
}

async function bounded(action, timeoutMs, message) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Soft terminate, wait, force terminate, and report remaining owned children. */
export async function terminateSuiteExecution(execution, options) {
  const processLabel = options.processLabel ?? 'owned process';
  const outcome = { settled: true, escalated: false, errors: [] };
  if (!execution?.isAlive()) return outcome;
  try {
    await bounded(
      execution.terminate,
      options.terminationGraceMs,
      'SIGTERM dispatch did not settle',
    );
  } catch (error) {
    outcome.errors.push({ signal: 'SIGTERM', ...errorDetails(error) });
  }
  if (
    await options.waitForSuiteSettlement(execution, options.terminationGraceMs)
  )
    return outcome;
  outcome.escalated = true;
  try {
    await bounded(
      execution.forceTerminate,
      options.terminationForceMs,
      'SIGKILL dispatch did not settle',
    );
  } catch (error) {
    outcome.errors.push({ signal: 'SIGKILL', ...errorDetails(error) });
  }
  if (
    await options.waitForSuiteSettlement(execution, options.terminationForceMs)
  )
    return outcome;
  outcome.settled = false;
  outcome.errors.push({
    signal: 'SIGKILL',
    name: 'Error',
    message: `${processLabel} process tree remained alive after SIGKILL deadline`,
  });
  return outcome;
}
