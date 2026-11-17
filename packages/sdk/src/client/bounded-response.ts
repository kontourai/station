/**
 * A response body passed its request's `maxResponseBytes`. Its own class so a
 * caller can tell "too large" from any other unreadable body without reading
 * the message.
 */
export class StationResponseTooLargeError extends Error {
  constructor(readonly maximum: number) {
    super('Station response exceeded its byte limit');
    this.name = 'StationResponseTooLargeError';
  }
}

/** Opt-in bounded GET body for portable client requests with a byte ceiling. */
export function boundResponse(
  response: Response,
  maximum: number,
  assertAuthority: () => void,
): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let bytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        assertAuthority();
        const chunk = await reader.read();
        assertAuthority();
        if (chunk.done) {
          controller.close();
          return;
        }
        bytes += chunk.value.byteLength;
        if (bytes > maximum) throw new StationResponseTooLargeError(maximum);
        controller.enqueue(chunk.value);
      } catch (error) {
        void reader.cancel().catch(() => {});
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const bounded = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  // Keep transport identity when wrapping only the response body.
  return new Proxy(bounded, {
    get(target, property) {
      if (
        property === 'url' ||
        property === 'redirected' ||
        property === 'type'
      )
        return response[property];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
