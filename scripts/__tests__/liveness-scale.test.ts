import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  livenessScale,
  MAX_LIVENESS_SCALE,
  parseLivenessScale,
  scaleLivenessMs,
} from '../lib/liveness-scale.mjs';
import {
  describeLivenessScale,
  ensureLivenessScale,
  MAX_SAMPLED_LIVENESS_SCALE,
  resolveLivenessScale,
  scaleFromBusyPercent,
} from '../lib/liveness-scale-resolve.mjs';
import {
  MAX_PRODUCT_LAW_RUNTIME_MS,
  PRODUCT_LAW_OBSERVATION_TIMEOUT_MS,
  productLawEffectiveObservationTimeoutMs,
  productLawObservationTimeoutMs,
  productLawRuntimeBudgetMs,
} from '../lib/product-laws.mjs';
import { digestVerificationEnvironment } from '../lib/test-reliability.mjs';
import {
  runTransferCapture,
  TRANSFER_CAPTURE_LIVENESS_TIMEOUT_MS,
  transferCaptureLivenessTimeoutMs,
} from '../orchestration-transfer-gate.mjs';
import { runProductLawGate } from '../product-law-gate.mjs';
import {
  FALLOW_WATCHDOG_BASE_MS,
  runFallowAnalysis,
} from '../run-fallow-audit.mjs';

const makeTempDir = trackTempDirs();
const ROOT = resolve(import.meta.dirname, '../..');
const sample = (busyPercent: number) => async () => ({
  status: busyPercent > 85 ? 'pressured' : 'healthy',
  busyPercent,
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('liveness scale factor', () => {
  test('a test worker starts without an inherited factor', () => {
    expect(process.env.STATION_LIVENESS_SCALE).toBeUndefined();
    expect(process.env.STATION_LIVENESS_SCALE_RESOLVED).toBeUndefined();
  });

  test('pins the documented constants', () => {
    expect(MAX_SAMPLED_LIVENESS_SCALE).toBe(4);
    expect(MAX_LIVENESS_SCALE).toBe(8);
  });

  test('healthy host is 1, pressure raises it, and it never exceeds 4', () => {
    const points = [0, 30, 60, 61, 70, 71, 85, 86, 100];
    const expected = [1, 1, 1, 2, 2, 3, 3, 4, 4];
    expect(points.map(scaleFromBusyPercent)).toEqual(expected);
    let previous = 1;
    for (let busy = 0; busy <= 100; busy++) {
      const scale = scaleFromBusyPercent(busy);
      expect(scale).toBeGreaterThanOrEqual(previous);
      expect(scale).toBeLessThanOrEqual(MAX_SAMPLED_LIVENESS_SCALE);
      previous = scale;
    }
    expect(scaleFromBusyPercent(Number.NaN)).toBe(1);
  });

  test('resolves 1 / >1 / unavailable / throwing sampler', async () => {
    const env = {};
    expect(
      (await resolveLivenessScale({ env, sampler: sample(10) })).scale,
    ).toBe(1);
    const pressured = await resolveLivenessScale({ env, sampler: sample(87) });
    expect(pressured.scale).toBe(4);
    expect(pressured.busyPercent).toBe(87);
    const unavailable = await resolveLivenessScale({
      env,
      sampler: async () => ({ status: 'unavailable' }),
    });
    expect(unavailable.scale).toBe(1);
    const noBusy = await resolveLivenessScale({
      env,
      sampler: async () => ({ status: 'healthy' }),
    });
    expect(noBusy.scale).toBe(1);
    const thrown = await resolveLivenessScale({
      env,
      sampler: async () => {
        throw new Error('no cpus');
      },
    });
    expect(thrown.scale).toBe(1);
  });

  test('CI stays 1 without sampling, even under pressure', async () => {
    for (const env of [{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }]) {
      const sampler = vi.fn(sample(100));
      expect((await resolveLivenessScale({ env, sampler })).scale).toBe(1);
      expect(sampler).not.toHaveBeenCalled();
    }
  });

  test('explicit override only raises, in CI and out', async () => {
    expect(
      (
        await resolveLivenessScale({
          env: { CI: 'true', STATION_LIVENESS_SCALE: '6' },
          sampler: sample(100),
        })
      ).scale,
    ).toBe(6);
    // An override below the sampled value cannot lower it.
    expect(
      (
        await resolveLivenessScale({
          env: { STATION_LIVENESS_SCALE: '2' },
          sampler: sample(100),
        })
      ).scale,
    ).toBe(4);
    expect(
      (
        await resolveLivenessScale({
          env: { STATION_LIVENESS_SCALE: '8' },
          sampler: sample(0),
        })
      ).scale,
    ).toBe(8);
  });

  test('refuses max+1, below 1, and malformed overrides', async () => {
    for (const bad of [
      '9',
      '8.01',
      '0',
      '0.5',
      '-1',
      'abc',
      '1e1',
      'Infinity',
      '2x',
      '99999',
    ]) {
      expect(() => parseLivenessScale(bad), bad).toThrow(
        /STATION_LIVENESS_SCALE/,
      );
      await expect(
        resolveLivenessScale({
          env: { STATION_LIVENESS_SCALE: bad },
          sampler: sample(0),
        }),
        bad,
      ).rejects.toThrow(/\[1\.\.8\]/);
      expect(() => livenessScale({ STATION_LIVENESS_SCALE: bad })).toThrow();
    }
    expect(parseLivenessScale('8')).toBe(8);
    expect(parseLivenessScale('1')).toBe(1);
    expect(parseLivenessScale('2.5')).toBe(2.5);
  });

  test('ensure publishes once, logs one line, and children never re-sample', async () => {
    const env: Record<string, string | undefined> = {};
    const log = vi.fn();
    const sampler = vi.fn(sample(87));
    expect(await ensureLivenessScale({ env, sampler, log })).toBe(4);
    expect(env.STATION_LIVENESS_SCALE).toBe('4');
    expect(env.STATION_LIVENESS_SCALE_RESOLVED).toBe('1');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe(
      'host under CPU pressure (87% busy): liveness bounds ×4',
    );
    // A child sees the marker: no second sample, no second line.
    expect(await ensureLivenessScale({ env, sampler, log })).toBe(4);
    expect(sampler).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
  });

  test('prints nothing at 1 and names the override when it raised the factor', async () => {
    const log = vi.fn();
    await ensureLivenessScale({ env: {}, sampler: sample(5), log });
    expect(log).not.toHaveBeenCalled();
    expect(
      describeLivenessScale({ scale: 6, sampled: 1, busyPercent: 5 }),
    ).toContain('STATION_LIVENESS_SCALE override');
    expect(
      describeLivenessScale({ scale: 1, sampled: 1, busyPercent: 5 }),
    ).toBeNull();
  });

  test('scaled bounds are always finite', () => {
    const scaled = scaleLivenessMs(30_000, { STATION_LIVENESS_SCALE: '8' });
    expect(scaled).toBe(240_000);
    expect(Number.isFinite(scaled)).toBe(true);
    expect(scaleLivenessMs(30_000, {})).toBe(30_000);
    expect(() => scaleLivenessMs(0, {})).toThrow();
  });

  test('the CLI prints the factor on stdout, and refuses an invalid override with exit 2', () => {
    const run = (extra: Record<string, string>) =>
      spawnSync(
        process.execPath,
        [join(ROOT, 'scripts/lib/liveness-scale-resolve.mjs')],
        {
          encoding: 'utf8',
          windowsHide: true,
          env: {
            ...process.env,
            STATION_LIVENESS_SCALE: undefined,
            STATION_LIVENESS_SCALE_RESOLVED: undefined,
            CI: 'true',
            ...extra,
          },
        },
      );
    const ok = run({ STATION_LIVENESS_SCALE: '3' });
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim()).toBe('3');
    const ci = run({});
    expect(ci.stdout.trim()).toBe('1');
    const refused = run({ STATION_LIVENESS_SCALE: '9' });
    expect(refused.status).toBe(2);
    expect(refused.stdout).toBe('');
  });

  test('the pre-push hook resolves the factor before its first check', () => {
    const hook = readFileSync(join(ROOT, '.githooks/pre-push'), 'utf8');
    const resolveAt = hook.indexOf(
      'node scripts/lib/liveness-scale-resolve.mjs',
    );
    expect(resolveAt).toBeGreaterThan(0);
    expect(hook).toContain('export STATION_LIVENESS_SCALE_RESOLVED=1');
    expect(resolveAt).toBeLessThan(hook.indexOf('npm run --silent lint:check'));
  });
});

describe('consumers multiply their liveness bound', () => {
  test('vitest test and hook timeouts', async () => {
    const load = async (scale?: string) => {
      vi.resetModules();
      if (scale === undefined) vi.stubEnv('STATION_LIVENESS_SCALE', '');
      else vi.stubEnv('STATION_LIVENESS_SCALE', scale);
      const mod = await import('../../vitest.config');
      return (mod.default as any).test;
    };
    expect(await load()).toMatchObject({
      testTimeout: 30_000,
      hookTimeout: 30_000,
    });
    expect(await load('3')).toMatchObject({
      testTimeout: 90_000,
      hookTimeout: 90_000,
    });
    const max = await load('8');
    expect(max.testTimeout).toBe(240_000);
    vi.resetModules();
    vi.stubEnv('STATION_LIVENESS_SCALE', '9');
    await expect(import('../../vitest.config')).rejects.toThrow(/\[1\.\.8\]/);
  });

  test('product-law per-observation and total bounds', () => {
    expect(PRODUCT_LAW_OBSERVATION_TIMEOUT_MS).toBe(30_000);
    expect(MAX_PRODUCT_LAW_RUNTIME_MS).toBe(150_000);
    const env = { STATION_LIVENESS_SCALE: '3' };
    expect(productLawEffectiveObservationTimeoutMs(env)).toBe(90_000);
    // The policy value that feeds receipt digests never depends on host load.
    expect(productLawObservationTimeoutMs(env)).toBe(30_000);
    expect(digestVerificationEnvironment({ ...env })).toBe(
      digestVerificationEnvironment({}),
    );
    expect(productLawRuntimeBudgetMs(env)).toBe(450_000);
    expect(productLawEffectiveObservationTimeoutMs({})).toBe(30_000);
    // An explicit per-observation value is the caller's own bound.
    expect(
      productLawEffectiveObservationTimeoutMs({
        ...env,
        PRODUCT_LAW_OBSERVATION_TIMEOUT_MS: '5',
      }),
    ).toBe(5);
    expect(
      Number.isFinite(
        productLawRuntimeBudgetMs({ STATION_LIVENESS_SCALE: '8' }),
      ),
    ).toBe(true);
  });

  test('the product-law gate hands each observation the scaled bound and stays finite', async () => {
    const run = async (scale: string | undefined) => {
      const timeouts: number[] = [];
      let clock = 0;
      const result = await runProductLawGate({
        rootDir: ROOT,
        env: scale ? { STATION_LIVENESS_SCALE: scale } : {},
        // Each observation "takes" 100s, so the shared total is what ends the run.
        now: () => clock,
        observe: async (observation: { timeoutMs: number }) => {
          timeouts.push(observation.timeoutMs);
          clock += 100_000;
          return { status: 'PASS' };
        },
      });
      return { timeouts, result };
    };
    const base = await run(undefined);
    expect(base.timeouts[0]).toBe(30_000);
    // 150s total: observation 1 at t=0, observation 2 at t=100s with 50s left.
    expect(base.timeouts.slice(0, 2)).toEqual([30_000, 30_000]);
    expect(base.timeouts).toHaveLength(2);
    expect(JSON.stringify(base.result.report)).toContain('exceeded 150000ms');

    const scaled = await run('3');
    expect(scaled.timeouts[0]).toBe(90_000);
    // 450s total at 100s per observation admits five before the ceiling.
    expect(scaled.timeouts).toHaveLength(5);
    expect(Math.max(...scaled.timeouts)).toBeLessThanOrEqual(90_000);
    expect(JSON.stringify(scaled.result.report)).toContain('exceeded 450000ms');
  });

  test('the fallow watchdog timer', async () => {
    expect(FALLOW_WATCHDOG_BASE_MS).toBe(120_000);
    const delays: number[] = [];
    const real = globalThis.setTimeout as unknown as (
      ...args: unknown[]
    ) => unknown;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      if (ms !== undefined && ms >= 100_000) delays.push(ms);
      return real(fn, ms, ...rest);
    }) as typeof setTimeout);
    const scratch = makeTempDir('liveness-fallow-');
    for (const scale of ['1', '3']) {
      await runFallowAnalysis(
        join(scratch, 'missing-root'),
        'dead-code',
        join(scratch, 'out.json'),
        [],
        { env: { STATION_LIVENESS_SCALE: scale } },
      ).catch(() => undefined);
    }
    expect(delays).toEqual([120_000, 360_000]);
  });

  test('the transfer capture liveness bound', () => {
    expect(TRANSFER_CAPTURE_LIVENESS_TIMEOUT_MS).toBe(60_000);
    expect(transferCaptureLivenessTimeoutMs({})).toBe(60_000);
    expect(
      transferCaptureLivenessTimeoutMs({ STATION_LIVENESS_SCALE: '2' }),
    ).toBe(120_000);
    // The explicit per-gate override is used as given.
    expect(
      transferCaptureLivenessTimeoutMs({
        STATION_LIVENESS_SCALE: '2',
        STATION_TRANSFER_CAPTURE_TIMEOUT_MS: '5000',
      }),
    ).toBe(5000);
    const timeouts: number[] = [];
    vi.stubEnv('STATION_LIVENESS_SCALE', '2');
    expect(() =>
      runTransferCapture({
        candidateRoot: ROOT,
        targetRoot: ROOT,
        output: join(tmpdir(), 'unused-liveness-capture.json'),
        baseSha: 'a'.repeat(40),
        spawn: ((_c: string, _a: string[], options: { timeout: number }) => {
          timeouts.push(options.timeout);
          return { status: 1, stdout: '', stderr: '' };
        }) as any,
      }),
    ).toThrow(/capture failed/);
    expect(timeouts).toEqual([120_000]);
  });

  test('the in-capture barrier is derived from the gate bound, not a bare literal', () => {
    // The capture's barriers take their deadline from the bound the gate
    // passes (#3058), and that bound is the scaled default above unless the
    // operator set one. The barrier's own behavior is proven by running it as
    // a child in transfer-capture-barrier.test.ts; this only pins the wiring.
    const source = readFileSync(
      join(ROOT, 'scripts/orchestration-transfer-capture.ts'),
      'utf8',
    );
    expect(source).toContain('createCaptureBarrier(captureTimeoutMs)');
    expect(source).not.toMatch(/performance\.now\(\) \+ \d/);
  });
});
