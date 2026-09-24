import { EventEmitter } from 'node:events';
import type {
  LiveSurfaceFrameHeader,
  LiveSurfaceStreamParams,
} from '@kontourai/station-contracts/live-surface';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  dispatchHumanInput,
  LiveSurfaceRegistry,
} from '../../live-surface/registry.js';
import type { DeviceHostActions } from '../device-host-tools.js';
import type { DeviceHubAccessConnection } from '../device-hub-endpoint.js';
import {
  type DeviceHubAccess,
  DeviceInputError,
  DeviceLiveSurfaceProducer,
  type DeviceLiveSurfaceProducerOptions,
  type DeviceSocket,
} from '../device-live-surface-producer.js';
import type {
  DeviceVideoDecoderCallbacks,
  DeviceVideoDecoderProvider,
} from '../h264-jpeg-decoder.js';

const ORIGIN = 'http://127.0.0.1:43871';
const IOS_UDID = '6E8C08FA-3A81-4347-90B9-AD41B7FAE876';
const PARAMS: LiveSurfaceStreamParams = {
  maxFps: 10,
  quality: 70,
  maxWidth: 1280,
  maxHeight: 1280,
};
const PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDWQAAAAASUVORK5CYII=',
    'base64',
  ),
);

function jpeg(width: number, height: number, fill = 1): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
    0xff,
    0xda,
    0x00,
    0x08,
    0x01,
    0x01,
    0x00,
    0x00,
    0x3f,
    0x00,
    fill,
    fill,
    0xff,
    0xd9,
  ]);
}

/** A fake hub socket: records what was sent, and lets a test drive events. */
class FakeSocket extends EventEmitter implements DeviceSocket {
  readyState = 0;
  sent: (string | Uint8Array)[] = [];
  /** When false, `send` never calls back (a hung socket). */
  acks = true;
  constructor(readonly url: string) {
    super();
  }
  send(data: string | Uint8Array, callback: (error?: Error) => void): void {
    this.sent.push(data);
    if (this.acks) queueMicrotask(() => callback());
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
  opened(): void {
    this.readyState = 1;
    this.emit('open');
  }
  /** Decoded packets: iOS `[tag, json]`, Android parsed JSON. */
  packets(): unknown[] {
    return this.sent.map((data) =>
      typeof data === 'string'
        ? JSON.parse(data)
        : [data[0], JSON.parse(new TextDecoder().decode(data.subarray(1)))],
    );
  }
}

interface Harness {
  producer: DeviceLiveSurfaceProducer;
  sockets: FakeSocket[];
  frames: { header: LiveSurfaceFrameHeader; body: Uint8Array }[];
  mjpeg: ReadableStreamDefaultController<Uint8Array> | null;
  screenshots: number;
}

const boundary = 'frame';
/** What the helper replays on connect: its last buffered, possibly stale, frame. */
const REPLAYED = jpeg(11, 22, 99);
const enc = new TextEncoder();
function part(body: Uint8Array): Uint8Array {
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${body.length}\r\n\r\n`,
  );
  const out = new Uint8Array(head.length + body.length + 2);
  out.set(head);
  out.set(body, head.length);
  out.set([13, 10], head.length + body.length);
  return out;
}

function harness(
  overrides: Partial<DeviceLiveSurfaceProducerOptions> = {},
): Harness {
  const h: Harness = {
    producer: null as unknown as DeviceLiveSurfaceProducer,
    sockets: [],
    frames: [],
    mjpeg: null,
    screenshots: 0,
  };
  const request = vi.fn(async (_method: string, path: string) => {
    if (path.endsWith('/stream.mjpeg')) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          // The helper answers at once with the frame it last buffered (a
          // stale replay the producer must drop), then streams captures.
          controller.enqueue(part(REPLAYED));
          h.mjpeg = controller;
        },
      });
      return new Response(body, {
        headers: {
          'content-type': `multipart/x-mixed-replace; boundary=${boundary}`,
        },
      });
    }
    throw new Error(`unexpected request ${path}`);
  });
  const connection = {
    baseUrl: ORIGIN,
    request,
    openWebSocket: (path: string) => {
      const socket = new FakeSocket(path);
      h.sockets.push(socket);
      return socket as never;
    },
  } as unknown as DeviceHubAccessConnection;
  const hub: DeviceHubAccess = {
    connect: async () => ({ ok: true, connection }),
    screenshot: async () => {
      h.screenshots += 1;
      return { png: PNG, width: 1, height: 1 };
    },
  };
  h.producer = new DeviceLiveSurfaceProducer({
    surfaceId: 'device:ios:test',
    platform: 'ios',
    deviceId: IOS_UDID,
    hub,
    dispatchTimeoutMs: 200,
    reconnectDelaysMs: [5],
    snapshotPollIntervalMs: 5,
    ...overrides,
  });
  return h;
}

const producers: DeviceLiveSurfaceProducer[] = [];
function track(h: Harness): Harness {
  producers.push(h.producer);
  return h;
}
afterEach(async () => {
  for (const producer of producers.splice(0)) await producer.dispose();
  vi.useRealTimers();
});

async function until(check: () => boolean, label = 'condition') {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function openInput(h: Harness): Promise<FakeSocket> {
  h.producer.open();
  await until(() => h.sockets.length > 0, 'input socket');
  const socket = h.sockets[0]!;
  socket.opened();
  return socket;
}

describe('iOS video: MJPEG parts as jpeg frames', () => {
  test('the frame the helper replays on connect is never published as current', async () => {
    const h = track(harness());
    await h.producer.start(PARAMS, (header, body) =>
      h.frames.push({ header, body }),
    );
    await until(() => h.mjpeg !== null, 'mjpeg stream');
    // Only the replay so far: nothing may reach a viewer.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.frames).toHaveLength(0);
    const fresh = jpeg(390, 844, 7);
    h.mjpeg!.enqueue(part(fresh));
    await until(() => h.frames.length === 1, 'first fresh frame');
    expect(h.frames[0]!.body).toEqual(fresh);
    // A restart from idle reconnects, and its replay is dropped again.
    await h.producer.stop();
    h.mjpeg = null;
    await h.producer.start(PARAMS, (header, body) =>
      h.frames.push({ header, body }),
    );
    await until(() => h.mjpeg !== null, 'second mjpeg stream');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.frames).toHaveLength(1);
    h.mjpeg!.enqueue(part(jpeg(390, 844, 8)));
    await until(() => h.frames.length === 2, 'fresh frame after restart');
    expect(
      h.frames.some(
        (frame) =>
          frame.body.length === REPLAYED.length &&
          frame.body.every((b, i) => b === REPLAYED[i]),
      ),
    ).toBe(false);
  });

  test('each part becomes a jpeg frame carrying its own size', async () => {
    const h = track(harness());
    await h.producer.start(PARAMS, (header, body) =>
      h.frames.push({ header, body }),
    );
    await until(() => h.mjpeg !== null, 'mjpeg stream');
    const frame = jpeg(390, 844);
    h.mjpeg!.enqueue(part(frame));
    await until(() => h.frames.length === 1, 'first frame');
    expect(h.frames[0]!.header).toMatchObject({
      surfaceId: 'device:ios:test',
      codec: 'jpeg',
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
    });
    expect(h.frames[0]!.body).toEqual(frame);
  });

  /**
   * Latest frame wins: while a frame is unacked, newer parts REPLACE the one
   * held, and the ack publishes the newest — never a queue.
   */
  test('unacked: parts are dropped for the newest, which the ack publishes', async () => {
    const h = track(harness());
    await h.producer.start(PARAMS, (header, body) =>
      h.frames.push({ header, body }),
    );
    await until(() => h.mjpeg !== null, 'mjpeg stream');
    h.mjpeg!.enqueue(part(jpeg(10, 20, 1)));
    await until(() => h.frames.length === 1, 'first frame');
    h.mjpeg!.enqueue(part(jpeg(10, 20, 2)));
    h.mjpeg!.enqueue(part(jpeg(10, 20, 3)));
    // Let the parser run; nothing may be published before the ack.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.frames).toHaveLength(1);
    h.producer.ack(h.frames[0]!.header.seq);
    expect(h.frames).toHaveLength(2);
    expect(h.frames[1]!.body).toEqual(jpeg(10, 20, 3));
    expect(h.frames[1]!.header.seq).toBeGreaterThan(h.frames[0]!.header.seq);
  });
});

describe('input', () => {
  test('pointer down/move/up become a touch in the frame unit square', async () => {
    const h = track(harness());
    const socket = await openInput(h);
    await h.producer.start(PARAMS, (header, body) =>
      h.frames.push({ header, body }),
    );
    await until(() => h.mjpeg !== null, 'mjpeg stream');
    h.mjpeg!.enqueue(part(jpeg(400, 800)));
    await until(() => h.frames.length === 1, 'frame');
    await h.producer.dispatch({
      kind: 'pointer',
      type: 'down',
      x: 100,
      y: 200,
      button: 'left',
    });
    await h.producer.dispatch({
      kind: 'pointer',
      type: 'move',
      x: 200,
      y: 400,
    });
    await h.producer.dispatch({
      kind: 'pointer',
      type: 'up',
      x: 200,
      y: 400,
      button: 'left',
    });
    // First packet is the hardware-keyboard toggle sent on open.
    expect(socket.packets().slice(1)).toEqual([
      [0x03, { type: 'begin', x: 0.25, y: 0.25 }],
      [0x03, { type: 'move', x: 0.5, y: 0.5 }],
      [0x03, { type: 'end', x: 0.5, y: 0.5 }],
    ]);
  });

  test('a device held sideways turns the frame, and input maps back to raw', async () => {
    const h = track(harness());
    const socket = await openInput(h);
    const config = { width: 400, height: 800, orientation: 'landscape_left' };
    const json = enc.encode(JSON.stringify(config));
    const message = new Uint8Array(1 + json.length);
    message[0] = 0x82;
    message.set(json, 1);
    socket.emit('message', Buffer.from(message), true);
    expect(h.producer.status().orientation).toBe('landscape-left');
    await h.producer.start(PARAMS, (header, body) =>
      h.frames.push({ header, body }),
    );
    await until(() => h.mjpeg !== null, 'mjpeg stream');
    h.mjpeg!.enqueue(part(jpeg(400, 800)));
    await until(() => h.frames.length === 1, 'frame');
    expect(h.frames[0]!.header.rotation).toBe(90);
    // Shown frame is 800x400; (200,100) on it is raw (0.25, 0.75).
    await h.producer.dispatch({
      kind: 'pointer',
      type: 'down',
      x: 200,
      y: 100,
      button: 'left',
    });
    expect(socket.packets().at(-1)).toEqual([
      0x03,
      { type: 'begin', x: 0.25, y: 0.75 },
    ]);
  });

  test('hardware buttons go out by their whitelisted names; others are refused unsent', async () => {
    const h = track(harness());
    const socket = await openInput(h);
    await h.producer.dispatch({ kind: 'device-button', button: 'home' });
    await h.producer.dispatch({ kind: 'device-button', button: 'power' });
    await expect(
      h.producer.dispatch({ kind: 'device-button', button: 'back' }),
    ).rejects.toMatchObject({ code: 'button-unsupported' });
    await expect(
      h.producer.dispatch({
        kind: 'device-button',
        button: 'reboot' as 'home',
      }),
    ).rejects.toBeInstanceOf(DeviceInputError);
    expect(socket.packets().slice(1)).toEqual([
      [0x04, { button: 'home' }],
      [0x04, { button: 'lock' }],
    ]);
  });

  test('rotate on iOS asks the helper for the orientation', async () => {
    const h = track(harness());
    const socket = await openInput(h);
    await h.producer.dispatch({
      kind: 'rotate',
      orientation: 'landscape-right',
    });
    expect(socket.packets().at(-1)).toEqual([
      0x07,
      { orientation: 'landscape_right' },
    ]);
  });

  /**
   * Each dispatch has its own deadline. A socket that never confirms a send
   * must fail the dispatch well inside the registry's wedge timeout.
   */
  test('a send that never completes fails the dispatch at its own bound', async () => {
    const h = track(harness({ dispatchTimeoutMs: 40 }));
    const socket = await openInput(h);
    socket.acks = false;
    const started = Date.now();
    await expect(
      h.producer.dispatch({ kind: 'device-button', button: 'home' }),
    ).rejects.toMatchObject({ code: 'dispatch-timeout' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('with the input channel down, input is refused at once and the state says so', async () => {
    const h = track(harness({ downAfterFailures: 2 }));
    const changes = vi.fn();
    h.producer.onStatusChange(changes);
    const socket = await openInput(h);
    expect(h.producer.status().inputChannel).toBe('connected');
    socket.close();
    expect(h.producer.status().inputChannel).toBe('reconnecting');
    await expect(
      h.producer.dispatch({ kind: 'device-button', button: 'home' }),
    ).rejects.toMatchObject({ code: 'input-channel-down' });
    await until(() => h.sockets.length > 1, 'reconnect');
    h.sockets[1]!.close();
    expect(h.producer.status().inputChannel).toBe('down');
    expect(changes).toHaveBeenCalled();
  });

  /**
   * The hub socket is not lease-fenced: a multi-send event must stop at the
   * next send once control changes hands, not finish typing.
   */
  test('a typed string stops at the next keystroke once the fence moves', async () => {
    const h = track(harness());
    const socket = await openInput(h);
    let current = true;
    const sentBefore = socket.sent.length;
    const typing = h.producer.dispatch(
      { kind: 'text', text: 'abc' },
      {
        isCurrent: () => {
          const answer = current;
          // Control changes hands right after the first keystroke is fenced.
          current = false;
          return answer;
        },
      },
    );
    await expect(typing).rejects.toMatchObject({ code: 'interrupted' });
    const keystrokes = socket.packets().slice(sentBefore);
    // Exactly one whole keystroke ('a' down + up), never a held key.
    expect(keystrokes).toEqual([
      [0x06, { type: 'down', usage: 0x04 }],
      [0x06, { type: 'up', usage: 0x04 }],
    ]);
  });

  test('a single send is refused when the fence has already moved', async () => {
    const h = track(harness());
    const socket = await openInput(h);
    const sentBefore = socket.sent.length;
    await expect(
      h.producer.dispatch(
        { kind: 'device-button', button: 'home' },
        { isCurrent: () => false },
      ),
    ).rejects.toMatchObject({ code: 'interrupted' });
    expect(socket.sent.length).toBe(sentBefore);
  });

  test('a cancel slides the held touch along the nearest edge and lifts, never where it was pressed', async () => {
    const h = track(harness());
    const socket = await openInput(h);
    await h.producer.start(PARAMS, (header, body) =>
      h.frames.push({ header, body }),
    );
    await until(() => h.mjpeg !== null, 'mjpeg stream');
    h.mjpeg!.enqueue(part(jpeg(100, 100)));
    await until(() => h.frames.length === 1, 'frame');
    const before = socket.sent.length;
    // A raw client's press: no `button` at all (S1). Near the LEFT edge.
    await h.producer.dispatch({ kind: 'pointer', type: 'down', x: 2, y: 50 });
    await h.producer.cancelHeldInput({
      buttons: ['left'],
      keys: [],
      pointer: { x: 2, y: 50 },
      pointerType: 'touch',
      buttonPointerTypes: {},
    });
    const packets = socket.packets().slice(before) as [
      number,
      { type: string; x: number; y: number },
    ][];
    expect(packets[0]).toEqual([0x03, { type: 'begin', x: 0.02, y: 0.5 }]);
    const moves = packets.filter(([, p]) => p.type === 'move');
    const end = packets.at(-1)![1];
    expect(moves.length).toBeGreaterThan(1);
    expect(end.type).toBe('end');
    // Parallel to the left edge: x never changes; y moved past tap slop.
    for (const [, p] of [...moves, [0, end] as const]) expect(p.x).toBe(0.02);
    expect(Math.abs(end.y - 0.5)).toBeGreaterThanOrEqual(0.05);
  });

  test('a device that stopped ends the producer', async () => {
    const onEnded = vi.fn();
    const h = track(harness({ isDeviceRunning: async () => false, onEnded }));
    const socket = await openInput(h);
    socket.close();
    await until(() => onEnded.mock.calls.length > 0, 'ended');
    expect(onEnded).toHaveBeenCalledWith('device-stopped');
    expect(h.producer.status().inputChannel).toBe('down');
  });
});

describe('Android', () => {
  function semu(key: boolean, nal: number): Buffer {
    const out = Buffer.alloc(24 + 5);
    out.writeUInt32BE(0x53454d55, 0);
    out.writeUInt8(2, 4);
    out.writeUInt8(key ? 1 : 0, 5);
    out.set([0, 0, 0, 1, nal], 24);
    return out;
  }
  /** A config-only unit (SPS + PPS), as the first half of a keyframe reply. */
  function semuConfig(): Buffer {
    const out = Buffer.alloc(24 + 10);
    out.writeUInt32BE(0x53454d55, 0);
    out.writeUInt8(2, 4);
    out.writeUInt8(0, 5);
    out.set([0, 0, 0, 1, 0x67, 0, 0, 0, 1, 0x68], 24);
    return out;
  }

  function fakeDecoder() {
    const writes: Uint8Array[] = [];
    const state = { dropping: false };
    let callbacks: DeviceVideoDecoderCallbacks | null = null;
    const provider: DeviceVideoDecoderProvider = {
      availability: async () => ({ available: true, path: '/usr/bin/ffmpeg' }),
      create: (_path, _params, cb) => {
        callbacks = cb;
        return {
          write: (unit) => {
            if (state.dropping) return false;
            writes.push(unit);
            return true;
          },
          close: async () => {},
        };
      },
    };
    return {
      provider,
      writes,
      state,
      emit: (image: Uint8Array) => callbacks?.onImage(image),
      exit: (reason: string) => callbacks?.onExit(reason),
    };
  }

  function android(overrides: Partial<DeviceLiveSurfaceProducerOptions> = {}) {
    return track(
      harness({
        surfaceId: 'device:android:test',
        platform: 'android',
        deviceId: 'emulator-5554',
        ...overrides,
      }),
    );
  }

  test('SEMU H.264 feeds the decoder from the first keyframe; its JPEGs are frames', async () => {
    const decoder = fakeDecoder();
    const h = android({ decoder: decoder.provider });
    await h.producer.start(PARAMS, (header, body) =>
      h.frames.push({ header, body }),
    );
    await until(() => h.sockets.length === 1, 'video socket');
    const video = h.sockets[0]!;
    expect(video.url).toContain('/vendor/serve-emu/ws?device=emulator-5554');
    expect(video.url).toContain('frame-meta=1');
    video.opened();
    expect(video.packets()).toEqual([{ type: 'reset-video', ack: false }]);
    video.emit('message', semu(false, 0x41), true);
    expect(decoder.writes).toHaveLength(0);
    video.emit('message', semu(true, 0x65), true);
    video.emit('message', semu(false, 0x41), true);
    expect(decoder.writes).toHaveLength(2);
    decoder.emit(jpeg(540, 1200));
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]!.header).toMatchObject({
      codec: 'jpeg',
      width: 540,
      height: 1200,
    });
    expect(h.producer.status()).toMatchObject({ videoMode: 'live' });
  });

  const resets = (socket: FakeSocket) =>
    socket
      .packets()
      .filter((packet) => (packet as { type?: string }).type === 'reset-video')
      .length;

  test('a still screen gets a keyframe after the idle interval, a bounded number of times (S3)', async () => {
    const decoder = fakeDecoder();
    const h = android({ decoder: decoder.provider, keyframeIdleMs: 20 });
    await h.producer.start(PARAMS, () => {});
    await until(() => h.sockets.length === 1, 'video socket');
    const video = h.sockets[0]!;
    video.opened();
    expect(resets(video)).toBe(1); // the opening keyframe request
    video.emit('message', semu(true, 0x65), true);
    // A still screen: the encoder sends a unit ONLY when asked. Each idle
    // request is answered; the requests stop after 3.
    let answered = resets(video);
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (resets(video) > answered) {
        answered = resets(video);
        video.emit('message', semu(true, 0x65), true);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(resets(video)).toBe(1 + 3);
  });

  test('a keyframe reply split in two units (SPS/PPS, then IDR) still caps the idle requests (D1)', async () => {
    const decoder = fakeDecoder();
    const h = android({ decoder: decoder.provider, keyframeIdleMs: 20 });
    await h.producer.start(PARAMS, () => {});
    await until(() => h.sockets.length === 1, 'video socket');
    const video = h.sockets[0]!;
    video.opened();
    video.emit('message', semu(true, 0x65), true);
    let answered = resets(video);
    for (let i = 0; i < 12; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (resets(video) > answered) {
        answered = resets(video);
        // The encoder answers with TWO units: parameter sets, then the IDR.
        video.emit('message', semuConfig(), true);
        video.emit('message', semu(true, 0x65), true);
      }
    }
    expect(resets(video)).toBe(1 + 3);
  });

  test('a changed screen (a content slice) starts a new idle budget', async () => {
    const decoder = fakeDecoder();
    const h = android({ decoder: decoder.provider, keyframeIdleMs: 20 });
    await h.producer.start(PARAMS, () => {});
    await until(() => h.sockets.length === 1, 'video socket');
    const video = h.sockets[0]!;
    video.opened();
    video.emit('message', semu(true, 0x65), true);
    let answered = resets(video);
    const answer = async (rounds: number) => {
      for (let i = 0; i < rounds; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (resets(video) > answered) {
          answered = resets(video);
          video.emit('message', semu(true, 0x65), true);
        }
      }
    };
    await answer(6);
    expect(resets(video)).toBe(4);
    video.emit('message', semu(false, 0x41), true); // the screen changed
    await answer(6);
    expect(resets(video)).toBe(7);
  });

  test('a unit the decoder dropped makes it wait for, and ask for, a keyframe (S3)', async () => {
    const decoder = fakeDecoder();
    const h = android({ decoder: decoder.provider, keyframeIdleMs: 60_000 });
    await h.producer.start(PARAMS, () => {});
    await until(() => h.sockets.length === 1, 'video socket');
    const video = h.sockets[0]!;
    video.opened();
    video.emit('message', semu(true, 0x65), true);
    decoder.state.dropping = true;
    video.emit('message', semu(false, 0x41), true);
    expect(resets(video)).toBe(2);
    decoder.state.dropping = false;
    // Deltas after a drop are not fed until the keyframe arrives.
    video.emit('message', semu(false, 0x41), true);
    expect(decoder.writes).toHaveLength(1);
    video.emit('message', semu(true, 0x65), true);
    expect(decoder.writes).toHaveLength(2);
  });

  test('a decoder that ran stably before dying is restarted, not given up on', async () => {
    const decoder = fakeDecoder();
    const h = android({ decoder: decoder.provider, decoderStableMs: 0 });
    await h.producer.start(PARAMS, () => {});
    decoder.exit('crash after a long run');
    await until(() => h.sockets.length >= 2, 'first restart');
    decoder.exit('another crash after a long run');
    await until(() => h.sockets.length >= 3, 'second restart');
    expect(h.producer.status()).toMatchObject({ videoMode: 'live' });
  });

  test('no decoder: polled screenshots, reported as snapshot-poll', async () => {
    const h = android({
      decoder: {
        availability: async () => ({
          available: false,
          reason: 'decoder-unavailable',
          remedy: 'install-ffmpeg-or-consent-to-pinned-download',
        }),
        create: () => {
          throw new Error('must not be created');
        },
      },
    });
    await h.producer.start(PARAMS, (header, body) => {
      h.frames.push({ header, body });
      h.producer.ack(header.seq);
    });
    await until(() => h.frames.length >= 2, 'polled frames');
    expect(h.frames[0]!.header.codec).toBe('png');
    expect(h.producer.status()).toMatchObject({
      videoMode: 'snapshot-poll',
      videoDegradedReason: 'decoder-unavailable',
    });
  });

  test('a decoder that dies twice falls back to snapshot-poll as decoder-failed', async () => {
    const decoder = fakeDecoder();
    const h = android({ decoder: decoder.provider });
    await h.producer.start(PARAMS, (header, body) => {
      h.frames.push({ header, body });
      h.producer.ack(header.seq);
    });
    decoder.exit('crash 1');
    await until(() => h.sockets.length >= 2, 'restart');
    decoder.exit('crash 2');
    await until(() => h.frames.length >= 1, 'polled frame');
    expect(h.producer.status()).toMatchObject({
      videoMode: 'snapshot-poll',
      videoDegradedReason: 'decoder-failed',
    });
  });

  test('buttons and text use the serve-emu vocabulary; rotation runs the typed action', async () => {
    const rotateAndroid = vi.fn<DeviceHostActions['rotateAndroid']>(
      async () => {},
    );
    const h = android({ actions: { rotateAndroid } });
    const socket = await openInput(h);
    expect(socket.url).toContain('video=0');
    await h.producer.dispatch({ kind: 'device-button', button: 'back' });
    await h.producer.dispatch({ kind: 'text', text: 'hi' });
    await h.producer.dispatch({
      kind: 'rotate',
      orientation: 'landscape-left',
    });
    expect(socket.packets()).toEqual([
      { type: 'back', ack: false },
      { type: 'text', text: 'hi', ack: false },
    ]);
    expect(rotateAndroid).toHaveBeenCalledWith(
      'emulator-5554',
      'landscape-left',
      200,
    );
  });
});

describe('through the live-surface registry', () => {
  test('viewers see the input channel in the state record', async () => {
    const h = track(harness());
    const registry = new LiveSurfaceRegistry();
    registry.register(h.producer, { authorize: () => true });
    const entry = registry.get('device:ios:test')!;
    const viewer = entry.hub.attach(PARAMS);
    const first = await viewer.next();
    expect(first).toMatchObject({
      kind: 'state',
      state: {
        inputChannel: 'reconnecting',
        videoMode: 'live',
        hostId: 'local',
      },
    });
    await openInput(h);
    const next = await viewer.next();
    expect(next).toMatchObject({
      kind: 'state',
      state: { inputChannel: 'connected' },
    });
    viewer.close();
    await registry.dispose();
  });

  test('an unsupported button is a refused dispatch, not a crash', async () => {
    const h = track(harness());
    await openInput(h);
    const registry = new LiveSurfaceRegistry();
    registry.register(h.producer, { authorize: () => true });
    const entry = registry.get('device:ios:test')!;
    const result = await dispatchHumanInput(
      entry,
      { kind: 'human', principal: 'operator', device: 'd1' },
      0,
      [{ kind: 'device-button', button: 'back' }],
    );
    expect(result).toMatchObject({ ok: false, code: 'dispatch-failed' });
    await registry.dispose();
  });
});
