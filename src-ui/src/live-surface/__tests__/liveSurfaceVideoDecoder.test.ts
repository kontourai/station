import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LiveSurfaceFrameHeader } from '@kontourai/station-contracts/live-surface';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  LiveSurfaceH264Decoder,
  liveSurfaceH264Capable,
} from '../liveSurfaceVideoDecoder';

// SPS, PPS, IDR and two deltas cut from a recorded Android emulator stream.
const sample = new Uint8Array(
  readFileSync(
    resolve(
      import.meta.dirname,
      '../../../../tests/fixtures/live-surface/android-emulator-1080x2400-baseline.h264',
    ),
  ),
);

function header(seq: number, keyframe: boolean): LiveSurfaceFrameHeader {
  return {
    surfaceId: 'device:android:test',
    seq,
    epoch: 0,
    codec: 'h264',
    keyframe,
    width: 576,
    height: 1280,
    deviceScaleFactor: 1,
    capturedAt: 1,
  };
}

/** A stand-in for WebCodecs: records configs and chunks; tests drive errors. */
class FakeVideoDecoder {
  static instances: FakeVideoDecoder[] = [];
  static supported = true;
  static checks: VideoDecoderConfig[] = [];
  static gate: Promise<void> = Promise.resolve();
  static async isConfigSupported(config: VideoDecoderConfig) {
    FakeVideoDecoder.checks.push(config);
    await FakeVideoDecoder.gate;
    return { supported: FakeVideoDecoder.supported, config };
  }
  state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
  configs: VideoDecoderConfig[] = [];
  chunks: { type: string; timestamp: number }[] = [];
  constructor(readonly init: VideoDecoderInit) {
    FakeVideoDecoder.instances.push(this);
  }
  configure(config: VideoDecoderConfig) {
    this.configs.push(config);
    this.state = 'configured';
  }
  decode(chunk: { type: string; timestamp: number }) {
    if (this.state !== 'configured') throw new Error('not configured');
    this.chunks.push({ type: chunk.type, timestamp: chunk.timestamp });
  }
  close() {
    this.state = 'closed';
  }
}

beforeEach(() => {
  FakeVideoDecoder.instances = [];
  FakeVideoDecoder.supported = true;
  FakeVideoDecoder.checks = [];
  FakeVideoDecoder.gate = Promise.resolve();
  vi.stubGlobal(
    'EncodedVideoChunk',
    class {
      constructor(init: object) {
        Object.assign(this, init);
      }
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function build() {
  const errors: unknown[] = [];
  const decoder = new LiveSurfaceH264Decoder(
    { onPicture: () => {}, onError: (error) => errors.push(error) },
    FakeVideoDecoder as unknown as typeof VideoDecoder,
  );
  return { decoder, errors };
}

const delta = Uint8Array.from([0, 0, 0, 1, 0x41, 0x9a]);

describe('client H.264 decoding (#4418)', () => {
  test('asks for H.264 only in a secure context that has WebCodecs', () => {
    expect(
      liveSurfaceH264Capable({ isSecureContext: true, VideoDecoder: class {} }),
    ).toBe(true);
    expect(
      liveSurfaceH264Capable({
        isSecureContext: false,
        VideoDecoder: class {},
      }),
    ).toBe(false);
    expect(liveSurfaceH264Capable({ isSecureContext: true })).toBe(false);
  });

  test('never decodes a delta before a keyframe; configures from the SPS', async () => {
    const { decoder, errors } = build();
    expect(await decoder.decode(header(1, false), delta)).toBe(
      'awaiting-keyframe',
    );
    // A quiet drop, not a failure: no error, so no reconnect for a keyframe.
    expect(errors).toEqual([]);
    expect(FakeVideoDecoder.instances).toHaveLength(0);
    expect(await decoder.decode(header(2, true), sample)).toBe('decoding');
    expect(FakeVideoDecoder.checks[0]).toMatchObject({
      codec: 'avc1.42c032',
      codedWidth: 1080,
      codedHeight: 2400,
    });
    expect(await decoder.decode(header(3, false), delta)).toBe('decoding');
    expect(FakeVideoDecoder.instances[0]!.chunks).toEqual([
      { type: 'key', timestamp: 2 },
      { type: 'delta', timestamp: 3 },
    ]);
  });

  test('deltas that arrive while the profile is being checked keep their order', async () => {
    const { decoder } = build();
    let open!: () => void;
    FakeVideoDecoder.gate = new Promise((resolve) => {
      open = resolve;
    });
    const outcomes = [
      decoder.decode(header(1, true), sample),
      decoder.decode(header(2, false), delta),
      decoder.decode(header(3, false), delta),
    ];
    open();
    expect(await Promise.all(outcomes)).toEqual([
      'decoding',
      'decoding',
      'decoding',
    ]);
    expect(
      FakeVideoDecoder.instances[0]!.chunks.map((chunk) => chunk.timestamp),
    ).toEqual([1, 2, 3]);
  });

  test('a profile the browser refuses is reported, and nothing is decoded', async () => {
    FakeVideoDecoder.supported = false;
    const { decoder } = build();
    expect(await decoder.decode(header(1, true), sample)).toBe('unsupported');
    expect(FakeVideoDecoder.instances).toHaveLength(0);
  });

  test('a decode error resets the decoder, which then waits for a keyframe', async () => {
    const { decoder, errors } = build();
    await decoder.decode(header(1, true), sample);
    const first = FakeVideoDecoder.instances[0]!;
    first.init.error(new DOMException('corrupt', 'EncodingError'));
    expect(errors).toHaveLength(1);
    expect(first.state).toBe('closed');
    expect(await decoder.decode(header(2, false), delta)).toBe(
      'awaiting-keyframe',
    );
    expect(errors).toHaveLength(1);
    expect(await decoder.decode(header(3, true), sample)).toBe('decoding');
    const second = FakeVideoDecoder.instances[1]!;
    expect(second.configs).toHaveLength(1);
    expect(second.chunks).toEqual([{ type: 'key', timestamp: 3 }]);
  });
});
