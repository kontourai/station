import type { TurnProgressSilence } from '@kontourai/station-sdk';
import { useEffect, useState } from 'react';
import { relativeTimeAgo } from '../../utils/relativeTime';

/** archive#4054: display-only rendering of the watchdog's server projection. */
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
  if (engineName) {
    const seconds = Math.max(
      0,
      Math.floor((now - Date.parse(observation.silentSinceEventAt)) / 1000),
    );
    const duration =
      seconds < 60
        ? `${seconds}s`
        : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return (
      <strong>
        No response from {engineName} for {duration}. Still waiting.
      </strong>
    );
  }
  const currentNow = Date.now();
  return (
    <strong title={observation.silentSinceEventAt}>
      No progress events for{' '}
      {relativeTimeAgo(
        Date.parse(observation.silentSinceEventAt),
        currentNow,
      ).replace(' ago', '')}{' '}
      (window{' '}
      {relativeTimeAgo(currentNow - observation.windowMs, currentNow).replace(
        ' ago',
        '',
      )}
      )
    </strong>
  );
}
