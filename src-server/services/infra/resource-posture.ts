/**
 * Server-owned host CPU diagnostics.
 *
 * These observations are display-only. Product behavior must never refuse,
 * defer, prioritize, or otherwise gate user work from this module's output.
 */
import { cpus } from 'node:os';

export const RUNTIME_RESOURCE_POSTURE_DEGRADED_BUSY_PERCENT = 85;
export const RUNTIME_RESOURCE_POSTURE_CRITICAL_BUSY_PERCENT = 95;
export const RUNTIME_RESOURCE_POSTURE_CACHE_MS = 2_000;
export const RUNTIME_RESOURCE_POSTURE_SAMPLE_GAP_MS = 500;

type CpuSnapshot = ReturnType<typeof cpus>;
type CpuTimes = { idle: number; total: number; cpuCount: number };

type RuntimePostureBase = {
  cpuCount: number;
  sampledAt: number | null;
  ageMs?: number | null;
  sampleMs: number | null;
  thresholdPercent: number;
  criticalThresholdPercent: number;
  source: string;
};

type RuntimeObservedPosture<TKind extends 'healthy' | 'degraded' | 'critical'> =
  RuntimePostureBase & {
    kind: TKind;
    busyPercent: number;
  };

export type RuntimeResourcePosture =
  | RuntimeObservedPosture<'healthy'>
  | RuntimeObservedPosture<'degraded'>
  | RuntimeObservedPosture<'critical'>
  | (RuntimePostureBase & { kind: 'unavailable' });

type HostPressureSample = {
  busyPercent?: number;
  cpuCount?: number;
  sampledAt?: number;
  sampleMs?: number;
  thresholdPercent?: number;
  source?: string;
};

export interface RuntimeResourcePostureProbe {
  observe(): Promise<RuntimeResourcePosture>;
}

export interface RuntimeResourcePostureController
  extends RuntimeResourcePostureProbe {
  reserveEngineStart(): RuntimeEngineStartLease;
}

export interface RuntimeEngineStartLease {
  release(): void;
}

export interface RuntimeResourcePostureProbeOptions {
  /** Numeric diagnostic observation seam for deterministic tests. */
  sample?: () => Promise<HostPressureSample>;
  now?: () => number;
  cacheMs?: number;
}

export type RuntimeEngineStartIntent =
  | 'interactive_user'
  | 'queued_background'
  | 'delegated_background'
  | 'webhook'
  | 'recovery';

function sumCpuTimes(snapshot: CpuSnapshot): CpuTimes | undefined {
  if (!snapshot.length) return undefined;
  let idle = 0;
  let total = 0;
  for (const cpu of snapshot) {
    const times = cpu.times;
    const values = [times.user, times.nice, times.sys, times.idle, times.irq];
    if (values.some((value) => !Number.isFinite(value) || value < 0))
      return undefined;
    idle += times.idle;
    total += values.reduce((sum, value) => sum + value, 0);
  }
  return { idle, total, cpuCount: snapshot.length };
}

/** Pure CPU-busy arithmetic over two `os.cpus()` snapshots. */
export function computeRuntimeCpuBusyPercent(
  firstSnapshot: CpuSnapshot,
  secondSnapshot: CpuSnapshot,
): number | undefined {
  const first = sumCpuTimes(firstSnapshot);
  const second = sumCpuTimes(secondSnapshot);
  if (!first || !second || first.cpuCount !== second.cpuCount) return undefined;
  const totalDelta = second.total - first.total;
  const idleDelta = second.idle - first.idle;
  if (totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta)
    return undefined;
  return Math.round(((totalDelta - idleDelta) / totalDelta) * 100);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Product-owned sampler used only by the diagnostics endpoint. */
export function createRuntimeCpuSampler(
  options: {
    readCpus?: () => CpuSnapshot;
    wait?: (ms: number) => Promise<void>;
    now?: () => number;
    sampleGapMs?: number;
  } = {},
): () => Promise<HostPressureSample> {
  const readCpus = options.readCpus ?? cpus;
  const waitForGap = options.wait ?? wait;
  const now = options.now ?? Date.now;
  const sampleGapMs =
    options.sampleGapMs ?? RUNTIME_RESOURCE_POSTURE_SAMPLE_GAP_MS;
  return async () => {
    const startedAt = now();
    const first = readCpus();
    await waitForGap(sampleGapMs);
    const second = readCpus();
    return {
      busyPercent: computeRuntimeCpuBusyPercent(first, second),
      cpuCount: second.length,
      sampledAt: now(),
      sampleMs: Math.max(0, now() - startedAt),
      thresholdPercent: RUNTIME_RESOURCE_POSTURE_DEGRADED_BUSY_PERCENT,
      source: 'runtime-diagnostics',
    };
  };
}

export function deriveRuntimeResourcePosture(
  sample: HostPressureSample,
): RuntimeResourcePosture {
  const cpuCount =
    Number.isInteger(sample.cpuCount) && (sample.cpuCount ?? 0) > 0
      ? sample.cpuCount!
      : 0;
  const busyPercent =
    Number.isFinite(sample.busyPercent) && (sample.busyPercent ?? -1) >= 0
      ? sample.busyPercent!
      : undefined;
  const base: RuntimePostureBase = {
    cpuCount,
    sampledAt: Number.isFinite(sample.sampledAt) ? sample.sampledAt! : null,
    ageMs: 0,
    sampleMs: Number.isFinite(sample.sampleMs) ? sample.sampleMs! : null,
    thresholdPercent: Number.isFinite(sample.thresholdPercent)
      ? sample.thresholdPercent!
      : RUNTIME_RESOURCE_POSTURE_DEGRADED_BUSY_PERCENT,
    criticalThresholdPercent: RUNTIME_RESOURCE_POSTURE_CRITICAL_BUSY_PERCENT,
    source: String(sample.source ?? 'runtime-diagnostics'),
  };
  if (busyPercent === undefined || cpuCount === 0)
    return { kind: 'unavailable', ...base };
  return {
    kind:
      busyPercent >= RUNTIME_RESOURCE_POSTURE_CRITICAL_BUSY_PERCENT
        ? 'critical'
        : busyPercent >= base.thresholdPercent
          ? 'degraded'
          : 'healthy',
    busyPercent,
    ...base,
  };
}

export class ConcurrentEngineStartCapacityError extends Error {
  readonly code = 'resource_engine_start_capacity';
  readonly retryable = true;
  constructor() {
    super('Another engine is already starting. Try again after it settles.');
    this.name = 'ConcurrentEngineStartCapacityError';
  }
}

export function createRuntimeResourcePostureController(
  options: RuntimeResourcePostureProbeOptions = {},
): RuntimeResourcePostureController {
  const sample = options.sample ?? createRuntimeCpuSampler();
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? RUNTIME_RESOURCE_POSTURE_CACHE_MS;
  let latest: RuntimeResourcePosture | undefined;
  let refreshedAt: number | undefined;
  let inFlight: Promise<RuntimeResourcePosture> | undefined;
  let engineStartReserved = false;

  const withAge = (
    posture: RuntimeResourcePosture,
  ): RuntimeResourcePosture => ({
    ...posture,
    ageMs:
      posture.sampledAt === null
        ? null
        : Math.max(0, now() - posture.sampledAt),
  });

  return {
    async observe() {
      if (
        latest &&
        refreshedAt !== undefined &&
        now() - refreshedAt >= 0 &&
        now() - refreshedAt <= cacheMs
      )
        return withAge(latest);
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          latest = deriveRuntimeResourcePosture(await sample());
        } catch {
          latest = deriveRuntimeResourcePosture({
            sampledAt: now(),
            source: 'runtime-diagnostics',
          });
        }
        refreshedAt = now();
        return withAge(latest);
      })().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    reserveEngineStart() {
      if (engineStartReserved) throw new ConcurrentEngineStartCapacityError();
      engineStartReserved = true;
      let released = false;
      return Object.freeze({
        release() {
          if (released) return;
          released = true;
          engineStartReserved = false;
        },
      });
    },
  };
}

export function createRuntimeResourcePostureProbe(
  options: RuntimeResourcePostureProbeOptions = {},
): RuntimeResourcePostureController {
  return createRuntimeResourcePostureController(options);
}

export function createEnvironmentRuntimeResourcePostureProbe(
  _env: NodeJS.ProcessEnv = process.env,
  options: RuntimeResourcePostureProbeOptions = {},
): RuntimeResourcePostureController {
  return createRuntimeResourcePostureController(options);
}

/**
 * Preserve start-intent plumbing and the real one-at-a-time start invariant.
 * Host diagnostics are deliberately neither sampled nor consulted here.
 */
export async function admitEngineStartForIntent(
  probe: RuntimeResourcePostureProbe | undefined,
  _logger: unknown,
  _intent: RuntimeEngineStartIntent,
  _input: { binding: string },
): Promise<RuntimeEngineStartLease | undefined> {
  const controller = probe as
    | Partial<RuntimeResourcePostureController>
    | undefined;
  return typeof controller?.reserveEngineStart === 'function'
    ? controller.reserveEngineStart()
    : undefined;
}
