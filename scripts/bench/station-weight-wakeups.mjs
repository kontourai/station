import { createRequire } from 'node:module';

/** @typedef {{birth: bigint, interrupt: bigint, packageIdle: bigint}} WakeupCounters */
/** @typedef {ReadonlyMap<number, WakeupCounters | null>} WakeupSnapshot */

export function createDarwinWakeupReader() {
  try {
    /** @type {typeof import('koffi')} */
    const koffi = createRequire(import.meta.url)('koffi');
    const libproc = koffi.load('/usr/lib/libproc.dylib');
    const usage = libproc.func('int proc_pid_rusage(int, int, void *)');
    // <sys/resource.h>, RUSAGE_INFO_V0: UUID (16 bytes), then ten uint64s.
    const info = Buffer.alloc(96);
    return (/** @type {number} */ pid) => {
      if (usage(pid, 0, info) !== 0) return null;
      const birth = info.readBigUInt64LE(80);
      if (birth === 0n || info.readBigUInt64LE(88) !== 0n) return null;
      return {
        birth,
        interrupt: info.readBigUInt64LE(40),
        packageIdle: info.readBigUInt64LE(32),
      };
    };
  } catch {
    return null;
  }
}

const unavailable = (reason) => ({
  status: 'not_measured',
  reason,
  unit: 'count',
});

/**
 * Count only processes read at both endpoints. A missing kernel reading,
 * changed birth, or regressing counter on a shared PID invalidates the sum.
 * @param {WakeupSnapshot | undefined} start
 * @param {WakeupSnapshot | undefined} end
 */
export function darwinWakeupMetric(start, end) {
  if (!start || !end) return unavailable('libproc wakeup counters unavailable');
  let interrupt = 0n;
  let packageIdle = 0n;
  let comparedProcesses = 0;
  for (const [pid, before] of start) {
    if (!end.has(pid)) continue;
    const after = end.get(pid);
    if (!before || !after)
      return unavailable('wakeups unreadable for a process at both endpoints');
    if (before.birth !== after.birth)
      return unavailable('process identity changed between wakeup endpoints');
    if (
      after.interrupt < before.interrupt ||
      after.packageIdle < before.packageIdle
    )
      return unavailable('a wakeup counter decreased');
    interrupt += after.interrupt - before.interrupt;
    packageIdle += after.packageIdle - before.packageIdle;
    comparedProcesses++;
  }
  if (!comparedProcesses)
    return unavailable('no process matched both wakeup endpoints');
  if (
    interrupt > Number.MAX_SAFE_INTEGER ||
    packageIdle > Number.MAX_SAFE_INTEGER
  )
    return unavailable('wakeup delta exceeded the safe integer range');
  return {
    status: 'measured',
    value: Number(interrupt),
    packageIdleWakeups: Number(packageIdle),
    unit: 'count',
    basis: 'libproc interrupt wakeups',
    comparedProcesses,
    endpointOnlyProcesses: start.size + end.size - 2 * comparedProcesses,
  };
}
