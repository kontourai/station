import { STATION_MARK_PATH, STATION_MARK_VIEW_BOX } from './station-mark';

/**
 * Station's mark at glyph size: the app icon's map tile with its river cut
 * through, in one colour (`currentColor`), generated from the icon source
 * (`station-mark.ts`). Decorative like every glyph; the element it sits in
 * names it.
 */
export function StationMarkGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="currentColor"
      focusable="false"
      height="1em"
      viewBox={STATION_MARK_VIEW_BOX}
      width="1em"
    >
      <path d={STATION_MARK_PATH} fillRule="evenodd" />
    </svg>
  );
}
