import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SSE_KEEPALIVE_INTERVAL_MS } from '../../constants.js';
import {
  SSE_KEEPALIVE_FRAME,
  type SseKeepaliveOptions,
  sseKeepalive,
} from '../sse-response.js';

/**
 * A stand-in for the two `SSEStreamingApi` members `sseKeepalive` touches.
 * Hono's `abort()` drains `abortSubscribers` exactly once and ignores
 * listeners registered afterwards (`hono/dist/utils/stream.js`), which is the
 * behaviour the second test relies on and the reason the helper also returns
 * an explicit stop.
 */
function fakeStream() {
  const written: unknown[] = [];
  const abortSubscribers: Array<() => void> = [];
  let aborted = false;
  let rejectNextWrite: unknown;
  return {
    written,
    abort(): void {
      if (aborted) return;
      aborted = true;
      for (const subscriber of abortSubscribers) subscriber();
    },
    failNextWriteWith(error: unknown): void {
      rejectNextWrite = error;
    },
    stream: {
      writeSSE(message: unknown): Promise<void> {
        if (rejectNextWrite !== undefined) {
          const error = rejectNextWrite;
          rejectNextWrite = undefined;
          return Promise.reject(error);
        }
        written.push(message);
        return Promise.resolve();
      },
      onAbort(listener: () => void): void {
        if (aborted) return;
        abortSubscribers.push(listener);
      },
    },
  };
}

function start(
  fake: ReturnType<typeof fakeStream>,
  intervalMs?: number,
  options?: SseKeepaliveOptions,
): () => void {
  return sseKeepalive(
    fake.stream as unknown as Parameters<typeof sseKeepalive>[0],
    intervalMs,
    options,
  );
}

describe('sseKeepalive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the shared ping frame once per SSE_KEEPALIVE_INTERVAL_MS by default', () => {
    const fake = fakeStream();
    const stop = start(fake);
    try {
      expect(fake.written).toHaveLength(0);

      // One tick short of the cadence: still nothing. Pins the interval
      // itself, not merely that something is eventually written — the whole
      // point of the constant is WHEN the frame lands, and no route test
      // asserts this cadence.
      vi.advanceTimersByTime(SSE_KEEPALIVE_INTERVAL_MS - 1);
      expect(fake.written).toHaveLength(0);

      vi.advanceTimersByTime(1);
      expect(fake.written).toEqual([SSE_KEEPALIVE_FRAME]);

      vi.advanceTimersByTime(SSE_KEEPALIVE_INTERVAL_MS * 3);
      expect(fake.written).toHaveLength(4);
      expect(fake.written.every((frame) => frame === SSE_KEEPALIVE_FRAME)).toBe(
        true,
      );
    } finally {
      stop();
    }
  });

  it('honours an explicit interval', () => {
    const fake = fakeStream();
    const stop = start(fake, 1_000);
    try {
      vi.advanceTimersByTime(999);
      expect(fake.written).toHaveLength(0);
      vi.advanceTimersByTime(1);
      expect(fake.written).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it('stops writing when the stream aborts', () => {
    const fake = fakeStream();
    start(fake);
    vi.advanceTimersByTime(SSE_KEEPALIVE_INTERVAL_MS);
    expect(fake.written).toHaveLength(1);

    fake.abort();

    vi.advanceTimersByTime(SSE_KEEPALIVE_INTERVAL_MS * 5);
    expect(fake.written).toHaveLength(1);
  });

  it('stops writing when the returned stop is called without an abort', () => {
    const fake = fakeStream();
    const stop = start(fake);
    vi.advanceTimersByTime(SSE_KEEPALIVE_INTERVAL_MS);
    expect(fake.written).toHaveLength(1);

    stop();

    vi.advanceTimersByTime(SSE_KEEPALIVE_INTERVAL_MS * 5);
    expect(fake.written).toHaveLength(1);
  });

  it('reports a rejected write to onWriteError and keeps pinging', async () => {
    const fake = fakeStream();
    const onWriteError = vi.fn();
    const stop = start(fake, undefined, { onWriteError });
    try {
      fake.failNextWriteWith(new Error('client gone'));
      vi.advanceTimersByTime(SSE_KEEPALIVE_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(0);

      expect(onWriteError).toHaveBeenCalledTimes(1);
      expect((onWriteError.mock.calls[0][0] as Error).message).toBe(
        'client gone',
      );
      expect(fake.written).toHaveLength(0);

      vi.advanceTimersByTime(SSE_KEEPALIVE_INTERVAL_MS);
      expect(fake.written).toHaveLength(1);
    } finally {
      stop();
    }
  });

  // Named for what it asserts: the interval survives a rejected write. It
  // does NOT prove the rejection never reaches `unhandledRejection` — that
  // fires on a later turn of the loop and is not observable here. The
  // `.catch()` in the helper is what makes it unreachable, and this pins that
  // the catch exists at all rather than the write being left unhandled.
  it('keeps pinging after a rejected write when no onWriteError is given', async () => {
    const fake = fakeStream();
    const stop = start(fake);
    try {
      fake.failNextWriteWith(new Error('client gone'));
      vi.advanceTimersByTime(SSE_KEEPALIVE_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.written).toHaveLength(0);

      vi.advanceTimersByTime(SSE_KEEPALIVE_INTERVAL_MS);
      expect(fake.written).toEqual([SSE_KEEPALIVE_FRAME]);
    } finally {
      stop();
    }
  });
});
