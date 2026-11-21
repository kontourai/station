import type { Context } from 'hono';
import { sseKeepalive, streamSSE } from '../sse-response.js';

/** The initial change closes the gap between the first page read and subscribing. */
export function sharedTaskChangeStream(
  c: Context,
  watch: (notify: (closed: boolean) => void) => () => void,
) {
  return streamSSE(c, async (stream) => {
    let closed = false;
    let dirty = true;
    let wake: (() => void) | undefined;
    const stop = () => {
      closed = true;
      wake?.();
    };
    stream.onAbort(stop);
    const signal = c.req.raw.signal;
    signal.addEventListener('abort', stop, { once: true });
    const unwatch = watch((ended) => {
      if (ended) stop();
      else {
        dirty = true;
        wake?.();
      }
    });
    const stopPings = sseKeepalive(stream);
    try {
      while (!closed && !signal.aborted && !stream.aborted) {
        if (dirty) {
          dirty = false;
          await stream.writeSSE({ event: 'changed', data: '{}' });
        } else {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
      }
    } finally {
      stopPings();
      unwatch();
      signal.removeEventListener('abort', stop);
    }
  });
}
