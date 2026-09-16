import { useEffect } from 'react';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import { regionLabel } from '../../regions/region-model';
import { useSidebarPillRegions } from './pill-region-open';

/**
 * A project Layout chip's "Open in <region>" menu (#2158).
 *
 * ## Why it is a chunk of its own
 *
 * `ProjectLayoutChips` is EAGER — `main.tsx` → `App.tsx` → `ProjectSidebar` —
 * so everything it references is paid for on every cold load by every user,
 * including the ones who never right-click a chip.
 *
 * THE MEASUREMENT THAT DECIDES IT, taken on this branch against base
 * 3b55b26fb, ceiling 333800: with this component inlined into
 * `ProjectLayoutChips` (and the retry key dropped, which an inlined menu does
 * not need) the entry chunk measures 333884 — over. Behind this boundary it
 * measures 333738. The delta is 146 B, which is smaller than this file's own
 * weight because the stub, the key and the boundary call are not free; 146 is
 * the number that decides it, not the component's size.
 *
 * That is also the shape its sibling already has. The Boards SECTION — whose
 * row menu this one mirrors — is behind a `LazyBoundary` for the same reason
 * (`ProjectSidebar.tsx`), which is why the eager copy was the odd one out
 * rather than this being a new kind of thing in the rail.
 *
 * The cost of the boundary, stated: the first right-click on a chip fetches
 * this chunk before the menu appears, and a fetch that fails renders nothing — `unavailable={() => null}` at the call
 * site, because an error card with two buttons planted permanently in a 240px
 * rail is a worse answer for a menu than no menu. That renderer discards
 * `LazyBoundary`'s own `onRetry`, so the retry is NOT the boundary's: the call
 * site gives it a `key` the gesture owns, and each new gesture mounts a fresh
 * boundary that runs the import again.
 */
export function ProjectLayoutChipMenu({
  label,
  surfaceId,
  onClose,
}: {
  /** The menu's accessible name; its rows read bare beneath it. */
  label: string;
  /** The Layout this chip names, as `layout:<projectId>/<layoutId>`. */
  surfaceId: string;
  onClose: () => void;
}) {
  // Read HERE rather than taken as a prop: the strip that mounts this is
  // eager, and the device read belongs with the rows it decides.
  const { regions, openInRegion } = useSidebarPillRegions();
  // Always open: this component only exists while the menu is.
  const menuRef = useMenuFocus<HTMLDivElement>(true, onClose);

  /**
   * Outside-pointer dismissal, the same gap and the same answer as
   * `ProjectSidebarBoards`' row menu: `useMenuFocus`'s focusout covers leaving
   * by keyboard and pressing another focusable control, but not a press on
   * ordinary page furniture — the rail's background, a section label — which
   * moves focus to `<body>` in some engines and nowhere at all in others. This
   * menu renders IN FLOW inside the scrolling rail, so the portalled header
   * menus' full-viewport dismiss backdrop is not available to it.
   *
   * NO EXEMPTION for the chip that opened it, which is where this differs from
   * that sibling. The exemption exists there because the Boards row's `⋯` is a
   * TOGGLE: without it the press closes the menu and the click that follows
   * reopens it, so the control looks inert. A `contextmenu` is not a toggle —
   * a right-click on the same chip closes the menu on the press and opens it
   * again on the gesture, which is what a second right-click should do anyway.
   */
  useEffect(() => {
    const onPointerDown = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () =>
      document.removeEventListener('pointerdown', onPointerDown, true);
  }, [menuRef, onClose]);

  return (
    <div
      ref={menuRef}
      className="menu-surface sidebar__layout-chip-menu"
      role="menu"
      aria-label={label}
      // Required by `useMenuFocus`: focus lands on the container when the menu
      // holds nothing focusable. `availablePlacements` never answers with an
      // empty list, so a mounted menu always has a row — but the hook's
      // contract is the container's, not this caller's.
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        // The shell carries document-level Escape handlers; dismissing a menu
        // is not also a request to close what is behind it.
        event.stopPropagation();
        // `useMenuFocus`'s teardown returns focus to the chip.
        onClose();
      }}
    >
      {regions.map((region) => (
        <button
          key={region}
          type="button"
          className="menu-row"
          role="menuitem"
          onClick={() => {
            onClose();
            openInRegion(surfaceId, region);
          }}
        >
          {/* Bare, with the subject in the menu's own `aria-label` — the shape
              the Boards row menu uses for Rename and Delete. */}
          Open in {regionLabel(region)}
        </button>
      ))}
    </div>
  );
}
