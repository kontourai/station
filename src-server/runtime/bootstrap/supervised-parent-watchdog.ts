import { lookupProcessBirthFingerprintAsync } from '@kontourai/station-shared/process-identity';
import type { Logger } from '../../utils/logger.js';

export const SUPERVISED_PARENT_WATCHDOG_INTERVAL_MS = 15_000;
export const SUPERVISED_PARENT_WATCHDOG_GRACE_MS = 20_000;

type SupervisorLiveness = 'alive' | 'dead' | 'unavailable';

/** Only ESRCH proves the pid is gone; EPERM and anything else are live or
 * ambiguous, so they never authorize stopping. */
function supervisorLiveness(pid: number): SupervisorLiveness {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ESRCH'
      ? 'dead'
      : 'unavailable';
  }
}

export async function shouldStopForMissingSupervisor(
  supervisorPid: string | undefined,
  parentPid: number,
  supervisorBirth?: string,
  lookupBirth: (
    pid: number,
  ) => Promise<string | null> = lookupProcessBirthFingerprintAsync,
  platform: NodeJS.Platform = process.platform,
  liveness: (pid: number) => SupervisorLiveness = supervisorLiveness,
): Promise<boolean> {
  if (!supervisorPid) return false;
  const parsedSupervisorPid = Number.parseInt(supervisorPid, 10);
  if (!Number.isSafeInteger(parsedSupervisorPid) || parsedSupervisorPid <= 0)
    return false;
  // `ppid` is useful only as a Unix backstop. Windows retains a stale parent
  // relationship after exit, so prove the actual process identity instead.
  if (supervisorBirth) {
    const observedBirth = await lookupBirth(parsedSupervisorPid).catch(
      () => null,
    );
    if (observedBirth !== null) return observedBirth !== supervisorBirth;
    // `null` is returned both for a dead pid and for a probe that failed
    // (e.g. `ps` exceeding its timeout on a loaded host). Reading every null
    // as "gone" shut down a live desktop's server while `ppid` still named
    // the supervisor (#2327), so stop only when the OS proves the pid is
    // absent. That proof is the only signal Windows has, since it keeps a
    // stale ppid after the parent exits.
    if (liveness(parsedSupervisorPid) === 'dead') return true;
  }
  return platform !== 'win32' && parentPid !== parsedSupervisorPid;
}

type Timer = ReturnType<typeof setTimeout>;

interface SupervisedParentWatchdogDependencies {
  env?: NodeJS.ProcessEnv;
  exit?: (code: number) => void;
  getParentPid?: () => number;
  lookupSupervisorBirth?: (pid: number) => Promise<string | null>;
  supervisorLiveness?: (pid: number) => SupervisorLiveness;
  logger: Pick<Logger, 'error'>;
  now?: () => number;
  onSupervisorGone: () => Promise<void> | void;
  setInterval?: (callback: () => void, delayMs: number) => Timer;
  setTimeout?: (callback: () => void, delayMs: number) => Timer;
}

/**
 * BACKSTOP only: a completely starved server cannot run this timer until its
 * event loop yields. It reaps a detached supervised child after its parent
 * dies; ordinary `station start` deliberately does not set the marker.
 */
export function armSupervisedParentWatchdog(
  dependencies: SupervisedParentWatchdogDependencies,
): void {
  const supervisorPid = (dependencies.env ?? process.env)
    .STATION_SUPERVISOR_PID;
  if (!supervisorPid) return;

  const getParentPid = dependencies.getParentPid ?? (() => process.ppid);
  const supervisorBirth = (dependencies.env ?? process.env)
    .STATION_SUPERVISOR_BIRTH;
  const lookupSupervisorBirth =
    dependencies.lookupSupervisorBirth ?? lookupProcessBirthFingerprintAsync;
  const exit = dependencies.exit ?? ((code) => process.exit(code));
  const now = dependencies.now ?? Date.now;
  const setIntervalFn = dependencies.setInterval ?? setInterval;
  const setTimeoutFn = dependencies.setTimeout ?? setTimeout;
  let stopping = false;
  // The probe is asynchronous so a slow `ps` never blocks the event loop; a
  // tick that arrives while one is still in flight is skipped, not queued.
  let checking = false;
  const check = async () => {
    const parentPid = getParentPid();
    if (
      !(await shouldStopForMissingSupervisor(
        supervisorPid,
        parentPid,
        supervisorBirth,
        lookupSupervisorBirth,
        process.platform,
        dependencies.supervisorLiveness ?? supervisorLiveness,
      )) ||
      stopping
    ) {
      return;
    }
    stopping = true;
    // Once `stopping` is set no later tick will retry, so a throwing logger
    // must not prevent the shutdown below from being armed.
    try {
      dependencies.logger.error(
        'Supervised parent watchdog detected a missing supervisor',
        {
          observedAt: new Date(now()).toISOString(),
          parentPid,
          supervisorPid,
        },
      );
    } catch {
      // The shutdown matters more than the log line.
    }
    const forceExitTimer = setTimeoutFn(
      () => exit(1),
      SUPERVISED_PARENT_WATCHDOG_GRACE_MS,
    );
    forceExitTimer.unref?.();
    void dependencies.onSupervisorGone();
  };
  const timer = setIntervalFn(() => {
    if (stopping || checking) return;
    checking = true;
    void check().finally(() => {
      checking = false;
    });
  }, SUPERVISED_PARENT_WATCHDOG_INTERVAL_MS);
  timer.unref?.();
}
