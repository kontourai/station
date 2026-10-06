import { useEffect, useRef, useState } from 'react';

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
  // A fresh mount's clock is already current; re-setting it a millisecond
  // later re-rendered the host and every row under it for no visible
  // change. Every LATER start of ticking (a sheet reopened, an injected
  // clock withdrawn) catches up at once, however long the clock stood.
  const freshMount = useRef(true);
  useEffect(() => {
    if (!ticking) return;
    if (!freshMount.current) setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [ticking, intervalMs]);
  // Declared after the ticking effect so a ticking mount sees `fresh`.
  useEffect(() => {
    freshMount.current = false;
  }, []);
  return supplied ?? now;
}
