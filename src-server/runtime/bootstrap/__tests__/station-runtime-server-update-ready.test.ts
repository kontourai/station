import { describe, expect, test, vi } from 'vitest';
import { StationRuntime } from '../station-runtime.js';

/**
 * #3851: apply-when-idle waits for `markReady`. The runtime gives it once
 * `initialize` finished AND orchestration's session recovery settled (it
 * runs unawaited, and re-registers the turns it finds), never before either,
 * and never when initialize failed.
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
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  runtime.orchestrationService = {
    whenSessionAttachmentSettled: () => settled,
  };
  return { runtime, settle };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('StationRuntime initialize and the server update coordinator', () => {
  test('marks the coordinator ready only once session recovery settled', async () => {
    const { runtime, settle } = runtimeDouble(async () => {});
    await runtime.initialize();
    await flush();
    // Initialize finished, recovery has not: not ready.
    expect(runtime.serverUpdate.markReady).not.toHaveBeenCalled();
    settle();
    await flush();
    expect(runtime.serverUpdate.markReady).toHaveBeenCalledTimes(1);
  });

  test('does not mark it ready when initialize failed, even once recovery settles', async () => {
    const { runtime, settle } = runtimeDouble(async () => {
      throw new Error('startup failed');
    });
    await expect(runtime.initialize()).rejects.toBeDefined();
    settle();
    await flush();
    expect(runtime.serverUpdate.markReady).not.toHaveBeenCalled();
  });
});
