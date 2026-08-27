import { type ChildProcess, spawn } from 'node:child_process';

/**
 * Test-only fixture: spawns a detached `node -e 'setInterval(...)'` process
 * that idles forever, as a stand-in for a real, backgrounded station server
 * process in scripts/__tests__/station-dogfood-runtime-recovery.integration.test.ts
 * (the "unrelated" process a fingerprint-mismatch reconcile must refuse to
 * touch).
 *
 * `detached: true` is required to match a real detached station server
 * (its own process-group leader), which is also exactly why this fixture is
 * invisible to a process-group signal sent to the *test worker* -- e.g.
 * scripts/lib/owned-process.mjs terminating a hung/timed-out vitest corpus
 * group, or a plain Ctrl-C. That gap is station#1812. Sibling
 * implementation, same shape:
 * packages/cli/src/__tests__/helpers/longrunning-fixture-child.ts (a
 * different workspace package, so duplicated here rather than imported
 * across the package boundary).
 */

const tracked = new Set<ChildProcess>();
let reaperInstalled = false;

function isOwnedAndLive(
  proc: ChildProcess,
): proc is ChildProcess & { pid: number } {
  return (
    proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null
  );
}

function signalIfOwned(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (!isOwnedAndLive(proc)) return;
  try {
    process.kill(proc.pid, signal);
  } catch {
    // ESRCH: exited between the liveness check and this call.
  }
}

/** Best-effort synchronous reap for contexts with no time (or, for 'exit',
 * no ability) to await a graceful settle. */
function reapAllSync(): void {
  for (const proc of tracked) signalIfOwned(proc, 'SIGKILL');
}

function installAbnormalExitReaper(): void {
  if (reaperInstalled) return;
  reaperInstalled = true;
  const onSignal = (signal: NodeJS.Signals) => {
    reapAllSync();
    process.removeListener(signal, onSignal);
    process.kill(process.pid, signal);
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  process.once('exit', reapAllSync);
}

export async function spawnLongRunningFixtureChild({
  cwd,
}: {
  cwd?: string;
} = {}): Promise<ChildProcess> {
  installAbnormalExitReaper();
  const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], {
    detached: true,
    cwd,
    stdio: 'ignore',
  });
  proc.unref();
  tracked.add(proc);
  proc.once('exit', () => tracked.delete(proc));
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

/** Graceful teardown for the normal (afterEach) path: SIGTERM first,
 * escalating to SIGKILL only if still alive after a short grace window. */
export async function reapLongRunningFixtureChild(
  proc: ChildProcess,
  { graceMs = DEFAULT_GRACE_MS }: { graceMs?: number } = {},
): Promise<void> {
  if (!isOwnedAndLive(proc)) return;
  signalIfOwned(proc, 'SIGTERM');
  if (await waitForExit(proc, graceMs)) return;
  signalIfOwned(proc, 'SIGKILL');
  await waitForExit(proc, graceMs);
}

export async function reapAllLongRunningFixtureChildren(): Promise<void> {
  const fixtures = [...tracked];
  await Promise.all(fixtures.map((proc) => reapLongRunningFixtureChild(proc)));
}
