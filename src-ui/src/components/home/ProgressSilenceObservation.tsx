import type { TurnProgressSilence } from '@kontourai/station-sdk';
import { useEffect, useState } from 'react';
import { absoluteTime, relativeTime } from '../../utils/relativeTime';
import { formatElapsed } from '../../views/home/work-status';

/**
 * archive#4054: display-only rendering of the watchdog's server projection,
 * in the status ladder's words ("No progress · 4m" on a row is "No progress
 * for 4m" in a sentence). The window the watchdog used is a tuning constant
 * and is not shown; the instant it has been silent since is the tooltip.
 *
 * With an `engineName` the sentence names who has gone quiet and the
 * duration ticks once a second in the row's own elapsed format, so the
 * banner and the row never disagree about how long.
 */
export default function ProgressSilenceObservation({
  observation,
  engineName,
}: {
  observation: TurnProgressSilence;
  engineName?: string;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!engineName) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [engineName]);
  const silentSince = Date.parse(observation.silentSinceEventAt);
  const title = absoluteTime(silentSince) || observation.silentSinceEventAt;
  if (engineName) {
    return (
      <strong title={title}>
        No progress from {engineName} for{' '}
        {formatElapsed(Math.max(0, now - silentSince))}
      </strong>
    );
  }
  return (
    <strong title={title}>
      No progress for {relativeTime(silentSince, Date.now())}
    </strong>
  );
}
