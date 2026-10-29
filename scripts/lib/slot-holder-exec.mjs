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
 * `holdsSlot: false` (hosted CI, or a check running under its parent's slot)
 * means there is no slot record for the program to outlive, so Windows runs it
 * as an ordinary child instead of an owned Job, whose coordinator identity
 * probe is unavailable on some hosts.
 *
 * @param {{ file: string, args: string[], cwd?: string, label: string, holdsSlot?: boolean }} command
 * @returns {Promise<void>} Only on Windows; on POSIX it never returns.
 */
export async function execAsSlotHolder({
  file,
  args,
  cwd = process.cwd(),
  label,
  holdsSlot = true,
  platform = process.platform,
  spawnSyncImpl,
}) {
  if (platform !== 'win32') {
    process.execve(file, [file, ...args], process.env);
    return;
  }
  if (!holdsSlot) {
    const run = spawnSyncImpl ?? (await import('node:child_process')).spawnSync;
    const result = run(file, args, {
      cwd,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    if (result.error) throw result.error;
    process.exitCode = result.signal ? 1 : (result.status ?? 1);
    return;
  }
  const {
    executeOwnedCommand,
    terminateSuiteExecution,
    waitForSuiteSettlement,
  } = await import('./owned-process.mjs');
  const execution = executeOwnedCommand(file, args, undefined, label, {
    cwd,
    env: process.env,
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
