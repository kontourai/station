import { readFileSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';

/**
 * A host-level CPU pressure reading for the service supervisor's wedge
 * watchdog. `pressured` is the only decision input; `detail` names the
 * measurement for the log line that explains an extended budget.
 */
export interface HostPressureReading {
  pressured: boolean;
  detail: string;
}

/**
 * Linux PSI `some avg60` percentage at or above which the host counts as
 * CPU-starved: at least one runnable task waited for a CPU for this share of
 * the last minute.
 */
export const PSI_CPU_SOME_AVG60_THRESHOLD = 25;

/**
 * One-minute load average per available CPU at or above which the host counts
 * as oversubscribed. Above 1 so a merely busy macOS desktop, whose load
 * average routinely sits near its core count, keeps the unpressured timing.
 */
export const LOAD_PER_CPU_THRESHOLD = 1.5;

/**
 * PSI files in preference order. Under cgroup v2 a container's root cgroup is
 * its own, so its cpu.pressure measures the container rather than the host;
 * on a host whose root cgroup has no pressure file, the system-wide file
 * applies.
 */
export const PSI_CPU_PATHS = [
  '/sys/fs/cgroup/cpu.pressure',
  '/proc/pressure/cpu',
] as const;

export interface HostPressureSources {
  /**
   * The first readable PSI cpu file and its path; throws where PSI is absent
   * (macOS, Windows, kernels without PSI).
   */
  readPsiCpu?: () => { path: string; text: string };
  /** os.loadavg(); Windows reports zeros. */
  loadAverage?: () => number[];
  cpuCount?: () => number;
}

function readFirstPsiCpu(): { path: string; text: string } {
  let lastError: unknown;
  for (const path of PSI_CPU_PATHS) {
    try {
      return { path, text: readFileSync(path, 'utf8') };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Parses the `some avg60=` field of a PSI cpu file, or null when absent or malformed. */
export function parsePsiCpuSomeAvg60(text: string): number | null {
  const someLine = text.split('\n').find((line) => line.startsWith('some '));
  const match = someLine?.match(/(?:^|\s)avg60=(\d+(?:\.\d+)?)(?:\s|$)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Reads CPU pressure from PSI where Linux provides it, and otherwise from the
 * one-minute load average relative to CPUs (macOS). PSI alone decides when it
 * is readable: Linux load averages also count tasks blocked on I/O, which is
 * not CPU starvation. Returns null when neither source yields a reading —
 * Windows, whose load average is always zero, and any host where both reads
 * fail — so callers keep their unpressured timing rather than guessing.
 */
export function readHostPressure(
  sources: HostPressureSources = {},
): HostPressureReading | null {
  const readPsiCpu = sources.readPsiCpu ?? readFirstPsiCpu;
  const loadAverage = sources.loadAverage ?? loadavg;
  const cpuCount = sources.cpuCount ?? availableParallelism;

  try {
    const psi = readPsiCpu();
    const avg60 = parsePsiCpuSomeAvg60(psi.text);
    if (avg60 !== null) {
      return {
        pressured: avg60 >= PSI_CPU_SOME_AVG60_THRESHOLD,
        detail: `${psi.path} some avg60=${avg60}%`,
      };
    }
  } catch {
    // No PSI here; fall back to the load average.
  }

  let load1: number | undefined;
  let cpus = 0;
  try {
    load1 = loadAverage()[0];
    cpus = cpuCount();
  } catch {
    return null;
  }
  // A zero load average is Windows' placeholder, not a measurement.
  if (
    typeof load1 !== 'number' ||
    !Number.isFinite(load1) ||
    load1 <= 0 ||
    cpus <= 0
  ) {
    return null;
  }
  return {
    pressured: load1 / cpus >= LOAD_PER_CPU_THRESHOLD,
    detail: `load ${load1.toFixed(2)} on ${cpus} CPUs`,
  };
}
