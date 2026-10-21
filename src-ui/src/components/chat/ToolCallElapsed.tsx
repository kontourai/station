import { useSyncExternalStore } from 'react';
import { formatDuration } from '../../utils/relativeTime';

/** A call shows how long it has run only once that stops being obvious. */
export const TOOL_CALL_ELAPSED_THRESHOLD_MS = 10_000;

// One clock for every mounted elapsed label, running only while one is
// mounted. Each label subscribes on its own, so a tick re-renders these
// spans and nothing else in the transcript.
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let now = Date.now();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 1_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const readNow = () => now;

/**
 * How long a running call has been running, from its `tool.started` time.
 * Empty before {@link TOOL_CALL_ELAPSED_THRESHOLD_MS}, but already holding
 * its column (`.tool-call__elapsed`'s min-width), so the time appearing
 * never widens the row or the card around it. Nothing at all when the start
 * is unknown — it never counts from its own mount.
 */
export function ToolCallElapsed({ startedAt }: { startedAt?: string }) {
  const clock = useSyncExternalStore(subscribe, readNow, readNow);
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (Number.isNaN(start)) return null;
  const elapsed = clock - start;
  return (
    <span className="tool-call__elapsed">
      {elapsed < TOOL_CALL_ELAPSED_THRESHOLD_MS ? '' : formatDuration(elapsed)}
    </span>
  );
}
