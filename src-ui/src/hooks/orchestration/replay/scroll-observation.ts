import type { ReplayIssue, ReplayScrollObservation } from './observation-types';

/** Compare one forward frame only, with no intervening reader input or resize. */
export function replayScrollIssue(
  before: ReplayScrollObservation | undefined,
  after: ReplayScrollObservation | undefined,
): ReplayIssue | undefined {
  if (
    !before ||
    !after ||
    before.clientHeight !== after.clientHeight ||
    before.clientWidth !== after.clientWidth
  )
    return;
  if (before.atBottom && after.atBottom) return;
  const anchor = before.visibleAnchors?.find((item) =>
    after.visibleAnchors?.some((next) => next.key === item.key),
  );
  const next = after.visibleAnchors?.find((item) => item.key === anchor?.key);
  // A new turn or a replaced row can intentionally have no shared anchor.
  if (!anchor || !next || Math.abs(next.top - anchor.top) <= 8) return;
  return {
    code: 'unexpected-scroll-jump',
    detail: `A retained visible row moved ${Math.round(next.top - anchor.top)} px during this frame without reader input.`,
  };
}
