import type { LiveSurfaceStreamParams } from '@kontourai/station-contracts/live-surface';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  SyntheticLiveSurfaceProducer,
  syntheticFrameCounter,
} from '../../../__test-utils__/synthetic-live-surface-producer.js';
import { LiveSurfaceControlLeaseState } from '../control-lease.js';
import { LiveSurfaceHub, type LiveSurfaceViewer } from '../surface-hub.js';

const PARAMS: LiveSurfaceStreamParams = {
  maxFps: 10,
  quality: 70,
  maxWidth: 1280,
  maxHeight: 1280,
};

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

function build(
  options: {
    backpressure?: boolean;
    withUpdateParams?: boolean;
    idleStopMs?: number;
    downgradeAfter?: number;
  } = {},
) {
  const producer = new SyntheticLiveSurfaceProducer('surface-1', {
    backpressure: options.backpressure,
    withUpdateParams: options.withUpdateParams,
  });
  const lease = new LiveSurfaceControlLeaseState('surface-1');
  const hub = new LiveSurfaceHub(producer, lease, {
    heartbeatMs: 60_000,
    downgradeAfter: options.downgradeAfter ?? 3,
    recoverAfterMs: 5_000,
    idleStopMs: options.idleStopMs ?? 0,
  });
  return { producer, lease, hub };
}

/** Advance past the fps interval so the throttle publishes immediately. */
function nextInterval() {
  vi.advanceTimersByTime(1_000);
}

async function frameCounter(viewer: LiveSurfaceViewer): Promise<number> {
  const record = await viewer.next();
  if (record?.kind !== 'frame')
    throw new Error(`expected a frame, got ${record?.kind}`);
  return syntheticFrameCounter(record.body);
}

describe('live surface hub', () => {
  test('starts the producer on the first viewer and stops it at zero viewers', async () => {
    const { producer, hub } = build();
    expect(producer.running).toBe(false);
    const a = hub.attach(PARAMS);
    await hub.settled();
    expect(producer.starts).toHaveLength(1);
    const b = hub.attach(PARAMS);
    await hub.settled();
    expect(producer.starts).toHaveLength(1);
    a.close();
    await hub.settled();
    expect(producer.stops).toBe(0);
    expect(producer.running).toBe(true);
    b.close();
    await hub.settled();
    expect(producer.stops).toBe(1);
    expect(producer.running).toBe(false);
    // A later viewer starts it again.
    hub.attach(PARAMS);
    await hub.settled();
    expect(producer.starts).toHaveLength(2);
  });

  test('the first record a viewer receives is the stream state, with the lease', async () => {
    const { hub, lease } = build();
    lease.claimHuman('human:local:operator');
    const viewer = hub.attach(PARAMS);
    const record = await viewer.next();
    expect(record).toMatchObject({
      kind: 'state',
      state: {
        surfaceId: 'surface-1',
        lease: { epoch: 1, holder: { kind: 'human' } },
        effectiveParams: PARAMS,
      },
    });
  });

  test('latest frame wins: a slow viewer skips stale frames and gets the newest', async () => {
    // A producer that ignores acks, so frames keep arriving while the
    // viewer is busy — the case a queue would turn into growing latency.
    const { producer, hub } = build({
      backpressure: false,
      downgradeAfter: 100,
    });
    const slow = hub.attach(PARAMS);
    await hub.settled();
    await slow.next(); // state; the viewer is now "busy" sending it
    for (let i = 0; i < 5; i += 1) {
      nextInterval();
      expect(producer.emit()).toBe(true);
    }
    expect(await frameCounter(slow)).toBe(5);
    expect(slow.stats).toEqual({ delivered: 1, overwritten: 4 });
    // Every superseded frame was acked exactly once, then the delivered one.
    expect(producer.acks).toEqual([1, 2, 3, 4, 5]);
  });

  test('a fast viewer is not held back by a slow one, and the slow one gets the latest', async () => {
    const { producer, hub } = build({
      backpressure: true,
      downgradeAfter: 100,
    });
    const fast = hub.attach(PARAMS);
    const slow = hub.attach(PARAMS);
    await hub.settled();
    await fast.next();
    await slow.next();
    for (let i = 1; i <= 4; i += 1) {
      nextInterval();
      expect(producer.emit()).toBe(true);
      // The fast viewer takes each frame, which acks it and unblocks the producer.
      expect(await frameCounter(fast)).toBe(i);
    }
    expect(await frameCounter(slow)).toBe(4);
    expect(slow.stats.overwritten).toBe(3);
    expect(fast.stats).toEqual({ delivered: 4, overwritten: 0 });
  });

  test('backpressure: the producer is not acked until a viewer takes the frame', async () => {
    const { producer, hub } = build({ backpressure: true });
    const viewer = hub.attach(PARAMS);
    await hub.settled();
    await viewer.next(); // state
    nextInterval();
    expect(producer.emit()).toBe(true);
    // Nobody has taken frame 1, so it is unacked and the producer must wait.
    expect(producer.acks).toEqual([]);
    nextInterval();
    expect(producer.emit()).toBe(false);
    expect(await frameCounter(viewer)).toBe(1);
    expect(producer.acks).toEqual([1]);
    nextInterval();
    expect(producer.emit()).toBe(true);
  });

  test('repeated overwrites of a busy viewer lower fps; quiet time restores it', async () => {
    const { producer, hub } = build({ backpressure: false });
    const viewer = hub.attach(PARAMS);
    await hub.settled();
    await viewer.next();
    expect(hub.effectiveParams().maxFps).toBe(10);
    nextInterval();
    producer.emit(); // fills the slot
    for (let i = 0; i < 3; i += 1) {
      nextInterval();
      producer.emit(); // overwrites while busy
    }
    expect(hub.effectiveParams().maxFps).toBe(5);
    await hub.settled();
    expect(producer.paramUpdates.at(-1)).toMatchObject({ maxFps: 5 });
    // The downgrade is published to the viewer as a state record.
    expect(await viewer.next()).toMatchObject({
      kind: 'state',
      state: { effectiveParams: { maxFps: 5 } },
    });
    // The viewer keeps up again; after the recovery window fps doubles back.
    await viewer.next(); // the latest frame
    vi.advanceTimersByTime(6_000);
    producer.emit();
    expect(hub.effectiveParams().maxFps).toBe(10);
  });

  test('the fps throttle publishes the last frame of a burst instead of dropping it', async () => {
    const { producer, hub } = build({ backpressure: false });
    const viewer = hub.attach({ ...PARAMS, maxFps: 1 });
    await hub.settled();
    await viewer.next();
    nextInterval();
    producer.emit(); // frame 1, published at once
    expect(await frameCounter(viewer)).toBe(1);
    vi.advanceTimersByTime(100);
    producer.emit(); // frame 2, inside the 1 s interval: held
    producer.emit(); // frame 3 supersedes the held frame 2
    expect(producer.acks).toEqual([1, 2]);
    const pending = viewer.next();
    vi.advanceTimersByTime(900);
    const record = await pending;
    expect(record?.kind === 'frame' && syntheticFrameCounter(record.body)).toBe(
      3,
    );
  });

  test('frame headers carry the current lease epoch, not the producer value', async () => {
    const { producer, hub, lease } = build();
    const viewer = hub.attach(PARAMS);
    await hub.settled();
    await viewer.next();
    lease.claimHuman('human:local:operator');
    expect(await viewer.next()).toMatchObject({
      kind: 'state',
      state: { lease: { epoch: 1 } },
    });
    nextInterval();
    producer.emit();
    expect(await viewer.next()).toMatchObject({
      kind: 'frame',
      header: { epoch: 1 },
    });
  });

  test('a closed viewer resolves null and the heartbeat re-sends state', async () => {
    const { hub } = build();
    const viewer = hub.attach(PARAMS);
    await viewer.next();
    const waiting = viewer.next();
    vi.advanceTimersByTime(60_000);
    expect(await waiting).toMatchObject({ kind: 'state' });
    const after = viewer.next();
    viewer.close();
    expect(await after).toBeNull();
  });
});
