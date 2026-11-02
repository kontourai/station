import {
  type LiveSurfaceFrameHeader,
  parseLiveSurfaceH264Sequence,
} from '@kontourai/station-contracts/live-surface';

/**
 * Client-side H.264 for a live surface (#4418).
 *
 * The host can pass Android's H.264 access units through instead of
 * decoding them to JPEG on the server. This viewer asks for them only where
 * WebCodecs can decode them: a secure context (loopback or HTTPS) with
 * `VideoDecoder`. The profile is checked per stream, from the SPS the first
 * keyframe carries, with `VideoDecoder.isConfigSupported`; a profile the
 * browser refuses makes the viewer fall back to images.
 *
 * Decoding never starts on a delta: the decoder waits for a keyframe after
 * it is created, after every reconfiguration, and after any decode error
 * (which also resets it). The hub never sends a delta before a keyframe
 * either; this is the client's own guard.
 */

/**
 * Units the decoder may hold before the viewer counts as behind (about a
 * second at 30 fps). Behind, it resets and waits for a keyframe rather than
 * queueing without bound.
 */
export const LIVE_SURFACE_DECODE_MAX_PENDING = 30;

/** Whether this page can ask for H.264 at all. */
export function liveSurfaceH264Capable(
  scope: { isSecureContext?: boolean; VideoDecoder?: unknown } = globalThis,
): boolean {
  return (
    scope.isSecureContext === true && typeof scope.VideoDecoder === 'function'
  );
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  );
}

/**
 * Whether this viewer asks `apiBase` for H.264: a capable page, talking to a
 * loopback Station. Relay and other remote paths are not qualified for an
 * inter-frame stream yet (a slow link turns into keyframe resyncs), so they
 * keep images until they are.
 */
export function liveSurfaceH264Offered(
  apiBase: string,
  scope: {
    isSecureContext?: boolean;
    VideoDecoder?: unknown;
    location?: { href: string };
  } = globalThis,
): boolean {
  if (!liveSurfaceH264Capable(scope)) return false;
  try {
    return isLoopbackHost(new URL(apiBase, scope.location?.href).hostname);
  } catch {
    return false;
  }
}

export type LiveSurfaceDecodeOutcome =
  /** The unit went to the decoder. */
  | 'decoding'
  /** A delta while waiting for a keyframe: dropped. */
  | 'awaiting-keyframe'
  /** The browser cannot decode this stream's profile: use images. */
  | 'unsupported';

export interface LiveSurfaceH264DecoderCallbacks {
  /** A decoded picture and the header of the unit it came from. Close it. */
  onPicture: (picture: VideoFrame, header: LiveSurfaceFrameHeader) => void;
  /**
   * The decoder failed and was reset; it waits for the next keyframe. The
   * owner should ask the host for one (a fresh stream starts at one).
   */
  onError: (error: unknown) => void;
}

type VideoDecoderConstructor = typeof VideoDecoder;

export class LiveSurfaceH264Decoder {
  private decoder: VideoDecoder | null = null;
  /**
   * The stream the decoder is configured for, or null: not yet, or reset
   * after an error. Only a keyframe configures it, so while it is null no
   * delta reaches the decoder.
   */
  private configured: string | null = null;
  private closed = false;
  /** Units are decoded strictly in order, even across a config check. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Headers of units in the decoder, in order, matched to its outputs. */
  private readonly inFlight = new Map<number, LiveSurfaceFrameHeader>();

  constructor(
    private readonly callbacks: LiveSurfaceH264DecoderCallbacks,
    private readonly Decoder: VideoDecoderConstructor = globalThis.VideoDecoder,
  ) {}

  decode(
    header: LiveSurfaceFrameHeader,
    body: Uint8Array,
  ): Promise<LiveSurfaceDecodeOutcome> {
    const next = this.chain.then(() => this.decodeInOrder(header, body));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async decodeInOrder(
    header: LiveSurfaceFrameHeader,
    body: Uint8Array,
  ): Promise<LiveSurfaceDecodeOutcome> {
    if (this.closed) return 'awaiting-keyframe';
    if (header.keyframe) {
      // A keyframe without parameter sets decodes under the current ones.
      const sequence = parseLiveSurfaceH264Sequence(body);
      if (!sequence && !this.configured) return 'awaiting-keyframe';
      const key =
        sequence && `${sequence.codec}:${sequence.width}x${sequence.height}`;
      if (sequence && key !== this.configured) {
        const config: VideoDecoderConfig = {
          codec: sequence.codec,
          codedWidth: sequence.width,
          codedHeight: sequence.height,
          optimizeForLatency: true,
        };
        let supported = false;
        try {
          supported =
            (await this.Decoder.isConfigSupported(config)).supported === true;
        } catch {
          supported = false;
        }
        if (this.closed) return 'awaiting-keyframe';
        if (!supported) return 'unsupported';
        const decoder = this.ensureDecoder();
        try {
          decoder.configure(config);
        } catch {
          // Claimed supported, refused anyway: images, not a resync loop.
          this.reset();
          return 'unsupported';
        }
        this.configured = key;
      }
    } else if (!this.configured) {
      return 'awaiting-keyframe';
    }
    const decoder = this.decoder!;
    if (
      this.inFlight.size >= LIVE_SURFACE_DECODE_MAX_PENDING ||
      decoder.decodeQueueSize >= LIVE_SURFACE_DECODE_MAX_PENDING
    ) {
      this.fail(new Error('the decoder fell behind'));
      return 'awaiting-keyframe';
    }
    const timestamp = header.seq;
    this.inFlight.set(timestamp, header);
    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: header.keyframe ? 'key' : 'delta',
          timestamp,
          data: body,
        }),
      );
    } catch (error) {
      this.fail(error);
      return 'awaiting-keyframe';
    }
    return 'decoding';
  }

  close(): void {
    this.closed = true;
    this.inFlight.clear();
    const decoder = this.decoder;
    this.decoder = null;
    if (decoder && decoder.state !== 'closed') decoder.close();
  }

  private ensureDecoder(): VideoDecoder {
    if (this.decoder && this.decoder.state !== 'closed') return this.decoder;
    const decoder: VideoDecoder = new this.Decoder({
      output: (picture) => {
        const header = this.inFlight.get(picture.timestamp);
        this.inFlight.delete(picture.timestamp);
        if (this.closed || decoder !== this.decoder || !header) {
          picture.close();
          return;
        }
        this.callbacks.onPicture(picture, header);
      },
      error: (error) => {
        if (decoder === this.decoder) this.fail(error);
      },
    });
    this.decoder = decoder;
    return decoder;
  }

  /** Reset after an error: nothing decodes again until a keyframe. */
  private fail(error: unknown): void {
    this.reset();
    if (!this.closed) this.callbacks.onError(error);
  }

  private reset(): void {
    this.configured = null;
    this.inFlight.clear();
    const decoder = this.decoder;
    this.decoder = null;
    try {
      if (decoder && decoder.state !== 'closed') decoder.close();
    } catch {
      // already closed by the error
    }
  }
}
