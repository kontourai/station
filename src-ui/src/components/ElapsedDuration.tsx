import { useElapsedClock } from '../hooks/useElapsedClock';
import { formatDuration } from '../utils/relativeTime';

/**
 * How long something has lasted, in the one duration format, read off the
 * one shared clock (`useElapsedClock`). Every row, card and sentence that
 * shows a live elapsed time renders this rather than its own interval and
 * formatter, so Home, the dock and Activity agree for the same item.
 * Text only: nothing here animates.
 */
export function ElapsedDuration({ since }: { since: number }) {
  const now = useElapsedClock();
  return <>{formatDuration(now - since)}</>;
}
