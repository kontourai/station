import { useRef, useState } from 'react';

/**
 * One entry of a project's chip row. The row renders and navigates chips; it
 * never decides what a project's layouts ARE — `ProjectSidebarRow` builds this
 * list from the layouts query and the Board-availability predicate, so the
 * chip row has no opinion about routing and can be driven directly by a test.
 */
export interface ProjectLayoutChip {
  /** Stable identity: a layout slug, or the synthesized Board entry's key. */
  key: string;
  /** The chip's visible text, which is also its accessible name. */
  name: string;
  /**
   * True for the chip whose destination the app is currently showing. Exactly
   * the routed-destination meaning `aria-current="page"` carries, which is why
   * the caller derives it from the route rather than from a click.
   */
  current: boolean;
  activate: () => void;
}

/**
 * #2063 (design record D3): a project's layouts are a chip row under the
 * project name, replacing the nested tree and its expand/collapse chevron.
 *
 * The tree put every layout of every expanded project in the tab order as an
 * ordinary button, so a keyboard reader Tabbed through N layouts to reach the
 * next project. A chip row is a composite widget instead: ONE tab stop, with
 * Left/Right/Home/End moving focus inside it (`role="toolbar"`, the WAI-ARIA
 * pattern for a row of buttons). That is strictly more navigable than the
 * tree, not merely equal to it — the tree offered no arrow-key movement at all
 * and its active layout was styled by class alone, announcing nothing.
 *
 * The roving tab stop starts on the current chip when there is one, so Tab
 * lands a reader on the layout they are looking at rather than on the row's
 * first chip. A reader who arrows away keeps their moved stop, but only while
 * the route stands still: reaching another layout by any other route — the
 * header's layout picker, the command palette, a link — moves the current chip
 * and the tab stop follows it, because otherwise Tab would keep landing on a
 * layout the reader left some navigations ago.
 */
export function ProjectLayoutChips({
  projectName,
  chips,
}: {
  projectName: string;
  chips: readonly ProjectLayoutChip[];
}) {
  // Where the reader moved the tab stop, and which chip was current when they
  // moved it. Null means "nobody has moved it", and the derivation below
  // answers from the route. `forCurrent` is what expires the move: a route
  // change elsewhere in the app makes a different chip current, and a stop
  // recorded against the old one no longer describes where the reader is.
  const [moved, setMoved] = useState<{
    key: string;
    forCurrent: string | undefined;
  } | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  const currentIndex = chips.findIndex((chip) => chip.current);
  const currentKey = chips[currentIndex]?.key;
  const movedIndex =
    moved && moved.forCurrent === currentKey
      ? chips.findIndex((chip) => chip.key === moved.key)
      : -1;
  // A live moved tab stop wins; otherwise the current chip; otherwise the
  // first. `movedIndex` falls back when the chip it named has left the list —
  // a layout deleted under a stale key must not strand the tab stop nowhere.
  const rovingIndex = movedIndex >= 0 ? movedIndex : Math.max(currentIndex, 0);

  const focusAt = (index: number) => {
    const next = chips[((index % chips.length) + chips.length) % chips.length];
    if (!next) return;
    setMoved({ key: next.key, forCurrent: currentKey });
    buttons.current.get(next.key)?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Horizontal toolbar: Up/Down stay unhandled on purpose. The row sits
    // beside a reorder handle whose own keyboard contract IS Up/Down, and
    // swallowing them here would teach two meanings for one pair of keys.
    switch (event.key) {
      case 'ArrowRight':
        focusAt(rovingIndex + 1);
        break;
      case 'ArrowLeft':
        focusAt(rovingIndex - 1);
        break;
      case 'Home':
        focusAt(0);
        break;
      case 'End':
        focusAt(chips.length - 1);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  // `role="toolbar"` is the composite-widget contract this row implements —
  // one tab stop, arrow-key movement — and no HTML element carries it.
  return (
    <div
      className="sidebar__layout-chips"
      role="toolbar"
      aria-label={`${projectName} layouts`}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
    >
      {chips.map((chip, index) => (
        <button
          key={chip.key}
          type="button"
          ref={(element) => {
            if (element) buttons.current.set(chip.key, element);
            else buttons.current.delete(chip.key);
          }}
          className={`sidebar__layout-chip${
            chip.current ? ' sidebar__layout-chip--current' : ''
          }`}
          aria-current={chip.current ? 'page' : undefined}
          tabIndex={index === rovingIndex ? 0 : -1}
          onClick={() => {
            // Recorded against the chip this click is about to make current,
            // so the activation that follows does not immediately expire it.
            setMoved({ key: chip.key, forCurrent: chip.key });
            chip.activate();
          }}
        >
          {chip.name}
        </button>
      ))}
    </div>
  );
}
