import { useEffect, useState } from 'react';

/**
 * The current time, re-read every `tickMs` while the caller is mounted, so a
 * relative time ("4m") keeps up with the clock without a render per second.
 * One interval per caller; it is cleared on unmount.
 */
export function useTickingNow(tickMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(tick);
  }, [tickMs]);
  return now;
}
