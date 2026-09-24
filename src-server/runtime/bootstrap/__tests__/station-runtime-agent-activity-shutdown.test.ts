import { describe, expect, test, vi } from 'vitest';
import { StationRuntime } from '../station-runtime.js';

describe('StationRuntime shutdown', () => {
  test('stops the agent-activity publisher, and with it its timer', async () => {
    // Prototype-built double, the established shutdown-test shape: shutdown
    // tolerates every field it does not find.
    const runtime = Object.create(StationRuntime.prototype) as any;
    runtime.logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const stop = vi.fn(async () => {});
    runtime.agentActivityPublisher = { stop };
    await runtime.shutdown().catch(() => {});
    expect(stop).toHaveBeenCalledTimes(1);
    expect(runtime.agentActivityPublisher).toBeUndefined();
  });
});
