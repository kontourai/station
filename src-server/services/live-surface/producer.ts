import type {
  LiveSurfaceCodec,
  LiveSurfaceFrameHeader,
  LiveSurfaceInput,
  LiveSurfacePointerButton,
  LiveSurfaceStreamParams,
} from '@kontourai/station-contracts/live-surface';

/**
 * What a controller had pressed when it lost control: buttons it sent a
 * `down` for without an `up`, keys likewise, and where the pointer was.
 */
export interface LiveSurfaceHeldInput {
  buttons: LiveSurfacePointerButton[];
  keys: { key: string; code: string }[];
  pointer: { x: number; y: number };
}

/**
 * A producer is any frame + input source behind a live surface: a Chromium
 * screencast (Browser pane), later a device mirror (Device pane).
 *
 * Contract the hub relies on:
 * - `start`/`stop` control the FRAME STREAM only (a screencast), never the
 *   surface itself: `start` when the first viewer attaches, `stop` when the
 *   last one leaves, and `start` again later. `dispatch` must work whether or
 *   not the stream is running, because an agent may drive a surface nobody
 *   is watching (D6). Stopping a producer must not close the page.
 * - `seq` strictly increases within one run.
 * - `ack(seq)` is backpressure (CDP `Page.screencastFrameAck`): a producer
 *   that honours it emits no further frame until the previous one is acked.
 *   The hub acks every frame exactly once — on first delivery to a viewer, on
 *   an fps-throttle drop, or when a newer frame supersedes it undelivered.
 * - The hub fills the frame header's `epoch` from the lease; whatever the
 *   producer put there is overwritten.
 */
export interface LiveSurfaceProducer {
  readonly surfaceId: string;
  readonly capabilities: {
    codecs: readonly LiveSurfaceCodec[];
    input: readonly LiveSurfaceInput['kind'][];
  };
  start(
    params: LiveSurfaceStreamParams,
    onFrame: (header: LiveSurfaceFrameHeader, body: Uint8Array) => void,
  ): Promise<void>;
  ack(seq: number): void;
  stop(): Promise<void>;
  dispatch(input: LiveSurfaceInput): Promise<void>;
  /**
   * Optional (added by the live-surface lane, not in the v1 brief): apply new
   * params to a running stream without a restart, e.g. when adaptive
   * downgrade lowers fps. A producer without it keeps its start params and
   * the hub enforces the lower fps by throttling delivery instead.
   */
  updateParams?(params: LiveSurfaceStreamParams): Promise<void>;
  /**
   * Optional: release input the previous controller left held, WITHOUT
   * completing its gesture. Called when control changes hands or is
   * released while something is pressed. It must not release a button at
   * the point where it was pressed — a `down` then `up` on the same target
   * is a click, and a human grabbing control to STOP an agent's click must
   * not be the thing that completes it.
   *
   * Without this hook the registry dispatches a neutral cancel: a pointer
   * move to (-1, -1), outside every viewport, then each button's `up` there,
   * then each key's `up`. A CDP producer can do better (e.g. dispatch the
   * release with the target removed from hit testing).
   */
  cancelHeldInput?(held: LiveSurfaceHeldInput): Promise<void>;
}
