import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  admitEngineStartForIntent,
  ConcurrentEngineStartCapacityError,
  computeRuntimeCpuBusyPercent,
  createEnvironmentRuntimeResourcePostureProbe,
  createRuntimeCpuSampler,
  createRuntimeResourcePostureController,
  deriveRuntimeResourcePosture,
} from '../resource-posture.js';

const observation = (busyPercent: number) => ({
  busyPercent,
  cpuCount: 8,
  sampledAt: 100,
  sampleMs: 500,
  thresholdPercent: 85,
  source: 'test',
});

function cpuSnapshot(idle: number, user: number) {
  return [
    {
      model: 'test',
      speed: 1,
      times: { idle, user, nice: 0, sys: 0, irq: 0 },
    },
  ];
}

describe('runtime resource diagnostics', () => {
  test('computes CPU busy percent from two os.cpus snapshots', () => {
    expect(
      computeRuntimeCpuBusyPercent(
        cpuSnapshot(100, 100),
        cpuSnapshot(110, 190),
      ),
    ).toBe(90);
    expect(computeRuntimeCpuBusyPercent([], [])).toBeUndefined();
  });

  test('the product-owned sampler reports an observed diagnostic', async () => {
    const snapshots = [cpuSnapshot(100, 100), cpuSnapshot(110, 190)];
    const sample = createRuntimeCpuSampler({
      readCpus: () => snapshots.shift()!,
      wait: async () => undefined,
      now: vi.fn().mockReturnValueOnce(1_000).mockReturnValue(1_500),
    });
    await expect(sample()).resolves.toMatchObject({
      busyPercent: 90,
      cpuCount: 1,
      sampledAt: 1_500,
      sampleMs: 500,
      source: 'runtime-diagnostics',
    });
  });

  test('keeps a 99%-busy observation diagnostic while admitting engine starts', async () => {
    const sample = vi.fn(async () => observation(99));
    const controller = createRuntimeResourcePostureController({ sample });

    await expect(controller.observe()).resolves.toMatchObject({
      kind: 'critical',
      busyPercent: 99,
    });
    const lease = await admitEngineStartForIntent(
      controller,
      undefined,
      'interactive_user',
      { binding: 'thread-a' },
    );
    expect(sample).toHaveBeenCalledOnce();
    await expect(
      admitEngineStartForIntent(controller, undefined, 'webhook', {
        binding: 'thread-b',
      }),
    ).rejects.toThrow(ConcurrentEngineStartCapacityError);
    lease?.release();
    await expect(
      admitEngineStartForIntent(controller, undefined, 'webhook', {
        binding: 'thread-b',
      }),
    ).resolves.toBeDefined();
    expect(sample).toHaveBeenCalledOnce();
  });

  test('environment cannot override the production diagnostic factory', async () => {
    const probe = createEnvironmentRuntimeResourcePostureProbe(
      {
        STATION_INSTANCE_ID: 'diagnostics-test',
      },
      { sample: async () => observation(99) },
    );
    await expect(probe.observe()).resolves.toMatchObject({
      kind: 'critical',
      busyPercent: 99,
      source: 'test',
    });
  });

  test('classifies malformed observations as unavailable', () => {
    expect(deriveRuntimeResourcePosture({ source: 'test' })).toMatchObject({
      kind: 'unavailable',
      cpuCount: 0,
    });
  });

  test('production server modules never import verification scripts', () => {
    const serverRoot = join(process.cwd(), 'src-server');
    const violations: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') visit(path);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const source = readFileSync(path, 'utf8');
        if (/from\s+['"][^'"]*scripts\//u.test(source))
          violations.push(relative(process.cwd(), path));
      }
    };
    visit(serverRoot);
    expect(violations).toEqual([]);
  });
});
