import type {
  LiveSurfaceFrameHeader,
  LiveSurfaceStreamParams,
} from '@kontourai/station-contracts/live-surface';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  SyntheticLiveSurfaceProducer,
  syntheticFrameCounter,
} from '../../../__test-utils__/synthetic-live-surface-producer.js';
import { LiveSurfaceControlLeaseState } from '../control-lease.js';
import {
  LiveSurfaceHub,
  type LiveSurfaceHubOptions,
  type LiveSurfaceViewer,
} from '../surface-hub.js';

const PARAMS: LiveSurfaceStreamParams = {
  maxFps: 10,
  quality: 70,
  maxWidth: 1280,
  maxHeight: 1280,
};
const human = {
  kind: 'human',
  principal: 'human:local:operator',
  device: 'device:a',
} as const;

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

function build(
  options: { backpressure?: boolean; hub?: LiveSurfaceHubOptions } = {},
) {
  const producer = new SyntheticLiveSurfaceProducer('surface-1', {
    backpressure: options.backpressure,
  });
  const lease = new LiveSurfaceControlLeaseState('surface-1');
  const errors: string[] = [];
  // Default hub options except a long heartbeat, so a test's records are
  // only the ones it causes.
  const hub = new LiveSurfaceHub(producer, lease, {
    heartbeatMs: 60_000,
    onError: (message) => errors.push(message),
    ...options.hub,
  });
  return { producer, lease, hub, errors };
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

  test('idleStopMs keeps the stream running briefly so a reconnect does not restart it', async () => {
    const { producer, hub } = build({ hub: { idleStopMs: 2_000 } });
    const a = hub.attach(PARAMS);
    await hub.settled();
    a.close();
    vi.advanceTimersByTime(1_999);
    await hub.settled();
    expect(producer.stops).toBe(0);
    // A viewer returning inside the window cancels the stop.
    const b = hub.attach(PARAMS);
    vi.advanceTimersByTime(5_000);
    await hub.settled();
    expect(producer.stops).toBe(0);
    expect(producer.starts).toHaveLength(1);
    b.close();
    vi.advanceTimersByTime(2_000);
    await hub.settled();
    expect(producer.stops).toBe(1);
  });

  test('the first record a viewer receives is the stream state, with the lease and its own identity', async () => {
    const { hub, lease } = build();
    lease.claimHuman(human);
    const viewer = hub.attach(PARAMS, {
      principal: 'human:local:operator',
      device: 'device:b',
    });
    expect(await viewer.next()).toMatchObject({
      kind: 'state',
      state: {
        surfaceId: 'surface-1',
        lease: { epoch: 1, holder: human },
        effectiveParams: PARAMS,
        viewer: { principal: 'human:local:operator', device: 'device:b' },
      },
    });
  });

  test('latest frame wins: a slow viewer skips stale frames and gets the newest', async () => {
    // A producer that ignores acks, so frames keep arriving while the
    // viewer is busy — the case a queue would turn into growing latency.
    const { producer, hub } = build({
      backpressure: false,
      hub: { downgradeAfter: 100 },
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

  test('with DEFAULT options a fast viewer keeps full fps while a slow one gets the latest (S5)', async () => {
    const { producer, hub } = build({ backpressure: true });
    const fast = hub.attach(PARAMS);
    const slow = hub.attach(PARAMS);
    await hub.settled();
    await fast.next();
    await slow.next();
    for (let i = 1; i <= 8; i += 1) {
      nextInterval();
      expect(producer.emit()).toBe(true);
      // The fast viewer takes each frame, which acks it and unblocks the producer.
      expect(await frameCounter(fast)).toBe(i);
    }
    expect(await frameCounter(slow)).toBe(8);
    expect(slow.stats.overwritten).toBe(7);
    expect(fast.stats).toEqual({ delivered: 8, overwritten: 0 });
    // One slow viewer never lowered the rate the fast one gets.
    expect(hub.effectiveParams().maxFps).toBe(10);
    // Exactly-once ack with two viewers (M1): each frame once, in order.
    expect(producer.acks).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
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

  test('a viewer that disconnects holding the only unacked frame releases the producer (B2)', async () => {
    const { producer, hub } = build({ backpressure: true });
    const a = hub.attach(PARAMS);
    await hub.settled();
    await a.next(); // state; a is busy
    nextInterval();
    expect(producer.emit()).toBe(true); // frame 1 sits in a's slot, unacked
    const b = hub.attach(PARAMS);
    await b.next(); // b's state
    a.close();
    expect(producer.acks).toEqual([1]);
    nextInterval();
    expect(producer.emit()).toBe(true);
    // (a leaving re-announces the stream state to b first)
    expect((await b.next())?.kind).toBe('state');
    expect(await frameCounter(b)).toBe(2);
  });

  test('a viewer joining a still page is seeded with the last frame (S2)', async () => {
    const { producer, hub } = build({ backpressure: true });
    const a = hub.attach(PARAMS);
    await hub.settled();
    await a.next();
    nextInterval();
    producer.emit();
    expect(await frameCounter(a)).toBe(1);
    // The page is now still: the producer sends nothing more.
    const b = hub.attach(PARAMS);
    expect((await b.next())?.kind).toBe('state');
    expect(await frameCounter(b)).toBe(1);
  });

  test('a frame delivered after a handoff carries the current epoch, not its capture epoch (B1)', async () => {
    const { producer, hub, lease } = build({ backpressure: true });
    const viewer = hub.attach(PARAMS);
    await hub.settled();
    await viewer.next(); // state at epoch 0; viewer busy
    nextInterval();
    producer.emit(); // frame published at epoch 0 into the busy viewer's slot
    lease.claimForHumanInput(human, 0); // epoch 1
    expect(await viewer.next()).toMatchObject({
      kind: 'state',
      state: { lease: { epoch: 1 } },
    });
    expect(await viewer.next()).toMatchObject({
      kind: 'frame',
      header: { epoch: 1 },
    });
  });

  test('fps halves only when every viewer is slow, at two data points, and recovers', async () => {
    const { producer, hub } = build({ backpressure: false });
    const viewer = hub.attach(PARAMS);
    await hub.settled();
    await viewer.next();
    expect(hub.effectiveParams().maxFps).toBe(10);
    const overwriteThreeTimes = () => {
      nextInterval();
      producer.emit(); // fills the slot
      for (let i = 0; i < 3; i += 1) {
        nextInterval();
        producer.emit(); // overwrites while busy
      }
    };
    overwriteThreeTimes();
    expect(hub.effectiveParams().maxFps).toBe(5);
    await hub.settled();
    expect(producer.paramUpdates.at(-1)).toMatchObject({ maxFps: 5 });
    // The downgrade is published to the viewer as a state record.
    expect(await viewer.next()).toMatchObject({
      kind: 'state',
      state: { effectiveParams: { maxFps: 5 } },
    });
    await viewer.next(); // the latest frame; viewer busy again
    overwriteThreeTimes();
    expect(hub.effectiveParams().maxFps).toBe(2);
    await viewer.next(); // state
    await viewer.next(); // frame
    // Quiet time doubles it back toward the requested 10.
    vi.advanceTimersByTime(6_000);
    producer.emit();
    expect(hub.effectiveParams().maxFps).toBe(4);
  });

  test('the fps floor is 1: a 1 fps viewer that stays slow is never throttled to 0 (M3)', async () => {
    const { producer, hub } = build({ backpressure: false });
    const viewer = hub.attach({ ...PARAMS, maxFps: 1 });
    await hub.settled();
    await viewer.next();
    for (let i = 0; i < 12; i += 1) {
      vi.advanceTimersByTime(1_500);
      producer.emit();
    }
    expect(hub.effectiveParams().maxFps).toBe(1);
    // A frame still arrives.
    const next = viewer.next();
    vi.advanceTimersByTime(1_500);
    expect((await next)?.kind).toBeDefined();
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

  test('an invalid producer frame is dropped, acked and reported, never delivered (S8)', async () => {
    const { producer, hub, errors } = build({ backpressure: true });
    const viewer = hub.attach(PARAMS);
    await hub.settled();
    await viewer.next();
    nextInterval();
    producer.size = { width: 0, height: 200, deviceScaleFactor: 1 };
    expect(producer.emit()).toBe(true);
    expect(errors).toEqual([
      'live surface producer emitted an invalid frame; dropped',
    ]);
    expect(producer.acks).toEqual([1]);
    producer.size = { width: 320, height: 200, deviceScaleFactor: 1 };
    nextInterval();
    expect(producer.emit()).toBe(true);
    expect(await frameCounter(viewer)).toBe(2);
  });

  test('a frame labelled for another surface is dropped', async () => {
    const { hub, errors } = build();
    let emit!: (h: LiveSurfaceFrameHeader, b: Uint8Array) => void;
    const producer = hub.producer as SyntheticLiveSurfaceProducer;
    const start = producer.start.bind(producer);
    producer.start = async (params, onFrame) => {
      emit = onFrame;
      return start(params, onFrame);
    };
    hub.attach(PARAMS);
    await hub.settled();
    emit(
      {
        surfaceId: 'someone-else',
        seq: 1,
        epoch: 0,
        codec: 'png',
        width: 1,
        height: 1,
        deviceScaleFactor: 1,
        capturedAt: 1,
      },
      new Uint8Array(1),
    );
    expect(errors).toHaveLength(1);
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
