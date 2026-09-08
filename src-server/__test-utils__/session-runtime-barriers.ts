/**
 * Named waits for an OrchestrationService's own lifecycle barriers
 * (station#1707).
 *
 * The barriers themselves — `whenSessionAttachmentSettled()` and
 * `whenSessionRecoveryCompleted()` — are deliberately deadline-free: a
 * production promise that rejects on a clock is a latency assertion nobody
 * wrote, which is the thing the repo's 30s `testTimeout` exists to avoid
 * (see `vitest.config.ts`). But a barrier that never resolves is silent, and
 * silence is expensive to read: the runner reports `Test timed out in
 * 30000ms` against the test's first line, naming neither attachment nor
 * recovery, once per await. A suite with ten of them burns five minutes to
 * say nothing.
 *
 * These wrappers add a message, not a policy. The bound is a diagnostic
 * clock orders of magnitude above any measured settle (tens of milliseconds)
 * and a third of the runner timeout, chosen so a runtime that never settles
 * fails saying which barrier never came instead of as a generic test timeout.
 * It is still a clock: a settle slower than the bound fails this wait.
 *
 * A test whose SUBJECT is a barrier staying pending must await the accessor
 * directly — these throw by design.
 */

/** Well above any observed settle; a diagnostic bound, not a deadline. */
export const RUNTIME_BARRIER_TIMEOUT_MS = 10_000;

interface RuntimeBarrierOptions {
  timeoutMs?: number;
}

async function awaitRuntimeBarrier(
  barrier: Promise<void>,
  detail: string,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      barrier,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${detail} within ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    // Both arms: a resolved barrier must not leave a pending timer holding
    // the event loop open for the rest of the file.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Await THIS runtime's attachment barrier, or fail saying so.
 *
 * @param runtime structurally typed so the helper does not drag the whole
 *   `OrchestrationService` module into every suite that waits on one.
 */
export function awaitSessionAttachmentSettled(
  runtime: { whenSessionAttachmentSettled(): Promise<void> },
  options: RuntimeBarrierOptions = {},
): Promise<void> {
  return awaitRuntimeBarrier(
    runtime.whenSessionAttachmentSettled(),
    'session attachment never settled for this runtime: initialize() was ' +
      'not called, or its recovery chain never reached the finally that ' +
      'settles attachment',
    options.timeoutMs ?? RUNTIME_BARRIER_TIMEOUT_MS,
  );
}

/** Await THIS runtime's boot recovery pass, or fail saying so. */
export function awaitSessionRecoveryCompleted(
  runtime: { whenSessionRecoveryCompleted(): Promise<void> },
  options: RuntimeBarrierOptions = {},
): Promise<void> {
  return awaitRuntimeBarrier(
    runtime.whenSessionRecoveryCompleted(),
    'session recovery never completed for this runtime: initialize() was ' +
      'not called, or the recovery pass rejected before it returned',
    options.timeoutMs ?? RUNTIME_BARRIER_TIMEOUT_MS,
  );
}
