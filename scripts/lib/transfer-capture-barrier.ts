export const TRANSFER_CAPTURE_TIMEOUT_ENV =
  'STATION_TRANSFER_CAPTURE_TIMEOUT_MS';

/**
 * Parses the capture bound the gate passes to the capture child. It is
 * required and explicit: a missing or malformed value would otherwise fall
 * back to a hidden constant, which is how a barrier once ignored the setting.
 */
export function parseCaptureTimeoutMs(raw: string | undefined): number {
  const value = Number(raw?.trim());
  if (!raw?.trim() || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(
      `capture timeout must be a positive integer of milliseconds, got ${JSON.stringify(raw)}`,
    );
  return value;
}

/**
 * Every barrier in the capture, including the scenario's own, gets half of the configured outer liveness bound. The
 * gate kills the whole child at the full bound, so a barrier that is genuinely
 * stuck reports itself, and the setting that governs it, before that kill
 * rather than being masked by a generic liveness failure. The bound stays
 * finite, so a hung capture still fails. A barrier is a dead-child guard, not a
 * performance budget: it fails on host load, not on a regression.
 */
export function captureBarrierTimeoutMs(captureTimeoutMs: number): number {
  return Math.max(1, Math.floor(captureTimeoutMs / 2));
}

export function createCaptureBarrier(captureTimeoutMs: number) {
  const barrierTimeoutMs = captureBarrierTimeoutMs(captureTimeoutMs);
  return async (predicate: () => boolean, name: string) => {
    const deadline = performance.now() + barrierTimeoutMs;
    while (!predicate()) {
      if (performance.now() > deadline)
        throw new Error(
          `capture barrier timed out after ${barrierTimeoutMs}ms: ${name} (half of ${TRANSFER_CAPTURE_TIMEOUT_ENV}=${captureTimeoutMs}; on a loaded host raise it for this run with ${TRANSFER_CAPTURE_TIMEOUT_ENV}=<milliseconds>)`,
        );
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
  };
}
