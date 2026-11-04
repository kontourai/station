import type {
  LiveSurfaceCodec,
  LiveSurfaceDisplay,
  LiveSurfaceFold,
  LiveSurfaceFoldInput,
  LiveSurfaceFrameHeader,
  LiveSurfaceFrameRotation,
  LiveSurfaceInput,
  LiveSurfaceInputChannelState,
  LiveSurfaceOrientation,
  LiveSurfaceProducerStatus,
  LiveSurfaceStreamParams,
  LiveSurfaceVideoDegradedReason,
  LiveSurfaceVideoMode,
} from '@kontourai/station-contracts/live-surface';
import type { MobileDevicePlatform } from '@kontourai/station-contracts/mobile-device';
import { jpegSize } from '../live-surface/jpeg-size.js';
import type {
  LiveSurfaceDispatchContext,
  LiveSurfaceHeldInput,
  LiveSurfaceProducer,
} from '../live-surface/producer.js';
import {
  annexBHasIdr,
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
  androidFoldFromHub,
  androidFoldPosture,
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
  IOS_MSG_HINGE_CONTROL,
  IOS_MSG_KEY,
  IOS_MSG_ORIENTATION,
  IOS_MSG_TOUCH,
  IOS_TAG_HINGE_REPLY,
  IOS_TAG_SCREEN_CONFIG,
  iosFoldFromScreenConfig,
  iosHingeCommand,
  iosPacket,
  iosPanelForDisplay,
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
 *   hub's H.264 (SEMU-framed over a WebSocket) decoded on this server by a
 *   supervised ffmpeg into `jpeg` frames; with no decoder, polled PNG
 *   screenshots at a low rate, reported as `videoMode: 'snapshot-poll'`.
 * - Input has its own socket, opened with the session (`open`) and kept
 *   (reconnecting) for its whole life, so an agent can drive a device nobody
 *   watches (D6). Its state is published as `inputChannel`.
 *
 * Backpressure: latest frame wins. While a published frame is unacked, newer
 * frames REPLACE the one held; on ack the held one is published. Nothing
 * queues.
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
      | 'fold-unsupported'
      | 'fold-refused'
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
  /** A foldable's display the frame came from. */
  display?: LiveSurfaceDisplay;
}

interface VideoRun {
  generation: number;
  params: LiveSurfaceStreamParams;
  onFrame: (header: LiveSurfaceFrameHeader, body: Uint8Array) => void;
  abort: AbortController;
  timers: Set<ReturnType<typeof setTimeout>>;
  decoder: DeviceVideoDecoder | null;
  socket: DeviceSocket | null;
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
  readonly capabilities = {
    codecs: ['jpeg', 'png'] as const satisfies readonly LiveSurfaceCodec[],
    input: [
      'pointer',
      'key',
      'text',
      'device-button',
      'rotate',
      'fold',
    ] as const satisfies readonly LiveSurfaceInput['kind'][],
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
  /** A foldable's hinge state, as its helper last reported it. */
  private fold: LiveSurfaceFold | undefined;
  /**
   * iOS: stream the active display's own panel. Cleared when the helper
   * refuses panel streams, so the device's main stream is used instead.
   */
  private panelStreams = true;
  /** Aborts the current MJPEG read alone, to switch displays. */
  private mjpegRead: AbortController | null = null;
  private nextHingeRequestId = 1;
  private readonly hingeReplies = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();
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

  constructor(options: DeviceLiveSurfaceProducerOptions) {
    this.options = options;
    this.surfaceId = options.surfaceId;
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
      ...(this.fold ? { fold: this.fold } : {}),
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
      if (this.options.platform === 'android') void this.readAndroidFold();
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
      this.failHingeReplies('device input disconnected');
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
    if (
      bytes.length < 2 ||
      (bytes[0] !== IOS_TAG_SCREEN_CONFIG && bytes[0] !== IOS_TAG_HINGE_REPLY)
    )
      return;
    let config: unknown;
    try {
      config = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
    } catch {
      return;
    }
    if (typeof config !== 'object' || config === null) return;
    if (bytes[0] === IOS_TAG_HINGE_REPLY) {
      this.onHingeReply(config as Record<string, unknown>);
      return;
    }
    this.setFold(iosFoldFromScreenConfig(config as Record<string, unknown>));
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

  // ---- foldables -------------------------------------------------------------

  /**
   * Adopt a newly observed fold state. When the lit display changes, the
   * iOS video switches to that display's own stream: the current read is
   * aborted and `readMjpeg` reconnects to the new panel.
   */
  private setFold(next: LiveSurfaceFold | undefined): void {
    const previous = this.fold;
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    this.fold = next;
    if (
      previous &&
      next &&
      previous.activeDisplay !== next.activeDisplay &&
      this.panelStreams
    )
      this.mjpegRead?.abort();
    this.notify();
  }

  private onHingeReply(reply: Record<string, unknown>): void {
    const { requestId, ok, error } = reply;
    if (typeof requestId !== 'number') return;
    const waiter = this.hingeReplies.get(requestId);
    if (!waiter) return;
    this.hingeReplies.delete(requestId);
    if (ok === true) waiter.resolve();
    else
      waiter.reject(
        new DeviceInputError(
          'fold-refused',
          typeof error === 'string' && error.length <= 200
            ? error
            : 'the device could not change its fold',
        ),
      );
  }

  private failHingeReplies(message: string): void {
    const waiters = [...this.hingeReplies.values()];
    this.hingeReplies.clear();
    for (const waiter of waiters)
      waiter.reject(new DeviceInputError('input-channel-down', message));
  }

  /**
   * One hinge command, resolved only by the helper's correlated reply (not
   * by the socket accepting the bytes): a fold the simulator refused is
   * reported as refused. The dispatch deadline bounds the wait.
   */
  private async foldIos(
    input: LiveSurfaceFoldInput,
    guard: LiveSurfaceDispatchContext | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const fold = this.fold;
    if (!fold)
      throw new DeviceInputError(
        'fold-unsupported',
        'this device does not fold',
      );
    if ('hingeAngle' in input && !fold.angleControl)
      throw new DeviceInputError(
        'fold-unsupported',
        'this device takes named stands only',
      );
    if ('posture' in input && !fold.postures.includes(input.posture))
      throw new DeviceInputError(
        'fold-unsupported',
        `this device cannot be put in the ${input.posture} stand`,
      );
    const requestId = this.nextHingeRequestId++;
    const replied = new Promise<void>((resolve, reject) => {
      this.hingeReplies.set(requestId, { resolve, reject });
      signal?.addEventListener('abort', () => {
        this.hingeReplies.delete(requestId);
        reject(new DeviceInputError('dispatch-timeout', 'no fold reply'));
      });
    });
    replied.catch(() => {});
    try {
      await this.sendIos(
        IOS_MSG_HINGE_CONTROL,
        { requestId, command: iosHingeCommand(input) },
        guard,
      );
    } catch (error) {
      this.hingeReplies.delete(requestId);
      throw error;
    }
    await replied;
  }

  private foldPath(): string {
    return `/vendor/serve-emu/api/fold?device=${encodeURIComponent(this.options.deviceId)}`;
  }

  /** Read an Android emulator's hinge (once per input connection). */
  private async readAndroidFold(): Promise<void> {
    try {
      const resolution = await this.options.hub.connect();
      if (!resolution.ok || this.disposed) return;
      const response = await resolution.connection.request(
        'GET',
        this.foldPath(),
        { signal: AbortSignal.timeout(this.dispatchTimeoutMs * 2) },
      );
      if (!response.ok) return;
      if (!this.disposed)
        this.setFold(androidFoldFromHub(await response.json()));
    } catch (error) {
      this.reportError('device fold state could not be read', error);
    }
  }

  private async foldAndroid(
    input: LiveSurfaceFoldInput,
    guard: LiveSurfaceDispatchContext | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const posture = this.fold ? androidFoldPosture(input) : null;
    if (!posture)
      throw new DeviceInputError(
        'fold-unsupported',
        this.fold
          ? 'this emulator can only be folded closed or opened flat'
          : 'this device does not fold',
      );
    if (guard && !guard.isCurrent())
      throw new DeviceInputError('interrupted', 'control changed hands');
    const resolution = await this.options.hub.connect();
    if (!resolution.ok)
      throw new DeviceInputError(
        'input-channel-down',
        'device hub unavailable',
      );
    const response = await resolution.connection.request(
      'POST',
      this.foldPath(),
      {
        body: JSON.stringify({ posture }),
        headers: { 'content-type': 'application/json' },
        ...(signal ? { signal } : {}),
      },
    );
    const reply: unknown = await response.json().catch(() => null);
    const fold = response.ok ? androidFoldFromHub(reply) : undefined;
    if (!fold)
      throw new DeviceInputError(
        'fold-refused',
        'the emulator did not confirm the fold',
      );
    this.setFold(fold);
  }

  // ---- video --------------------------------------------------------------

  /** The display this read streams: the lit one, when panels are in use. */
  private mjpegDisplay(): LiveSurfaceDisplay | undefined {
    return this.fold && this.panelStreams ? this.fold.activeDisplay : undefined;
  }

  private mjpegPath(display = this.mjpegDisplay()): string {
    const device = encodeURIComponent(this.options.deviceId);
    return display
      ? `/vendor/serve-sim/helper/${device}/panel/${iosPanelForDisplay(display)}/stream.mjpeg`
      : `/vendor/serve-sim/helper/${device}/stream.mjpeg`;
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
    const provider = this.options.decoder;
    const availability = provider
      ? await provider.availability()
      : ({ available: false } as const);
    if (this.run !== run) return;
    if (!provider || !availability.available) {
      this.setVideoMode('snapshot-poll', 'decoder-unavailable');
      void this.pollSnapshots(run);
      return;
    }
    this.setVideoMode('live', undefined);
    this.startAndroidVideo(run, provider, availability.path, 0);
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
    let switched = false;
    const display = this.mjpegDisplay();
    const read = new AbortController();
    const onRunAbort = () => read.abort();
    run.abort.signal.addEventListener('abort', onRunAbort);
    this.mjpegRead = read;
    try {
      const response = await resolution.connection.request(
        'GET',
        this.mjpegPath(display),
        { signal: read.signal },
      );
      // A helper without per-display streams answers the panel path with a
      // client error: use the main stream from now on.
      if (
        display &&
        !response.ok &&
        response.status >= 400 &&
        response.status < 500
      ) {
        await response.body?.cancel().catch(() => {});
        this.panelStreams = false;
        switched = true;
        throw new Error(`device panel stream refused (${response.status})`);
      }
      const boundary = multipartBoundary(response.headers.get('content-type'));
      if (!response.ok || !response.body || !boundary)
        throw new Error(`device MJPEG stream refused (${response.status})`);
      const parser = new MjpegMultipartParser(boundary);
      const reader = response.body.getReader();
      // An abort is not guaranteed to reach a read already waiting on the
      // body; cancelling the reader ends it (a display switch relies on it).
      read.signal.addEventListener(
        'abort',
        () => void reader.cancel().catch(() => {}),
        { once: true },
      );
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
            this.offer(run, {
              codec: 'jpeg',
              body: part,
              ...size,
              ...(display ? { display } : {}),
            });
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch (error) {
      // A display switch aborts this read on purpose.
      if (display !== this.mjpegDisplay()) switched = true;
      else if (this.run === run)
        this.reportError('device MJPEG stream failed', error);
    } finally {
      run.abort.signal.removeEventListener('abort', onRunAbort);
      if (this.mjpegRead === read) this.mjpegRead = null;
    }
    if (this.run !== run) return;
    if (switched) {
      void this.readMjpeg(run, 0);
      return;
    }
    this.later(
      run,
      this.delay(delivered ? 0 : attempt),
      () => void this.readMjpeg(run, delivered ? 0 : attempt + 1),
    );
  }

  private startAndroidVideo(
    run: VideoRun,
    provider: DeviceVideoDecoderProvider,
    decoderPath: string,
    decoderRestarts: number,
  ): void {
    let awaitingKeyframe = true;
    const startedAt = this.now();
    const createDecoder = () =>
      provider.create(decoderPath, run.params, {
        onImage: (jpeg) => {
          const size = jpegSize(jpeg);
          if (size) this.offer(run, { codec: 'jpeg', body: jpeg, ...size });
        },
        onExit: (reason) => {
          if (this.run !== run) return;
          this.reportError('device video decoder exited', reason);
          run.decoder = null;
          run.socket?.close();
          run.socket = null;
          // A decoder that ran stably before dying is a fresh failure, not
          // the second of a pattern.
          const restarts =
            this.now() - startedAt >= (this.options.decoderStableMs ?? 60_000)
              ? 0
              : decoderRestarts;
          if (restarts >= 1) {
            // Twice is a pattern, not a blip: fall back, and say so.
            this.setVideoMode('snapshot-poll', 'decoder-failed');
            void this.pollSnapshots(run);
            return;
          }
          this.later(run, this.delay(0), () =>
            this.startAndroidVideo(run, provider, decoderPath, restarts + 1),
          );
        },
      });
    try {
      run.decoder = createDecoder();
    } catch (error) {
      this.reportError('device video decoder could not start', error);
      this.setVideoMode('snapshot-poll', 'decoder-failed');
      void this.pollSnapshots(run);
      return;
    }
    const connect = async (attempt: number) => {
      const resolution = await this.options.hub.connect();
      if (this.run !== run || !run.decoder) return;
      if (!resolution.ok) {
        this.later(run, this.delay(attempt), () => void connect(attempt + 1));
        return;
      }
      let socket: DeviceSocket;
      try {
        socket = resolution.connection.openWebSocket(
          `/vendor/serve-emu/ws?device=${encodeURIComponent(this.options.deviceId)}&frame-meta=1`,
        ) as unknown as DeviceSocket;
      } catch (error) {
        this.reportError('device video socket could not be opened', error);
        this.later(run, this.delay(attempt), () => void connect(attempt + 1));
        return;
      }
      run.socket = socket;
      awaitingKeyframe = true;
      const requestKeyframe = () =>
        socket.send(
          JSON.stringify({ type: 'reset-video', ack: false }),
          () => {},
        );
      // Idle keyframes (see `keyframeIdleMs`): re-armed on every access
      // unit; only a content slice starts a new quiet period (below).
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
            awaitingKeyframe = true;
            requestKeyframe();
          }
          return;
        }
        const packet = parseSemuPacket(bytesOf(data));
        const isKey = packet.isKey ?? annexBHasIdr(packet.data);
        // Only CONTENT resets the idle budget: a non-IDR slice means the
        // screen changed. Keyframes and parameter sets are what our own
        // requests produce (a reply can be several units — SPS/PPS, then
        // the IDR), so they never reset it; a still screen gets at most
        // MAX_IDLE_KEYFRAMES requests, however its replies are split.
        if (annexBNalTypes(packet.data).has(1)) idleRequests = 0;
        armIdle();
        if (awaitingKeyframe) {
          if (!isKey) return;
          awaitingKeyframe = false;
        }
        if (run.decoder && !run.decoder.write(packet.data)) {
          // The decoder fell behind and dropped this unit: resynchronize on
          // a keyframe instead of decoding deltas against a missing base.
          awaitingKeyframe = true;
          requestKeyframe();
        }
      });
      let lost = false;
      const onLost = () => {
        if (lost) return;
        lost = true;
        if (run.socket !== socket || this.run !== run) return;
        run.socket = null;
        this.later(run, this.delay(attempt), () => void connect(attempt + 1));
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
    };
    void connect(0);
  }

  private async pollSnapshots(run: VideoRun): Promise<void> {
    const interval = this.options.snapshotPollIntervalMs ?? 1_000;
    while (this.run === run) {
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
      await new Promise<void>((resolve) => this.later(run, interval, resolve));
      // `later` never fires for a stopped run; bail out of the wait too.
      if (this.run !== run) return;
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
    const rotation = frameRotationFor(
      this.options.platform,
      this.orientation,
      frame,
    );
    this.lastFrame = { width: frame.width, height: frame.height, rotation };
    const seq = ++this.seq;
    this.awaitingAck = seq;
    run.onFrame(
      {
        surfaceId: this.surfaceId,
        seq,
        epoch: 0,
        codec: frame.codec,
        width: frame.width,
        height: frame.height,
        deviceScaleFactor: 1,
        capturedAt: this.now(),
        ...(rotation === 0 ? {} : { rotation }),
        ...(frame.display ? { display: frame.display } : {}),
      },
      frame.body,
    );
  }

  ack(seq: number): void {
    if (this.awaitingAck === null || seq < this.awaitingAck) return;
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
      case 'fold':
        if (this.options.platform === 'ios')
          await this.foldIos(input, guard, signal);
        else await this.foldAndroid(input, guard, signal);
        return;
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
    this.failHingeReplies('device closed');
    this.setInputChannel('down');
    await this.stop();
    this.listeners.clear();
  }
}
