import { streamSSE as honoStreamSSE } from 'hono/streaming';

/**
 * Construct an SSE response that reverse proxies must deliver incrementally.
 * Route code must use this seam instead of importing Hono's helper directly.
 */
export const streamSSE: typeof honoStreamSSE = (c, callback, onError) => {
  c.header('X-Accel-Buffering', 'no');
  return honoStreamSSE(c, callback, onError);
};
