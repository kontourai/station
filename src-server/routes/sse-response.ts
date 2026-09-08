import type { SSEStreamingApi } from 'hono/streaming';
import { streamSSE as honoStreamSSE } from 'hono/streaming';
import { SSE_KEEPALIVE_INTERVAL_MS } from '../constants.js';

/**
 * Construct an SSE response that reverse proxies must deliver incrementally.
 * Route code must use this seam instead of importing Hono's helper directly.
 */
export const streamSSE: typeof honoStreamSSE = (c, callback, onError) => {
  c.header('X-Accel-Buffering', 'no');
  return honoStreamSSE(c, callback, onError);
};

/**
 * The frame every Station SSE stream sends to keep an idle connection open.
 * One definition so a fourth stream cannot quietly invent `:ping` or
 * `keepalive`: `packages/sdk` and `packages/cli` both parse this exact
 * `event: ping` frame off the wire.
 */
export const SSE_KEEPALIVE_FRAME: {
  readonly event: string;
  readonly data: string;
} = { event: 'ping', data: '' };

export interface SseKeepaliveOptions {
  /**
   * Called when a keepalive write rejects. Default: swallowed. A rejected
   * write must never escape the interval callback as an unhandled rejection,
   * which is why this is a hook rather than a returned promise.
   */
  onWriteError?: (error: unknown) => void;
}

/**
 * Writes `SSE_KEEPALIVE_FRAME` to `stream` every `intervalMs` and returns the
 * function that stops it. Also stops on abort — but callers must still call
 * the returned stop from their own cleanup, because Hono only notifies
 * subscribers registered before `abort()` ran (`utils/stream.ts`: `abort()`
 * sets `aborted` and drains `abortSubscribers` once), so a stream that
 * aborted during setup never calls back.
 *
 * Only for streams that write the keepalive straight to the stream at the
 * shared cadence. `routes/operations/monitoring.ts` (a synthetic
 * `MonitoringEvent` heartbeat, not this frame),
 * `routes/orchestration/events.ts` (writes through its paired-device
 * `writeFrame` and touches a connection lease on success) and
 * `routes/orchestration/project-task-rooms.ts` (a 15s authorization cadence
 * that pings as a side effect) deliberately keep their own loops.
 */
export function sseKeepalive(
  stream: SSEStreamingApi,
  intervalMs: number = SSE_KEEPALIVE_INTERVAL_MS,
  options: SseKeepaliveOptions = {},
): () => void {
  const timer = setInterval(() => {
    stream.writeSSE(SSE_KEEPALIVE_FRAME).catch((error: unknown) => {
      options.onWriteError?.(error);
    });
  }, intervalMs);
  const stop = (): void => {
    clearInterval(timer);
  };
  stream.onAbort(stop);
  return stop;
}
