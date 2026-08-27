/**
 * Portable host CPU-pressure admission for the verification coordinator.
 *
 * The coordinator admits queued work on Station-owned weight alone. On a shared
 * host, external CPU saturation can leave no real capacity even when the
 * Station weight budget says a heavy lane may start (a canonical verify-e2e-full
 * once began at load/core 2.66). This module samples host CPU pressure from two
 * `os.cpus()` snapshots and classifies a sample as healthy/pressured/unavailable
 * so the coordinator can gate heavy lanes (weight >= HOST_PRESSURE_GATE_WEIGHT)
 * behind two consecutive healthy samples before admitting them.
 *
 * Design rules (see AGENTS.md / verification-receipts.md):
 * - Sampling is cross-platform: busy = (totalDelta - idleDelta) / totalDelta.
 * - `os.loadavg()` is telemetry only. On Windows it is always [0, 0, 0], so it
 *   can never be the admission signal; it is recorded for observability only.
 * - Empty/malformed/zero-delta snapshots yield `unavailable`, and the
 *   coordinator fails closed (infrastructure_error) rather than guessing.
 * - The threshold default is 85%. STATION_VERIFICATION_MAX_HOST_CPU_PERCENT may
 *   only lower it, bounded to [70..85]; invalid/relaxing values are rejected
 *   before any lease or child is acquired.
 */

import { cpus, loadavg } from 'node:os';

/** Lanes at or above this weight are admitted behind a host-pressure gate. */
export const HOST_PRESSURE_GATE_WEIGHT = 80;

export const DEFAULT_HOST_CPU_THRESHOLD_PERCENT = 85;
export const MIN_HOST_CPU_THRESHOLD_PERCENT = 70;
export const MAX_HOST_CPU_THRESHOLD_PERCENT = 85;
export const DEFAULT_HOST_PRESSURE_SAMPLE_GAP_MS = 500;
/** A healthy sample held for admission must be no older than this under the
 *  scheduler lock, otherwise the lane resamples outside the lock. */
export const HOST_PRESSURE_FRESH_SAMPLE_MS = 2_000;
export const DEFAULT_HOST_PRESSURE_WAIT_MS = 5 * 60_000;
export const HOST_PRESSURE_OVERRIDE_ENV =
  'STATION_VERIFICATION_MAX_HOST_CPU_PERCENT';

const THRESHOLD_SOURCE_DEFAULT = 'default';
const THRESHOLD_SOURCE_OVERRIDE = 'override';
const CPU_TIME_FIELDS = ['user', 'nice', 'sys', 'idle', 'irq'];

/**
 * Sums the CPU time fields of one `os.cpus()` snapshot into idle/total totals.
 * Returns null for an empty, non-array, or malformed snapshot so the caller
 * treats it as unavailable rather than deriving a misleading 0% busy.
 *
 * @param {Array<{ times?: Record<string, number> }>} snapshot
 * @returns {{ idle: number, total: number, cpuCount: number } | null}
 */
export function sumCpuTimes(snapshot) {
  if (!Array.isArray(snapshot) || snapshot.length === 0) return null;
  let idle = 0;
  let total = 0;
  for (const cpu of snapshot) {
    const times = cpu?.times;
    if (!times || typeof times !== 'object') return null;
    let cpuTotal = 0;
    for (const field of CPU_TIME_FIELDS) {
      const value = times[field];
      if (value !== undefined && typeof value !== 'number') return null;
      const numeric = typeof value === 'number' ? value : 0;
      cpuTotal += numeric;
      if (field === 'idle') idle += numeric;
    }
    total += cpuTotal;
  }
  return { idle, total, cpuCount: snapshot.length };
}

/**
 * Pure CPU-busy math over two snapshots. Returns an integer busy percent
 * [0..100], or null when the delta is empty, malformed, zero, or negative —
 * every such case is "unavailable" rather than "idle".
 *
 * @param {Array<{ times?: Record<string, number> }>} firstSnapshot
 * @param {Array<{ times?: Record<string, number> }>} secondSnapshot
 * @returns {number | null}
 */
export function computeBusyPercent(firstSnapshot, secondSnapshot) {
  const first = sumCpuTimes(firstSnapshot);
  const second = sumCpuTimes(secondSnapshot);
  if (!first || !second) return null;
  if (first.cpuCount !== second.cpuCount || first.cpuCount === 0) return null;
  const totalDelta = second.total - first.total;
  const idleDelta = second.idle - first.idle;
  if (!Number.isFinite(totalDelta) || totalDelta <= 0) return null;
  if (!Number.isFinite(idleDelta)) return null;
  const busy = (totalDelta - idleDelta) / totalDelta;
  if (!Number.isFinite(busy) || busy < 0 || busy > 1) return null;
  return Math.round(busy * 100);
}

/**
 * Resolves the admission threshold from the environment. The default is 85%;
 * STATION_VERIFICATION_MAX_HOST_CPU_PERCENT may only lower it, bounded to
 * [70..85]. A missing value yields the default; an invalid or relaxing value
 * throws so it is rejected before any lease or child is acquired.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ percent: number, source: 'default' | 'override' }}
 */
export function resolveHostPressureThreshold(env = process.env) {
  const raw = env[HOST_PRESSURE_OVERRIDE_ENV];
  if (raw === undefined || raw === '') {
    return {
      percent: DEFAULT_HOST_CPU_THRESHOLD_PERCENT,
      source: THRESHOLD_SOURCE_DEFAULT,
    };
  }
  const text = String(raw).trim();
  if (!/^-?\d+$/.test(text)) {
    throw new Error(
      `${HOST_PRESSURE_OVERRIDE_ENV} must be a strict integer in [${MIN_HOST_CPU_THRESHOLD_PERCENT}..${MAX_HOST_CPU_THRESHOLD_PERCENT}]: ${JSON.stringify(raw)}`,
    );
  }
  const value = Number(text);
  if (
    !Number.isInteger(value) ||
    value < MIN_HOST_CPU_THRESHOLD_PERCENT ||
    value > MAX_HOST_CPU_THRESHOLD_PERCENT
  ) {
    throw new Error(
      `${HOST_PRESSURE_OVERRIDE_ENV} must be a strict integer in [${MIN_HOST_CPU_THRESHOLD_PERCENT}..${MAX_HOST_CPU_THRESHOLD_PERCENT}]: ${JSON.stringify(raw)}`,
    );
  }
  return { percent: value, source: THRESHOLD_SOURCE_OVERRIDE };
}

/**
 * Builds the observable host-pressure sample recorded on a lease / status job.
 * A null busy percent or zero cpu count is `unavailable`; otherwise the sample
 * is `healthy` (at or below threshold) or `pressured` (above threshold). The
 * load-average fields are telemetry only and included when finite.
 *
 * @param {object} options
 * @returns {object}
 */
export function buildHostPressureSample({
  busyPercent,
  cpuCount,
  sampleMs,
  sampledAt,
  threshold,
  source,
  load1,
  loadPerCpu,
}) {
  const resolvedCpuCount =
    Number.isInteger(cpuCount) && cpuCount > 0 ? cpuCount : 0;
  if (
    busyPercent == null ||
    !Number.isFinite(busyPercent) ||
    resolvedCpuCount === 0
  ) {
    return {
      status: 'unavailable',
      cpuCount: resolvedCpuCount,
      sampledAt,
      sampleMs,
      thresholdPercent: threshold,
      source,
      ...(Number.isFinite(load1) ? { load1 } : {}),
      ...(Number.isFinite(loadPerCpu) ? { loadPerCpu } : {}),
    };
  }
  const healthy = busyPercent <= threshold;
  return {
    status: healthy ? 'healthy' : 'pressured',
    busyPercent,
    cpuCount: resolvedCpuCount,
    sampledAt,
    sampleMs,
    thresholdPercent: threshold,
    source,
    ...(Number.isFinite(load1) ? { load1 } : {}),
    ...(Number.isFinite(loadPerCpu) ? { loadPerCpu } : {}),
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates the production host CPU sampler: two `os.cpus()` snapshots separated
 * by `gapMs`, classified against the resolved threshold. Any internal failure
 * yields an `unavailable` sample so the coordinator fails closed rather than
 * raising. Every dependency is injectable for deterministic testing.
 *
 * @returns {() => Promise<object>}
 */
export function createHostCpuSampler({
  threshold = resolveHostPressureThreshold(),
  now = Date.now,
  snapshot = () => cpus(),
  loadavgFn = () => loadavg(),
  gapMs = DEFAULT_HOST_PRESSURE_SAMPLE_GAP_MS,
  sleep = defaultSleep,
} = {}) {
  return async () => {
    try {
      const first = snapshot();
      const startedAt = now();
      await sleep(gapMs);
      const second = snapshot();
      const sampledAt = now();
      const sampleMs = Math.max(0, sampledAt - startedAt);
      const busyPercent = computeBusyPercent(first, second);
      const cpuCount = Array.isArray(second) ? second.length : 0;
      const averages = loadavgFn();
      const load1 = Number.isFinite(averages?.[0]) ? averages[0] : null;
      const loadPerCpu =
        cpuCount > 0 && Number.isFinite(load1) ? load1 / cpuCount : null;
      return buildHostPressureSample({
        busyPercent,
        cpuCount,
        sampleMs,
        sampledAt,
        threshold: threshold.percent,
        source: threshold.source,
        load1,
        loadPerCpu,
      });
    } catch {
      return buildHostPressureSample({
        busyPercent: null,
        cpuCount: 0,
        sampleMs: null,
        sampledAt: now(),
        threshold: threshold.percent,
        source: threshold.source,
      });
    }
  };
}

/** True when the lane's current execution weight is heavy enough to gate. */
export function isLaneHostPressureGated(lane) {
  return (
    Number.isInteger(lane?.weight) && lane.weight >= HOST_PRESSURE_GATE_WEIGHT
  );
}

/**
 * True when the gate has two consecutive healthy samples and the latest is
 * still fresh enough to admit under the scheduler lock.
 */
export function pressureGateSatisfied(consecutiveHealthy, lastSample, now) {
  if (!Number.isInteger(consecutiveHealthy) || consecutiveHealthy < 2)
    return false;
  if (lastSample?.status !== 'healthy') return false;
  const sampledAt = lastSample.sampledAt;
  if (!Number.isFinite(sampledAt)) return false;
  const age = now() - sampledAt;
  return age >= 0 && age <= HOST_PRESSURE_FRESH_SAMPLE_MS;
}

/**
 * Bounded projection of a host-pressure sample for the CLI status surface.
 * Returns undefined when there is nothing to project.
 */
export function projectHostPressureForStatus(hostPressure) {
  if (!hostPressure || typeof hostPressure !== 'object') return undefined;
  const projection = {
    status: String(hostPressure.status ?? ''),
    ...(Number.isFinite(hostPressure.busyPercent)
      ? { busyPercent: hostPressure.busyPercent }
      : {}),
    cpuCount: hostPressure.cpuCount,
    ...(Number.isFinite(hostPressure.sampledAt)
      ? { sampledAt: hostPressure.sampledAt }
      : {}),
    ...(Number.isFinite(hostPressure.sampleMs)
      ? { sampleMs: hostPressure.sampleMs }
      : {}),
    thresholdPercent: hostPressure.thresholdPercent,
    source: String(hostPressure.source ?? ''),
    ...(Number.isFinite(hostPressure.load1)
      ? { load1: hostPressure.load1 }
      : {}),
    ...(Number.isFinite(hostPressure.loadPerCpu)
      ? { loadPerCpu: hostPressure.loadPerCpu }
      : {}),
  };
  return projection;
}
