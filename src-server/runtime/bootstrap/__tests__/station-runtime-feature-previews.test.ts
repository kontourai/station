import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { FeaturePreviewRegistry } from '../../../services/feature-previews/feature-preview-registry.js';
import { StationRuntime } from '../station-runtime.js';

vi.mock(
  '@kontourai/station-shared/lifecycle-events',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-shared/lifecycle-events')
      >();
    return {
      ...actual,
      acquireFileMutationLockAsync: (lock: string) =>
        actual.acquireFileMutationLockAsync(lock, {
          birthFingerprint: () => 'station-runtime-feature-preview-test',
        }),
    };
  },
);

const directories: string[] = [];
const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
  setLevel: vi.fn(),
  getLevel: vi.fn(() => 'info' as const),
};

function runtimeFor(registry: FeaturePreviewRegistry) {
  const runtime = Object.create(StationRuntime.prototype) as any;
  runtime.featurePreviews = registry;
  runtime.logger = logger;
  runtime.bindFleetConsumerProbesPreview();
  return runtime;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Fleet consumer probes toggle the actual runtime consuming path', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'station-runtime-previews-'));
  directories.push(directory);
  const registry = new FeaturePreviewRegistry(directory, logger);
  const runtime = runtimeFor(registry);

  expect(registry.list()).toEqual([
    expect.objectContaining({ id: 'fleet-consumer-probes', enabled: false }),
  ]);
  expect(runtime.fleetProbes()).toBeUndefined();
  await registry.setEnabled('fleet-consumer-probes', true);

  // This invokes StationRuntime.fleetProbes itself: the observed service is
  // the production object passed to FleetCandidateService, not fixture data.
  expect(runtime.fleetProbes()).toBeDefined();

  // Rebuild the runtime-owned registry from the same Station home, mirroring
  // the part of a server restart that owns preview state and consumption.
  const restartedRuntime = runtimeFor(
    new FeaturePreviewRegistry(directory, logger),
  );
  expect(restartedRuntime.fleetProbes()).toBeDefined();
});
