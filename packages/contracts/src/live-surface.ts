/**
 * Live surface (#90): a host-neutral frame stream + input channel + control
 * lease. The Browser pane is the first consumer (a server-side Chromium
 * screencast produces the frames); the Device pane (#1969/#1970) reuses it.
 *
 * Everything that crosses the wire is parsed strictly here, so the server
 * route seam and every client agree on one grammar. Two properties are
 * deliberate and load-bearing:
 *
 * - Frames are LATEST-FRAME-WINS. The remote relay (`packages/connect`
 *   application channel) is stop-and-wait with 16 KB chunks, so a queued
 *   frame is a stale frame. Nothing in this contract describes a frame queue.
 * - The frame stream is length-prefixed binary over fetch, not SSE: a frame
 *   is bytes, and base64-in-SSE would inflate every frame by a third on the
 *   connection the relay can least afford (see ADR 0018's connection budget).
 */

export type LiveSurfaceCodec = 'jpeg' | 'png' | 'webp';

export const LIVE_SURFACE_CODECS: readonly LiveSurfaceCodec[] = [
  'jpeg',
  'png',
  'webp',
];

export interface LiveSurfaceFrameHeader {
  surfaceId: string;
  /** Producer sequence number; strictly increasing within one producer run. */
  seq: number;
  /** Control-lease epoch in force when the frame was published by the hub. */
  epoch: number;
  codec: LiveSurfaceCodec;
  /** Encoded image size in image pixels. */
  width: number;
  height: number;
  /**
   * Image pixels per SURFACE pixel. Input coordinates address surface pixels
   * (the surface's own layout/CSS pixels), so a viewer maps a point on the
   * image to `imagePx / deviceScaleFactor`. A producer that downscales its
   * capture (e.g. a screencast capped by `maxWidth`) reports the effective
   * ratio here, not the page's native device scale factor.
   */
  deviceScaleFactor: number;
  /**
   * Producer wall-clock capture time (ms since epoch). Informational only: a
   * client must not compare it with its own clock to decide staleness, since
   * the two clocks are not the same clock. Staleness is measured from the
   * client's own receive time.
   */
  capturedAt: number;
  /**
   * Optional (added by the Device pane lane, #1970): how far clockwise a
   * viewer turns THIS frame to show it upright. A simulator can stream its
   * raw portrait framebuffer while the device is held in landscape. Input
   * coordinates then address the ROTATED image (what the viewer shows), in
   * rotated surface pixels; the producer maps them back. Absent means 0.
   */
  rotation?: LiveSurfaceFrameRotation;
}

export type LiveSurfaceModifiers = {
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
};

export type LiveSurfacePointerButton = 'left' | 'middle' | 'right';
export type LiveSurfacePointerType = 'mouse' | 'touch' | 'pen';

export type LiveSurfaceInput =
  | {
      kind: 'pointer';
      type: 'down' | 'up' | 'move' | 'wheel';
      x: number;
      y: number;
      button?: LiveSurfacePointerButton;
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
      modifiers?: LiveSurfaceModifiers;
      /** Absent means mouse. Lets a producer cancel a touch as a touch. */
      pointerType?: LiveSurfacePointerType;
    }
  | {
      kind: 'key';
      type: 'down' | 'up';
      key: string;
      code: string;
      modifiers?: LiveSurfaceModifiers;
    }
  | { kind: 'text'; text: string }
  /**
   * A hardware button on a device surface (#1970). A CONTROL action like any
   * other input: it needs the lease, and a human pressing it auto-claims. Not
   * every platform has every button (iOS has no Back); a producer refuses a
   * button its platform lacks rather than approximating it.
   */
  | { kind: 'device-button'; button: LiveSurfaceDeviceButton }
  /** Rotate a device surface to an absolute orientation (#1970). */
  | { kind: 'rotate'; orientation: LiveSurfaceOrientation };

export type LiveSurfaceInputKind = LiveSurfaceInput['kind'];

export type LiveSurfaceDeviceButton = 'home' | 'back' | 'recents' | 'power';

export const LIVE_SURFACE_DEVICE_BUTTONS: readonly LiveSurfaceDeviceButton[] = [
  'home',
  'back',
  'recents',
  'power',
];

/**
 * A device's physical orientation, named from the device's point of view
 * (the side the home edge is on is `portrait`). Distinct from how a viewer
 * must turn a frame to show it upright, which is `LiveSurfaceFrameHeader.rotation`.
 */
export type LiveSurfaceOrientation =
  | 'portrait'
  | 'landscape-left'
  | 'portrait-upside-down'
  | 'landscape-right';

export const LIVE_SURFACE_ORIENTATIONS: readonly LiveSurfaceOrientation[] = [
  'portrait',
  'landscape-left',
  'portrait-upside-down',
  'landscape-right',
];

/** Quarter turns clockwise a viewer applies to a frame to show it upright. */
export type LiveSurfaceFrameRotation = 0 | 90 | 180 | 270;

export const LIVE_SURFACE_FRAME_ROTATIONS: readonly LiveSurfaceFrameRotation[] =
  [0, 90, 180, 270];

export type LiveSurfaceController =
  | {
      kind: 'human';
      principal: string;
      /**
       * The server-derived client the human acts from (a paired device, or
       * one credential). Two clients of the same person are distinct
       * controllers: the later one's input takes control and fences the
       * earlier one. Absent only in contexts that never name a device.
       */
      device?: string;
    }
  | { kind: 'agent'; principal: string; sessionId: string };

export interface LiveSurfaceControlLease {
  surfaceId: string;
  /**
   * Viewer-facing epoch: advances only when control passes to a DIFFERENT
   * controller. A viewer echoes it with its input; a stale one is refused.
   */
  epoch: number;
  holder: LiveSurfaceController | null;
  expiresAt: number | null;
  /**
   * Fencing token: advances on EVERY holder change (claim, release, expiry,
   * handoff). An operation fences on this, not on `epoch`, so its stragglers
   * are refused even after the same controller releases and reclaims.
   * Always present on server-produced leases.
   */
  fence?: number;
}

export interface LiveSurfaceStreamParams {
  maxFps: number;
  quality: number;
  maxWidth: number;
  maxHeight: number;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Surface ids are opaque, URL-safe, and short enough to log. */
export const LIVE_SURFACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const LIVE_SURFACE_STREAM_PARAM_BOUNDS = {
  maxFps: { min: 1, max: 30 },
  quality: { min: 10, max: 100 },
  maxWidth: { min: 64, max: 4096 },
  maxHeight: { min: 64, max: 4096 },
} as const satisfies Record<
  keyof LiveSurfaceStreamParams,
  { min: number; max: number }
>;

/** What a viewer gets when it asks for nothing in particular. */
export const LIVE_SURFACE_DEFAULT_STREAM_PARAMS: Readonly<LiveSurfaceStreamParams> =
  Object.freeze({ maxFps: 10, quality: 70, maxWidth: 1280, maxHeight: 1280 });

/**
 * One input POST must fit in a single relay chunk (16 KB) so remote input
 * never waits behind a multi-chunk stop-and-wait exchange.
 */
export const LIVE_SURFACE_INPUT_MAX_BODY_BYTES = 16 * 1024;
export const LIVE_SURFACE_INPUT_MAX_EVENTS = 64;
export const LIVE_SURFACE_TEXT_MAX_LENGTH = 1024;
export const LIVE_SURFACE_KEY_MAX_LENGTH = 64;
/** Surface pixel coordinates beyond this are nonsense, not large screens. */
export const LIVE_SURFACE_COORDINATE_MAX = 65_536;
export const LIVE_SURFACE_WHEEL_DELTA_MAX = 100_000;
export const LIVE_SURFACE_LEASE_MAX_BODY_BYTES = 1024;
export const LIVE_SURFACE_MAX_EPOCH = Number.MAX_SAFE_INTEGER;
/**
 * Image pixels per surface pixel. The floor admits a thumbnail capture of a
 * wide page (64 image px of a 1280 px page is 0.05); the ceiling is a
 * generous device pixel ratio.
 */
export const LIVE_SURFACE_DEVICE_SCALE_FACTOR_MIN = 0.01;
export const LIVE_SURFACE_DEVICE_SCALE_FACTOR_MAX = 16;

// ---------------------------------------------------------------------------
// Typed results
// ---------------------------------------------------------------------------

export type LiveSurfaceLeaseRefusalCode =
  /** The caller's epoch is not the current one: it acted on a stale view. */
  | 'stale-epoch'
  /**
   * The operation's fencing token is not current: the lease changed hands
   * (or was released or expired) since the operation claimed it. Distinct
   * from `stale-epoch`, which is about a viewer's view.
   */
  | 'stale-fence'
  /**
   * An agent claim refused because a human holds the lease and is live
   * (within the human hold time since their last input or claim). An agent
   * never preempts a live human; a human always preempts an agent.
   */
  | 'human-controlling'
  /** Another agent holds an unexpired lease the caller may not take. */
  | 'held-by-other'
  /** The surface's authorizer refused the principal this action. */
  | 'not-authorized'
  /** The surface was unregistered; its lease accepts no further claims. */
  | 'surface-closed'
  /** The caller is not the current holder (release/renew/dispatch). */
  | 'not-holder';

export type LiveSurfaceLeaseResult =
  | { ok: true; lease: LiveSurfaceControlLease }
  | {
      ok: false;
      code: LiveSurfaceLeaseRefusalCode;
      lease: LiveSurfaceControlLease;
    };

export type LiveSurfaceInputRefusalCode =
  | LiveSurfaceLeaseRefusalCode
  /** The producer does not accept one of the batch's input kinds. */
  | 'unsupported-input'
  /**
   * An earlier dispatch timed out and has not settled yet. Input is refused
   * until it does, so nothing ever runs concurrently with it.
   */
  | 'surface-wedged'
  /**
   * The producer failed, or did not answer within the dispatch timeout,
   * while dispatching; `accepted` events did land.
   */
  | 'dispatch-failed';

export type LiveSurfaceInputResult =
  | { ok: true; accepted: number; lease: LiveSurfaceControlLease }
  | {
      ok: false;
      code: LiveSurfaceInputRefusalCode;
      /** Events that were dispatched before the refusal (0 when none). */
      accepted: number;
      lease: LiveSurfaceControlLease;
    };

/**
 * What a principal asks to do with a surface. Each is authorized separately
 * (D5): `view` reads frames and the lease; `input` sends pointer/key/text;
 * `control` claims or releases the lease. Human input auto-claims the lease,
 * so the input route requires both `input` and `control`.
 */
export type LiveSurfaceAction = 'view' | 'input' | 'control';

/** Route-level failure codes that are not lease/input outcomes. */
export type LiveSurfaceRouteErrorCode =
  | 'unknown-surface'
  | 'invalid-surface-id'
  | 'invalid-request'
  | 'request-too-large'
  | 'access-denied'
  | 'principal-unresolved'
  /**
   * 503, retryable (#2433): the surface's authorizer cannot answer right now
   * (an SSH device host's lookup queue is full). Not a refusal: the same
   * request may succeed in a moment.
   */
  | 'surface-busy';

// ---------------------------------------------------------------------------
// Wire parsers (strict: unknown keys, wrong types and out-of-range values are
// refusals, never coercions)
// ---------------------------------------------------------------------------

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return value as Record<string, unknown>;
}

function onlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function finiteInRange(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

function intInRange(value: unknown, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && finiteInRange(value, min, max);
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

export function isLiveSurfaceId(value: unknown): value is string {
  return typeof value === 'string' && LIVE_SURFACE_ID_PATTERN.test(value);
}

export function isLiveSurfaceEpoch(value: unknown): value is number {
  return intInRange(value, 0, LIVE_SURFACE_MAX_EPOCH);
}

function parseModifiers(value: unknown): LiveSurfaceModifiers | null {
  const record = plainRecord(value);
  if (!record || !onlyKeys(record, ['alt', 'ctrl', 'meta', 'shift']))
    return null;
  const out: LiveSurfaceModifiers = {};
  for (const key of ['alt', 'ctrl', 'meta', 'shift'] as const) {
    if (record[key] === undefined) continue;
    if (typeof record[key] !== 'boolean') return null;
    out[key] = record[key];
  }
  return out;
}

/** Strict parse of one input event. Returns null for anything malformed. */
export function parseLiveSurfaceInput(value: unknown): LiveSurfaceInput | null {
  const record = plainRecord(value);
  if (!record) return null;
  let modifiers: LiveSurfaceModifiers | undefined;
  if (record.modifiers !== undefined) {
    const parsed = parseModifiers(record.modifiers);
    if (!parsed) return null;
    modifiers = parsed;
  }
  switch (record.kind) {
    case 'pointer': {
      if (
        !onlyKeys(record, [
          'kind',
          'type',
          'x',
          'y',
          'button',
          'clickCount',
          'deltaX',
          'deltaY',
          'modifiers',
          'pointerType',
        ])
      )
        return null;
      const type = record.type;
      if (
        type !== 'down' &&
        type !== 'up' &&
        type !== 'move' &&
        type !== 'wheel'
      )
        return null;
      if (
        !finiteInRange(record.x, 0, LIVE_SURFACE_COORDINATE_MAX) ||
        !finiteInRange(record.y, 0, LIVE_SURFACE_COORDINATE_MAX)
      )
        return null;
      const out: LiveSurfaceInput = {
        kind: 'pointer',
        type,
        x: record.x as number,
        y: record.y as number,
      };
      if (record.button !== undefined) {
        if (
          record.button !== 'left' &&
          record.button !== 'middle' &&
          record.button !== 'right'
        )
          return null;
        out.button = record.button;
      }
      if (record.clickCount !== undefined) {
        if (!intInRange(record.clickCount, 0, 3)) return null;
        out.clickCount = record.clickCount as number;
      }
      for (const key of ['deltaX', 'deltaY'] as const) {
        if (record[key] === undefined) continue;
        if (
          type !== 'wheel' ||
          !finiteInRange(
            record[key],
            -LIVE_SURFACE_WHEEL_DELTA_MAX,
            LIVE_SURFACE_WHEEL_DELTA_MAX,
          )
        )
          return null;
        out[key] = record[key] as number;
      }
      if (record.pointerType !== undefined) {
        if (
          record.pointerType !== 'mouse' &&
          record.pointerType !== 'touch' &&
          record.pointerType !== 'pen'
        )
          return null;
        out.pointerType = record.pointerType;
      }
      if (modifiers) out.modifiers = modifiers;
      return out;
    }
    case 'key': {
      if (!onlyKeys(record, ['kind', 'type', 'key', 'code', 'modifiers']))
        return null;
      if (record.type !== 'down' && record.type !== 'up') return null;
      if (!boundedText(record.key, LIVE_SURFACE_KEY_MAX_LENGTH)) return null;
      // `code` may legitimately be empty (virtual keyboards report '').
      if (
        typeof record.code !== 'string' ||
        record.code.length > LIVE_SURFACE_KEY_MAX_LENGTH
      )
        return null;
      const out: LiveSurfaceInput = {
        kind: 'key',
        type: record.type,
        key: record.key,
        code: record.code,
      };
      if (modifiers) out.modifiers = modifiers;
      return out;
    }
    case 'text': {
      if (!onlyKeys(record, ['kind', 'text'])) return null;
      if (!boundedText(record.text, LIVE_SURFACE_TEXT_MAX_LENGTH)) return null;
      return { kind: 'text', text: record.text };
    }
    case 'device-button': {
      if (!onlyKeys(record, ['kind', 'button'])) return null;
      if (
        !LIVE_SURFACE_DEVICE_BUTTONS.includes(
          record.button as LiveSurfaceDeviceButton,
        )
      )
        return null;
      return {
        kind: 'device-button',
        button: record.button as LiveSurfaceDeviceButton,
      };
    }
    case 'rotate': {
      if (!onlyKeys(record, ['kind', 'orientation'])) return null;
      if (
        !LIVE_SURFACE_ORIENTATIONS.includes(
          record.orientation as LiveSurfaceOrientation,
        )
      )
        return null;
      return {
        kind: 'rotate',
        orientation: record.orientation as LiveSurfaceOrientation,
      };
    }
    default:
      return null;
  }
}

/** The body of `POST /api/live-surfaces/:surfaceId/input`. */
export interface LiveSurfaceInputBatch {
  /** The lease epoch the viewer last observed (frame header or state record). */
  epoch: number;
  events: LiveSurfaceInput[];
}

export function parseLiveSurfaceInputBatch(
  value: unknown,
): LiveSurfaceInputBatch | null {
  const record = plainRecord(value);
  if (!record || !onlyKeys(record, ['epoch', 'events'])) return null;
  if (!isLiveSurfaceEpoch(record.epoch)) return null;
  if (
    !Array.isArray(record.events) ||
    record.events.length === 0 ||
    record.events.length > LIVE_SURFACE_INPUT_MAX_EVENTS
  )
    return null;
  const events: LiveSurfaceInput[] = [];
  for (const event of record.events) {
    const parsed = parseLiveSurfaceInput(event);
    if (!parsed) return null;
    events.push(parsed);
  }
  return { epoch: record.epoch as number, events };
}

/**
 * The body of `POST /api/live-surfaces/:surfaceId/lease`. The HTTP seam only
 * ever acts for the authenticated HUMAN caller: an agent claims through the
 * server-side lease API with a verified session, never by naming a session in
 * a request body.
 */
export type LiveSurfaceLeaseRequest =
  | { action: 'claim' }
  | { action: 'release'; epoch: number };

export function parseLiveSurfaceLeaseRequest(
  value: unknown,
): LiveSurfaceLeaseRequest | null {
  const record = plainRecord(value);
  if (!record) return null;
  if (record.action === 'claim' && onlyKeys(record, ['action']))
    return { action: 'claim' };
  if (
    record.action === 'release' &&
    onlyKeys(record, ['action', 'epoch']) &&
    isLiveSurfaceEpoch(record.epoch)
  )
    return { action: 'release', epoch: record.epoch as number };
  return null;
}

export type LiveSurfaceStreamParamsParseResult =
  | { ok: true; params: LiveSurfaceStreamParams }
  | { ok: false; field: keyof LiveSurfaceStreamParams };

/**
 * Parse viewer-requested stream params from query-string values. An absent
 * field takes the default; a present field outside its bound is a refusal
 * (not a clamp), so a client learns its request was wrong.
 */
export function parseLiveSurfaceStreamParams(
  query: Partial<Record<keyof LiveSurfaceStreamParams, string | undefined>>,
): LiveSurfaceStreamParamsParseResult {
  const params: LiveSurfaceStreamParams = {
    ...LIVE_SURFACE_DEFAULT_STREAM_PARAMS,
  };
  for (const field of Object.keys(
    LIVE_SURFACE_STREAM_PARAM_BOUNDS,
  ) as (keyof LiveSurfaceStreamParams)[]) {
    const raw = query[field];
    if (raw === undefined) continue;
    if (!/^[0-9]{1,5}$/.test(raw)) return { ok: false, field };
    const value = Number(raw);
    const bound = LIVE_SURFACE_STREAM_PARAM_BOUNDS[field];
    if (value < bound.min || value > bound.max) return { ok: false, field };
    params[field] = value;
  }
  return { ok: true, params };
}

export function isLiveSurfaceStreamParams(
  value: unknown,
): value is LiveSurfaceStreamParams {
  const record = plainRecord(value);
  if (
    !record ||
    !onlyKeys(record, ['maxFps', 'quality', 'maxWidth', 'maxHeight'])
  )
    return false;
  return (
    Object.keys(
      LIVE_SURFACE_STREAM_PARAM_BOUNDS,
    ) as (keyof LiveSurfaceStreamParams)[]
  ).every((field) =>
    intInRange(
      record[field],
      LIVE_SURFACE_STREAM_PARAM_BOUNDS[field].min,
      LIVE_SURFACE_STREAM_PARAM_BOUNDS[field].max,
    ),
  );
}

function parseController(value: unknown): LiveSurfaceController | null {
  const record = plainRecord(value);
  if (!record) return null;
  if (
    record.kind === 'human' &&
    onlyKeys(record, ['kind', 'principal', 'device']) &&
    boundedText(record.principal, 512) &&
    (record.device === undefined || boundedText(record.device, 512))
  )
    return record.device === undefined
      ? { kind: 'human', principal: record.principal }
      : { kind: 'human', principal: record.principal, device: record.device };
  if (
    record.kind === 'agent' &&
    onlyKeys(record, ['kind', 'principal', 'sessionId']) &&
    boundedText(record.principal, 512) &&
    boundedText(record.sessionId, 512)
  )
    return {
      kind: 'agent',
      principal: record.principal,
      sessionId: record.sessionId,
    };
  return null;
}

export function parseLiveSurfaceControlLease(
  value: unknown,
): LiveSurfaceControlLease | null {
  const record = plainRecord(value);
  if (
    !record ||
    !onlyKeys(record, ['surfaceId', 'epoch', 'holder', 'expiresAt', 'fence']) ||
    (record.fence !== undefined && !isLiveSurfaceEpoch(record.fence)) ||
    !isLiveSurfaceId(record.surfaceId) ||
    !isLiveSurfaceEpoch(record.epoch)
  )
    return null;
  let holder: LiveSurfaceController | null = null;
  if (record.holder !== null) {
    holder = parseController(record.holder);
    if (!holder) return null;
  }
  if (
    record.expiresAt !== null &&
    !intInRange(record.expiresAt, 0, Number.MAX_SAFE_INTEGER)
  )
    return null;
  return {
    surfaceId: record.surfaceId,
    epoch: record.epoch as number,
    holder,
    expiresAt: record.expiresAt as number | null,
    ...(record.fence === undefined ? {} : { fence: record.fence as number }),
  };
}

export function parseLiveSurfaceFrameHeader(
  value: unknown,
): LiveSurfaceFrameHeader | null {
  const record = plainRecord(value);
  if (
    !record ||
    !onlyKeys(record, [
      'surfaceId',
      'seq',
      'epoch',
      'codec',
      'width',
      'height',
      'deviceScaleFactor',
      'capturedAt',
      'rotation',
    ]) ||
    (record.rotation !== undefined &&
      !LIVE_SURFACE_FRAME_ROTATIONS.includes(
        record.rotation as LiveSurfaceFrameRotation,
      )) ||
    !isLiveSurfaceId(record.surfaceId) ||
    !intInRange(record.seq, 0, Number.MAX_SAFE_INTEGER) ||
    !isLiveSurfaceEpoch(record.epoch) ||
    !LIVE_SURFACE_CODECS.includes(record.codec as LiveSurfaceCodec) ||
    !intInRange(record.width, 1, LIVE_SURFACE_COORDINATE_MAX) ||
    !intInRange(record.height, 1, LIVE_SURFACE_COORDINATE_MAX) ||
    !finiteInRange(
      record.deviceScaleFactor,
      LIVE_SURFACE_DEVICE_SCALE_FACTOR_MIN,
      LIVE_SURFACE_DEVICE_SCALE_FACTOR_MAX,
    ) ||
    !finiteInRange(record.capturedAt, 0, Number.MAX_SAFE_INTEGER)
  )
    return null;
  return {
    surfaceId: record.surfaceId,
    seq: record.seq as number,
    epoch: record.epoch as number,
    codec: record.codec as LiveSurfaceCodec,
    width: record.width as number,
    height: record.height as number,
    deviceScaleFactor: record.deviceScaleFactor as number,
    capturedAt: record.capturedAt as number,
    ...(record.rotation === undefined || record.rotation === 0
      ? {}
      : { rotation: record.rotation as LiveSurfaceFrameRotation }),
  };
}

/**
 * Stream state published alongside frames: the current lease (so a viewer
 * can show who is in control without polling) and the params the hub is
 * actually delivering at (which adaptive downgrade can lower). The server
 * also sends one as a heartbeat, which is what lets a client tell "the page
 * has not changed" from "the stream has stalled".
 */
export interface LiveSurfaceStreamState {
  surfaceId: string;
  lease: LiveSurfaceControlLease;
  effectiveParams: LiveSurfaceStreamParams;
  /**
   * Who THIS viewer is, as the server resolved it: compare with
   * `lease.holder` (principal and device) to tell "you" from "you on another
   * device" from "another person". Server-derived, never client-asserted.
   */
  viewer?: LiveSurfaceViewerIdentity;
  /**
   * The surface is not accepting input: a dispatch did not return in time
   * and has not settled (a page showing a JavaScript dialog does exactly
   * this). Input is refused `surface-wedged` until it clears. `wedgedSince`
   * is server time (ms), informational only.
   */
  wedged?: boolean;
  wedgedSince?: number | null;
  /**
   * Optional producer-reported liveness (added by the Device pane lane,
   * #1970). VIDEO and INPUT are separate channels on a device: a simulator's
   * picture can keep streaming while the socket that carries taps is down,
   * and a viewer must be told that rather than left tapping into nothing.
   *
   * - `inputChannel`: whether input can reach the surface right now.
   *   `reconnecting` and `down` both mean input is refused
   *   (`dispatch-failed`) until it is `connected` again.
   * - `videoMode`: `live` is a real stream; `snapshot-poll` is the honest
   *   name for a fallback that polls still screenshots at a low rate.
   * - `videoDegradedReason`: why the video is not `live`, when it is not.
   * - `orientation`: the device's orientation, when the producer knows it.
   */
  inputChannel?: LiveSurfaceInputChannelState;
  videoMode?: LiveSurfaceVideoMode;
  videoDegradedReason?: LiveSurfaceVideoDegradedReason;
  orientation?: LiveSurfaceOrientation;
  /**
   * Which host produces the surface, when the producer runs on a named
   * host (a device on the Station's own machine is `local`; D13).
   */
  hostId?: string;
}

export type LiveSurfaceInputChannelState =
  | 'connected'
  | 'reconnecting'
  | 'down';
export type LiveSurfaceVideoMode = 'live' | 'snapshot-poll';
/**
 * - `decoder-unavailable`: the stream needs a local decoder (Android's H.264)
 *   and none is installed; frames come from polled screenshots instead.
 * - `decoder-failed`: the decoder was found but could not keep running.
 */
export type LiveSurfaceVideoDegradedReason =
  | 'decoder-unavailable'
  | 'decoder-failed';

/** The producer-owned part of a stream state record (see above). */
export interface LiveSurfaceProducerStatus {
  inputChannel?: LiveSurfaceInputChannelState;
  videoMode?: LiveSurfaceVideoMode;
  videoDegradedReason?: LiveSurfaceVideoDegradedReason;
  orientation?: LiveSurfaceOrientation;
  hostId?: string;
}

/** A host id: short, URL-safe, and never a path or address. */
export const LIVE_SURFACE_HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const INPUT_CHANNEL_STATES: readonly LiveSurfaceInputChannelState[] = [
  'connected',
  'reconnecting',
  'down',
];
const VIDEO_MODES: readonly LiveSurfaceVideoMode[] = ['live', 'snapshot-poll'];
const VIDEO_DEGRADED_REASONS: readonly LiveSurfaceVideoDegradedReason[] = [
  'decoder-unavailable',
  'decoder-failed',
];

/**
 * Strictly parse the producer-owned status fields out of `record`; null when
 * any present field is malformed. Absent fields stay absent.
 */
function parseProducerStatus(
  record: Record<string, unknown>,
): LiveSurfaceProducerStatus | null {
  const out: LiveSurfaceProducerStatus = {};
  if (record.inputChannel !== undefined) {
    if (
      !INPUT_CHANNEL_STATES.includes(
        record.inputChannel as LiveSurfaceInputChannelState,
      )
    )
      return null;
    out.inputChannel = record.inputChannel as LiveSurfaceInputChannelState;
  }
  if (record.videoMode !== undefined) {
    if (!VIDEO_MODES.includes(record.videoMode as LiveSurfaceVideoMode))
      return null;
    out.videoMode = record.videoMode as LiveSurfaceVideoMode;
  }
  if (record.videoDegradedReason !== undefined) {
    if (
      !VIDEO_DEGRADED_REASONS.includes(
        record.videoDegradedReason as LiveSurfaceVideoDegradedReason,
      )
    )
      return null;
    out.videoDegradedReason =
      record.videoDegradedReason as LiveSurfaceVideoDegradedReason;
  }
  if (record.orientation !== undefined) {
    if (
      !LIVE_SURFACE_ORIENTATIONS.includes(
        record.orientation as LiveSurfaceOrientation,
      )
    )
      return null;
    out.orientation = record.orientation as LiveSurfaceOrientation;
  }
  if (record.hostId !== undefined) {
    if (
      typeof record.hostId !== 'string' ||
      !LIVE_SURFACE_HOST_ID_PATTERN.test(record.hostId)
    )
      return null;
    out.hostId = record.hostId;
  }
  return out;
}

export interface LiveSurfaceViewerIdentity {
  principal: string;
  device: string;
}

export function parseLiveSurfaceStreamState(
  value: unknown,
): LiveSurfaceStreamState | null {
  const record = plainRecord(value);
  if (
    !record ||
    !onlyKeys(record, [
      'surfaceId',
      'lease',
      'effectiveParams',
      'viewer',
      'wedged',
      'wedgedSince',
      'inputChannel',
      'videoMode',
      'videoDegradedReason',
      'orientation',
      'hostId',
    ]) ||
    (record.wedged !== undefined && typeof record.wedged !== 'boolean') ||
    (record.wedgedSince !== undefined &&
      record.wedgedSince !== null &&
      !intInRange(record.wedgedSince, 0, Number.MAX_SAFE_INTEGER)) ||
    !isLiveSurfaceId(record.surfaceId) ||
    !isLiveSurfaceStreamParams(record.effectiveParams)
  )
    return null;
  const lease = parseLiveSurfaceControlLease(record.lease);
  if (!lease || lease.surfaceId !== record.surfaceId) return null;
  const producerStatus = parseProducerStatus(record);
  if (!producerStatus) return null;
  let viewer: LiveSurfaceViewerIdentity | undefined;
  if (record.viewer !== undefined) {
    const identity = plainRecord(record.viewer);
    if (
      !identity ||
      !onlyKeys(identity, ['principal', 'device']) ||
      !boundedText(identity.principal, 512) ||
      !boundedText(identity.device, 512)
    )
      return null;
    viewer = { principal: identity.principal, device: identity.device };
  }
  return {
    surfaceId: record.surfaceId,
    lease,
    effectiveParams: { ...record.effectiveParams },
    ...(viewer ? { viewer } : {}),
    ...(record.wedged === undefined ? {} : { wedged: record.wedged }),
    ...(record.wedgedSince === undefined
      ? {}
      : { wedgedSince: record.wedgedSince as number | null }),
    ...producerStatus,
  };
}

// ---------------------------------------------------------------------------
// Binary record envelope
//
//   offset 0  u8   version (LIVE_SURFACE_RECORD_VERSION)
//   offset 1  u8   kind    (1 = frame, 2 = state)
//   offset 2  u32  header length in bytes (big-endian)
//   offset 6  u32  body length in bytes (big-endian)
//   offset 10      header: UTF-8 JSON (LiveSurfaceFrameHeader | LiveSurfaceStreamState)
//                  body:   encoded image bytes (frames); empty for state
// ---------------------------------------------------------------------------

export const LIVE_SURFACE_FRAMES_CONTENT_TYPE =
  'application/x-station-live-surface-frames';
export const LIVE_SURFACE_RECORD_VERSION = 1;
export const LIVE_SURFACE_RECORD_PREFIX_BYTES = 10;
export const LIVE_SURFACE_RECORD_MAX_HEADER_BYTES = 4 * 1024;
export const LIVE_SURFACE_RECORD_MAX_BODY_BYTES = 8 * 1024 * 1024;

const RECORD_KIND_FRAME = 1;
const RECORD_KIND_STATE = 2;

export type LiveSurfaceRecord =
  | { kind: 'frame'; header: LiveSurfaceFrameHeader; body: Uint8Array }
  | { kind: 'state'; state: LiveSurfaceStreamState };

export class LiveSurfaceRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveSurfaceRecordError';
  }
}

export function encodeLiveSurfaceRecord(record: LiveSurfaceRecord): Uint8Array {
  const headerBytes = new TextEncoder().encode(
    JSON.stringify(record.kind === 'frame' ? record.header : record.state),
  );
  const body = record.kind === 'frame' ? record.body : new Uint8Array(0);
  if (headerBytes.byteLength > LIVE_SURFACE_RECORD_MAX_HEADER_BYTES)
    throw new LiveSurfaceRecordError('record header exceeds its bound');
  if (body.byteLength > LIVE_SURFACE_RECORD_MAX_BODY_BYTES)
    throw new LiveSurfaceRecordError('record body exceeds its bound');
  const out = new Uint8Array(
    LIVE_SURFACE_RECORD_PREFIX_BYTES + headerBytes.byteLength + body.byteLength,
  );
  const view = new DataView(out.buffer);
  view.setUint8(0, LIVE_SURFACE_RECORD_VERSION);
  view.setUint8(
    1,
    record.kind === 'frame' ? RECORD_KIND_FRAME : RECORD_KIND_STATE,
  );
  view.setUint32(2, headerBytes.byteLength);
  view.setUint32(6, body.byteLength);
  out.set(headerBytes, LIVE_SURFACE_RECORD_PREFIX_BYTES);
  out.set(body, LIVE_SURFACE_RECORD_PREFIX_BYTES + headerBytes.byteLength);
  return out;
}

/**
 * Incremental decoder for a frames response body. Feed it chunks as they
 * arrive (chunk boundaries are arbitrary; the relay re-chunks at 16 KB) and
 * it yields complete records. Any malformed prefix or header is fatal for
 * the stream: the decoder throws `LiveSurfaceRecordError` and the caller
 * must drop the connection, because a length-prefixed stream cannot resync.
 *
 * Buffering is linear: chunks are kept as a list and each byte is copied
 * once, into the record it belongs to. (Concatenating on every push is
 * quadratic — a 2 MB frame in 16 KB chunks copied ~128 MB.)
 */
export class LiveSurfaceRecordDecoder {
  private chunks: Uint8Array[] = [];
  /** Index of the first unconsumed chunk (no O(n) `shift` per chunk). */
  private head = 0;
  /** Offset into `chunks[head]` of the first unconsumed byte. */
  private offset = 0;
  private buffered = 0;

  push(chunk: Uint8Array): LiveSurfaceRecord[] {
    if (chunk.byteLength > 0) {
      this.chunks.push(chunk);
      this.buffered += chunk.byteLength;
    }
    const records: LiveSurfaceRecord[] = [];
    while (this.buffered >= LIVE_SURFACE_RECORD_PREFIX_BYTES) {
      const prefix = this.peek(LIVE_SURFACE_RECORD_PREFIX_BYTES);
      const view = new DataView(
        prefix.buffer,
        prefix.byteOffset,
        prefix.byteLength,
      );
      const version = view.getUint8(0);
      const kind = view.getUint8(1);
      const headerLength = view.getUint32(2);
      const bodyLength = view.getUint32(6);
      if (version !== LIVE_SURFACE_RECORD_VERSION)
        throw new LiveSurfaceRecordError(
          `unsupported record version ${version}`,
        );
      if (kind !== RECORD_KIND_FRAME && kind !== RECORD_KIND_STATE)
        throw new LiveSurfaceRecordError(`unknown record kind ${kind}`);
      if (
        headerLength === 0 ||
        headerLength > LIVE_SURFACE_RECORD_MAX_HEADER_BYTES
      )
        throw new LiveSurfaceRecordError('record header length out of bounds');
      if (bodyLength > LIVE_SURFACE_RECORD_MAX_BODY_BYTES)
        throw new LiveSurfaceRecordError('record body length out of bounds');
      if (kind === RECORD_KIND_STATE && bodyLength !== 0)
        throw new LiveSurfaceRecordError('state record carries a body');
      const total =
        LIVE_SURFACE_RECORD_PREFIX_BYTES + headerLength + bodyLength;
      if (this.buffered < total) break;
      this.take(LIVE_SURFACE_RECORD_PREFIX_BYTES);
      const headerBytes = this.take(headerLength);
      const body = this.take(bodyLength);
      let json: unknown;
      try {
        json = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(headerBytes),
        );
      } catch {
        throw new LiveSurfaceRecordError('record header is not UTF-8 JSON');
      }
      if (kind === RECORD_KIND_FRAME) {
        const header = parseLiveSurfaceFrameHeader(json);
        if (!header) throw new LiveSurfaceRecordError('invalid frame header');
        records.push({ kind: 'frame', header, body });
      } else {
        const state = parseLiveSurfaceStreamState(json);
        if (!state) throw new LiveSurfaceRecordError('invalid state record');
        records.push({ kind: 'state', state });
      }
    }
    return records;
  }

  /** Bytes buffered toward an incomplete record. */
  get pendingBytes(): number {
    return this.buffered;
  }

  /** Copy of the next `length` bytes without consuming them (prefix only). */
  private peek(length: number): Uint8Array {
    const out = new Uint8Array(length);
    let written = 0;
    let offset = this.offset;
    for (let index = this.head; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index]!;
      const part = chunk.subarray(offset, offset + (length - written));
      out.set(part, written);
      written += part.byteLength;
      offset = 0;
      if (written === length) break;
    }
    return out;
  }

  /** Consume the next `length` bytes into a new, owned array. */
  private take(length: number): Uint8Array {
    const out = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const chunk = this.chunks[this.head]!;
      const available = chunk.byteLength - this.offset;
      const count = Math.min(available, length - written);
      out.set(chunk.subarray(this.offset, this.offset + count), written);
      written += count;
      this.offset += count;
      if (this.offset === chunk.byteLength) {
        this.head += 1;
        this.offset = 0;
      }
    }
    // Drop consumed chunks in bulk, amortized O(1) per chunk.
    if (this.head > 0 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
    this.buffered -= length;
    return out;
  }
}
