import { expect, test, vi } from 'vitest';
import { SyntheticLiveSurfaceProducer } from '../../../__test-utils__/synthetic-live-surface-producer.js';
import type { LiveSurfaceHeldInput } from '../../live-surface/producer.js';
import {
  dispatchHumanInput,
  LiveSurfaceRegistry,
  releaseHumanControl,
} from '../../live-surface/registry.js';
import { DeviceSessionService } from '../device-session-service.js';

const human = {
  kind: 'human',
  principal: 'human:a',
  device: 'a',
} as const;
const device = {
  hostId: 'local',
  platform: 'android' as const,
  deviceId: 'emulator-5554',
  name: 'Test',
  runtime: 'Android 16',
  booted: true,
};

test("a key whose release keeps failing ends the device session; the device's next session releases it before anyone types (round 8, item 4)", async () => {
  const surfaces = new LiveSurfaceRegistry();
  const producers: SyntheticLiveSurfaceProducer[] = [];
  const cancels: LiveSurfaceHeldInput[][] = [];
  const service = new DeviceSessionService({
    host: {
      inventory: async () => ({
        hostId: 'local',
        state: 'ready',
        observedAt: new Date().toISOString(),
        devices: [device],
      }),
      boot: vi.fn(),
      attachStream: vi.fn(),
      shutdown: vi.fn(),
      screenshot: vi.fn(),
      connect: vi.fn(),
    } as never,
    endpoint: { onExit: () => () => {} },
    surfaces,
    access: {
      isOperator: async () => true,
      hasStanding: async () => true,
      mayAccessDevice: async () => true,
    } as never,
    createProducer: (options) => {
      const producer = new SyntheticLiveSurfaceProducer(options.surfaceId);
      const index = producers.length;
      cancels.push([]);
      // The first session's device never takes the release.
      producer.cancelHeldInput = async (held) => {
        cancels[index]!.push(held);
        if (index === 0) throw new Error('device refused the release');
      };
      Object.assign(producer, { open: () => {}, dispose: async () => {} });
      producers.push(producer);
      return producer as never;
    },
  });
  const first = await service.open({
    hostId: 'local',
    platform: 'android',
    deviceId: device.deviceId,
  });
  const entry = surfaces.get(first.surfaceId)!;
  await dispatchHumanInput(entry, human, 0, [
    { kind: 'key', type: 'down', key: 'Shift', code: 'ShiftLeft' },
  ]);
  expect(
    releaseHumanControl(entry, human, entry.lease.snapshot().epoch).ok,
  ).toBe(true);
  // Six failed releases, with the capped pauses between them, end it.
  await vi.waitFor(() => expect(service.get(first.sessionId)).toBeUndefined(), {
    timeout: 10_000,
    interval: 100,
  });
  expect(cancels[0]).toHaveLength(6);
  expect(surfaces.get(first.surfaceId)).toBeUndefined();
  // Reconnect: a new session on the same device releases the key first.
  const next = await service.open({
    hostId: 'local',
    platform: 'android',
    deviceId: device.deviceId,
  });
  expect(next.sessionId).not.toBe(first.sessionId);
  await vi.waitFor(() =>
    expect(cancels[1]).toEqual([
      expect.objectContaining({ keys: [{ key: 'Shift', code: 'ShiftLeft' }] }),
    ]),
  );
  const nextEntry = surfaces.get(next.surfaceId)!;
  expect(
    (
      await dispatchHumanInput(nextEntry, human, 0, [
        { kind: 'text', text: 'after' },
      ])
    ).ok,
  ).toBe(true);
  await service.dispose();
  await surfaces.dispose();
}, 20_000);
