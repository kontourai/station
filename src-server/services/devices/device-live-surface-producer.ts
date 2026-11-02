import {
  type LiveSurfaceCodec,
  type LiveSurfaceFrameHeader,
  type LiveSurfaceFrameRotation,
  type LiveSurfaceH264Sequence,
  type LiveSurfaceInput,
  type LiveSurfaceInputChannelState,
  type LiveSurfaceOrientation,
  type LiveSurfaceProducerStatus,
  type LiveSurfaceStreamParams,
  type LiveSurfaceVideoDegradedReason,
  type LiveSurfaceVideoMode,
  parseLiveSurfaceH264Sequence,
  splitAnnexB,
} from '@kontourai/station-contracts/live-surface';
import type { MobileDevicePlatform } from '@kontourai/station-contracts/mobile-device';
import { jpegSize } from '../live-surface/jpeg-size.js';
import type {
  LiveSurfaceCodecDemand,
  LiveSurfaceDispatchContext,
  LiveSurfaceHeldInput,
  LiveSurfaceProducer,
} from '../live-surface/producer.js';
import {
  annexBNalTypes,
  MjpegMultipartParser,
  multipartBoundary,
  parseSemuPacket,
} from './device-frame-codecs.js';
import type { DeviceHostActions } from './device-host-tools.js';
import type {
  DeviceHubAccessConnection,
  DeviceHubConnectResult,
} from './device-hub-endpoint.js';
import {
  androidKeycodeForKey,
  cancelSlidePath,
  deviceButtonCommand,
  frameRotationFor,
  fromIosOrientation,
  HID_SHIFT,
  hidStrokeForCharacter,
  hidUsageForCode,
  IOS_MSG_BUTTON,
  IOS_MSG_HARDWARE_KEYBOARD,
  IOS_MSG_KEY,
  IOS_MSG_ORIENTATION,
  IOS_MSG_TOUCH,
  IOS_TAG_SCREEN_CONFIG,
  iosPacket,
  surfacePointToRawUnit,
  toIosOrientation,
  type UnitPoint,
} from './device-input-mapping.js';
import type {
  DeviceVideoDecoder,
  DeviceVideoDecoderProvider,
} from './h264-jpeg-decoder.js';

/**
 * A live-surface producer for ONE simulator or emulator (#1970, D8): the
 * device's screen as frames, and pointer/key/text/hardware-button/rotation
 * input into it, through the device hub.
 *
 * VIDEO and INPUT are separate channels, with separate liveness:
 * - Video runs only while viewers watch (`start`/`stop`). iOS: the helper's
 *   MJPEG stream, each part passed through as a `jpeg` frame. Android: the
 *   hub's H.264 (SEMU-framed over a WebSocket). Viewers that decode H.264
 *   themselves (#4418) get the access units as `h264` frames; for image
 *   viewers a supervised ffmpeg decodes them into `jpeg` frames, and runs
 *   only while an image viewer is attached (`setCodecDemand`). With no
 *   decoder, image viewers get polled PNG screenshots at a low rate,
 *   reported as `videoMode: 'snapshot-poll'`; H.264 viewers still get video.
 * - Input has its own socket, opened with the session (`open`) and kept
 *   (reconnecting) for its whole life, so an agent can drive a device nobody
 *   watches (D6). Its state is published as `inputChannel`.
 *
 * Backpressure for images: latest frame wins. While a published image is
 * unacked, newer images REPLACE the one held; on ack the held one is
 * published. H.264 units are published as they arrive and never acked: the
 * hub queues them per viewer, bounded, and resynchronizes on keyframes.
 *
 * The producer contract's REQUIRED items:
 * - Dialogs: device dialogs never block input delivery — the hub's socket
 *   accepts a gesture whatever the device shows — so there is nothing to
 *   answer.
 * - Bounded dispatch: EVERY dispatch (and every held-input cancel) races its
 *   own deadline (`dispatchTimeoutMs`, default 3 s, below the registry's
 *   10 s), so the registry's wedge — which it cannot cancel — is never the
 *   thing that stops a stuck device. "Wedged" therefore does not arise from
 *   this producer in practice. The device's real input failure is its input
 *   channel being DOWN (hub gone, device stopped): dispatch then fails
 *   immediately (`dispatch-failed` at the route), and viewers see
 *   `inputChannel: 'reconnecting' | 'down'` in the state record, so the pane
 *   disables its controls instead of accepting taps that go nowhere.
 * - A dispatch resolves when the hub's socket ACCEPTED the bytes, not when
 *   the device applied them; the hub does not correlate replies to gestures.
 * - Fencing: the hub's sockets are NOT lease-fenced. The registry fences
 *   before each event; inside one event this producer asks the dispatch
 *   context before EVERY send (a typed string is many keystrokes), so a
 *   human who takes control mid-event stops it at the next send
 *   (`interrupted`).
 *
 * Bound agent tools use the same lease and authorizer through
 * DeviceAutomation. Human takeover interrupts their input at the next send.
 *
 * Every hub call goes through the allowlisted connection
 * (`DeviceHubAccessConnection`): `request` for the MJPEG stream and the
 * iOS prime, `openWebSocket` for the input and Android video sockets.
 *
 * Coordinates: surface pixels are the frame's image pixels AS SHOWN — after
 * the viewer turns it by the header's `rotation` — and deviceScaleFactor is
 * 1. They are mapped to the RAW frame's unit square the helpers address.
 */

export class DeviceInputError extends Error {
  constructor(
    readonly code:
      | 'input-channel-down'
      | 'button-unsupported'
      | 'text-unsupported'
      | 'surface-size-unknown'
      | 'dispatch-timeout'
      | 'send-failed'
      | 'interrupted'
      | 'disposed',
    message: string,
  ) {
    super(message);
    this.name = 'DeviceInputError';
  }
}

/** The subset of a `ws` WebSocket this producer uses (tests inject a fake). */
export interface DeviceSocket {
  readonly readyState: number;
  send(data: string | Uint8Array, callback: (error?: Error) => void): void;
  close(): void;
  on(event: 'open', listener: () => void): unknown;
  on(
    event: 'message',
    listener: (
      data: Buffer | ArrayBuffer | Buffer[],
      isBinary: boolean,
    ) => void,
  ): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

const SOCKET_OPEN = 1;

export interface DeviceHubAccess {
  connect(): Promise<DeviceHubConnectResult>;
  screenshot(target: {
    hostId: string;
    platform: MobileDevicePlatform;
    deviceId: string;
  }): Promise<{ png: Uint8Array; width: number; height: number }>;
}

export interface DeviceLiveSurfaceProducerOptions {
  surfaceId: string;
  /** The device host serving this device (D13; `local` today). */
  hostId?: string;
  platform: MobileDevicePlatform;
  deviceId: string;
  hub: DeviceHubAccess;
  /** Android only. Absent: no decoder, so snapshot polling. */
  decoder?: DeviceVideoDecoderProvider;
  actions?: DeviceHostActions;
  /** Each dispatch's own deadline. */
  dispatchTimeoutMs?: number;
  /** Reconnect backoff for the input channel and video. */
  reconnectDelaysMs?: readonly number[];
  /** After this many consecutive input-channel failures it reads `down`. */
  downAfterFailures?: number;
  snapshotPollIntervalMs?: number;
  /**
   * Android: after this long with no new access unit while watched, ask the
   * encoder for a keyframe. A still screen stops sending frames, and the
   * decoder holds its last 1-3 back until more arrive; a keyframe pushes
   * them out. At most `MAX_IDLE_KEYFRAMES` per quiet period.
   */
  keyframeIdleMs?: number;
  /** A decoder that ran this long before dying counts as a fresh failure. */
  decoderStableMs?: number;
  /**
   * Asked when the input channel drops: is the device still running? A
   * `false` ends the producer (`onEnded('device-stopped')`), which is how a
   * device shut down elsewhere closes its session.
   */
  isDeviceRunning?: () => Promise<boolean>;
  onEnded?: (reason: string) => void;
  /** The frame stream started (a viewer attached) or stopped (the last left). */
  onViewing?: (watching: boolean) => void;
  onError?: (message: string, error: unknown) => void;
  now?: () => number;
}

interface PendingFrame {
  codec: LiveSurfaceCodec;
  body: Uint8Array;
  width: number;
  height: number;
}

interface VideoRun {
  generation: number;
  params: LiveSurfaceStreamParams;
  onFrame: (header: LiveSurfaceFrameHeader, body: Uint8Array) => void;
  abort: AbortController;
  timers: Set<ReturnType<typeof setTimeout>>;
  decoder: DeviceVideoDecoder | null;
  socket: DeviceSocket | null;
  android: AndroidVideo | null;
}

/** Android's video paths for one run, reconciled against codec demand. */
interface AndroidVideo {
  provider: DeviceVideoDecoderProvider | null;
  /** The decoder binary, or null when none is available (never started). */
  decoderPath: string | null;
  /** The decoder failed twice in a row: image viewers get polled stills. */
  decoderFailed: boolean;
  decoderRestarts: number;
  /** A decoder restart is scheduled; do not start another meanwhile. */
  decoderRestartPending: boolean;
  /** The decoder needs a keyframe before it can take deltas. */
  decoderAwaitingKey: boolean;
  /** H.264 viewers need a keyframe of the current encoder session. */
  videoAwaitingKey: boolean;
  connecting: boolean;
  polling: boolean;
  /** The last unit carried a non-IDR slice: the screen changed. */
  lastUnitHadContent: boolean;
  requestKeyframe: (() => void) | null;
  /** The latest parameter sets, prepended to an IDR that lacks them. */
  sps: Uint8Array | null;
  pps: Uint8Array | null;
  sequence: LiveSurfaceH264Sequence | null;
}

const ANNEX_B_START = Uint8Array.from([0, 0, 0, 1]);

function withParameterSets(
  unit: Uint8Array,
  sps: Uint8Array,
  pps: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(
    ANNEX_B_START.length * 2 + sps.length + pps.length + unit.length,
  );
  let at = 0;
  for (const part of [ANNEX_B_START, sps, ANNEX_B_START, pps, unit]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Android's ONE coordinate space: the device picture fitted inside the
 * stream's max size, never upscaled, even dimensions. Every Android frame
 * (H.264 unit, ffmpeg JPEG, polled PNG) declares this size in its header,
 * whatever resolution its body is encoded at, and viewers draw it scaled to
 * that box. Input from any viewer is therefore in the same pixels, and maps
 * through `lastFrame` to the same point on the device.
 */
function fittedVideoSize(
  sequence: { width: number; height: number },
  params: Pick<LiveSurfaceStreamParams, 'maxWidth' | 'maxHeight'>,
): { width: number; height: number } {
  const scale = Math.min(
    1,
    params.maxWidth / sequence.width,
    params.maxHeight / sequence.height,
  );
  const even = (value: number) =>
    Math.max(2, Math.floor((value * scale) / 2) * 2);
  return { width: even(sequence.width), height: even(sequence.height) };
}

const DEFAULT_RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];
const MAX_IDLE_KEYFRAMES = 3;

function bytesOf(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export class DeviceLiveSurfaceProducer implements LiveSurfaceProducer {
  readonly surfaceId: string;
  readonly capabilities: {
    codecs: readonly LiveSurfaceCodec[];
    input: readonly LiveSurfaceInput['kind'][];
  };

  private readonly options: DeviceLiveSurfaceProducerOptions;
  private readonly now: () => number;
  private readonly dispatchTimeoutMs: number;
  private readonly reconnectDelays: readonly number[];
  private readonly listeners = new Set<() => void>();

  private disposed = false;
  private ended = false;
  private inputChannel: LiveSurfaceInputChannelState = 'reconnecting';
  private inputSocket: DeviceSocket | null = null;
  private inputGeneration = 0;
  private inputFailures = 0;
  private inputRetry: ReturnType<typeof setTimeout> | null = null;
  private videoMode: LiveSurfaceVideoMode = 'live';
  private videoDegradedReason: LiveSurfaceVideoDegradedReason | undefined;
  private orientation: LiveSurfaceOrientation | undefined;
  /** The iOS helper's screen config (the stream's size), when pushed. */
  private iosScreen: { width: number; height: number } | null = null;
  /** The size and turn of the frame input is aimed at. */
  private lastFrame: {
    width: number;
    height: number;
    rotation: LiveSurfaceFrameRotation;
  } | null = null;
  /** The raw-unit point a touch is held at, or null. */
  private touchDown: UnitPoint | null = null;
  /** Keys pressed and not released (for a cancel). */
  private readonly heldKeys = new Map<string, { key: string; code: string }>();

  private run: VideoRun | null = null;
  private runGeneration = 0;
  private seq = 0;
  private awaitingAck: number | null = null;
  private pending: PendingFrame | null = null;
  /** Until the hub says otherwise, every viewer takes images. */
  private demand: LiveSurfaceCodecDemand = { image: true, h264: false };

  constructor(options: DeviceLiveSurfaceProducerOptions) {
    this.options = options;
    this.surfaceId = options.surfaceId;
    this.capabilities = {
      // Only Android's hub offers H.264; iOS is MJPEG.
      codecs:
        options.platform === 'android'
          ? ['jpeg', 'png', 'h264']
          : ['jpeg', 'png'],
      input: ['pointer', 'key', 'text', 'device-button', 'rotate'],
    };
    this.now = options.now ?? Date.now;
    this.dispatchTimeoutMs = options.dispatchTimeoutMs ?? 3_000;
    this.reconnectDelays =
      options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  }

  // ---- status -------------------------------------------------------------

  status(): LiveSurfaceProducerStatus {
    return {
      hostId: this.options.hostId ?? 'local',
      inputChannel: this.inputChannel,
      videoMode: this.videoMode,
      ...(this.videoDegradedReason
        ? { videoDegradedReason: this.videoDegradedReason }
        : {}),
      ...(this.orientation ? { orientation: this.orientation } : {}),
    };
  }

  onStatusChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.reportError('device status listener failed', error);
      }
    }
  }

  private setInputChannel(next: LiveSurfaceInputChannelState): void {
    if (this.inputChannel === next) return;
    this.inputChannel = next;
    this.notify();
  }

  private setVideoMode(
    mode: LiveSurfaceVideoMode,
    reason: LiveSurfaceVideoDegradedReason | undefined,
  ): void {
    if (this.videoMode === mode && this.videoDegradedReason === reason) return;
    this.videoMode = mode;
    this.videoDegradedReason = reason;
    this.notify();
  }

  private reportError(message: string, error: unknown): void {
    try {
      this.options.onError?.(message, error);
    } catch {
      // A logger failure must not break a stream.
    }
  }

  private target() {
    return {
      hostId: this.options.hostId ?? 'local',
      platform: this.options.platform,
      deviceId: this.options.deviceId,
    };
  }

  private delay(attempt: number): number {
    return this.reconnectDelays[
      Math.min(attempt, this.reconnectDelays.length - 1)
    ]!;
  }

  // ---- input channel --------------------------------------------------------

  /** Open the input channel. Idempotent; reconnects until `dispose`. */
  open(): void {
    if (this.disposed || this.inputSocket || this.inputRetry) return;
    void this.connectInput();
  }

  private inputPath(): string {
    const device = encodeURIComponent(this.options.deviceId);
    return this.options.platform === 'ios'
      ? `/vendor/serve-sim/helper/ws?device=${device}`
      : `/vendor/serve-emu/ws?device=${device}&video=0`;
  }

  private async connectInput(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.inputGeneration;
    const resolution = await this.options.hub.connect();
    if (this.disposed || generation !== this.inputGeneration) return;
    if (!resolution.ok) {
      this.inputFailed(generation);
      return;
    }
    if (this.options.platform === 'ios' && !this.run)
      await this.primeIosHelper(resolution.connection);
    if (this.disposed || generation !== this.inputGeneration) return;
    let socket: DeviceSocket;
    try {
      socket = resolution.connection.openWebSocket(
        this.inputPath(),
      ) as unknown as DeviceSocket;
    } catch (error) {
      this.reportError('device input socket could not be opened', error);
      this.inputFailed(generation);
      return;
    }
    this.inputSocket = socket;
    let failed = false;
    socket.on('open', () => {
      if (this.inputSocket !== socket || this.disposed) return;
      this.inputFailures = 0;
      if (this.options.platform === 'ios')
        socket.send(
          iosPacket(IOS_MSG_HARDWARE_KEYBOARD, { enabled: false }),
          () => {},
        );
      this.setInputChannel('connected');
    });
    socket.on('message', (data, isBinary) => {
      if (this.inputSocket !== socket || !isBinary) return;
      if (this.options.platform === 'ios')
        this.onIosHelperMessage(bytesOf(data));
    });
    const lost = () => {
      if (failed) return;
      failed = true;
      if (this.inputSocket !== socket) return;
      this.inputSocket = null;
      this.touchDown = null;
      this.heldKeys.clear();
      this.inputFailed(generation);
    };
    socket.on('close', lost);
    socket.on('error', (error) => {
      this.reportError('device input socket error', error);
      try {
        socket.close();
      } catch {
        // already closing
      }
      lost();
    });
  }

  private inputFailed(generation: number): void {
    if (this.disposed || generation !== this.inputGeneration) return;
    this.inputFailures += 1;
    this.setInputChannel(
      this.inputFailures >= (this.options.downAfterFailures ?? 3)
        ? 'down'
        : 'reconnecting',
    );
    void this.checkDeviceStillRunning();
    const wait = this.delay(this.inputFailures - 1);
    this.inputRetry = setTimeout(() => {
      this.inputRetry = null;
      void this.connectInput();
    }, wait);
  }

  private async checkDeviceStillRunning(): Promise<void> {
    const probe = this.options.isDeviceRunning;
    if (!probe || this.ended) return;
    let running = true;
    try {
      running = await probe();
    } catch {
      // Unknown is not "stopped": keep retrying.
      return;
    }
    if (!running) this.end('device-stopped');
  }

  /** The producer is over for good; the owner unregisters its surface. */
  private end(reason: string): void {
    if (this.ended || this.disposed) return;
    this.ended = true;
    this.setInputChannel('down');
    try {
      this.options.onEnded?.(reason);
    } catch (error) {
      this.reportError('device session end handler failed', error);
    }
  }

  /**
   * serve-sim's helper accepts input and pushes its screen config only once
   * screen capture runs; touching the MJPEG endpoint starts it. One bounded
   * request, aborted after its first bytes.
   */
  private async primeIosHelper(
    connection: DeviceHubAccessConnection,
  ): Promise<void> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The deadline covers the whole prime, the body read included: an abort
    // is not guaranteed to reach a read already waiting on the body.
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 2_000);
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await Promise.race([
        (async () => {
          const response = await connection.request('GET', this.mjpegPath(), {
            signal: abort.signal,
          });
          reader = response.body?.getReader();
          await reader?.read();
        })(),
        deadline,
      ]);
    } catch {
      // A failed prime only means the socket may need a retry.
    } finally {
      clearTimeout(timer);
      abort.abort();
      void reader?.cancel().catch(() => {});
    }
  }

  private onIosHelperMessage(bytes: Uint8Array): void {
    if (bytes.length < 2 || bytes[0] !== IOS_TAG_SCREEN_CONFIG) return;
    let config: unknown;
    try {
      config = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
    } catch {
      return;
    }
    if (typeof config !== 'object' || config === null) return;
    const { width, height, orientation } = config as Record<string, unknown>;
    if (
      typeof width === 'number' &&
      typeof height === 'number' &&
      width > 0 &&
      height > 0 &&
      width <= 65_536 &&
      height <= 65_536
    )
      this.iosScreen = { width, height };
    const next = fromIosOrientation(orientation);
    if (next && next !== this.orientation) {
      this.orientation = next;
      this.notify();
    }
  }

  // ---- video --------------------------------------------------------------

  private mjpegPath(): string {
    return `/vendor/serve-sim/helper/${encodeURIComponent(this.options.deviceId)}/stream.mjpeg`;
  }

  async start(
    params: LiveSurfaceStreamParams,
    onFrame: (header: LiveSurfaceFrameHeader, body: Uint8Array) => void,
  ): Promise<void> {
    if (this.disposed) throw new Error('device producer is disposed');
    await this.stop();
    const run: VideoRun = {
      generation: ++this.runGeneration,
      params: { ...params },
      onFrame,
      abort: new AbortController(),
      timers: new Set(),
      decoder: null,
      socket: null,
      android: null,
    };
    this.run = run;
    this.awaitingAck = null;
    this.pending = null;
    this.options.onViewing?.(true);
    if (this.options.platform === 'ios') {
      this.setVideoMode('live', undefined);
      void this.readMjpeg(run, 0);
      return;
    }
    const provider = this.options.decoder ?? null;
    const availability = provider
      ? await provider.availability()
      : ({ available: false } as const);
    if (this.run !== run) return;
    run.android = {
      provider,
      decoderPath: availability.available ? availability.path : null,
      decoderFailed: false,
      decoderRestarts: 0,
      decoderRestartPending: false,
      decoderAwaitingKey: true,
      videoAwaitingKey: true,
      connecting: false,
      polling: false,
      lastUnitHadContent: false,
      requestKeyframe: null,
      sps: null,
      pps: null,
      sequence: null,
    };
    this.reconcileAndroid(run);
  }

  setCodecDemand(demand: LiveSurfaceCodecDemand): void {
    this.demand = { image: demand.image, h264: demand.h264 };
    if (this.run) this.reconcileAndroid(this.run);
  }

  requestKeyframe(): void {
    this.run?.android?.requestKeyframe?.();
  }

  /**
   * Bring Android's three video paths in line with what viewers take: the
   * hub socket (for H.264 viewers, or to feed the decoder), the ffmpeg
   * decoder (image viewers, when a decoder is available and has not failed),
   * and screenshot polling (image viewers otherwise).
   */
  private reconcileAndroid(run: VideoRun): void {
    const android = run.android;
    if (!android || this.run !== run) return;
    const decode =
      this.demand.image &&
      android.decoderPath !== null &&
      !android.decoderFailed;
    const poll = this.demand.image && !decode;
    if (!decode && run.decoder) {
      const decoder = run.decoder;
      run.decoder = null;
      void decoder.close();
    }
    const wantSocket = this.demand.h264 || decode;
    if (!wantSocket && run.socket) {
      const socket = run.socket;
      run.socket = null;
      android.requestKeyframe = null;
      try {
        socket.close();
      } catch {
        // already closing
      }
    }
    if (wantSocket && !run.socket && !android.connecting)
      void this.connectAndroidVideo(run, 0);
    if (decode && !run.decoder && !android.decoderRestartPending)
      this.startDecoder(run);
    if (poll && !android.polling) void this.pollSnapshots(run);
    if (poll)
      this.setVideoMode(
        'snapshot-poll',
        android.decoderPath === null ? 'decoder-unavailable' : 'decoder-failed',
      );
    else this.setVideoMode('live', undefined);
  }

  async updateParams(params: LiveSurfaceStreamParams): Promise<void> {
    // fps is enforced by the hub's throttle and by acks; size/quality only
    // matter to the Android decoder, which picks them up on its next start.
    if (this.run) this.run.params = { ...params };
  }

  private later(run: VideoRun, wait: number, fn: () => void): void {
    const timer = setTimeout(() => {
      run.timers.delete(timer);
      if (this.run === run) fn();
    }, wait);
    run.timers.add(timer);
  }

  private async readMjpeg(run: VideoRun, attempt: number): Promise<void> {
    const resolution = await this.options.hub.connect();
    if (this.run !== run) return;
    if (!resolution.ok) {
      this.later(
        run,
        this.delay(attempt),
        () => void this.readMjpeg(run, attempt + 1),
      );
      return;
    }
    let delivered = false;
    try {
      const response = await resolution.connection.request(
        'GET',
        this.mjpegPath(),
        { signal: run.abort.signal },
      );
      const boundary = multipartBoundary(response.headers.get('content-type'));
      if (!response.ok || !response.body || !boundary)
        throw new Error(`device MJPEG stream refused (${response.status})`);
      const parser = new MjpegMultipartParser(boundary);
      const reader = response.body.getReader();
      // The helper answers a new stream connection with the frame it last
      // buffered, captured whenever capture last ran — seconds or minutes
      // ago when nobody was watching (live: a home screen replayed while
      // Settings was open). Stamped with `capturedAt: now` it would pass as
      // current, so it is dropped; the helper's own capture follows within
      // a frame interval.
      let replay = true;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done || this.run !== run) break;
          for (const part of parser.push(next.value)) {
            const size = jpegSize(part);
            if (!size) continue;
            if (replay) {
              replay = false;
              continue;
            }
            delivered = true;
            this.offer(run, { codec: 'jpeg', body: part, ...size });
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch (error) {
      if (this.run === run)
        this.reportError('device MJPEG stream failed', error);
    }
    if (this.run !== run) return;
    this.later(
      run,
      this.delay(delivered ? 0 : attempt),
      () => void this.readMjpeg(run, delivered ? 0 : attempt + 1),
    );
  }

  private startDecoder(run: VideoRun): void {
    const android = run.android!;
    const startedAt = this.now();
    let decoder: DeviceVideoDecoder | null = null;
    try {
      decoder = android.provider!.create(android.decoderPath!, run.params, {
        onImage: (jpeg) => {
          if (run.decoder !== decoder) return;
          const size = jpegSize(jpeg);
          if (!size) return;
          this.offer(run, { codec: 'jpeg', body: jpeg, ...size });
        },
        onExit: (reason) => {
          if (this.run !== run || run.decoder !== decoder) return;
          this.reportError('device video decoder exited', reason);
          run.decoder = null;
          // A decoder that ran stably before dying is a fresh failure, not
          // the second of a pattern.
          const restarts =
            this.now() - startedAt >= (this.options.decoderStableMs ?? 60_000)
              ? 0
              : android.decoderRestarts;
          if (restarts >= 1) {
            // Twice is a pattern, not a blip: image viewers fall back to
            // polled stills, and the state says so.
            android.decoderFailed = true;
            this.reconcileAndroid(run);
            return;
          }
          android.decoderRestarts = restarts + 1;
          android.decoderRestartPending = true;
          this.later(run, this.delay(0), () => {
            android.decoderRestartPending = false;
            this.reconcileAndroid(run);
          });
        },
      });
    } catch (error) {
      this.reportError('device video decoder could not start', error);
      android.decoderFailed = true;
      this.reconcileAndroid(run);
      return;
    }
    run.decoder = decoder;
    android.decoderAwaitingKey = true;
    android.requestKeyframe?.();
  }

  private async connectAndroidVideo(
    run: VideoRun,
    attempt: number,
  ): Promise<void> {
    const android = run.android!;
    android.connecting = true;
    const resolution = await this.options.hub.connect();
    android.connecting = false;
    const wanted = () =>
      this.run === run &&
      !run.socket &&
      (this.demand.h264 || run.decoder !== null);
    if (!wanted()) return;
    const retry = () => {
      android.connecting = true;
      this.later(run, this.delay(attempt), () => {
        android.connecting = false;
        if (wanted()) void this.connectAndroidVideo(run, attempt + 1);
      });
    };
    if (!resolution.ok) {
      retry();
      return;
    }
    let socket: DeviceSocket;
    try {
      socket = resolution.connection.openWebSocket(
        `/vendor/serve-emu/ws?device=${encodeURIComponent(this.options.deviceId)}&frame-meta=1`,
      ) as unknown as DeviceSocket;
    } catch (error) {
      this.reportError('device video socket could not be opened', error);
      retry();
      return;
    }
    run.socket = socket;
    android.decoderAwaitingKey = true;
    android.videoAwaitingKey = true;
    // `ws` throws from `send` until the socket opens; the `open` handler
    // asks for a keyframe then, so an earlier request has nothing to add.
    const requestKeyframe = () => {
      if (socket.readyState !== 1) return;
      socket.send(
        JSON.stringify({ type: 'reset-video', ack: false }),
        () => {},
      );
    };
    android.requestKeyframe = requestKeyframe;
    // Idle keyframes (see `keyframeIdleMs`): re-armed on every access unit;
    // only a content slice starts a new quiet period (below).
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let idleRequests = 0;
    const armIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        run.timers.delete(idleTimer);
      }
      idleTimer = null;
      if (idleRequests >= MAX_IDLE_KEYFRAMES) return;
      const timer = setTimeout(() => {
        run.timers.delete(timer);
        idleTimer = null;
        if (run.socket !== socket || this.run !== run) return;
        idleRequests += 1;
        requestKeyframe();
      }, this.options.keyframeIdleMs ?? 300);
      idleTimer = timer;
      run.timers.add(timer);
    };
    socket.on('open', () => {
      if (run.socket === socket) requestKeyframe();
    });
    socket.on('message', (data, isBinary) => {
      if (run.socket !== socket || this.run !== run) return;
      if (!isBinary) {
        // The encoder restarts at a new size when the device rotates; the
        // next keyframe carries the new SPS.
        const text = bytesOf(data);
        if (new TextDecoder().decode(text).includes('"video-session"')) {
          // A new session has new parameter sets and size: never prepend or
          // size its IDR with the old session's.
          android.decoderAwaitingKey = true;
          android.videoAwaitingKey = true;
          android.sps = null;
          android.pps = null;
          android.sequence = null;
          requestKeyframe();
        }
        return;
      }
      this.onAndroidUnit(run, parseSemuPacket(bytesOf(data)));
      // Only CONTENT resets the idle budget: a non-IDR slice means the
      // screen changed. Keyframes and parameter sets are what our own
      // requests produce (a reply can be several units — SPS/PPS, then the
      // IDR), so they never reset it; a still screen gets at most
      // MAX_IDLE_KEYFRAMES requests, however its replies are split.
      if (android.lastUnitHadContent) idleRequests = 0;
      armIdle();
    });
    let lost = false;
    const onLost = () => {
      if (lost) return;
      lost = true;
      if (run.socket !== socket || this.run !== run) return;
      run.socket = null;
      android.requestKeyframe = null;
      retry();
    };
    socket.on('close', onLost);
    socket.on('error', () => {
      try {
        socket.close();
      } catch {
        // already closing
      }
      onLost();
    });
  }

  /** One access unit from the hub: to H.264 viewers, and to the decoder. */
  private onAndroidUnit(
    run: VideoRun,
    packet: { data: Uint8Array; isKey: boolean | null },
  ): void {
    const android = run.android!;
    const types = annexBNalTypes(packet.data);
    android.lastUnitHadContent = types.has(1);
    if (types.has(7) || types.has(8)) {
      for (const nal of splitAnnexB(packet.data)) {
        const type = nal[0]! & 0x1f;
        if (type === 8) android.pps = nal.slice();
        if (type !== 7) continue;
        android.sps = nal.slice();
        // An SPS that does not parse leaves no size to head frames with.
        android.sequence = parseLiveSurfaceH264Sequence(
          Buffer.concat([ANNEX_B_START, nal]),
        );
      }
    }
    const idr = types.has(5);
    const unit =
      idr && !types.has(7) && android.sps && android.pps
        ? withParameterSets(packet.data, android.sps, android.pps)
        : packet.data;
    if (this.demand.h264 && android.sequence && (idr || types.has(1))) {
      if (idr) android.videoAwaitingKey = false;
      if (!android.videoAwaitingKey) this.publishVideo(run, unit, idr);
    }
    const decoder = run.decoder;
    if (!decoder) return;
    if (android.decoderAwaitingKey) {
      if (!(packet.isKey ?? idr)) return;
      android.decoderAwaitingKey = false;
    }
    if (!decoder.write(unit)) {
      // The decoder fell behind and dropped this unit: resynchronize on a
      // keyframe instead of decoding deltas against a missing base.
      android.decoderAwaitingKey = true;
      android.requestKeyframe?.();
    }
  }

  /** An H.264 access unit, published as it arrives: the hub queues it. */
  private publishVideo(run: VideoRun, unit: Uint8Array, keyframe: boolean) {
    const size = fittedVideoSize(run.android!.sequence!, run.params);
    const rotation = frameRotationFor(
      this.options.platform,
      this.orientation,
      size,
    );
    this.lastFrame = { ...size, rotation };
    run.onFrame(
      {
        surfaceId: this.surfaceId,
        seq: ++this.seq,
        epoch: 0,
        codec: 'h264',
        keyframe,
        width: size.width,
        height: size.height,
        deviceScaleFactor: 1,
        capturedAt: this.now(),
        ...(rotation === 0 ? {} : { rotation }),
      },
      unit,
    );
  }

  private async pollSnapshots(run: VideoRun): Promise<void> {
    const interval = this.options.snapshotPollIntervalMs ?? 1_000;
    const android = run.android;
    if (android) android.polling = true;
    // Android polls only for image viewers the decoder cannot serve.
    const wanted = () =>
      this.run === run &&
      (!android ||
        (this.demand.image &&
          (android.decoderPath === null || android.decoderFailed)));
    try {
      while (wanted()) {
        try {
          const shot = await this.options.hub.screenshot(this.target());
          if (this.run !== run) return;
          this.offer(run, {
            codec: 'png',
            body: shot.png,
            width: shot.width,
            height: shot.height,
          });
        } catch (error) {
          if (this.run === run)
            this.reportError('device screenshot poll failed', error);
        }
        await new Promise<void>((resolve) =>
          this.later(run, interval, resolve),
        );
      }
    } finally {
      if (android) android.polling = false;
    }
  }

  /** Latest frame wins: publish now, or replace the one waiting for an ack. */
  private offer(run: VideoRun, frame: PendingFrame): void {
    if (this.run !== run) return;
    if (this.awaitingAck !== null) {
      this.pending = frame;
      return;
    }
    this.publish(run, frame);
  }

  private publish(run: VideoRun, frame: PendingFrame): void {
    const size = this.declaredSize(run, frame);
    const rotation = frameRotationFor(
      this.options.platform,
      this.orientation,
      size,
    );
    this.lastFrame = { ...size, rotation };
    const seq = ++this.seq;
    this.awaitingAck = seq;
    run.onFrame(
      {
        surfaceId: this.surfaceId,
        seq,
        epoch: 0,
        codec: frame.codec,
        width: size.width,
        height: size.height,
        deviceScaleFactor: 1,
        capturedAt: this.now(),
        ...(rotation === 0 ? {} : { rotation }),
      },
      frame.body,
    );
  }

  /**
   * The size an image frame declares. iOS has one video path, so its frames
   * keep their own size. Android frames declare the shared fitted box of the
   * device picture: the SPS size when known (an ffmpeg JPEG is that picture,
   * scaled), else the image's own (a polled PNG is the full screen).
   */
  private declaredSize(
    run: VideoRun,
    frame: PendingFrame,
  ): { width: number; height: number } {
    if (!run.android) return { width: frame.width, height: frame.height };
    const native =
      frame.codec === 'jpeg' && run.android.sequence
        ? run.android.sequence
        : frame;
    return fittedVideoSize(native, run.params);
  }

  ack(seq: number): void {
    // Exact: H.264 units share the sequence and are never acked, so a stray
    // ack of one (the hub acks a malformed frame) must not release an image.
    if (seq !== this.awaitingAck) return;
    this.awaitingAck = null;
    const next = this.pending;
    this.pending = null;
    if (next && this.run) this.publish(this.run, next);
  }

  async stop(): Promise<void> {
    const run = this.run;
    if (!run) return;
    this.run = null;
    if (!this.disposed) this.options.onViewing?.(false);
    run.abort.abort();
    for (const timer of run.timers) clearTimeout(timer);
    run.timers.clear();
    const socket = run.socket;
    run.socket = null;
    try {
      socket?.close();
    } catch {
      // already closing
    }
    const decoder = run.decoder;
    run.decoder = null;
    this.awaitingAck = null;
    this.pending = null;
    await decoder?.close();
  }

  // ---- input --------------------------------------------------------------

  async dispatch(
    input: LiveSurfaceInput,
    context?: LiveSurfaceDispatchContext,
  ): Promise<void> {
    await this.bounded((signal) => this.dispatchNow(input, context, signal));
  }

  async cancelHeldInput(_held: LiveSurfaceHeldInput): Promise<void> {
    // The registry runs a cancel at a handoff on behalf of NO controller:
    // it is not fenced, and must not be.
    await this.bounded(() => this.cancelNow());
  }

  /**
   * Each dispatch has its own deadline, so the registry never wedges on it.
   * When the deadline passes the caller is told `dispatch-timeout` AND the
   * work's signal aborts (#2442 review M1): work that is still waiting, or
   * running on a device host, is cancelled rather than left to act after
   * the caller was told it failed.
   */
  private async bounded(
    work: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (this.disposed) throw new DeviceInputError('disposed', 'device closed');
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work(abort.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(
              new DeviceInputError(
                'dispatch-timeout',
                'device input timed out',
              ),
            );
          }, this.dispatchTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * One message to the hub's input socket. `guard` is the dispatch's fence:
   * the socket itself is not lease-fenced, so it is asked before EVERY send.
   */
  private send(
    payload: string | Uint8Array,
    guard: LiveSurfaceDispatchContext | undefined,
  ): Promise<void> {
    if (guard && !guard.isCurrent())
      return Promise.reject(
        new DeviceInputError('interrupted', 'control changed hands'),
      );
    const socket = this.inputSocket;
    if (
      !socket ||
      socket.readyState !== SOCKET_OPEN ||
      this.inputChannel !== 'connected'
    )
      return Promise.reject(
        new DeviceInputError(
          'input-channel-down',
          'device input is not connected',
        ),
      );
    return new Promise((resolve, reject) => {
      socket.send(payload, (error) =>
        error
          ? reject(new DeviceInputError('send-failed', error.message))
          : resolve(),
      );
    });
  }

  private sendIos(
    tag: number,
    payload: unknown,
    guard: LiveSurfaceDispatchContext | undefined,
  ): Promise<void> {
    return this.send(iosPacket(tag, payload), guard);
  }

  private sendAndroid(
    payload: Record<string, unknown>,
    guard: LiveSurfaceDispatchContext | undefined,
  ): Promise<void> {
    return this.send(JSON.stringify({ ...payload, ack: false }), guard);
  }

  private async touch(
    phase: 'down' | 'move' | 'up',
    point: UnitPoint,
    guard: LiveSurfaceDispatchContext | undefined,
  ): Promise<void> {
    if (this.options.platform === 'ios')
      await this.sendIos(
        IOS_MSG_TOUCH,
        {
          type: phase === 'down' ? 'begin' : phase === 'move' ? 'move' : 'end',
          x: point.x,
          y: point.y,
        },
        guard,
      );
    else
      await this.sendAndroid(
        { type: 'touch', action: phase, x: point.x, y: point.y },
        guard,
      );
  }

  /** Surface pixels → the raw frame's unit square, learning the size if needed. */
  private async toRawUnit(point: { x: number; y: number }): Promise<UnitPoint> {
    let frame = this.lastFrame;
    if (!frame && this.iosScreen)
      frame = {
        ...this.iosScreen,
        rotation: frameRotationFor('ios', this.orientation, this.iosScreen),
      };
    if (!frame) {
      // Nobody has watched yet (an agent driving an unwatched device): learn
      // the frame size from one screenshot, the size a viewer would see.
      try {
        const shot = await this.options.hub.screenshot(this.target());
        frame = {
          width: shot.width,
          height: shot.height,
          rotation: frameRotationFor(
            this.options.platform,
            this.orientation,
            shot,
          ),
        };
        this.lastFrame = frame;
      } catch {
        throw new DeviceInputError(
          'surface-size-unknown',
          'the device screen size is not known yet',
        );
      }
    }
    return surfacePointToRawUnit(point, frame, frame.rotation);
  }

  private async dispatchNow(
    input: LiveSurfaceInput,
    guard: LiveSurfaceDispatchContext | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    switch (input.kind) {
      case 'pointer': {
        // A phone has one finger here: the primary button is the touch;
        // hover, wheel and other buttons have no device meaning and are
        // accepted as no-ops rather than invented gestures.
        if (input.type === 'wheel') return;
        if (input.type === 'move') {
          if (!this.touchDown) return;
          const point = await this.toRawUnit(input);
          await this.touch('move', point, guard);
          this.touchDown = point;
          return;
        }
        if (input.button !== undefined && input.button !== 'left') return;
        if (input.type === 'down') {
          const point = await this.toRawUnit(input);
          this.touchDown = point;
          await this.touch('down', point, guard);
          return;
        }
        if (!this.touchDown) return;
        const point = await this.toRawUnit(input);
        this.touchDown = null;
        await this.touch('up', point, guard);
        return;
      }
      case 'key': {
        const id = input.code || input.key;
        if (input.type === 'down') this.heldKeys.set(id, input);
        else this.heldKeys.delete(id);
        await this.sendKey(input.type, input.key, input.code, guard);
        return;
      }
      case 'text':
        await this.sendText(input.text, guard);
        return;
      case 'device-button': {
        const command = deviceButtonCommand(
          this.options.platform,
          input.button,
        );
        if (!command)
          throw new DeviceInputError(
            'button-unsupported',
            `this device has no ${String(input.button)} button`,
          );
        if (command.platform === 'ios')
          await this.sendIos(IOS_MSG_BUTTON, { button: command.button }, guard);
        else await this.sendAndroid({ type: command.type }, guard);
        return;
      }
      case 'rotate': {
        if (this.options.platform === 'ios') {
          await this.sendIos(
            IOS_MSG_ORIENTATION,
            { orientation: toIosOrientation(input.orientation) },
            guard,
          );
          return;
        }
        const actions = this.options.actions;
        if (!actions)
          throw new DeviceInputError(
            'button-unsupported',
            'rotation is not available for this device',
          );
        const stillCurrent = () => {
          if (guard && !guard.isCurrent())
            throw new DeviceInputError('interrupted', 'control changed hands');
        };
        stillCurrent();
        // The host may make the rotation wait (an SSH device host's slot):
        // the lease is asked again once it can run, before anything runs,
        // and the dispatch deadline cancels it (#2442 review M1).
        await actions.rotateAndroid(
          this.options.deviceId,
          input.orientation,
          this.dispatchTimeoutMs,
          { beforeRun: stillCurrent, ...(signal ? { signal } : {}) },
        );
        return;
      }
    }
  }

  private async sendKey(
    type: 'down' | 'up',
    key: string,
    code: string,
    guard: LiveSurfaceDispatchContext | undefined,
  ): Promise<void> {
    if (this.options.platform === 'ios') {
      const usage = hidUsageForCode(code);
      if (usage !== null)
        await this.sendIos(IOS_MSG_KEY, { type, usage }, guard);
      return;
    }
    const keycode = androidKeycodeForKey(key);
    if (keycode !== null)
      await this.sendAndroid({ type: 'key', keycode, action: type }, guard);
  }

  private async sendText(
    text: string,
    guard: LiveSurfaceDispatchContext | undefined,
  ): Promise<void> {
    if (this.options.platform === 'android') {
      await this.sendAndroid({ type: 'text', text }, guard);
      return;
    }
    // iOS takes keystrokes, not text: type each character on a US layout.
    // Refuse the whole string rather than type part of it.
    const strokes = [...text].map(hidStrokeForCharacter);
    if (strokes.some((stroke) => stroke === null))
      throw new DeviceInputError(
        'text-unsupported',
        'this text cannot be typed on the simulator keyboard',
      );
    for (const stroke of strokes) {
      if (!stroke) continue;
      // Fenced once per keystroke, never between its down and its up, so
      // control changing hands mid-string never leaves a key held down.
      if (guard && !guard.isCurrent())
        throw new DeviceInputError('interrupted', 'control changed hands');
      if (stroke.shift)
        await this.sendIos(
          IOS_MSG_KEY,
          { type: 'down', usage: HID_SHIFT },
          undefined,
        );
      await this.sendIos(
        IOS_MSG_KEY,
        { type: 'down', usage: stroke.usage },
        undefined,
      );
      await this.sendIos(
        IOS_MSG_KEY,
        { type: 'up', usage: stroke.usage },
        undefined,
      );
      if (stroke.shift)
        await this.sendIos(
          IOS_MSG_KEY,
          { type: 'up', usage: HID_SHIFT },
          undefined,
        );
    }
  }

  /**
   * End what the previous controller held WITHOUT completing it. The hub has
   * no touch-cancel, so a held touch slides a short way parallel to the
   * nearest edge and lifts there (`cancelSlidePath`): never a tap where it
   * was pressed, and not an edge swipe. Held keys are released.
   */
  private async cancelNow(): Promise<void> {
    const press = this.touchDown;
    this.touchDown = null;
    if (press) {
      const path = cancelSlidePath(press);
      for (const point of path) await this.touch('move', point, undefined);
      await this.touch('up', path[path.length - 1]!, undefined);
    }
    const keys = [...this.heldKeys.values()];
    this.heldKeys.clear();
    for (const { key, code } of keys)
      await this.sendKey('up', key, code, undefined);
  }

  // ---- lifecycle ------------------------------------------------------------

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.inputGeneration += 1;
    if (this.inputRetry) clearTimeout(this.inputRetry);
    this.inputRetry = null;
    const socket = this.inputSocket;
    this.inputSocket = null;
    try {
      socket?.close();
    } catch {
      // already closing
    }
    this.setInputChannel('down');
    await this.stop();
    this.listeners.clear();
  }
}
