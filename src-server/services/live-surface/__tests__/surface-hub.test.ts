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
  H264_FALLBACK_OVERFLOWS,
  H264_FALLBACK_WINDOW_MS,
  H264_QUEUE_MAX_UNITS,
  KEYFRAME_REQUEST_MIN_INTERVAL_MS,
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
    // idleStopMs keeps the stream running with no viewers, so a producer
    // left waiting on an ack would stay wedged for the next viewer.
    const { producer, hub } = build({
      backpressure: true,
      hub: { idleStopMs: 60_000 },
    });
    const a = hub.attach(PARAMS);
    await hub.settled();
    await a.next(); // state; a is busy
    nextInterval();
    expect(producer.emit()).toBe(true); // frame 1 sits in a's slot, unacked
    a.close();
    expect(producer.acks).toEqual([1]);
    nextInterval();
    expect(producer.emit()).toBe(true);
  });

  test('closing one of two viewers holding a frame does not ack it early (N-d)', async () => {
    const { producer, hub } = build({ backpressure: true });
    const a = hub.attach(PARAMS);
    const b = hub.attach(PARAMS);
    await hub.settled();
    await a.next();
    await b.next(); // both busy
    nextInterval();
    producer.emit(); // frame 1 in both slots
    a.close();
    // b still holds it undelivered: its take is the ack, not a's leaving.
    expect(producer.acks).toEqual([]);
    expect((await b.next())?.kind).toBe('state'); // a leaving re-announces
    expect(await frameCounter(b)).toBe(1);
    expect(producer.acks).toEqual([1]);
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

describe('live surface hub: H.264 viewers (#4418)', () => {
  /** A producer whose frames the test emits by hand. */
  async function videoHub() {
    let publish!: (header: LiveSurfaceFrameHeader, body: Uint8Array) => void;
    const producer = new SyntheticLiveSurfaceProducer('surface-1', {
      backpressure: false,
    });
    const requestKeyframe = vi.fn();
    const setCodecDemand = vi.fn();
    producer.start = async (_params, onFrame) => {
      publish = onFrame;
    };
    const hub = new LiveSurfaceHub(
      Object.assign(producer, { requestKeyframe, setCodecDemand }),
      new LiveSurfaceControlLeaseState('surface-1'),
      { heartbeatMs: 60_000 },
    );
    let seq = 0;
    const unit = (keyframe: boolean, tag: number) =>
      publish(
        {
          surfaceId: 'surface-1',
          seq: ++seq,
          epoch: 0,
          codec: 'h264',
          keyframe,
          width: 320,
          height: 200,
          deviceScaleFactor: 1,
          capturedAt: 1,
        },
        new Uint8Array([tag]),
      );
    const jpeg = () =>
      publish(
        {
          surfaceId: 'surface-1',
          seq: ++seq,
          epoch: 0,
          codec: 'jpeg',
          width: 320,
          height: 200,
          deviceScaleFactor: 1,
          capturedAt: 1,
        },
        new Uint8Array([0xff]),
      );
    return { hub, unit, jpeg, requestKeyframe, setCodecDemand };
  }

  async function tagOf(viewer: LiveSurfaceViewer): Promise<number | string> {
    const record = await viewer.next();
    if (record?.kind !== 'frame') return `not a frame: ${record?.kind}`;
    return record.header.codec === 'h264'
      ? record.body[0]!
      : `codec ${record.header.codec}`;
  }

  test('delivers units in order, never a delta before the first keyframe', async () => {
    const { hub, unit } = await videoHub();
    const viewer = hub.attach(PARAMS, undefined, 'h264');
    await hub.settled();
    expect((await viewer.next())?.kind).toBe('state');
    unit(false, 1);
    unit(false, 2);
    unit(true, 3);
    unit(false, 4);
    unit(false, 5);
    expect(await tagOf(viewer)).toBe(3);
    expect(await tagOf(viewer)).toBe(4);
    expect(await tagOf(viewer)).toBe(5);
    viewer.close();
    await hub.dispose();
  });

  test('overflow drops the queue, asks for a keyframe and resumes only at one', async () => {
    const { hub, unit, requestKeyframe } = await videoHub();
    const viewer = hub.attach(PARAMS, undefined, 'h264');
    await hub.settled();
    await viewer.next();
    requestKeyframe.mockClear();
    unit(true, 1);
    // The viewer is not reading: fill its queue, then one more.
    for (let i = 0; i < H264_QUEUE_MAX_UNITS; i++) unit(false, 2);
    expect(requestKeyframe).toHaveBeenCalledTimes(1);
    // Deltas after the overflow are undecodable without the dropped base:
    // the first record the viewer gets is the next keyframe.
    unit(false, 3);
    unit(false, 4);
    unit(true, 5);
    unit(false, 6);
    expect(await tagOf(viewer)).toBe(5);
    expect(await tagOf(viewer)).toBe(6);
    viewer.close();
    await hub.dispose();
  });

  test('keyframe requests reach the encoder at most once per interval, and a suppressed one is deferred, not dropped', async () => {
    const { hub, unit, requestKeyframe } = await videoHub();
    const viewers = [0, 1, 2].map(() => hub.attach(PARAMS, undefined, 'h264'));
    await hub.settled();
    vi.advanceTimersByTime(KEYFRAME_REQUEST_MIN_INTERVAL_MS);
    requestKeyframe.mockClear();
    // All three overflow on the same unit: one request, not three.
    unit(true, 1);
    for (let i = 0; i < H264_QUEUE_MAX_UNITS; i++) unit(false, 2);
    expect(requestKeyframe).toHaveBeenCalledTimes(1);
    // Inside the window: held back, then sent once when it opens.
    unit(true, 3);
    for (let i = 0; i < H264_QUEUE_MAX_UNITS; i++) unit(false, 4);
    expect(requestKeyframe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(KEYFRAME_REQUEST_MIN_INTERVAL_MS - 1);
    expect(requestKeyframe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(requestKeyframe).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(KEYFRAME_REQUEST_MIN_INTERVAL_MS * 4);
    expect(requestKeyframe).toHaveBeenCalledTimes(2);
    for (const viewer of viewers) viewer.close();
    await hub.dispose();
  });

  test('a second viewer joining inside the window still gets its keyframe request', async () => {
    const { hub, requestKeyframe } = await videoHub();
    const first = hub.attach(PARAMS, undefined, 'h264');
    await hub.settled();
    vi.advanceTimersByTime(KEYFRAME_REQUEST_MIN_INTERVAL_MS);
    requestKeyframe.mockClear();
    const second = hub.attach(PARAMS, undefined, 'h264');
    await hub.settled();
    expect(requestKeyframe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    const third = hub.attach(PARAMS, undefined, 'h264');
    await hub.settled();
    expect(requestKeyframe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(KEYFRAME_REQUEST_MIN_INTERVAL_MS);
    expect(requestKeyframe).toHaveBeenCalledTimes(2);
    for (const viewer of [first, second, third]) viewer.close();
    await hub.dispose();
  });

  test('a viewer that keeps overflowing is switched to images and stops asking for keyframes', async () => {
    const { hub, unit, jpeg, requestKeyframe, setCodecDemand } =
      await videoHub();
    const viewer = hub.attach(PARAMS, undefined, 'h264');
    await hub.settled();
    await viewer.next();
    requestKeyframe.mockClear();
    const overflow = () => {
      unit(true, 1);
      for (let i = 0; i < H264_QUEUE_MAX_UNITS; i++) unit(false, 2);
      // Past the hub-wide rate window, so each request is sent at once.
      vi.advanceTimersByTime(600);
    };
    for (let i = 0; i < H264_FALLBACK_OVERFLOWS; i++) overflow();
    // Two overflows asked for keyframes; the third switched to images.
    expect(requestKeyframe).toHaveBeenCalledTimes(H264_FALLBACK_OVERFLOWS - 1);
    expect(setCodecDemand).toHaveBeenLastCalledWith({
      image: true,
      h264: false,
    });
    expect((await viewer.next())?.kind).toBe('state');
    const next = tagOf(viewer);
    unit(true, 9);
    vi.advanceTimersByTime(1_000);
    jpeg();
    expect(await next).toBe('codec jpeg');
    overflow();
    expect(requestKeyframe).toHaveBeenCalledTimes(H264_FALLBACK_OVERFLOWS - 1);
    viewer.close();
    await hub.dispose();
  });

  test('overflows spread wider than the window keep the viewer on H.264', async () => {
    const { hub, unit, setCodecDemand } = await videoHub();
    const viewer = hub.attach(PARAMS, undefined, 'h264');
    await hub.settled();
    await viewer.next();
    for (let round = 0; round < H264_FALLBACK_OVERFLOWS + 1; round++) {
      unit(true, 1);
      for (let i = 0; i < H264_QUEUE_MAX_UNITS; i++) unit(false, 2);
      vi.advanceTimersByTime(H264_FALLBACK_WINDOW_MS / 2 + 1);
    }
    expect(setCodecDemand).toHaveBeenLastCalledWith({
      image: false,
      h264: true,
    });
    viewer.close();
    await hub.dispose();
  });

  test('a keyframe larger than the whole queue bound sends that viewer to images at once', async () => {
    const { hub, setCodecDemand, requestKeyframe } = await videoHub();
    let publish!: (header: LiveSurfaceFrameHeader, body: Uint8Array) => void;
    (hub.producer as SyntheticLiveSurfaceProducer).start = async (_p, f) => {
      publish = f;
    };
    const viewer = hub.attach(PARAMS, undefined, 'h264');
    await hub.settled();
    await viewer.next();
    requestKeyframe.mockClear();
    publish(
      {
        surfaceId: 'surface-1',
        seq: 1,
        epoch: 0,
        codec: 'h264',
        keyframe: true,
        width: 320,
        height: 200,
        deviceScaleFactor: 1,
        capturedAt: 1,
      },
      new Uint8Array(4 * 1024 * 1024 + 1),
    );
    expect(requestKeyframe).not.toHaveBeenCalled();
    expect(setCodecDemand).toHaveBeenLastCalledWith({
      image: true,
      h264: false,
    });
    viewer.close();
    await hub.dispose();
  });

  test('keeps image and H.264 viewers apart and reports their demand', async () => {
    const { hub, unit, jpeg, setCodecDemand, requestKeyframe } =
      await videoHub();
    const image = hub.attach(PARAMS);
    await hub.settled();
    expect(setCodecDemand).toHaveBeenLastCalledWith({
      image: true,
      h264: false,
    });
    await image.next();
    const video = hub.attach(PARAMS, undefined, 'h264');
    await hub.settled();
    // Joining a running stream asks for a decoding point at once.
    expect(requestKeyframe).toHaveBeenCalled();
    expect(setCodecDemand).toHaveBeenLastCalledWith({
      image: true,
      h264: true,
    });
    await video.next();
    await image.next();
    // Each viewer's next record is the first of its own codec: the image
    // viewer skips the access unit, the H.264 viewer skips the JPEG.
    const imageNext = tagOf(image);
    unit(true, 7);
    vi.advanceTimersByTime(1_000);
    jpeg();
    expect(await imageNext).toBe('codec jpeg');
    expect(await tagOf(video)).toBe(7);
    const videoNext = tagOf(video);
    vi.advanceTimersByTime(1_000);
    jpeg();
    unit(false, 8);
    expect(await videoNext).toBe(8);
    image.close();
    expect(setCodecDemand).toHaveBeenLastCalledWith({
      image: false,
      h264: true,
    });
    video.close();
    await hub.dispose();
  });
});
