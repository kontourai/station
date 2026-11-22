import { spawnSync } from 'node:child_process';

/**
 * Run a program as the holder of a host slot (`typecheck-host-slots.mjs`), so
 * the program cannot outlive the slot record that admits it.
 *
 * On POSIX this process becomes the program through execve: the holder's pid
 * and birth fingerprint are the program's, the exit hook never runs, and the
 * next waiter reclaims the record from the dead pid. On Windows, which has no
 * execve, an owned Job kills the program if this holder dies, and completion
 * waits for the whole Job to settle before the caller's exit hook releases
 * the slot.
 *
 * Before execve, stdio is put back into blocking mode (#5119). Touching
 * `process.stdout`/`process.stderr` (a slot-wait message, a warning) makes
 * libuv set O_NONBLOCK on the inherited pipe or socket, a flag that belongs to
 * the open file description shared with the caller's capture and survives
 * execve. A native program that expects blocking stdio, such as Biome, then
 * dies with EAGAIN ("Resource temporarily unavailable") the moment its reader
 * lags, even though that reader drains continuously. libuv clears O_NONBLOCK
 * on fds 0-2 when it spawns a child with inherited stdio, so a no-op child
 * restores the mode the program expects.
 *
 * @param {{ file: string, args: string[], cwd?: string, label: string, env?: NodeJS.ProcessEnv }} command
 * @returns {Promise<void>} Only on Windows; on POSIX it never returns.
 */
export async function execAsSlotHolder({
  file,
  args,
  cwd = process.cwd(),
  label,
  env = process.env,
}) {
  if (process.platform !== 'win32') {
    const reset = spawnSync('/bin/sh', ['-c', ':'], {
      stdio: 'inherit',
      windowsHide: true,
    });
    if (reset.error || reset.status !== 0)
      throw new Error(
        `${label}: cannot restore blocking stdio before exec: ${reset.error?.message ?? `exit ${reset.status}`}`,
      );
    process.execve(file, [file, ...args], env);
    return;
  }
  const {
    executeOwnedCommand,
    terminateSuiteExecution,
    waitForSuiteSettlement,
  } = await import('./owned-process.mjs');
  const execution = executeOwnedCommand(file, args, undefined, label, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  execution.child.stdout?.pipe(process.stdout, { end: false });
  execution.child.stderr?.pipe(process.stderr, { end: false });
  let interrupted = false;
  let cleanup;
  const stop = () => {
    cleanup ??= terminateSuiteExecution(execution, {
      processLabel: label,
      waitForSuiteSettlement,
      terminationGraceMs: 2000,
      terminationForceMs: 2000,
    });
    return cleanup;
  };
  const onSignal = () => {
    interrupted = true;
    void stop();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const result = await execution.completion;
    if (execution.isAlive()) await stop();
    if (cleanup) {
      const settled = await cleanup;
      if (!settled.settled || settled.errors.length)
        throw new Error(`${label} process tree did not settle`);
    }
    if (result.error) throw result.error;
    process.exitCode = interrupted || result.signal ? 1 : (result.status ?? 1);
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}
