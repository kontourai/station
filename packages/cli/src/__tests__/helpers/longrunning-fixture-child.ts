import { type ChildProcess, spawn } from 'node:child_process';

/**
 * Test-only fixture: spawns a detached `node -e 'setInterval(...)'` process
 * that idles forever, as a stand-in for a real long-running background
 * service (the station server/UI process) in tests that exercise
 * process-tree lifecycle logic (killProcessTree, lifecycle stop/upgrade
 * guards, dogfood recovery).
 *
 * `detached: true` is required: production code that manages a real,
 * backgrounded station process signals it via `process.kill(-pid, ...)`
 * (see killProcessTree in ../../commands/platform.ts), which only reaches a
 * process that is itself a process-group leader. That is also exactly why
 * this fixture is invisible to a process-group signal sent to the *test
 * worker* (e.g. by scripts/lib/owned-process.mjs terminating a hung or
 * timed-out vitest corpus group, or a plain Ctrl-C): the fixture is its own,
 * separate group, so `-workerPid` never reaches it. That gap is
 * station#1812 -- 91 of these accumulated, reparented to launchd, from
 * killed/timed-out/aborted runs. `installAbnormalExitReaper` below closes it
 * by reaping tracked children directly from the worker's own signal/exit
 * handlers, which *do* still fire in that path.
 */

const tracked = new Set<ChildProcess>();
let reaperInstalled = false;

function isOwnedAndLive(
  proc: ChildProcess,
): proc is ChildProcess & { pid: number } {
  // `exitCode`/`signalCode` are set by Node's own wait/reap bookkeeping the
  // moment it observes this exact child exit, regardless of `unref()`. Once
  // either is non-null we no longer own a live pid, and signalling the bare
  // number again risks hitting an unrelated process that has since reused
  // it. This is the guard against that: never signal a pid our own handle
  // has already told us is gone.
  return (
    proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null
  );
}

function signalIfOwned(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (!isOwnedAndLive(proc)) return;
  try {
    process.kill(proc.pid, signal);
  } catch {
    // ESRCH: exited between the liveness check above and this call.
  }
}

/** Best-effort synchronous reap for contexts with no time (or, for 'exit',
 * no ability) to await a graceful settle. SIGKILL is deliberately immediate
 * here -- there is no budget left to wait out a SIGTERM in an 'exit'
 * handler, and a signal handler racing an already-abnormal teardown should
 * not add its own delay. */
function reapAllSync(): void {
  for (const proc of tracked) signalIfOwned(proc, 'SIGKILL');
}

function installAbnormalExitReaper(): void {
  if (reaperInstalled) return;
  reaperInstalled = true;
  const onSignal = (signal: NodeJS.Signals) => {
    reapAllSync();
    process.removeListener(signal, onSignal);
    // Re-raise so any other listener (vitest's own, or the platform
    // default) still runs. This handler only ever exists to get a chance to
    // reap first, not to swallow the signal or take over shutdown.
    process.kill(process.pid, signal);
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  // `afterEach` cannot run once the whole worker process is torn down by an
  // external kill; 'exit' still fires for any signal Node itself can
  // observe (everything except SIGKILL, which no process can catch or
  // react to -- an unavoidable, disclosed limit, not a gap in this fix).
  process.once('exit', reapAllSync);
}

/** Spawns and tracks the fixture child. Registers the abnormal-exit reaper
 * (idempotent) so it is reaped even if the caller never runs its own
 * cleanup. */
export async function spawnLongRunningFixtureChild(): Promise<ChildProcess> {
  installAbnormalExitReaper();
  const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  proc.unref();
  tracked.add(proc);
  proc.once('exit', () => tracked.delete(proc));
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (proc.pid === undefined) {
    throw new Error('long-running fixture child did not start');
  }
  return proc;
}

const SETTLE_POLL_MS = 20;
const DEFAULT_GRACE_MS = 500;

async function waitForExit(
  proc: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isOwnedAndLive(proc) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
  return !isOwnedAndLive(proc);
}

/**
 * Graceful teardown for the normal (afterEach/finally) path: SIGTERM first,
 * escalating to SIGKILL only if the process is still alive after a short
 * grace window. A bare `setInterval` fixture with no signal handler of its
 * own dies on the first SIGTERM, so the escalation branch is rarely
 * exercised in practice and this stays fast.
 */
export async function reapLongRunningFixtureChild(
  proc: ChildProcess,
  { graceMs = DEFAULT_GRACE_MS }: { graceMs?: number } = {},
): Promise<void> {
  if (!isOwnedAndLive(proc)) return;
  signalIfOwned(proc, 'SIGTERM');
  if (await waitForExit(proc, graceMs)) return;
  signalIfOwned(proc, 'SIGKILL');
  if (!(await waitForExit(proc, graceMs))) {
    throw new Error(
      `owned long-running fixture process ${proc.pid ?? 'unknown'} did not settle after SIGKILL`,
    );
  }
}

/** Reaps every currently-tracked fixture child. Safe to call repeatedly
 * (e.g. once inline in a test and again from `afterEach`) -- an
 * already-exited child is a no-op via the `isOwnedAndLive` guard. */
export async function reapAllLongRunningFixtureChildren(): Promise<void> {
  const fixtures = [...tracked];
  await Promise.all(fixtures.map((proc) => reapLongRunningFixtureChild(proc)));
}
