/**
 * Runs `check` every `intervalMs` on an injectable clock, one at a time: the
 * next check is scheduled only after the previous one settles.
 */
import type { Clock } from './generation-manager.ts';

export function startSelfCheck(options: {
  clock: Clock;
  intervalMs: number;
  check: () => Promise<void>;
  log: (message: string) => void;
}): () => void {
  let timer: unknown = null;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    timer = options.clock.setTimeout(() => {
      timer = null;
      void options
        .check()
        .catch((error: unknown) =>
          options.log(`self-check failed: ${String(error)}`),
        )
        .finally(schedule);
    }, options.intervalMs);
  };
  schedule();
  return () => {
    stopped = true;
    if (timer !== null) options.clock.clearTimeout(timer);
  };
}
