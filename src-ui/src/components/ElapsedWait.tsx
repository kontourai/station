import { useEffect, useState } from 'react';

/** Elapsed observation time, never an estimate of progress or completion. */
export function ElapsedWait({
  startedAt,
  elapsedMs,
  label = 'Waiting',
  separator = ' · ',
}: {
  /**
   * Epoch ms the wait began. It may come from another clock (a server
   * timestamp): a start ahead of this clock reads 0:00, never negative.
   */
  startedAt?: number;
  elapsedMs?: number;
  label?: string;
  separator?: string;
}) {
  const [mountedAt] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (elapsedMs !== undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [elapsedMs]);
  const seconds = Math.max(
    0,
    Math.floor((elapsedMs ?? now - (startedAt ?? mountedAt)) / 1000),
  );
  return (
    <span
      className="elapsed-wait"
      aria-live="off"
      // #2304: not "in this view" — the start may be the server's turn
      // start, which predates this view.
      title="Elapsed time; not an estimate of completion"
    >
      {label ? `${label}${separator}` : ''}
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  );
}
