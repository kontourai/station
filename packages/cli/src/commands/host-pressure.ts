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

export interface HostPressureSources {
  /** Contents of /proc/pressure/cpu; throws where PSI is absent (macOS, Windows, older kernels). */
  readPsiCpu?: () => string;
  /** os.loadavg(); Windows reports zeros. */
  loadAverage?: () => number[];
  cpuCount?: () => number;
}

/** Parses the `some avg60=` field of /proc/pressure/cpu, or null when absent or malformed. */
export function parsePsiCpuSomeAvg60(text: string): number | null {
  const someLine = text.split('\n').find((line) => line.startsWith('some '));
  const match = someLine?.match(/(?:^|\s)avg60=(\d+(?:\.\d+)?)(?:\s|$)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Reads host CPU pressure from PSI (Linux) and the load average relative to
 * CPUs (Linux, macOS). Either source reporting pressure is enough. Returns
 * null when neither source yields a reading — Windows, whose load average is
 * always zero, and any host where both reads fail — so callers keep their
 * unpressured timing rather than guessing.
 */
export function readHostPressure(
  sources: HostPressureSources = {},
): HostPressureReading | null {
  const readPsiCpu =
    sources.readPsiCpu ?? (() => readFileSync('/proc/pressure/cpu', 'utf8'));
  const loadAverage = sources.loadAverage ?? loadavg;
  const cpuCount = sources.cpuCount ?? availableParallelism;

  const findings: string[] = [];
  let pressured = false;
  let measured = false;

  let psiAvg60: number | null = null;
  try {
    psiAvg60 = parsePsiCpuSomeAvg60(readPsiCpu());
  } catch {
    // PSI is Linux-only and can be disabled; the load average still applies.
  }
  if (psiAvg60 !== null) {
    measured = true;
    findings.push(`PSI cpu some avg60=${psiAvg60}%`);
    if (psiAvg60 >= PSI_CPU_SOME_AVG60_THRESHOLD) pressured = true;
  }

  let load1: number | undefined;
  let cpus = 0;
  try {
    load1 = loadAverage()[0];
    cpus = cpuCount();
  } catch {
    load1 = undefined;
  }
  // A zero load average is Windows' placeholder, not a measurement.
  if (
    typeof load1 === 'number' &&
    Number.isFinite(load1) &&
    load1 > 0 &&
    cpus > 0
  ) {
    measured = true;
    findings.push(`load ${load1.toFixed(2)} on ${cpus} CPUs`);
    if (load1 / cpus >= LOAD_PER_CPU_THRESHOLD) pressured = true;
  }

  return measured ? { pressured, detail: findings.join(', ') } : null;
}
