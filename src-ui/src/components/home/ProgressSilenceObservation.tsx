import type { TurnProgressSilence } from '@kontourai/station-sdk';
import { relativeTimeAgo } from '../../utils/relativeTime';

/** archive#4054: display-only rendering of the watchdog's server projection. */
export default function ProgressSilenceObservation({
  observation,
}: {
  observation: TurnProgressSilence;
}) {
  const now = Date.now();
  return (
    <strong title={observation.silentSinceEventAt}>
      No progress events for{' '}
      {relativeTimeAgo(Date.parse(observation.silentSinceEventAt), now).replace(
        ' ago',
        '',
      )}{' '}
      (window{' '}
      {relativeTimeAgo(now - observation.windowMs, now).replace(' ago', '')})
    </strong>
  );
}
