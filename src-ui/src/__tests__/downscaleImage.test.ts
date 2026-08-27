// @vitest-environment jsdom

import { describe, expect, test, vi } from 'vitest';
import {
  canResizeFormat,
  type DownscaleAttempt,
  type DownscaleOutcome,
  downscaleAttempts,
  downscaleImageToFit,
  formatNotResizableReason,
  type ImageDecoder,
  type ImageReencoder,
} from '../utils/downscaleImage';

const MAX_BYTES = 4_000;

/** The resized image, or null for either refusal — keeps assertions readable. */
function resized(outcome: DownscaleOutcome) {
  return outcome.status === 'resized' ? outcome.image : null;
}

/** Counts decodes so the ladder cannot quietly go back to one per attempt. */
function countingDecoder(width = 4_000, height = 3_000) {
  const closed = vi.fn();
  const decode = vi.fn<ImageDecoder>(async () => ({
    width,
    height,
    close: closed,
  }));
  return { decode, closed };
}

/** Decoded byte count of a data URL, derived the way the server derives it. */
function decodedBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

function recordingReencoder(
  policy: (
    attempt: DownscaleAttempt,
  ) => number | { bytes: number; type: string } | null,
) {
  const attempts: DownscaleAttempt[] = [];
  const reencode: ImageReencoder = async (_source, attempt) => {
    attempts.push(attempt);
    const outcome = policy(attempt);
    if (outcome === null) return null;
    const { bytes, type } =
      typeof outcome === 'number'
        ? { bytes: outcome, type: attempt.mimeType }
        : outcome;
    return {
      blob: new Blob([new Uint8Array(bytes)], { type }),
      width: attempt.maxEdge,
      height: Math.round(attempt.maxEdge / 2),
    };
  };
  return { reencode, attempts };
}

const source = new Blob([new Uint8Array(64_000)], { type: 'image/png' });

describe('downscaleAttempts', () => {
  test('tries the source format once before spending quality', () => {
    const attempts = downscaleAttempts('image/png');

    expect(attempts[0]).toEqual({
      maxEdge: 2048,
      mimeType: 'image/png',
      quality: 1,
    });
    expect(
      attempts.filter((attempt) => attempt.mimeType === 'image/png'),
    ).toHaveLength(1);
  });

  test('falls back to WebP before JPEG so alpha survives a PNG source', () => {
    const fallbacks = downscaleAttempts('image/png')
      .slice(1)
      .map((attempt) => attempt.mimeType);

    expect(fallbacks.indexOf('image/webp')).toBeLessThan(
      fallbacks.indexOf('image/jpeg'),
    );
  });

  test('never re-encodes a GIF, whose animation a canvas cannot carry', () => {
    expect(downscaleAttempts('image/gif')).toEqual([]);
  });
});

describe('canResizeFormat', () => {
  test('answers from the ladder itself, not a second list', () => {
    for (const mimeType of ['image/png', 'image/jpeg', 'image/webp'] as const) {
      expect(canResizeFormat(mimeType)).toBe(
        downscaleAttempts(mimeType).length > 0,
      );
      expect(canResizeFormat(mimeType)).toBe(true);
    }
    expect(canResizeFormat('image/gif')).toBe(false);
    expect(downscaleAttempts('image/gif')).toHaveLength(0);
  });

  test('says why, in terms of what was actually withheld', () => {
    expect(formatNotResizableReason()).toMatch(/animated/i);
    expect(formatNotResizableReason()).toMatch(/single frame/i);
  });
});

describe('downscaleImageToFit', () => {
  test('keeps the source format when one re-encode already fits', async () => {
    const { decode } = countingDecoder();
    const { reencode, attempts } = recordingReencoder(() => 3_000);

    const outcome = await downscaleImageToFit(
      source,
      'image/jpeg',
      MAX_BYTES,
      reencode,
      decode,
    );
    const result = resized(outcome);

    expect(result?.mimeType).toBe('image/jpeg');
    expect(attempts).toHaveLength(1);
  });

  test('reports the decoded byte count of the bytes it produced', async () => {
    const { decode } = countingDecoder();
    const { reencode } = recordingReencoder(() => 3_000);

    const outcome = await downscaleImageToFit(
      source,
      'image/jpeg',
      MAX_BYTES,
      reencode,
      decode,
    );
    const result = resized(outcome);

    expect(result?.bytes).toBe(3_000);
    expect(result?.bytes).toBe(decodedBytes(result?.dataUrl ?? ''));
  });

  test('changes format when the source format stays over the cap', async () => {
    const { decode } = countingDecoder();
    const { reencode } = recordingReencoder((attempt) =>
      attempt.mimeType === 'image/png' ? 9_000 : 3_500,
    );

    const outcome = await downscaleImageToFit(
      source,
      'image/png',
      MAX_BYTES,
      reencode,
      decode,
    );
    const result = resized(outcome);

    expect(result?.mimeType).toBe('image/webp');
    expect(result?.bytes).toBe(3_500);
  });

  test('walks down quality and then resolution until something fits', async () => {
    const { decode } = countingDecoder();
    const { reencode, attempts } = recordingReencoder((attempt) =>
      attempt.maxEdge === 1024 ? 2_000 : 9_000,
    );

    const outcome = await downscaleImageToFit(
      source,
      'image/jpeg',
      MAX_BYTES,
      reencode,
      decode,
    );
    const result = resized(outcome);

    expect(result?.width).toBe(1024);
    expect(attempts.map((attempt) => attempt.maxEdge)).toEqual([
      2048, 2048, 1440, 1440, 1024,
    ]);
    expect(attempts[0].quality).toBeGreaterThan(attempts[1].quality);
  });

  test('refuses when nothing in the ladder fits', async () => {
    const { decode } = countingDecoder();
    const { reencode, attempts } = recordingReencoder(() => 9_000);

    expect(
      resized(
        await downscaleImageToFit(
          source,
          'image/jpeg',
          MAX_BYTES,
          reencode,
          decode,
        ),
      ),
    ).toBeNull();
    expect(attempts.length).toBeGreaterThan(1);
  });

  test('refuses when this environment can encode nothing', async () => {
    const { decode } = countingDecoder();
    const { reencode } = recordingReencoder(() => null);

    expect(
      resized(
        await downscaleImageToFit(
          source,
          'image/png',
          MAX_BYTES,
          reencode,
          decode,
        ),
      ),
    ).toBeNull();
  });

  test('refuses a GIF outright instead of sending one flattened frame', async () => {
    const { decode } = countingDecoder();
    const { reencode, attempts } = recordingReencoder(() => 100);

    expect(
      resized(
        await downscaleImageToFit(
          source,
          'image/gif',
          MAX_BYTES,
          reencode,
          decode,
        ),
      ),
    ).toBeNull();
    expect(attempts).toEqual([]);
  });

  test('rejects bytes that came back as a format nobody asked for', async () => {
    const { decode } = countingDecoder();
    const { reencode } = recordingReencoder((attempt) =>
      attempt.mimeType === 'image/webp'
        ? { bytes: 1_000, type: 'image/png' }
        : attempt.mimeType === 'image/jpeg'
          ? 1_500
          : 9_000,
    );

    const outcome = await downscaleImageToFit(
      source,
      'image/png',
      MAX_BYTES,
      reencode,
      decode,
    );
    const result = resized(outcome);

    expect(result?.mimeType).toBe('image/jpeg');
  });

  test('decodes the source once for the whole ladder, and releases it', async () => {
    const { decode, closed } = countingDecoder();
    const { reencode, attempts } = recordingReencoder((attempt) =>
      attempt.maxEdge === 1024 ? 2_000 : 9_000,
    );

    await downscaleImageToFit(
      source,
      'image/jpeg',
      MAX_BYTES,
      reencode,
      decode,
    );

    expect(attempts.length).toBeGreaterThan(1);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  test('releases the decoded source even when nothing fits', async () => {
    const { decode, closed } = countingDecoder();
    const { reencode } = recordingReencoder(() => 9_000);

    expect(
      resized(
        await downscaleImageToFit(
          source,
          'image/jpeg',
          MAX_BYTES,
          reencode,
          decode,
        ),
      ),
    ).toBeNull();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  test('releases the decoded source when a re-encode throws', async () => {
    const { decode, closed } = countingDecoder();
    const reencode: ImageReencoder = async () => {
      throw new Error('canvas is gone');
    };

    // The browser re-encoder can throw, and the caller turns that into a
    // refusal (chatAttachments.test.ts). An ImageBitmap leaked on that path
    // holds the full decoded 4000x3000 surface.
    await expect(
      downscaleImageToFit(source, 'image/jpeg', MAX_BYTES, reencode, decode),
    ).rejects.toThrow('canvas is gone');
    expect(closed).toHaveBeenCalledTimes(1);
  });

  test('does not decode a format the ladder will never attempt', async () => {
    const { decode } = countingDecoder();
    const { reencode } = recordingReencoder(() => 100);

    await downscaleImageToFit(source, 'image/gif', MAX_BYTES, reencode, decode);

    expect(decode).not.toHaveBeenCalled();
  });

  test('tells an undecodable source apart from one nothing could shrink', async () => {
    const { reencode } = recordingReencoder(() => 9_000);
    const { decode } = countingDecoder();

    expect(
      await downscaleImageToFit(
        source,
        'image/jpeg',
        MAX_BYTES,
        reencode,
        decode,
      ),
    ).toEqual({ status: 'too-large' });
    expect(
      await downscaleImageToFit(
        source,
        'image/jpeg',
        MAX_BYTES,
        reencode,
        async () => null,
      ),
    ).toEqual({ status: 'undecodable' });
    // A format the ladder never attempts decoded nothing either.
    expect(
      await downscaleImageToFit(
        source,
        'image/gif',
        MAX_BYTES,
        reencode,
        decode,
      ),
    ).toEqual({ status: 'undecodable' });
  });

  test('refuses when the source cannot be decoded here', async () => {
    const { reencode, attempts } = recordingReencoder(() => 100);
    const decode: ImageDecoder = async () => null;

    expect(
      resized(
        await downscaleImageToFit(
          source,
          'image/png',
          MAX_BYTES,
          reencode,
          decode,
        ),
      ),
    ).toBeNull();
    expect(attempts).toEqual([]);
  });
});
