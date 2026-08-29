/**
 * One server-owned view of host pressure for runtime admission and UI truth.
 * The portable sampler owns CPU arithmetic; this controller owns time:
 * shared sampling, smoothing, sustained critical entry, and hysteresis.
 */
import { randomBytes } from 'node:crypto';
import {
  buildHostPressureSample,
  createHostCpuSampler,
} from '../../../scripts/lib/verification-host-pressure.mjs';
import { resourcePostureDecisions } from '../../telemetry/metrics.js';
import type { Logger } from '../../utils/logger.js';

export const RUNTIME_RESOURCE_POSTURE_DEGRADED_BUSY_PERCENT = 85;
export const RUNTIME_RESOURCE_POSTURE_CRITICAL_BUSY_PERCENT = 95;
export const RUNTIME_RESOURCE_POSTURE_DEGRADED_EXIT_BUSY_PERCENT = 80;
export const RUNTIME_RESOURCE_POSTURE_CRITICAL_EXIT_BUSY_PERCENT = 90;
export const RUNTIME_RESOURCE_POSTURE_CRITICAL_ENTRY_SAMPLES = 3;
export const RUNTIME_RESOURCE_POSTURE_RECOVERY_SAMPLES = 2;
export const RUNTIME_RESOURCE_POSTURE_WINDOW_SIZE = 5;
export const RUNTIME_RESOURCE_POSTURE_CACHE_MS = 2_000;
export const RUNTIME_RESOURCE_POSTURE_UNAVAILABLE_WARNING_INTERVAL_MS = 60_000;
export const RUNTIME_RESOURCE_POSTURE_MIN_AVAILABLE_MEMORY_BYTES =
  512 * 1024 * 1024;
export const RUNTIME_RESOURCE_POSTURE_MIN_AVAILABLE_MEMORY_PERCENT = 5;
export const RUNTIME_RESOURCE_OVERRIDE_TTL_MS = 30_000;
export const RUNTIME_RESOURCE_OVERRIDE_CAPACITY = 64;

type Operation =
  | 'engine_start'
  | 'scheduled_job'
  | 'background_start'
  | 'recovery_start';
const unavailableWarningAtByOperation = new Map<Operation, number>();
type ResourcePostureLogger = Pick<Logger, 'warn'> &
  Partial<Pick<Logger, 'info'>>;

type RuntimePostureBase = {
  cpuCount: number;
  sampledAt: number | null;
  ageMs?: number | null;
  sampleMs: number | null;
  thresholdPercent: number;
  criticalThresholdPercent?: number;
  source: string;
  windowLength?: number;
  postureSince?: number | null;
  availableMemoryBytes?: number | null;
  totalMemoryBytes?: number | null;
  memoryPressure?: 'healthy' | 'critical' | 'unavailable';
};

type RuntimeObservedPosture<TKind extends 'healthy' | 'degraded' | 'critical'> =
  RuntimePostureBase & {
    kind: TKind;
    /** Latest raw observation. */
    busyPercent: number;
    /** Median of the bounded rolling window. */
    smoothedBusyPercent?: number;
  };

export type RuntimeResourcePosture =
  | RuntimeObservedPosture<'healthy'>
  | RuntimeObservedPosture<'degraded'>
  | RuntimeObservedPosture<'critical'>
  | (RuntimePostureBase & { kind: 'unavailable' });

type HostPressureSample = {
  status?: unknown;
  busyPercent?: number;
  cpuCount?: number;
  sampledAt?: number;
  sampleMs?: number;
  thresholdPercent?: number;
  source?: string;
  availableMemoryBytes?: number;
  totalMemoryBytes?: number;
};

export interface RuntimeResourcePostureProbe {
  observe(): Promise<RuntimeResourcePosture>;
}
export interface RuntimeResourcePostureController
  extends RuntimeResourcePostureProbe {
  reserveEngineStart(): RuntimeEngineStartLease;
  issueInteractiveOverride(binding: string): RuntimeInteractiveOverride;
  consumeInteractiveOverride(binding: string, token: string): boolean;
}
export interface RuntimeEngineStartLease {
  release(): void;
}
export interface RuntimeInteractiveOverride {
  token: string;
  expiresAt: number;
}
export interface RuntimeResourcePostureProbeOptions {
  /** Numeric observation only; a supplied posture string is never trusted. */
  sample?: () => Promise<HostPressureSample>;
  now?: () => number;
  cacheMs?: number;
  readMemory?: () => {
    availableMemoryBytes: number;
    totalMemoryBytes: number;
  };
}

export const E2E_HEALTHY_RESOURCE_POSTURE_ENV =
  'STATION_E2E_RESOURCE_POSTURE_HEALTHY';
const STARTER_CLEAN_INSTALL_INSTANCE =
  /^e2e-starter-clean-install-[a-z0-9]+-[a-z0-9]+$/;

function memoryObservation(sample: HostPressureSample) {
  const availableMemoryBytes =
    typeof sample.availableMemoryBytes === 'number' &&
    Number.isFinite(sample.availableMemoryBytes) &&
    sample.availableMemoryBytes >= 0
      ? sample.availableMemoryBytes
      : null;
  const totalMemoryBytes =
    typeof sample.totalMemoryBytes === 'number' &&
    Number.isFinite(sample.totalMemoryBytes) &&
    sample.totalMemoryBytes > 0
      ? sample.totalMemoryBytes
      : null;
  if (availableMemoryBytes === null || totalMemoryBytes === null) {
    return {
      availableMemoryBytes,
      totalMemoryBytes,
      memoryPressure: 'unavailable' as const,
    };
  }
  const availablePercent = (availableMemoryBytes / totalMemoryBytes) * 100;
  return {
    availableMemoryBytes,
    totalMemoryBytes,
    memoryPressure:
      availableMemoryBytes <
        RUNTIME_RESOURCE_POSTURE_MIN_AVAILABLE_MEMORY_BYTES ||
      availablePercent < RUNTIME_RESOURCE_POSTURE_MIN_AVAILABLE_MEMORY_PERCENT
        ? ('critical' as const)
        : ('healthy' as const),
  };
}

/** Pure classification of one observation. Stateful policy lives below. */
export function deriveRuntimeResourcePosture(
  sample: HostPressureSample,
): RuntimeResourcePosture {
  const cpuCount =
    typeof sample.cpuCount === 'number' && Number.isInteger(sample.cpuCount)
      ? sample.cpuCount
      : 0;
  const thresholdPercent =
    typeof sample.thresholdPercent === 'number' &&
    Number.isFinite(sample.thresholdPercent)
      ? sample.thresholdPercent
      : RUNTIME_RESOURCE_POSTURE_DEGRADED_BUSY_PERCENT;
  const sampledAt =
    typeof sample.sampledAt === 'number' && Number.isFinite(sample.sampledAt)
      ? sample.sampledAt
      : null;
  const base: RuntimePostureBase = {
    cpuCount,
    sampledAt,
    ageMs: sampledAt === null ? null : 0,
    sampleMs:
      typeof sample.sampleMs === 'number' && Number.isFinite(sample.sampleMs)
        ? sample.sampleMs
        : null,
    thresholdPercent,
    criticalThresholdPercent: RUNTIME_RESOURCE_POSTURE_CRITICAL_BUSY_PERCENT,
    source: String(sample.source ?? 'runtime-probe'),
    windowLength: 1,
    postureSince: sampledAt,
    ...memoryObservation(sample),
  };
  const busyPercent =
    typeof sample.busyPercent === 'number' &&
    Number.isFinite(sample.busyPercent)
      ? sample.busyPercent
      : null;
  if (busyPercent === null || cpuCount <= 0) {
    return { kind: 'unavailable', ...base };
  }
  const kind =
    busyPercent >= RUNTIME_RESOURCE_POSTURE_CRITICAL_BUSY_PERCENT
      ? 'critical'
      : busyPercent > thresholdPercent
        ? 'degraded'
        : 'healthy';
  return {
    kind,
    busyPercent,
    smoothedBusyPercent: busyPercent,
    ...base,
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function tailEvery(
  values: readonly number[],
  count: number,
  predicate: (value: number) => boolean,
): boolean {
  return (
    values.length >= count &&
    values.slice(-count).every((value) => predicate(value))
  );
}

/**
 * Concurrent reads join one sample. A lone critical sample becomes a warning,
 * not a veto; critical requires three consecutive observations. Recovery uses
 * lower exit thresholds and two consecutive observations.
 */
export function createRuntimeResourcePostureController(
  options: RuntimeResourcePostureProbeOptions = {},
): RuntimeResourcePostureController {
  const sample = options.sample ?? createHostCpuSampler();
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? RUNTIME_RESOURCE_POSTURE_CACHE_MS;
  // Node's `freemem()` is not a portable available-memory signal (notably on
  // macOS, reclaimable cache is excluded). Keep memory explicit/unavailable
  // until a platform-correct Adapter is supplied; CPU policy must not smuggle
  // in a fragile second veto.
  const readMemory =
    options.readMemory ??
    (() => ({
      availableMemoryBytes: Number.NaN,
      totalMemoryBytes: Number.NaN,
    }));
  const window: number[] = [];
  const smoothedHistory: number[] = [];
  const overrides = new Map<string, { binding: string; expiresAt: number }>();
  let engineStartReserved = false;
  let effectiveKind: 'healthy' | 'degraded' | 'critical' = 'healthy';
  let postureSince = now();
  let latest: RuntimeResourcePosture | undefined;
  let refreshedAt: number | undefined;
  let inFlight: Promise<RuntimeResourcePosture> | undefined;

  const withAge = (
    posture: RuntimeResourcePosture,
  ): RuntimeResourcePosture => ({
    ...posture,
    ageMs:
      posture.sampledAt === null
        ? null
        : Math.max(0, now() - posture.sampledAt),
  });

  const refresh = async (): Promise<RuntimeResourcePosture> => {
    try {
      const observed = deriveRuntimeResourcePosture({
        ...(await sample()),
        ...readMemory(),
      });
      if (observed.kind === 'unavailable') {
        latest = { ...observed, windowLength: window.length, postureSince };
        refreshedAt = now();
        return withAge(latest);
      }
      window.push(observed.busyPercent);
      if (window.length > RUNTIME_RESOURCE_POSTURE_WINDOW_SIZE) window.shift();
      const smoothedBusyPercent = median(window);
      smoothedHistory.push(smoothedBusyPercent);
      if (smoothedHistory.length > RUNTIME_RESOURCE_POSTURE_WINDOW_SIZE)
        smoothedHistory.shift();
      let next = effectiveKind;
      if (effectiveKind === 'critical') {
        if (
          tailEvery(
            smoothedHistory,
            RUNTIME_RESOURCE_POSTURE_RECOVERY_SAMPLES,
            (value) =>
              value <= RUNTIME_RESOURCE_POSTURE_CRITICAL_EXIT_BUSY_PERCENT,
          )
        )
          next = 'degraded';
      } else if (
        tailEvery(
          smoothedHistory,
          RUNTIME_RESOURCE_POSTURE_CRITICAL_ENTRY_SAMPLES,
          (value) => value >= RUNTIME_RESOURCE_POSTURE_CRITICAL_BUSY_PERCENT,
        )
      ) {
        next = 'critical';
      } else if (effectiveKind === 'degraded') {
        if (
          tailEvery(
            smoothedHistory,
            RUNTIME_RESOURCE_POSTURE_RECOVERY_SAMPLES,
            (value) =>
              value <= RUNTIME_RESOURCE_POSTURE_DEGRADED_EXIT_BUSY_PERCENT,
          )
        )
          next = 'healthy';
      } else if (smoothedBusyPercent > observed.thresholdPercent) {
        next = 'degraded';
      }
      if (next !== effectiveKind) {
        effectiveKind = next;
        postureSince = observed.sampledAt ?? now();
      }
      const nextSnapshot = {
        ...observed,
        kind:
          observed.memoryPressure === 'critical' ? 'critical' : effectiveKind,
        smoothedBusyPercent,
        windowLength: window.length,
        postureSince,
      } as RuntimeResourcePosture;
      latest = nextSnapshot;
      refreshedAt = now();
      return withAge(nextSnapshot);
    } catch {
      const unavailable = deriveRuntimeResourcePosture(
        buildHostPressureSample({
          busyPercent: null,
          cpuCount: 0,
          sampleMs: null,
          sampledAt: now(),
          threshold: RUNTIME_RESOURCE_POSTURE_DEGRADED_BUSY_PERCENT,
          source: 'runtime-probe',
        }),
      );
      latest = { ...unavailable, windowLength: window.length, postureSince };
      refreshedAt = now();
      return withAge(latest);
    }
  };

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
      inFlight = refresh().finally(() => {
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
    issueInteractiveOverride(binding) {
      const current = now();
      for (const [token, entry] of overrides) {
        if (entry.expiresAt <= current) overrides.delete(token);
      }
      while (overrides.size >= RUNTIME_RESOURCE_OVERRIDE_CAPACITY) {
        const oldest = overrides.keys().next().value;
        if (oldest === undefined) break;
        overrides.delete(oldest);
      }
      const token = randomBytes(24).toString('base64url');
      const expiresAt = current + RUNTIME_RESOURCE_OVERRIDE_TTL_MS;
      overrides.set(token, { binding, expiresAt });
      return { token, expiresAt };
    },
    consumeInteractiveOverride(binding, token) {
      const entry = overrides.get(token);
      overrides.delete(token);
      return Boolean(
        entry && entry.binding === binding && entry.expiresAt > now(),
      );
    },
  };
}

/** Compatibility export: callers now receive the stateful controller. */
export function createRuntimeResourcePostureProbe(
  options: RuntimeResourcePostureProbeOptions = {},
): RuntimeResourcePostureController {
  return createRuntimeResourcePostureController(options);
}

export function createEnvironmentRuntimeResourcePostureProbe(
  env: NodeJS.ProcessEnv = process.env,
  options: RuntimeResourcePostureProbeOptions = {},
): RuntimeResourcePostureController {
  const authorized =
    env[E2E_HEALTHY_RESOURCE_POSTURE_ENV] === '1' &&
    env.STATION_HOME_SOURCE === '--temp-home' &&
    STARTER_CLEAN_INSTALL_INSTANCE.test(env.STATION_INSTANCE_ID ?? '');
  if (!authorized) return createRuntimeResourcePostureController(options);
  return createRuntimeResourcePostureController({
    ...options,
    sample: async () =>
      buildHostPressureSample({
        busyPercent: 0,
        cpuCount: 1,
        sampleMs: 0,
        sampledAt: Date.now(),
        threshold: RUNTIME_RESOURCE_POSTURE_DEGRADED_BUSY_PERCENT,
        source: 'starter-clean-install-e2e',
      }),
    readMemory: () => ({
      availableMemoryBytes: 1024 * 1024 * 1024,
      totalMemoryBytes: 2 * 1024 * 1024 * 1024,
    }),
  });
}

export class CriticalResourcePostureError extends Error {
  readonly code = 'resource_posture_critical';
  constructor(readonly posture: RuntimeObservedPosture<'critical'>) {
    super(
      `Engine start refused: resource posture=${posture.kind}, observed busyPercent=${posture.busyPercent}, smoothedBusyPercent=${posture.smoothedBusyPercent}, thresholdPercent=${posture.thresholdPercent}, cpuCount=${posture.cpuCount}`,
    );
    this.name = 'CriticalResourcePostureError';
  }
}

export class CriticalMemoryPressureError extends Error {
  readonly code = 'resource_memory_critical';
  constructor(readonly posture: RuntimeResourcePosture) {
    super('Engine start refused: available memory is below the safe minimum.');
    this.name = 'CriticalMemoryPressureError';
  }
}

export class ConcurrentEngineStartCapacityError extends Error {
  readonly code = 'resource_engine_start_capacity';
  readonly retryable = true;
  constructor() {
    super('Another engine is already starting. Try again after it settles.');
    this.name = 'ConcurrentEngineStartCapacityError';
  }
}

export class InteractiveResourceOverrideRequiredError extends Error {
  readonly code = 'resource_posture_override_required';
  readonly retryable = true;
  constructor(
    readonly posture: RuntimeObservedPosture<'critical'>,
    readonly override: RuntimeInteractiveOverride,
  ) {
    super(
      `This Station remains busy (${posture.smoothedBusyPercent ?? posture.busyPercent}% averaged CPU). Start anyway?`,
    );
    this.name = 'InteractiveResourceOverrideRequiredError';
  }
}

export type RuntimeEngineStartIntent =
  | 'interactive_user'
  | 'delegated_background'
  | 'webhook'
  | 'recovery';

export class ResourcePostureDeferredError extends Error {
  readonly code = 'resource_posture_deferred';
  readonly retryable = true;
  constructor(readonly posture: RuntimeResourcePosture) {
    super(
      `Engine start deferred: resource posture=${posture.kind}${posture.kind === 'unavailable' ? '' : `, observed busyPercent=${posture.busyPercent}`}`,
    );
    this.name = 'ResourcePostureDeferredError';
  }
}

function resourceController(
  probe: RuntimeResourcePostureProbe,
): RuntimeResourcePostureController | undefined {
  const candidate = probe as Partial<RuntimeResourcePostureController>;
  return typeof candidate.reserveEngineStart === 'function' &&
    typeof candidate.issueInteractiveOverride === 'function' &&
    typeof candidate.consumeInteractiveOverride === 'function'
    ? (candidate as RuntimeResourcePostureController)
    : undefined;
}

/** Compatibility helper for direct callers that do not carry override state. */
export async function admitEngineStart(
  probe: RuntimeResourcePostureProbe | undefined,
  logger: Pick<Logger, 'warn'> | undefined,
): Promise<void> {
  const lease = await admitEngineStartForIntent(
    probe,
    logger,
    'interactive_user',
    { binding: 'compatibility-direct-start' },
  );
  lease?.release();
}

/** Machine-triggered starts defer under pressure and never override memory. */
export async function admitBackgroundEngineStart(
  probe: RuntimeResourcePostureProbe | undefined,
  logger: ResourcePostureLogger | undefined,
  operation: 'background_start' | 'recovery_start' = 'background_start',
): Promise<
  { kind: 'admitted' } | { kind: 'deferred'; posture: RuntimeResourcePosture }
> {
  if (!probe) return { kind: 'admitted' };
  const posture = await probe.observe();
  const deferred =
    posture.memoryPressure === 'critical' ||
    posture.kind === 'degraded' ||
    posture.kind === 'critical';
  observeDecision(operation, posture, deferred ? 'deferred' : 'allowed');
  warnUnavailableAdmission(operation, posture, logger);
  if (!deferred) return { kind: 'admitted' };
  logger?.info?.(
    'Background engine start deferred by resource posture',
    posture,
  );
  return { kind: 'deferred', posture };
}

/** Fixed server-derived intent seam; public command bodies never carry this. */
export async function admitEngineStartForIntent(
  probe: RuntimeResourcePostureProbe | undefined,
  logger: ResourcePostureLogger | undefined,
  intent: RuntimeEngineStartIntent,
  input: { binding: string; overrideToken?: string },
): Promise<RuntimeEngineStartLease | undefined> {
  if (!probe) return undefined;
  const controller = resourceController(probe);
  const lease = controller?.reserveEngineStart();
  try {
    const posture = await probe.observe();
    if (posture.memoryPressure === 'critical') {
      observeDecision('engine_start', posture, 'refused');
      throw new CriticalMemoryPressureError(posture);
    }
    if (intent === 'interactive_user') {
      warnUnavailableAdmission('engine_start', posture, logger);
      if (posture.kind === 'critical') {
        if (!controller) throw new CriticalResourcePostureError(posture);
        const accepted =
          typeof input.overrideToken === 'string' &&
          controller.consumeInteractiveOverride(
            input.binding,
            input.overrideToken,
          );
        if (!accepted) {
          observeDecision('engine_start', posture, 'refused');
          throw new InteractiveResourceOverrideRequiredError(
            posture,
            controller.issueInteractiveOverride(input.binding),
          );
        }
        observeDecision('engine_start', posture, 'overridden');
        logger?.warn('Interactive engine start override consumed', posture);
        return lease;
      }
      const warned = posture.kind === 'degraded';
      observeDecision('engine_start', posture, warned ? 'warned' : 'allowed');
      if (warned)
        logger?.warn(
          'Interactive engine start admitted under host pressure',
          posture,
        );
      return lease;
    }
    const deferred = posture.kind === 'degraded' || posture.kind === 'critical';
    const operation =
      intent === 'recovery' ? 'recovery_start' : 'background_start';
    observeDecision(operation, posture, deferred ? 'deferred' : 'allowed');
    warnUnavailableAdmission(operation, posture, logger);
    if (deferred) throw new ResourcePostureDeferredError(posture);
    return lease;
  } catch (error) {
    lease?.release();
    throw error;
  }
}

export async function admitScheduledJob(
  probe: RuntimeResourcePostureProbe | undefined,
  logger: ResourcePostureLogger | undefined,
  options: { manual: boolean } = { manual: false },
): Promise<
  | { kind: 'admitted'; warning?: RuntimeResourcePosture }
  | { kind: 'deferred'; posture: RuntimeResourcePosture }
> {
  if (!probe) return { kind: 'admitted' };
  const posture = await probe.observe();
  if (posture.memoryPressure === 'critical') {
    observeDecision('scheduled_job', posture, 'refused');
    return { kind: 'deferred', posture };
  }
  const pressured = posture.kind === 'degraded' || posture.kind === 'critical';
  if (options.manual) {
    observeDecision('scheduled_job', posture, pressured ? 'warned' : 'allowed');
    return pressured
      ? { kind: 'admitted', warning: posture }
      : { kind: 'admitted' };
  }
  observeDecision('scheduled_job', posture, pressured ? 'deferred' : 'allowed');
  warnUnavailableAdmission('scheduled_job', posture, logger);
  if (!pressured) return { kind: 'admitted' };
  logger?.info?.(
    'Automatic scheduled job deferred by resource posture',
    posture,
  );
  return { kind: 'deferred', posture };
}

function warnUnavailableAdmission(
  operation: Operation,
  posture: RuntimeResourcePosture,
  logger: Pick<Logger, 'warn'> | undefined,
): void {
  if (posture.kind !== 'unavailable') return;
  const now = Date.now();
  const lastWarningAt = unavailableWarningAtByOperation.get(operation);
  if (
    lastWarningAt !== undefined &&
    now - lastWarningAt <
      RUNTIME_RESOURCE_POSTURE_UNAVAILABLE_WARNING_INTERVAL_MS
  )
    return;
  unavailableWarningAtByOperation.set(operation, now);
  logger?.warn('Resource posture unavailable; admission fails open', {
    operation,
    ...posture,
    warning_interval_ms:
      RUNTIME_RESOURCE_POSTURE_UNAVAILABLE_WARNING_INTERVAL_MS,
  });
}

function observeDecision(
  operation: Operation,
  posture: RuntimeResourcePosture,
  outcome: 'allowed' | 'warned' | 'overridden' | 'deferred' | 'refused',
): void {
  try {
    resourcePostureDecisions.add(1, {
      operation,
      posture: posture.kind,
      outcome,
    });
  } catch {
    // Observability must not change admission.
  }
}
