import type {
  LiveSurfaceFrameHeader,
  LiveSurfaceInput,
  LiveSurfaceStreamParams,
} from '@kontourai/station-contracts/live-surface';
import type {
  LiveSurfaceHeldInput,
  LiveSurfaceProducer,
} from '../services/live-surface/producer.js';

/**
 * TEST-ONLY producer (#90): proves the hub, lease, routes and canvas without
 * Chromium. Each frame body is a tiny generated "image" — 4 bytes of a
 * gradient keyed by the counter, then the counter as u32 — so a test can
 * decode a frame and say exactly which one it received.
 *
 * It honours backpressure like a CDP screencast: with `backpressure` on (the
 * default) `emit()` refuses to produce another frame until the previous one
 * is acked, and returns false. `dispatched` echoes every input it receives.
 */
export class SyntheticLiveSurfaceProducer implements LiveSurfaceProducer {
  readonly capabilities: LiveSurfaceProducer['capabilities'];
  starts: LiveSurfaceStreamParams[] = [];
  stops = 0;
  acks: number[] = [];
  paramUpdates: LiveSurfaceStreamParams[] = [];
  dispatched: LiveSurfaceInput[] = [];
  private onFrame:
    | ((header: LiveSurfaceFrameHeader, body: Uint8Array) => void)
    | null = null;
  private seq = 0;
  private outstanding: number | null = null;
  private readonly backpressure: boolean;
  dispatchImpl: (input: LiveSurfaceInput) => Promise<void> = async () => {};

  constructor(
    readonly surfaceId: string,
    options: {
      backpressure?: boolean;
      input?: LiveSurfaceInput['kind'][];
      width?: number;
      height?: number;
      deviceScaleFactor?: number;
      withUpdateParams?: boolean;
    } = {},
  ) {
    this.backpressure = options.backpressure ?? true;
    this.capabilities = {
      codecs: ['png'] as const,
      input: options.input ?? (['pointer', 'key', 'text'] as const),
    };
    this.size = {
      width: options.width ?? 320,
      height: options.height ?? 200,
      deviceScaleFactor: options.deviceScaleFactor ?? 1,
    };
    if (options.withUpdateParams === false) this.updateParams = undefined;
  }

  size: { width: number; height: number; deviceScaleFactor: number };

  get running(): boolean {
    return this.onFrame !== null;
  }

  async start(
    params: LiveSurfaceStreamParams,
    onFrame: (header: LiveSurfaceFrameHeader, body: Uint8Array) => void,
  ): Promise<void> {
    this.starts.push({ ...params });
    this.onFrame = onFrame;
    this.outstanding = null;
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.onFrame = null;
    this.outstanding = null;
  }

  ack(seq: number): void {
    this.acks.push(seq);
    if (this.outstanding === seq) this.outstanding = null;
  }

  /** Absent by default, so the registry's neutral cancel is exercised. */
  cancelHeldInput?: (held: LiveSurfaceHeldInput) => Promise<void>;

  updateParams?: (params: LiveSurfaceStreamParams) => Promise<void> = async (
    params,
  ) => {
    this.paramUpdates.push({ ...params });
  };

  async dispatch(input: LiveSurfaceInput): Promise<void> {
    this.dispatched.push(input);
    await this.dispatchImpl(input);
  }

  /** Produce the next frame. False when not running or awaiting an ack. */
  emit(): boolean {
    if (!this.onFrame) return false;
    if (this.backpressure && this.outstanding !== null) return false;
    this.seq += 1;
    const seq = this.seq;
    this.outstanding = seq;
    this.onFrame(
      {
        surfaceId: this.surfaceId,
        seq,
        epoch: 0,
        codec: 'png',
        width: this.size.width,
        height: this.size.height,
        deviceScaleFactor: this.size.deviceScaleFactor,
        capturedAt: Date.now(),
      },
      syntheticFrameBody(seq),
    );
    return true;
  }
}

function syntheticFrameBody(seq: number): Uint8Array {
  const body = new Uint8Array(8);
  body.set([seq % 256, (seq * 3) % 256, (seq * 7) % 256, 255], 0);
  new DataView(body.buffer).setUint32(4, seq);
  return body;
}

export function syntheticFrameCounter(body: Uint8Array): number {
  return new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(
    4,
  );
}
