/**
 * `new Promise((resolve) => setTimeout(resolve, ms))`, which five src-server
 * modules had each written under three names (`sleep`, `delay`, `wait`).
 *
 * It does NOT unref the timer. With a `signal`, an abort clears the timer and
 * resolves early (it never rejects), so a caller that is being stopped neither
 * waits out the delay nor leaves its timer running; the caller checks
 * `signal.aborted` afterwards. That is why
 * `services/evidence/orchestration-review-executor.ts` keeps its own `delay`:
 * that one also unrefs, so it is a different contract rather than a
 * differently-named copy of this one.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
