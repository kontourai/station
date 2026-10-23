import { describe, expect, test, vi } from 'vitest';
import { StationRuntime } from '../station-runtime.js';

describe('StationRuntime shutdown', () => {
  test('stops activity and closes Project Room producers before their authority and stores', async () => {
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
    const closed: string[] = [];
    runtime.projectRoomRuntime = { close: () => closed.push('room') };
    runtime.projectMembership = { close: () => closed.push('membership') };
    runtime.orchestrationEventStore = { close: () => closed.push('sessions') };
    await runtime.shutdown().catch(() => {});
    expect(closed).toEqual(['room', 'membership', 'sessions']);
    expect(runtime.projectRoomRuntime).toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(runtime.agentActivityPublisher).toBeUndefined();
  });
});
