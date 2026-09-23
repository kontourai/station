import { lookupProcessBirthFingerprintAsync } from '@kontourai/station-shared/process-identity';
import type { Logger } from '../../utils/logger.js';

export const SUPERVISED_PARENT_WATCHDOG_INTERVAL_MS = 15_000;
export const SUPERVISED_PARENT_WATCHDOG_GRACE_MS = 20_000;

export async function shouldStopForMissingSupervisor(
  supervisorPid: string | undefined,
  parentPid: number,
  supervisorBirth?: string,
  lookupBirth: (
    pid: number,
  ) => Promise<string | null> = lookupProcessBirthFingerprintAsync,
  platform: NodeJS.Platform = process.platform,
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
    // `null` means the probe failed (e.g. `ps` exceeded its timeout on a
    // loaded host), not that the supervisor is gone. Treating it as gone
    // shut down a live desktop's server while `ppid` still named the
    // supervisor (#2327). Fall through to the ppid backstop instead.
  }
  return platform !== 'win32' && parentPid !== parsedSupervisorPid;
}

type Timer = ReturnType<typeof setTimeout>;

interface SupervisedParentWatchdogDependencies {
  env?: NodeJS.ProcessEnv;
  exit?: (code: number) => void;
  getParentPid?: () => number;
  lookupSupervisorBirth?: (pid: number) => Promise<string | null>;
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
      )) ||
      stopping
    ) {
      return;
    }
    stopping = true;
    dependencies.logger.error(
      'Supervised parent watchdog detected a missing supervisor',
      {
        observedAt: new Date(now()).toISOString(),
        parentPid,
        supervisorPid,
      },
    );
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
