import type { TurnProgressSilence } from '@kontourai/station-sdk';
import { absoluteTime } from '../../utils/relativeTime';
import { ElapsedDuration } from '../ElapsedDuration';

/**
 * archive#4054: display-only rendering of the watchdog's server projection,
 * in the status ladder's words ("No progress · 4m" on a row is "No progress
 * for 4m" in a sentence). The window the watchdog used is a tuning constant
 * and is not shown; the instant it has been silent since is the tooltip.
 *
 * The duration is the shared one (`ElapsedDuration`: one format, one clock),
 * so this sentence and the row beside it never disagree about how long.
 */
export default function ProgressSilenceObservation({
  observation,
  engineName,
}: {
  observation: TurnProgressSilence;
  engineName?: string;
}) {
  const silentSince = Date.parse(observation.silentSinceEventAt);
  const title = absoluteTime(silentSince) || observation.silentSinceEventAt;
  return (
    <strong title={title}>
      {engineName ? `No progress from ${engineName} for ` : 'No progress for '}
      <ElapsedDuration since={silentSince} />
    </strong>
  );
}
