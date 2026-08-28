import { describe, expect, test, vi } from 'vitest';
import {
  admitEngineStart,
  admitScheduledJob,
  CriticalResourcePostureError,
  createEnvironmentRuntimeResourcePostureProbe,
  createRuntimeResourcePostureProbe,
  deriveRuntimeResourcePosture,
  E2E_HEALTHY_RESOURCE_POSTURE_ENV,
  RUNTIME_RESOURCE_POSTURE_CRITICAL_BUSY_PERCENT,
  RUNTIME_RESOURCE_POSTURE_DEGRADED_BUSY_PERCENT,
  RUNTIME_RESOURCE_POSTURE_UNAVAILABLE_WARNING_INTERVAL_MS,
} from '../resource-posture.js';

const healthyObservation = {
  busyPercent: 20,
  cpuCount: 8,
  sampledAt: 100,
  sampleMs: 500,
  thresholdPercent: 85,
  source: 'test',
};

describe('runtime resource posture', () => {
  test('isolates the explicit clean-install E2E from unrelated host load without accepting other values', async () => {
    await expect(
      createEnvironmentRuntimeResourcePostureProbe({
        [E2E_HEALTHY_RESOURCE_POSTURE_ENV]: '1',
        STATION_HOME_SOURCE: '--temp-home',
        STATION_INSTANCE_ID: 'e2e-starter-clean-install-1234-abcd',
      }).observe(),
    ).resolves.toMatchObject({
      kind: 'healthy',
      busyPercent: 0,
      cpuCount: 1,
      source: 'starter-clean-install-e2e',
    });

    const criticalSample = {
      sample: async () => ({
        busyPercent: 96,
        cpuCount: 8,
        sampledAt: 100,
        sampleMs: 500,
        thresholdPercent: 85,
        source: 'test',
      }),
    };
    for (const env of [
      {
        [E2E_HEALTHY_RESOURCE_POSTURE_ENV]: '1',
        STATION_HOME_SOURCE: 'default',
        STATION_INSTANCE_ID: 'e2e-starter-clean-install-1234-abcd',
      },
      {
        [E2E_HEALTHY_RESOURCE_POSTURE_ENV]: '1',
        STATION_HOME_SOURCE: '--temp-home',
        STATION_INSTANCE_ID: 'stable',
      },
      {
        [E2E_HEALTHY_RESOURCE_POSTURE_ENV]: 'true',
        STATION_HOME_SOURCE: '--temp-home',
        STATION_INSTANCE_ID: 'e2e-starter-clean-install-1234-abcd',
      },
    ]) {
      await expect(
        createEnvironmentRuntimeResourcePostureProbe(
          env,
          criticalSample,
        ).observe(),
      ).resolves.toMatchObject({ kind: 'critical', busyPercent: 96 });
    }
  });

  test('derives critical from the observed busy percent, not a supplied status', () => {
    expect(
      deriveRuntimeResourcePosture({
        ...healthyObservation,
        busyPercent: RUNTIME_RESOURCE_POSTURE_CRITICAL_BUSY_PERCENT,
        status: 'healthy',
      }),
    ).toMatchObject({ kind: 'critical', busyPercent: 95 });
  });

  // archive#3089 fault-injection target (a): the boundary that separates
  // degraded from critical. One busy percent below the critical threshold
  // must classify degraded, never critical — a `>=` vs `>` slip on this
  // comparison would make an engine-start refusal fire one point early (or
  // late), and this is the exact assertion that would catch it.
  test('classifies one point below the critical threshold as degraded, not critical', () => {
    expect(
      deriveRuntimeResourcePosture({
        ...healthyObservation,
        busyPercent: RUNTIME_RESOURCE_POSTURE_CRITICAL_BUSY_PERCENT - 1,
      }),
    ).toMatchObject({ kind: 'degraded', busyPercent: 94 });
  });

  test('classifies exactly the degraded threshold value as healthy (degraded requires strictly greater)', () => {
    expect(
      deriveRuntimeResourcePosture({
        ...healthyObservation,
        busyPercent: RUNTIME_RESOURCE_POSTURE_DEGRADED_BUSY_PERCENT,
      }),
    ).toMatchObject({ kind: 'healthy', busyPercent: 85 });
  });

  test('classifies one point above the degraded threshold as degraded', () => {
    expect(
      deriveRuntimeResourcePosture({
        ...healthyObservation,
        busyPercent: RUNTIME_RESOURCE_POSTURE_DEGRADED_BUSY_PERCENT + 1,
      }),
    ).toMatchObject({ kind: 'degraded', busyPercent: 86 });
  });

  // archive#3089 fault-injection target (b): the observed value must be
  // carried into the refusal message a client eventually renders — not
  // resampled or summarized away. This is the server-side half of that
  // proof; `chatErrorTranslation.test.ts` proves the client half (the
  // translated copy shows this exact text verbatim).
  test('CriticalResourcePostureError names the posture kind and the exact observed busy percent', () => {
    const posture = deriveRuntimeResourcePosture({
      ...healthyObservation,
      busyPercent: 97,
    });
    if (posture.kind !== 'critical') throw new Error('fixture is not critical');
    const error = new CriticalResourcePostureError(posture);

    expect(error.code).toBe('resource_posture_critical');
    expect(error.message).toBe(
      'Engine start refused: resource posture=critical, observed busyPercent=97, thresholdPercent=85, cpuCount=8',
    );
    // Distinct from the scheduler's deferred/refused copy
    // (builtin-scheduler-execution.ts) — an engine-start refusal and a
    // deferred scheduled job are different facts and must not collapse
    // into one message.
    expect(error.message).not.toMatch(/Scheduler job/);
  });

  test('admitEngineStart throws CriticalResourcePostureError only at critical, carrying the same observed value admitScheduledJob would defer on', async () => {
    const criticalProbe = {
      observe: async () => ({
        kind: 'critical' as const,
        busyPercent: 99,
        cpuCount: 4,
        sampledAt: 100,
        sampleMs: 500,
        thresholdPercent: 85,
        source: 'test',
      }),
    };

    await expect(admitEngineStart(criticalProbe, undefined)).rejects.toThrow(
      /observed busyPercent=99/,
    );

    const degradedProbe = {
      observe: async () => ({
        kind: 'degraded' as const,
        busyPercent: 90,
        cpuCount: 4,
        sampledAt: 100,
        sampleMs: 500,
        thresholdPercent: 85,
        source: 'test',
      }),
    };
    // Degraded never refuses an engine start — only a scheduled job defers
    // at degraded (admitScheduledJob below). Collapsing these would refuse
    // starts far more often than the derivation intends.
    await expect(
      admitEngineStart(degradedProbe, undefined),
    ).resolves.toBeUndefined();
    await expect(admitScheduledJob(degradedProbe, undefined)).resolves.toEqual({
      kind: 'deferred',
      posture: await degradedProbe.observe(),
    });
  });

  test('a config field cannot assert posture over a healthy observation', async () => {
    const sample = vi.fn().mockResolvedValue(healthyObservation);
    const probe = createRuntimeResourcePostureProbe({
      sample,
      posture: 'critical',
    } as never);

    await expect(probe.observe()).resolves.toMatchObject({
      kind: 'healthy',
      busyPercent: 20,
    });
    expect(sample).toHaveBeenCalledOnce();
  });

  test('declares probe failure as unavailable rather than healthy or critical', async () => {
    const probe = createRuntimeResourcePostureProbe({
      sample: async () => {
        throw new Error('os probe unavailable');
      },
    });

    await expect(probe.observe()).resolves.toMatchObject({
      kind: 'unavailable',
      cpuCount: 0,
    });
  });

  test('warns locally once per named interval when unavailable admission fails open', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T12:00:00.000Z'));
    try {
      const logger = { warn: vi.fn() };
      const probe = {
        observe: async () => ({
          kind: 'unavailable' as const,
          cpuCount: 0,
          sampledAt: null,
          sampleMs: null,
          thresholdPercent: 85,
          source: 'test-malformed-cpus',
        }),
      };

      await admitEngineStart(probe, logger);
      await admitEngineStart(probe, logger);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        'Resource posture unavailable; admission fails open',
        expect.objectContaining({
          operation: 'engine_start',
          warning_interval_ms:
            RUNTIME_RESOURCE_POSTURE_UNAVAILABLE_WARNING_INTERVAL_MS,
        }),
      );

      await vi.advanceTimersByTimeAsync(
        RUNTIME_RESOURCE_POSTURE_UNAVAILABLE_WARNING_INTERVAL_MS,
      );
      await admitEngineStart(probe, logger);
      expect(logger.warn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
