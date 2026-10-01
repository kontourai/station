import { useEffect, useState } from 'react';

/**
 * A clock for relative-time copy ("2m", "no progress for 6m") that advances
 * on ONE coarse interval per list, not on every render of its host. Reading
 * `Date.now()` during render hands children a new `now` each time the host
 * re-renders for any reason, which restarts whatever they anchored to it.
 *
 * `supplied` (a test's injected clock, or a host that already ticks) wins
 * and starts no interval. `enabled: false` (a closed sheet) starts none.
 */
export function useCoarseNow(
  supplied?: number,
  { intervalMs = 30_000, enabled = true } = {},
): number {
  const [now, setNow] = useState(() => Date.now());
  const ticking = supplied === undefined && enabled;
  useEffect(() => {
    if (!ticking) return;
    // Catch up a clock that went stale while not ticking (a sheet reopened
    // minutes later) by at least one interval; a fresh mount is already
    // current, and re-setting it a millisecond later would re-render the
    // host and every row under it for no visible change.
    setNow((previous) => {
      const current = Date.now();
      return current - previous >= intervalMs ? current : previous;
    });
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [ticking, intervalMs]);
  return supplied ?? now;
}
