/**
 * Glyphs only the Device pane draws (#1970): Back, Power, Recents, Rotate
 * and Stop.
 *
 * Kept here, in the pane's lazy chunk, rather than in the shared
 * `components/icons/Glyph.tsx`: that module rides the entry chunk and its
 * exports are not tree-shaken out of it, so a glyph added there is paid on
 * every cold load for a pane most sessions never open. Same drawing rules
 * as `Glyph.tsx` (16-unit box, 1.8 stroke, `currentColor`, hidden from
 * assistive technology — the button that holds one carries the name).
 */

function deviceGlyph(path: string) {
  return function DeviceGlyph() {
    return (
      <svg
        aria-hidden="true"
        fill="none"
        focusable="false"
        height="1em"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
        viewBox="0 0 16 16"
        width="1em"
      >
        <path d={path} />
      </svg>
    );
  };
}

/**
 * Android's Back: the same chevron as `ArrowLeftGlyph`, drawn here because
 * importing that export pulled it into the entry chunk (+6 gzip bytes).
 */
export const BackGlyph = deviceGlyph('M10.5 3 5.5 8l5 5');

/** A broken ring with a stem. */
export const PowerGlyph = deviceGlyph('M8 2v5.5M4.6 4.2a5 5 0 1 0 6.8 0');

/** Two stacked cards (Android's app switcher). */
export const RecentsGlyph = deviceGlyph(
  'M5.5 2.5h6a1 1 0 0 1 1 1v7M3.5 5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z',
);

/** A quarter turn clockwise. */
export const RotateGlyph = deviceGlyph(
  'M12.5 2.5v3h-3M12.3 5.5A5 5 0 1 0 13 9',
);

/** A square: end the session for everyone. */
export const StopGlyph = deviceGlyph('M4.5 4.5h7v7h-7z');

/** Two sliders: the Tools drawer (#1971). */
export const ToolsGlyph = deviceGlyph('M2.5 5h11M2.5 11h11M6 3v4M10 9v4');

/** A window with a small one in its corner: float over the chat (#90 D9). */
export const FloatGlyph = deviceGlyph('M2.5 3.5h11v9h-11zM8.5 8h3.5v3h-3.5z');
