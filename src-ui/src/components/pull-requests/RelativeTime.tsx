import { relativeTime } from '../../utils/relativeTime';

/**
 * A compact relative time ("4m", "2h", "3d") with the absolute time in its
 * title, as the time rule asks: never a locale string in body text. Renders
 * nothing for an unparseable stamp. `now` comes from the caller's ticking
 * clock so a list of rows shares one interval.
 */
export function RelativeTime({
  iso,
  now,
  className,
}: {
  iso: string;
  now: number;
  className?: string;
}) {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return (
    <time
      className={className}
      dateTime={iso}
      title={new Date(at).toLocaleString()}
    >
      {relativeTime(at, now)}
    </time>
  );
}
