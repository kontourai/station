import { useElapsedClock } from '../../hooks/useElapsedClock';
import { formatDuration } from '../../utils/relativeTime';

/** A call shows how long it has run only once that stops being obvious. */
const TOOL_CALL_ELAPSED_THRESHOLD_MS = 10_000;

/**
 * How long a running call has been running, from its `tool.started` time.
 * Empty before {@link TOOL_CALL_ELAPSED_THRESHOLD_MS}, but already holding
 * its column (`.tool-call__elapsed`'s min-width), so the time appearing
 * never widens the row or the card around it. Nothing at all when the start
 * is unknown — it never counts from its own mount.
 */
export function ToolCallElapsed({ startedAt }: { startedAt?: string }) {
  // The shared elapsed clock: a tick re-renders these spans and nothing
  // else in the transcript, and a hidden page holds no timer.
  const clock = useElapsedClock();
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (Number.isNaN(start)) return null;
  const elapsed = clock - start;
  return (
    <span className="tool-call__elapsed">
      {elapsed < TOOL_CALL_ELAPSED_THRESHOLD_MS ? '' : formatDuration(elapsed)}
    </span>
  );
}
