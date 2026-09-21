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

/**
 * Owned bounded composition without AbortSignal.any/timeout: aborts when the
 * caller aborts or the deadline elapses. The caller must dispose() to clear
 * the deadline timer; disposal never aborts the owned signal.
 */
export function composeOwnedSignal(
  parent: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; dispose(): void } {
  const owned = new AbortController();
  if (parent.aborted) {
    owned.abort(parent.reason ?? new Error('cancelled'));
    return { signal: owned.signal, dispose: () => {} };
  }
  const onParent = () => owned.abort(parent.reason ?? new Error('cancelled'));
  const timer = setTimeout(
    () => owned.abort(new Error('browser_transport_timeout')),
    timeoutMs,
  );
  parent.addEventListener('abort', onParent, { once: true });
  let disposed = false;
  return {
    signal: owned.signal,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      parent.removeEventListener('abort', onParent);
    },
  };
}

/**
 * Race a non-abortable promise against an owned lifetime so the caller returns
 * promptly on retire. The observed promise keeps an owned no-op rejection
 * handler so late settlement cannot publish or go unobserved.
 */
export function raceOwnedLifetime<T>(
  observed: Promise<T>,
  lifetime: AbortSignal,
): Promise<T> {
  void observed.catch(() => {});
  if (lifetime.aborted)
    return Promise.reject(lifetime.reason ?? new Error('cancelled'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(lifetime.reason ?? new Error('cancelled'));
    lifetime.addEventListener('abort', onAbort, { once: true });
    observed.then(
      (value) => {
        lifetime.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        lifetime.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
