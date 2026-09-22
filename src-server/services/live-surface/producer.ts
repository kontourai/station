import type {
  LiveSurfaceCodec,
  LiveSurfaceFrameHeader,
  LiveSurfaceInput,
  LiveSurfaceStreamParams,
} from '@kontourai/station-contracts/live-surface';

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
}
