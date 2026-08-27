/**
 * Read one chunk from a stream reader, racing it against a stall timeout
 * that resets on every call (station#1256, deduplicating station#1207).
 *
 * Two call sites raced an identical `Promise.race(reader.read(), stalled)`
 * against their own per-domain timeout, differing only in which `Error`
 * subclass the stall produced: the SDK's `chatRuntimeStream.ts`
 * (`ChatStreamStallError`, browser/client fetch stream) and the server's
 * `station-agent-adapter.ts` (`StationAgentStreamStallError`, the internal
 * `/chat` bridge stream). This is that one implementation with the error
 * type injected via `makeError`, so each caller still throws its own,
 * distinguishable error class.
 */
export async function readWithStallWatchdog(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  makeError: (timeoutMs: number) => Error,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(makeError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([reader.read(), stalled]);
  } finally {
    clearTimeout(timer);
  }
}
