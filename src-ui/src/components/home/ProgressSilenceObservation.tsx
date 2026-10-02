import type { TurnProgressSilence } from '@kontourai/station-sdk';
import { absoluteTime, relativeTime } from '../../utils/relativeTime';

/**
 * archive#4054: display-only rendering of the watchdog's server projection,
 * in the status ladder's words ("No progress · 4m" on a row is "No progress
 * for 4m" in a sentence). The window the watchdog used is a tuning constant
 * and is not shown; the instant it has been silent since is the tooltip.
 */
export default function ProgressSilenceObservation({
  observation,
}: {
  observation: TurnProgressSilence;
}) {
  const now = Date.now();
  const silentSince = Date.parse(observation.silentSinceEventAt);
  return (
    <strong title={absoluteTime(silentSince) || observation.silentSinceEventAt}>
      No progress for {relativeTime(silentSince, now)}
    </strong>
  );
}
