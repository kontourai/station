import { describe, expect, test, vi } from 'vitest';
import { StationRuntime } from '../station-runtime.js';

/**
 * #3851 review round 2 item 6: apply-when-idle waits for `markReady`, and
 * the runtime's own `initialize` is what gives it: only once it finished
 * (listening, turn recovery run), never when it failed.
 */
function runtimeDouble(runInitialize: () => Promise<void>) {
  // Prototype-built double, the established runtime lifecycle-test shape.
  const runtime = Object.create(StationRuntime.prototype) as any;
  runtime.logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  runtime.virtualApplicationLifetime = new AbortController();
  runtime.runInitialize = runInitialize;
  runtime.recordRuntimeLifecycle = vi.fn();
  runtime.serverUpdate = { markReady: vi.fn(), stop: vi.fn() };
  return runtime;
}

describe('StationRuntime initialize and the server update coordinator', () => {
  test('marks the coordinator ready once initialize finished', async () => {
    const runtime = runtimeDouble(async () => {});
    await runtime.initialize();
    expect(runtime.serverUpdate.markReady).toHaveBeenCalledTimes(1);
  });

  test('does not mark it ready when initialize failed', async () => {
    const failure = new Error('startup failed');
    const runtime = runtimeDouble(async () => {
      throw failure;
    });
    await expect(runtime.initialize()).rejects.toBeDefined();
    expect(runtime.serverUpdate.markReady).not.toHaveBeenCalled();
  });
});
