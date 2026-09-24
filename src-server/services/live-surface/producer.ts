import type {
  LiveSurfaceCodec,
  LiveSurfaceFrameHeader,
  LiveSurfaceInput,
  LiveSurfacePointerButton,
  LiveSurfacePointerType,
  LiveSurfaceProducerStatus,
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
  /** The type of the most recent pointer down. */
  pointerType: LiveSurfacePointerType;
  /** The pointer type each held button's down was dispatched as. */
  buttonPointerTypes: Partial<
    Record<LiveSurfacePointerButton, LiveSurfacePointerType>
  >;
}

/**
 * Passed with each dispatch (added by the Device pane lane, #1970). The
 * registry fences before every EVENT; a producer that turns one event into
 * several sends (a typed string on a keyboard that only takes keystrokes, a
 * touch that is a move and a lift) asks `isCurrent` before each send, so a
 * human taking control mid-event stops it at the next send, not after the
 * whole event. A producer free to ignore it: the registry's own fence still
 * holds between events.
 */
export interface LiveSurfaceDispatchContext {
  /** The controller this dispatch runs for still holds the lease at its fence. */
  isCurrent(): boolean;
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
 *
 * REQUIRED of every producer (not enforced by types — the surface wedges if
 * a producer ignores it):
 * - Handle JavaScript dialogs itself. A page whose handler calls `alert()`
 *   leaves the input that triggered it pending until the dialog closes (in
 *   CDP, `Input.dispatchMouseEvent` does not resolve). Subscribe to the
 *   dialog event and answer it (CDP: `Page.javascriptDialogOpening` →
 *   `Page.handleJavaScriptDialog`), so input never waits on a dialog nobody
 *   can see.
 * - Bound its own dispatch. The registry's dispatch timeout WEDGES the
 *   surface (input refused `surface-wedged`, and shown to viewers) until
 *   the stuck dispatch settles; it cannot cancel it. A producer that never
 *   settles a dispatch leaves the surface wedged forever.
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
  dispatch(
    input: LiveSurfaceInput,
    context?: LiveSurfaceDispatchContext,
  ): Promise<void>;
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
   * then each key's `up`. Cancel each held input in the SAME modality its
   * down was dispatched in (`buttonPointerTypes`): a touch is cancelled as
   * a touch, a mouse button as a mouse button. A CDP producer should do
   * better than the default: for a touch
   * (`held.pointerType === 'touch'`) dispatch `Input.dispatchTouchEvent`
   * with `type: 'touchCancel'`, which ends the gesture without a tap.
   */
  cancelHeldInput?(held: LiveSurfaceHeldInput): Promise<void>;
  /**
   * Optional (added by the Device pane lane, #1970): liveness the producer
   * owns and viewers must see — whether input can reach the surface, whether
   * video is a real stream or a polled fallback, the device orientation. The
   * hub merges it into every state record, and re-sends state to every
   * viewer when `onStatusChange` fires. Must not throw.
   */
  status?(): LiveSurfaceProducerStatus;
  /** Subscribe to `status` changes; returns an unsubscribe function. */
  onStatusChange?(listener: () => void): () => void;
}
