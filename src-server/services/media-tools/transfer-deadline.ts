/** Receive progress extends the idle window, but never the total deadline. */
export function transferDeadline(
  idleMs: number,
  totalMs: number,
  parent?: AbortSignal,
): { signal: AbortSignal; progress(): void; dispose(): void } {
  const controller = new AbortController();
  let idle: ReturnType<typeof setTimeout> | undefined;
  const timeout = () =>
    controller.abort(
      new DOMException('Media transfer timed out', 'TimeoutError'),
    );
  const total = setTimeout(timeout, totalMs);
  const progress = () => {
    clearTimeout(idle);
    if (!controller.signal.aborted) idle = setTimeout(timeout, idleMs);
  };
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', abort, { once: true });
  progress();
  if (parent?.aborted) abort();
  return {
    signal: controller.signal,
    progress,
    dispose() {
      clearTimeout(idle);
      clearTimeout(total);
      parent?.removeEventListener('abort', abort);
    },
  };
}
