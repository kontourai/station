/** Own one browser event subscription through synchronous completion or abort. */
export function waitForBrowserTransport(
  signal: AbortSignal,
  subscribe: (finish: () => void, fail: () => void) => () => void,
  timeoutMs = 15_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('cancelled'));
      return;
    }
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const complete = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      const cleanup = unsubscribe;
      unsubscribe = undefined;
      cleanup?.();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const aborted = () => complete(signal.reason ?? new Error('cancelled'));
    const timer = setTimeout(
      () => complete(new Error('browser_transport_timeout')),
      timeoutMs,
    );
    signal.addEventListener('abort', aborted, { once: true });
    try {
      const cleanup = subscribe(
        () => complete(),
        () => complete(new Error('browser_transport_failed')),
      );
      // A subscriber may finish immediately when its channel is already open.
      if (settled) cleanup();
      else unsubscribe = cleanup;
    } catch (error) {
      complete(error);
    }
  });
}

export function delayBrowserTransport(signal: AbortSignal, durationMs: number) {
  return waitForBrowserTransport(
    signal,
    (finish) => {
      const timer = setTimeout(finish, durationMs);
      return () => clearTimeout(timer);
    },
    durationMs + 1_000,
  );
}
