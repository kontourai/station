/**
 * Runtime resource posture is a derived observation, not configuration.
 *
 * This module imports the verification coordinator's portable CPU sampler
 * directly.  It is already an ESM, dependency-light leaf and TypeScript's
 * `allowJs` project setting accepts it, so extracting or copying its busy
 * calculation would only create a second definition of host pressure.
 */

import {
  buildHostPressureSample,
  createHostCpuSampler,
} from '../../../scripts/lib/verification-host-pressure.mjs';
import { resourcePostureDecisions } from '../../telemetry/metrics.js';
import type { Logger } from '../../utils/logger.js';

/**
 * The existing verification threshold is the first degraded point: over 85%
 * CPU busy has already consumed the host headroom reserved for Station work.
 */
export const RUNTIME_RESOURCE_POSTURE_DEGRADED_BUSY_PERCENT = 85;

/**
 * At 95% CPU busy there is no meaningful local headroom for another engine;
 * engine/session starts are refused, while an in-flight process is untouched.
 */
export const RUNTIME_RESOURCE_POSTURE_CRITICAL_BUSY_PERCENT = 95;

/**
 * A broken host probe must be visible locally even when optional OTel export
 * is inactive, but persistent failure must not make every start log noise.
 */
export const RUNTIME_RESOURCE_POSTURE_UNAVAILABLE_WARNING_INTERVAL_MS = 60_000;

const unavailableWarningAtByOperation = new Map<
  'engine_start' | 'scheduled_job',
  number
>();

export type RuntimeResourcePosture =
  | RuntimeObservedPosture<'healthy'>
  | RuntimeObservedPosture<'degraded'>
  | RuntimeObservedPosture<'critical'>
  | {
      kind: 'unavailable';
      cpuCount: number;
      sampledAt: number | null;
      sampleMs: number | null;
      thresholdPercent: number;
      source: string;
    };

type RuntimeObservedPosture<TKind extends string> = {
  kind: TKind;
  busyPercent: number;
  cpuCount: number;
  sampledAt: number | null;
  sampleMs: number | null;
  thresholdPercent: number;
  source: string;
};

type HostPressureSample = {
  /** Ignored deliberately: posture is recomputed from numeric observation. */
  status?: unknown;
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

export interface RuntimeResourcePostureProbeOptions {
  /** The only input: a sampled host observation. It never accepts a posture. */
  sample?: () => Promise<HostPressureSample>;
}

export const E2E_HEALTHY_RESOURCE_POSTURE_ENV =
  'STATION_E2E_RESOURCE_POSTURE_HEALTHY';
const STARTER_CLEAN_INSTALL_INSTANCE =
  /^e2e-starter-clean-install-[a-z0-9]+-[a-z0-9]+$/;

/**
 * #766 item 2 (core-loop journeys): the mirrored critical-forcing override.
 * The capacity-gate journey must observe the REAL refusal path — banner,
 * engine-start admission, and scheduler all reading one forced observation —
 * and no seam existed to force it (the healthy override above forces the
 * opposite). Authorization mirrors the healthy override exactly: the CLI
 * must attest `--temp-home` AND the runner-owned journey instance namespace;
 * the env value alone has no effect, so a persistent production home can
 * never be forced into refusing engine starts. The forced sample still
 * travels through `deriveRuntimeResourcePosture` — this seam supplies an
 * observation (busyPercent 97), never a posture string.
 */
export const E2E_CRITICAL_RESOURCE_POSTURE_ENV =
  'STATION_E2E_RESOURCE_POSTURE_CRITICAL';
const CORE_LOOP_CAPACITY_INSTANCE =
  /^e2e-core-loop-capacity-[a-z0-9]+-[a-z0-9]+$/;

/**
 * Classifies a sampled observation. The source sample's `status` is deliberately
 * not trusted: this recomputes the posture from measured busy percent, CPU
 * count, and the named thresholds, so a caller cannot assert a posture string.
 */
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
  const base = {
    cpuCount,
    sampledAt:
      typeof sample.sampledAt === 'number' && Number.isFinite(sample.sampledAt)
        ? sample.sampledAt
        : null,
    sampleMs:
      typeof sample.sampleMs === 'number' && Number.isFinite(sample.sampleMs)
        ? sample.sampleMs
        : null,
    thresholdPercent,
    source: String(sample.source ?? 'runtime-probe'),
  };
  const busyPercent =
    typeof sample.busyPercent === 'number' &&
    Number.isFinite(sample.busyPercent)
      ? sample.busyPercent
      : null;
  if (busyPercent === null || cpuCount <= 0) {
    return { kind: 'unavailable', ...base };
  }
  if (busyPercent >= RUNTIME_RESOURCE_POSTURE_CRITICAL_BUSY_PERCENT) {
    return { kind: 'critical', busyPercent, ...base };
  }
  if (busyPercent > thresholdPercent) {
    return { kind: 'degraded', busyPercent, ...base };
  }
  return { kind: 'healthy', busyPercent, ...base };
}

/** Creates a fail-open probe backed by two observed CPU snapshots. */
export function createRuntimeResourcePostureProbe(
  options: RuntimeResourcePostureProbeOptions = {},
): RuntimeResourcePostureProbe {
  const sample = options.sample ?? createHostCpuSampler();
  return {
    async observe() {
      try {
        return deriveRuntimeResourcePosture(await sample());
      } catch {
        return deriveRuntimeResourcePosture(
          buildHostPressureSample({
            busyPercent: null,
            cpuCount: 0,
            sampleMs: null,
            sampledAt: Date.now(),
            threshold: RUNTIME_RESOURCE_POSTURE_DEGRADED_BUSY_PERCENT,
            source: 'runtime-probe',
          }),
        );
      }
    },
  };
}

/**
 * Keep one full product journey deterministic without weakening persistent
 * production admission. The CLI must attest both its resolved `--temp-home`
 * and the runner-owned instance namespace; the explicit E2E value alone has
 * no effect. The sample still travels through the ordinary numeric derivation.
 */
export function createEnvironmentRuntimeResourcePostureProbe(
  env: NodeJS.ProcessEnv = process.env,
  options: RuntimeResourcePostureProbeOptions = {},
): RuntimeResourcePostureProbe {
  const authorized =
    env[E2E_HEALTHY_RESOURCE_POSTURE_ENV] === '1' &&
    env.STATION_HOME_SOURCE === '--temp-home' &&
    STARTER_CLEAN_INSTALL_INSTANCE.test(env.STATION_INSTANCE_ID ?? '');
  if (authorized) {
    return createRuntimeResourcePostureProbe({
      sample: async () =>
        buildHostPressureSample({
          busyPercent: 0,
          cpuCount: 1,
          sampleMs: 0,
          sampledAt: Date.now(),
          threshold: RUNTIME_RESOURCE_POSTURE_DEGRADED_BUSY_PERCENT,
          source: 'starter-clean-install-e2e',
        }),
    });
  }
  // The critical override is gated on ITS OWN instance namespace, disjoint
  // by construction from the starter-clean-install one, so a single process
  // can never be authorized for both and the healthy override's behavior is
  // byte-identical to before this branch existed.
  const criticalAuthorized =
    env[E2E_CRITICAL_RESOURCE_POSTURE_ENV] === '1' &&
    env.STATION_HOME_SOURCE === '--temp-home' &&
    CORE_LOOP_CAPACITY_INSTANCE.test(env.STATION_INSTANCE_ID ?? '');
  if (criticalAuthorized) {
    return createRuntimeResourcePostureProbe({
      sample: async () =>
        buildHostPressureSample({
          // Above RUNTIME_RESOURCE_POSTURE_CRITICAL_BUSY_PERCENT so the
          // ordinary numeric derivation classifies critical; the journey
          // asserts this exact source string to prove the refusal it saw
          // came from the seam, not from coincidental real host load.
          busyPercent: 97,
          cpuCount: 8,
          sampleMs: 0,
          sampledAt: Date.now(),
          threshold: RUNTIME_RESOURCE_POSTURE_DEGRADED_BUSY_PERCENT,
          source: 'core-loop-capacity-e2e',
        }),
    });
  }
  return createRuntimeResourcePostureProbe(options);
}

export class CriticalResourcePostureError extends Error {
  readonly code = 'resource_posture_critical';

  constructor(
    readonly posture: Extract<RuntimeResourcePosture, { kind: 'critical' }>,
  ) {
    super(
      `Engine start refused: resource posture=${posture.kind}, observed busyPercent=${posture.busyPercent}, thresholdPercent=${posture.thresholdPercent}, cpuCount=${posture.cpuCount}`,
    );
    this.name = 'CriticalResourcePostureError';
  }
}

export async function admitEngineStart(
  probe: RuntimeResourcePostureProbe | undefined,
  logger: Pick<Logger, 'warn'> | undefined,
): Promise<void> {
  if (!probe) return;
  const posture = await probe.observe();
  observeDecision(
    'engine_start',
    posture,
    posture.kind === 'critical' ? 'refused' : 'allowed',
  );
  warnUnavailableAdmission('engine_start', posture, logger);
  if (posture.kind !== 'critical') return;
  logger?.warn('Engine start refused by resource posture', posture);
  throw new CriticalResourcePostureError(posture);
}

export async function admitScheduledJob(
  probe: RuntimeResourcePostureProbe | undefined,
  logger: Pick<Logger, 'info' | 'warn'> | undefined,
): Promise<
  { kind: 'admitted' } | { kind: 'deferred'; posture: RuntimeResourcePosture }
> {
  if (!probe) return { kind: 'admitted' };
  const posture = await probe.observe();
  const deferred = posture.kind === 'degraded' || posture.kind === 'critical';
  observeDecision('scheduled_job', posture, deferred ? 'deferred' : 'allowed');
  warnUnavailableAdmission('scheduled_job', posture, logger);
  if (!deferred) return { kind: 'admitted' };
  logger?.info('Scheduler job admission blocked by resource posture', posture);
  return { kind: 'deferred', posture };
}

function warnUnavailableAdmission(
  operation: 'engine_start' | 'scheduled_job',
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
  ) {
    return;
  }
  unavailableWarningAtByOperation.set(operation, now);
  logger?.warn('Resource posture unavailable; admission fails open', {
    operation,
    ...posture,
    warning_interval_ms:
      RUNTIME_RESOURCE_POSTURE_UNAVAILABLE_WARNING_INTERVAL_MS,
  });
}

function observeDecision(
  operation: 'engine_start' | 'scheduled_job',
  posture: RuntimeResourcePosture,
  outcome: 'allowed' | 'deferred' | 'refused',
): void {
  try {
    resourcePostureDecisions.add(1, {
      operation,
      posture: posture.kind,
      outcome,
    });
  } catch {
    // Observability must not change the posture decision.
  }
}
