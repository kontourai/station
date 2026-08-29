import { describe, expect, it } from 'vitest';
import {
  buildHostPressureSample,
  computeBusyPercent,
  createHostCpuSampler,
  DEFAULT_HOST_CPU_THRESHOLD_PERCENT,
  DEFAULT_HOST_PRESSURE_SAMPLE_GAP_MS,
  DEFAULT_HOST_PRESSURE_WAIT_MS,
  HOST_PRESSURE_FRESH_SAMPLE_MS,
  HOST_PRESSURE_GATE_WEIGHT,
  HOST_PRESSURE_OVERRIDE_ENV,
  isLaneHostPressureGated,
  MAX_HOST_CPU_THRESHOLD_PERCENT,
  MIN_HOST_CPU_THRESHOLD_PERCENT,
  pressureGateSatisfied,
  projectHostPressureForStatus,
  resolveHostPressureThreshold,
  sumCpuTimes,
} from '../lib/verification-host-pressure.mjs';
import { LANES, resolveLane } from '../verification-lanes.mjs';

type Times = {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
};
type Snapshot = { times: Times }[];

function snapshot(idle: number, total: number): Snapshot {
  const user = Math.max(0, total - idle);
  return [{ times: { user, nice: 0, sys: 0, idle, irq: 0 } }];
}

function multiCoreSnapshot(idle: number, total: number, cores = 4): Snapshot {
  const perIdle = idle / cores;
  const perUser = Math.max(0, total - idle) / cores;
  return Array.from({ length: cores }, () => ({
    times: { user: perUser, nice: 0, sys: 0, idle: perIdle, irq: 0 },
  }));
}

const healthySample = (
  busyPercent: number,
  overrides: Record<string, unknown> = {},
) =>
  buildHostPressureSample({
    busyPercent,
    cpuCount: 4,
    sampleMs: 500,
    sampledAt: 1_000,
    threshold: 85,
    source: 'override',
    load1: busyPercent / 10,
    loadPerCpu: busyPercent / 40,
    ...overrides,
  });

describe('host-pressure busy math', () => {
  it('computes a known busy percent from two single-core snapshots', () => {
    // totalDelta 100, idleDelta 50 => 50% busy
    expect(computeBusyPercent(snapshot(100, 100), snapshot(150, 200))).toBe(50);
    // totalDelta 100, idleDelta 0 => 100% busy
    expect(computeBusyPercent(snapshot(100, 100), snapshot(100, 200))).toBe(
      100,
    );
    // totalDelta 100, idleDelta 10 => 90% busy
    expect(computeBusyPercent(snapshot(100, 100), snapshot(110, 200))).toBe(90);
    // totalDelta 100, idleDelta 100 => 0% busy
    expect(computeBusyPercent(snapshot(100, 100), snapshot(200, 200))).toBe(0);
  });

  it('computes the same percent across multiple cores', () => {
    expect(
      computeBusyPercent(
        multiCoreSnapshot(100, 100),
        multiCoreSnapshot(150, 200),
      ),
    ).toBe(50);
  });

  it('normalizes one fully busy CPU across a 15-CPU host to seven percent', () => {
    const first = Array.from({ length: 15 }, () => ({
      times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
    }));
    const second = Array.from({ length: 15 }, (_unused, index) => ({
      times: {
        user: index === 0 ? 100 : 0,
        nice: 0,
        sys: 0,
        idle: index === 0 ? 0 : 100,
        irq: 0,
      },
    }));
    expect(computeBusyPercent(first, second)).toBe(7);
  });

  it('treats real os.cpus()-shaped snapshots identically', () => {
    // Mirrors the exact object shape os.cpus() returns (extra fields ignored).
    const first = [
      {
        model: 'arm',
        speed: 2400,
        times: { user: 100, nice: 0, sys: 20, idle: 100, irq: 5 },
      },
    ];
    const second = [
      {
        model: 'arm',
        speed: 2400,
        times: { user: 160, nice: 0, sys: 30, idle: 120, irq: 10 },
      },
    ];
    // total first=225 idle=100 ; total second=320 idle=120
    // totalDelta=95 idleDelta=20 busy=(95-20)/95=78.94..=>79
    expect(computeBusyPercent(first, second)).toBe(79);
  });

  it.each([
    ['empty arrays', [], []],
    [
      'identical snapshots (zero delta)',
      snapshot(100, 100),
      snapshot(100, 100),
    ],
    ['malformed times', [{ times: null }], [{ times: null }]],
    [
      'non-numeric time field',
      [{ times: { user: 'x' } }] as never,
      snapshot(0, 0),
    ],
    ['mismatched core counts', snapshot(100, 100), multiCoreSnapshot(150, 200)],
    ['negative delta', snapshot(150, 200), snapshot(100, 100)],
  ])('returns null (unavailable) for %s', (_name, a, b) => {
    expect(computeBusyPercent(a as never, b as never)).toBeNull();
  });

  it('sumCpuTimes returns null for empty or malformed input', () => {
    expect(sumCpuTimes([])).toBeNull();
    expect(sumCpuTimes(null as never)).toBeNull();
    expect(sumCpuTimes([{ nope: true }] as never)).toBeNull();
  });
});

describe('host-pressure sample classification', () => {
  it('classifies healthy at or below threshold and pressured above', () => {
    expect(healthySample(85).status).toBe('healthy');
    expect(healthySample(84).status).toBe('healthy');
    expect(healthySample(86).status).toBe('pressured');
  });

  it('records load telemetry but never derives status from it', () => {
    const windowsZero = buildHostPressureSample({
      busyPercent: 30,
      cpuCount: 4,
      sampleMs: 500,
      sampledAt: 1_000,
      threshold: 85,
      source: 'override',
      load1: 0,
      loadPerCpu: 0,
    });
    // Windows loadavg is always [0,0,0]; it is telemetry only, never the gate.
    expect(windowsZero.status).toBe('healthy');
    expect(windowsZero.load1).toBe(0);
    expect(windowsZero.loadPerCpu).toBe(0);
  });

  it('reports unavailable when busy percent or cpu count is missing', () => {
    expect(
      buildHostPressureSample({
        busyPercent: null,
        cpuCount: 4,
        sampleMs: 500,
        sampledAt: 1,
        threshold: 85,
        source: 'default',
      }).status,
    ).toBe('unavailable');
    expect(
      buildHostPressureSample({
        busyPercent: 50,
        cpuCount: 0,
        sampleMs: 500,
        sampledAt: 1,
        threshold: 85,
        source: 'default',
      }).status,
    ).toBe('unavailable');
  });
});

describe('host-pressure threshold override', () => {
  it('defaults to 85 when unset or empty', () => {
    expect(resolveHostPressureThreshold({})).toEqual({
      percent: 85,
      source: 'default',
    });
    expect(
      resolveHostPressureThreshold({ [HOST_PRESSURE_OVERRIDE_ENV]: '' }),
    ).toEqual({
      percent: 85,
      source: 'default',
    });
  });

  it.each([['70'], ['80'], ['85']])(
    'accepts a strict integer that lowers within [%d..85]',
    (value) => {
      expect(
        resolveHostPressureThreshold({ [HOST_PRESSURE_OVERRIDE_ENV]: value }),
      ).toEqual({
        percent: Number(value),
        source: 'override',
      });
    },
  );

  it.each([
    ['69', 'below floor'],
    ['86', 'above ceiling'],
    ['85.0', 'float'],
    ['90%', 'with percent sign'],
    ['abc', 'non-numeric'],
    ['0x55', 'hex'],
  ])('rejects %s (%s) before lease/child', (value) => {
    expect(() =>
      resolveHostPressureThreshold({ [HOST_PRESSURE_OVERRIDE_ENV]: value }),
    ).toThrow(/must be a strict integer/);
  });

  it('trims surrounding whitespace but keeps it a strict integer', () => {
    expect(
      resolveHostPressureThreshold({ [HOST_PRESSURE_OVERRIDE_ENV]: '  72  ' }),
    ).toEqual({ percent: 72, source: 'override' });
  });

  it('pins the bounds to 70..85', () => {
    expect(MIN_HOST_CPU_THRESHOLD_PERCENT).toBe(70);
    expect(MAX_HOST_CPU_THRESHOLD_PERCENT).toBe(85);
  });
});

describe('host-pressure gate membership', () => {
  it('gates only current lane or phase weights at or above the threshold', () => {
    const gated = LANES.filter(
      (lane) => lane.weight >= HOST_PRESSURE_GATE_WEIGHT,
    ).map((lane) => lane.id);
    expect(gated).toEqual([
      'test-full',
      'test-coverage',
      'verify-static',
      'verify-local',
      'verify-e2e-full',
    ]);
    // Low lanes stay ungated.
    expect(LANES.filter(isLaneHostPressureGated).map((l) => l.id)).toEqual(
      gated,
    );
    expect(LANES.find((l) => l.id === 'prepush')?.weight).toBe(40);
    expect(LANES.find((l) => l.id === 'test-changed')?.weight).toBe(20);
    expect(isLaneHostPressureGated(LANES.find((l) => l.id === 'prepush'))).toBe(
      false,
    );
    expect(
      isLaneHostPressureGated(LANES.find((l) => l.id === 'verify-e2e-full')),
    ).toBe(true);
    const outer = resolveLane('ci-fast');
    expect(isLaneHostPressureGated(outer)).toBe(false);
    expect(outer.weight).toBe(20);
  });

  it('exposes the documented constants', () => {
    expect(HOST_PRESSURE_GATE_WEIGHT).toBe(80);
    expect(DEFAULT_HOST_CPU_THRESHOLD_PERCENT).toBe(85);
    expect(DEFAULT_HOST_PRESSURE_WAIT_MS).toBe(5 * 60_000);
    expect(DEFAULT_HOST_PRESSURE_SAMPLE_GAP_MS).toBe(500);
    expect(HOST_PRESSURE_FRESH_SAMPLE_MS).toBe(2_000);
  });
});

describe('pressureGateSatisfied', () => {
  it('requires two consecutive healthy samples', () => {
    const fresh = healthySample(50, { sampledAt: 1_000 });
    expect(pressureGateSatisfied(1, fresh, () => 1_000)).toBe(false);
    expect(pressureGateSatisfied(2, fresh, () => 1_000)).toBe(true);
  });

  it('rejects a pressured or stale latest sample', () => {
    const pressured = healthySample(90, { sampledAt: 1_000 });
    expect(pressureGateSatisfied(2, pressured, () => 1_000)).toBe(false);
    const fresh = healthySample(50, { sampledAt: 1_000 });
    expect(
      pressureGateSatisfied(
        2,
        fresh,
        () => 1_000 + HOST_PRESSURE_FRESH_SAMPLE_MS + 1,
      ),
    ).toBe(false);
  });

  it('rejects a clock-regressed sample whose age is negative', () => {
    // now() before sampledAt (clock regression) must not satisfy the gate.
    const sample = healthySample(50, { sampledAt: 1_100 });
    expect(pressureGateSatisfied(2, sample, () => 1_000)).toBe(false);
    // A zero-age sample at the exact sampledAt boundary is still fresh.
    expect(pressureGateSatisfied(2, sample, () => 1_100)).toBe(true);
  });
});

describe('createHostCpuSampler', () => {
  it('samples two injected snapshots and classifies against the threshold', async () => {
    let calls = 0;
    const snapshots = [
      [snapshot(100, 100)], // first
      [snapshot(150, 200)], // second => 50% busy
    ];
    const sampler = createHostCpuSampler({
      threshold: { percent: 85, source: 'override' },
      now: () => 1_000,
      snapshot: () => snapshots[Math.min(calls++, 1)][0],
      loadavgFn: () => [2.0, 2.0, 2.0],
      gapMs: 0,
      sleep: async () => {},
    });
    const sample = await sampler();
    expect(sample.status).toBe('healthy');
    expect(sample.busyPercent).toBe(50);
    expect(sample.cpuCount).toBe(1);
    expect(sample.load1).toBe(2);
    expect(sample.loadPerCpu).toBe(2);
    expect(sample.thresholdPercent).toBe(85);
    expect(sample.source).toBe('override');
  });

  it('fails closed to unavailable when the sampler errors internally', async () => {
    const sampler = createHostCpuSampler({
      threshold: { percent: 85, source: 'default' },
      snapshot: () => {
        throw new Error('sensor gone');
      },
      gapMs: 0,
      sleep: async () => {},
    });
    const sample = await sampler();
    expect(sample.status).toBe('unavailable');
  });

  it('sanitizes a clock-regressed sampleMs to a nonnegative value', async () => {
    let time = 1_000;
    let call = 0;
    const sampler = createHostCpuSampler({
      threshold: { percent: 85, source: 'default' },
      now: () => time,
      snapshot: () => {
        call += 1;
        return call === 1 ? snapshot(100, 100) : snapshot(150, 200);
      },
      gapMs: 0,
      sleep: async () => {
        time = 900;
      },
    });
    const sample = await sampler();
    // sampledAt (900) precedes startedAt (1000) => raw sampleMs would be -100.
    expect(sample.sampleMs).toBe(0);
    expect(sample.status).toBe('healthy');
    expect(sample.busyPercent).toBe(50);
  });
});

describe('projectHostPressureForStatus', () => {
  it('projects the bounded observable fields', () => {
    expect(
      projectHostPressureForStatus(healthySample(50, { sampledAt: 9 })),
    ).toMatchObject({
      status: 'healthy',
      busyPercent: 50,
      cpuCount: 4,
      sampledAt: 9,
      thresholdPercent: 85,
      source: 'override',
    });
  });

  it('returns undefined for nothing to project', () => {
    expect(projectHostPressureForStatus(undefined)).toBeUndefined();
    expect(projectHostPressureForStatus(null)).toBeUndefined();
  });
});
