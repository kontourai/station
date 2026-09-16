import { useCallback, useRef, useState } from 'react';
import { useRegionModelOptional } from '../../contexts/RegionModelContext';
import { LazyBoundary } from '../LazyBoundary';

/**
 * Module-level so `LazyBoundary` sees ONE identity: it memoizes the lazy
 * component on this function, and a factory rebuilt every render would remount
 * the chunk on each keystroke elsewhere in the rail.
 */
const loadProjectLayoutChipMenu = () =>
  import('./ProjectLayoutChipMenu').then((module) => ({
    default: module.ProjectLayoutChipMenu,
  }));

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
  /**
   * This chip's Layout as a dock pane (#2158), when it has one:
   * `layout:<projectId>/<layoutId>`, built by `sidebarLayoutPaneId`.
   *
   * ABSENT is a real answer and there are two of them. The synthesized
   * "Board" chip is the project's SESSION board, which is a route and not a
   * pane at all (#2157 declares panes for Boards and project Layouts only),
   * and a Layout whose id is not the lowercase UUID the server mints cannot
   * be named by the grammar. Either way the chip offers no placement rows,
   * and its `contextmenu` is left to the platform rather than swallowed by a
   * menu with nothing in it.
   */
  dockSurfaceId?: string | null;
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
  /**
   * The chip whose "Open in <region>" menu is open, by key — one at a time,
   * the shape `ProjectSidebarBoards`' `RowMode` already uses for the rail's
   * other pill menu (#2158).
   */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /**
   * Bumped by every gesture that opens the menu, and used as the
   * `LazyBoundary`'s `key` — so each gesture gets a FRESH boundary (#2158).
   *
   * Without it a failed chunk fetch was permanent. `LazyBoundary` clears its
   * error only when its `onRetry` runs, and the `unavailable` renderer below
   * discards that callback deliberately (an error card with two buttons is a
   * worse answer than no menu, and nothing in the rail could dismiss it); its
   * `attempt` therefore never moved, and the boundary is not unmounted by
   * re-opening either — right-clicking the SAME chip writes the value
   * `menuFor` already holds and React bails out, and a different chip only
   * changes the boundary's props. One failed fetch and the chip's menu was off
   * for the life of the row, silently. A key the gesture owns is what makes
   * the retry real rather than asserted in a comment.
   */
  const [menuAttempt, setMenuAttempt] = useState(0);
  /**
   * Whether a region model is mounted — the whole of what this strip needs to
   * know before it swallows a gesture. WHICH regions is the menu's own read
   * (`pill-region-open.ts`, behind the lazy boundary), because
   * `availablePlacements` never answers with an empty list: a coarse pointer
   * or a narrow viewport offers `['bottom']`, not nothing. So "there is a
   * model" and "there is somewhere to put it" are the same fact here, and this
   * is the cheap spelling of it in a chunk every cold load pays for.
   */
  const hasRegionModel = useRegionModelOptional() !== null;

  // Derived from the LIST, not trusted from state: a layout deleted or a
  // project switched under an open menu leaves a key naming no chip, and a
  // menu whose subject has left the row is a menu about nothing.
  const menuChip = chips.find((chip) => chip.key === menuFor);
  const closeMenu = useCallback(() => setMenuFor(null), []);

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

  /**
   * Opens one chip's menu, or answers that there is nothing to open.
   *
   * Shared by the two gestures that reach it — `contextmenu` on the chip and
   * the keyboard's own context-menu request on the strip — so both apply the
   * same precondition and both get a fresh boundary. Returns whether it
   * opened, because each caller only suppresses the platform's default
   * behaviour when it did.
   */
  const openMenuFor = (index: number): boolean => {
    const chip = chips[index];
    if (!chip?.dockSurfaceId || !hasRegionModel) return false;
    focusAt(index);
    setMenuFor(chip.key);
    setMenuAttempt((attempt) => attempt + 1);
    return true;
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Horizontal toolbar: Up/Down stay unhandled on purpose. The row sits
    // beside a reorder handle whose own keyboard contract IS Up/Down, and
    // swallowing them here would teach two meanings for one pair of keys.
    switch (event.key) {
      /**
       * The keyboard's route to the chip's menu (#2158), and the ONLY key
       * this adds.
       *
       * The context-menu gesture is already a keyboard route on Windows and
       * Linux: the Menu key and Shift+F10 make the browser fire `contextmenu`
       * on the focused element, which the chip's own handler answers. macOS
       * has neither — no Menu key, no Shift+F10 — so on Station's primary
       * desktop platform a sighted keyboard-only reader had NO way to reach
       * these rows, while the design record claimed the menu is the route a
       * keyboard has. Shift+Enter is what closes that, and handling the
       * `ContextMenu` key here as well would be a second mechanism doing what
       * the browser already does for the first.
       *
       * The subject is the chip holding the roving tab stop, which is the chip
       * the reader is on. `preventDefault` runs at the bottom of this handler
       * and only when a menu actually OPENED — which is what leaves Enter its
       * ordinary meaning (activate the chip, navigate) on plain Enter, and on
       * a chip with nothing to offer.
       */
      case 'Enter':
        if (!event.shiftKey || !openMenuFor(rovingIndex)) return;
        break;
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
  //
  // The menu is the strip's SIBLING, never a descendant (#2158 D5). A
  // `role="menu"` inside a `role="toolbar"` puts a second focusable structure
  // inside the composite widget the toolbar promises is one tab stop, and its
  // rows would land in the strip's own Left/Right roving order. Outside it,
  // the strip's tab stop and arrow keys are exactly what they were.
  return (
    <>
      <div
        className="sidebar__layout-chips"
        role="toolbar"
        aria-label={`${projectName} layouts`}
        aria-orientation="horizontal"
        // Advertised, not just implemented: a chord nothing announces is a
        // chord only its author knows. The reorder handle beside this row
        // states its own the same way.
        aria-keyshortcuts="Shift+Enter"
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
            // #2158: the chip's own "Open in <region>" menu, on the BUTTON
            // rather than a wrapper (a handler on a static element is what
            // the a11y ratchet refuses). Anchored below the strip, not at the
            // pointer, following `RegionChromeBar`'s tab menu: a panel at the
            // pointer covers the control that opened it.
            //
            // Nothing to offer, nothing swallowed — the shape
            // `RegionChromeBar` uses for a tab that cannot move. The Session
            // Board chip carries no `dockSurfaceId`, and a folded device
            // offers no region, so on both the platform keeps its own menu
            // rather than meeting an empty one.
            //
            // NO `aria-haspopup` here either, following that same tab: the
            // menu is reachable ONLY by the context-menu gesture, and a chip
            // announcing a popup would be describing something Enter and
            // Space do not do — they navigate, which is the chip's primary
            // action and stays so.
            //
            // `openMenuFor` moves the roving tab stop onto this chip as it
            // focuses it — the same pair `focusAt` performs for an arrow key.
            // Focusing without the stop would leave the strip's
            // `tabIndex={0}` on a different chip from the one holding focus;
            // not focusing at all would leave the menu's return focus
            // (`useMenuFocus` captures whatever is focused when it opens)
            // wherever the engine happened to put it, and engines disagree
            // about whether a right-click focuses a button.
            //
            // ON TOUCH this is the LONG PRESS, and suppressing the platform
            // callout is the point: the pill's menu is what the gesture is
            // for. A coarse pointer offers one region rather than none, so
            // the Boards row beside it answers the same gesture the same way.
            onContextMenu={(event) => {
              if (!openMenuFor(index)) return;
              event.preventDefault();
            }}
          >
            {chip.name}
          </button>
        ))}
      </div>
      {/* Both halves, not just the id — the same pair `openMenuFor` requires,
          so a model that goes away under an open menu takes the menu with
          it rather than leaving a surface nothing can honour. */}
      {menuChip?.dockSurfaceId && hasRegionModel && (
        <LazyBoundary
          // A FRESH boundary per gesture — see `menuAttempt`. This is what
          // retries an import that failed; nothing else can.
          key={menuAttempt}
          load={loadProjectLayoutChipMenu}
          componentProps={{
            label: `${menuChip.name} actions`,
            surfaceId: menuChip.dockSurfaceId,
            onClose: closeMenu,
          }}
          pending={null}
          // A menu that failed to arrive renders nothing, rather than planting
          // an error card with two buttons permanently in a 240px rail that
          // nothing here could dismiss. Discarding `onRetry` is why the retry
          // has to come from `key={menuAttempt}` above.
          unavailable={() => null}
        />
      )}
    </>
  );
}
