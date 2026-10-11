import type { Writable } from 'node:stream';

/**
 * Attach the `'error'` listener a child process's stdin needs before any
 * `write` or `end`.
 *
 * A ChildProcess `'error'` listener does not receive stdin stream errors.
 * When the child has exited (or closed its stdin) before Station's input
 * reaches it, the write fails with EPIPE on the stdin stream itself, and an
 * unlistened stream `'error'` is an uncaught exception that ends the server
 * (#774, #776). `stdin.end(data)` is a write and fails the same way.
 *
 * `onError` runs for the first stdin error only; later ones are absorbed.
 * The listener is never removed, so it also covers writes made after the
 * caller's own bookkeeping has moved on. Returns a reader for that first
 * error, so a caller whose child still exits 0 can refuse to treat undelivered
 * input as success.
 */
export function guardChildStdin(
  stdin: Writable,
  onError?: (error: Error) => void,
): () => Error | undefined {
  let first: Error | undefined;
  stdin.on('error', (error: Error) => {
    if (first) return;
    first = error;
    onError?.(error);
  });
  return () => first;
}
