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
 * The `event: ping` keepalive frame shared by the four event-style ping
 * streams under `routes/`: `operations/scheduler.ts`,
 * `orchestration/orchestration.ts` (both through `sseKeepalive` below),
 * `orchestration/events.ts` and `orchestration/project-task-rooms.ts` (both
 * keeping their own loops, for the reasons on `sseKeepalive`). One definition
 * so a fifth event-style stream cannot quietly invent `keepalive` or
 * `heartbeat`; `packages/sdk/src/client/project-task-rooms.ts` reads
 * `message.event === 'ping'` off the wire.
 *
 * NOT every Station SSE stream. The chat stream keeps a separate, deliberate
 * wire shape: `runtime/conversation/stream-orchestrator.ts`
 * `startSSEKeepalive` (used by `routes/chat/chat-primary-stream.ts`) writes a
 * bare SSE comment, `':ping\n\n'`, on its own 15s
 * `SSE_KEEPALIVE_INTERVAL_MS` — a different constant from `constants.ts`'s.
 * That shape is pinned in both directions (`stream-orchestrator.test.ts`
 * asserts it is not a `data: ` frame; the SDK's `chatRuntimeStream.test.ts`
 * asserts its parser ignores it), because its consumer only acts on `data: `
 * lines. Do not fold the two together.
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
 * shared cadence. Four other keepalive loops deliberately keep their own:
 * `routes/operations/monitoring.ts` (a synthetic `MonitoringEvent`
 * heartbeat, not this frame); `routes/orchestration/events.ts` (writes
 * through its paired-device `writeFrame` and touches a connection lease on
 * success); `routes/orchestration/project-task-rooms.ts` (a 15s
 * authorization cadence that pings as a side effect); and
 * `runtime/conversation/stream-orchestrator.ts` `startSSEKeepalive`, which is
 * outside `routes/` entirely and writes the comment-style `':ping\n\n'`
 * described on `SSE_KEEPALIVE_FRAME` above.
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
