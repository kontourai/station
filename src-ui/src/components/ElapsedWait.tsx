import { useEffect, useState } from 'react';

/** Elapsed observation time, never an estimate of progress or completion. */
export function ElapsedWait({
  startedAt,
  elapsedMs,
  label = 'Waiting',
}: {
  startedAt?: number;
  elapsedMs?: number;
  label?: string;
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
      title="Time waiting in this view; not an estimate of completion"
    >
      {label ? `${label} · ` : ''}
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  );
}
