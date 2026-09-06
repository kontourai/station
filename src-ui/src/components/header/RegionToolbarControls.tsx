import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRegionModelOptional } from '../../contexts/RegionModelContext';
import { useKeyboardShortcut } from '../../hooks/useKeyboardShortcut';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import type { RegisteredSurface } from '../../regions/region-model';
import { ChartGlyph, HomeGlyph, MessageGlyph } from '../icons/Glyph';
import './HeaderMenu.css';
import {
  type RegionPlacementRow,
  useRegionSurfaceMenu,
} from './useRegionSurfaceMenu';

/**
 * `RegisteredSurface.icon` → a glyph from the one factory, so every icon in this
 * control and its menu is drawn at the family's single stroke weight (#1552 D1).
 * An unknown key renders nothing rather than a placeholder: the slot is reserved
 * either way, so the labels still line up, and a surface with no glyph should
 * not be given a wrong one.
 */
function SurfaceGlyph({ icon }: { icon: string }) {
  if (icon === 'chat') return <MessageGlyph />;
  if (icon === 'activity') return <ChartGlyph />;
  if (icon === 'home') return <HomeGlyph />;
  return null;
}

const DOCK_WHEN = { not: 'composerFocused' } as const;

/**
 * What the folded control opens. The trigger's `aria-haspopup` and the panel's
 * own `role` are both derived from one value of this type, so a branch cannot
 * announce one and render the other (#1552 review M1).
 */
type PopupRole = 'menu' | 'group';

/**
 * Where the picker puts focus on open: the checked segment of the first row —
 * where the surface currently IS, which is also the row's roving tab stop.
 */
const CHECKED_SEGMENT = '[role="radio"][aria-checked="true"]';

/**
 * The region frame. One glyph, not one per region: since #1536 F the toolbar
 * carries a single folded control, so the glyph names the arrangement rather
 * than identifying which of five rectangles this one was.
 */
function LayoutGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 16">
      <rect x="1" y="1" width="18" height="14" rx="2" />
      <path d="M6 1v9M1 10h18" />
    </svg>
  );
}

function RegionShortcut({
  surface,
  shortcut,
  onToggle,
}: {
  surface: RegisteredSurface;
  shortcut: NonNullable<RegisteredSurface['shortcut']>;
  onToggle: () => void;
}) {
  useKeyboardShortcut(
    shortcut.id,
    shortcut.key,
    [...shortcut.modifiers],
    `Toggle ${surface.title} region`,
    onToggle,
    true,
    0,
    DOCK_WHEN,
  );
  return null;
}

interface ToolbarMenuRow {
  key: string;
  label: string;
  /** `RegisteredSurface.icon`, for the row's 16px glyph slot. */
  icon: string;
  checked: boolean;
  onSelect: () => void;
}

/**
 * The portalled panel and its dismiss backdrop, shared by the folded device's
 * flat Show/Hide menu and the fine pointer's placement picker.
 *
 * `role` is the CALLER'S, not this component's, and that is load-bearing.
 * `useMenuFocus` gives arrow-key roving focus to a `role="menu"` container only
 * — deliberately, because a container that is not a menu must keep the arrow
 * keys for whatever pattern it does declare. The picker is a stack of
 * `radiogroup`s whose arrow keys belong to the row a segment sits in, so it
 * passes no role and gets focus entry, Escape and focus-return from the hook
 * without the roving handler that would swallow them (#1552 D2).
 */
function ToolbarMenuSurface({
  ariaLabel,
  dismissLabel,
  anchorRight,
  className,
  role,
  initialFocusSelector,
  onClose,
  children,
}: {
  ariaLabel: string;
  dismissLabel: string;
  anchorRight: number;
  className?: string;
  /**
   * `menu` for the folded command list; `group` for the placement picker, whose
   * arrow keys belong to the `radiogroup` rows inside it. Never absent — the
   * panel has an `aria-label`, and a labelled element with no role is not
   * reachable by role from a test or an assistive technology's rotor.
   *
   * The TRIGGER derives its `aria-haspopup` from this same value, so the claim
   * and the popup cannot disagree (#1552 review M1: it announced `menu` while
   * opening a `group`).
   */
  role: PopupRole;
  /**
   * Where focus lands on open, when the family's default is wrong.
   *
   * `useMenuFocus` focuses the first focusable descendant, which for the picker
   * is the first row's FIRST segment — not its checked one — so opening the
   * panel silently proposed "Left" while the roving `tabIndex` said the checked
   * segment was the row's tab stop (review M2). Applied in an effect declared
   * AFTER the `useMenuFocus` call below, so it runs after that hook's own focus
   * within the same commit rather than racing it.
   */
  initialFocusSelector?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const menuRef = useMenuFocus<HTMLDivElement>(true, onClose);
  // Declared after `useMenuFocus` on purpose: effects in one component run in
  // declaration order, so this lands after that hook has already focused the
  // first focusable descendant, and replaces it rather than being replaced.
  useEffect(() => {
    if (!initialFocusSelector) return;
    menuRef.current?.querySelector<HTMLElement>(initialFocusSelector)?.focus();
  }, [initialFocusSelector, menuRef]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return createPortal(
    <>
      <button
        type="button"
        // A pointer convenience, not a tab stop: it sits immediately before the
        // menu in document order, so as a tab stop Shift+Tab off the first row
        // landed on it and `useMenuFocus`'s focusout closed the menu.
        tabIndex={-1}
        className="header-menu__dismiss-backdrop"
        aria-label={dismissLabel}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 'calc(var(--layer-navigation) - 1)',
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
      />
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: `role` is always set (its type is `'menu' | 'group'`), which the rule cannot see through a dynamic value; both roles support a name. */}
      <div
        ref={menuRef}
        className={`menu-surface app-toolbar__overflow-menu app-toolbar__region-menu${
          className ? ` ${className}` : ''
        }`}
        role={role}
        aria-label={ariaLabel}
        tabIndex={-1}
        style={{ right: `${anchorRight}px` }}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

/** The folded device's flat Show/Hide list — one row per dock surface. */
function FoldedRegionMenu({
  items,
  onClose,
}: {
  items: readonly ToolbarMenuRow[];
  onClose: () => void;
}) {
  return (
    <>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className="menu-row"
          role="menuitemcheckbox"
          aria-checked={item.checked}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          <span className="menu-row__glyph" aria-hidden="true">
            <SurfaceGlyph icon={item.icon} />
          </span>
          {item.label}
        </button>
      ))}
    </>
  );
}

/**
 * The fine pointer's placement picker: one row per surface, a segmented control
 * of the regions that surface declares plus `Hidden`.
 *
 * KEYBOARD. Each row is a `radiogroup` and its segments are `radio`s with roving
 * `tabIndex`, so the arrow keys move WITHIN a row and Tab moves BETWEEN rows —
 * the standard radio-group pattern, and the reason the container above is not a
 * `role="menu"` (a menu owns the arrow keys for its own rows, which would take
 * them away from the segments here).
 *
 * The arrows move FOCUS only; Space/Enter on the focused segment commits it and
 * closes the panel. A radio group conventionally selects as it moves, but here
 * selection IS the placement — it relocates a surface and dismisses the panel —
 * so moving through the segments would rearrange the shell three times on the
 * way to the fourth. Focus-only is the deliberate deviation (#1552 review L1).
 *
 * PRESSED STATE is `segment.checked`, derived by `useRegionSurfaceMenu` from the
 * arrangement. Nothing here holds a second opinion about which segment is on.
 */
function RegionPlacementPicker({
  rows,
  onClose,
}: {
  rows: readonly RegionPlacementRow[];
  onClose: () => void;
}) {
  return (
    <>
      {rows.map((row) => {
        // Roving tabIndex: the checked segment is the row's tab stop, so Tab
        // lands on the current placement rather than on the first one.
        const checkedIndex = Math.max(
          row.segments.findIndex((segment) => segment.checked),
          0,
        );
        return (
          <div
            key={row.surfaceId}
            className="region-placement__row"
            role="radiogroup"
            aria-label={`${row.label} placement`}
            onKeyDown={(event) => {
              const step =
                event.key === 'ArrowRight' || event.key === 'ArrowDown'
                  ? 1
                  : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                    ? -1
                    : 0;
              if (step === 0) return;
              event.preventDefault();
              event.stopPropagation();
              const segments = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role="radio"]',
                ),
              ];
              const current = segments.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const from = current < 0 ? checkedIndex : current;
              // Wraps, as a radio group does.
              segments[
                (from + step + segments.length) % segments.length
              ]?.focus();
            }}
          >
            <span className="region-placement__surface">
              <span className="region-placement__glyph" aria-hidden="true">
                <SurfaceGlyph icon={row.icon} />
              </span>
              {row.label}
            </span>
            <span className="region-placement__segments">
              {row.segments.map((segment, index) => (
                // biome-ignore lint/a11y/useSemanticElements: a segmented control is a styled button row, not a form control — `<input type="radio">` cannot carry the segment's own box, needs a visible `<label>` per segment, and submits nothing.
                <button
                  key={segment.key}
                  type="button"
                  className="region-placement__segment"
                  role="radio"
                  aria-checked={segment.checked}
                  tabIndex={index === checkedIndex ? 0 : -1}
                  // What happens to whoever holds the region, from the model's
                  // own `placeSurface` run over the current arrangement — see
                  // `displacementNote`. Absent when nothing is displaced, so a
                  // tooltip never promises a consequence that will not occur.
                  //
                  // `title` is a POINTER channel only, so the consequence is
                  // also a description (#1552 review L6). The referenced span is
                  // `hidden`, which keeps it out of the button's accessible NAME
                  // (still just "Bottom") while `aria-describedby` still
                  // resolves its text — the accname spec includes referenced
                  // hidden nodes.
                  {...(segment.displaces
                    ? {
                        title: segment.displaces,
                        'aria-describedby': `${segment.key}-displaces`,
                      }
                    : {})}
                  onClick={() => {
                    segment.onSelect();
                    onClose();
                  }}
                >
                  {segment.label}
                  {segment.displaces ? (
                    <span id={`${segment.key}-displaces`} hidden>
                      {segment.displaces}
                    </span>
                  ) : null}
                </button>
              ))}
            </span>
          </div>
        );
      })}
    </>
  );
}

function ConnectedRegionToolbarControls() {
  const {
    bottomOnly,
    commandsInOverflowMenu,
    surfaceList,
    toggleSurface,
    menuItems,
    placementRows,
  } = useRegionSurfaceMenu();
  const [menuOpen, setMenuOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the layout owners are this effect's trigger, not values it reads — it exists to fire when they change.
  useEffect(() => {
    // Close whenever the branch that OWNS the menu changes, not only when the
    // overflow branch takes over. Three transitions reach this, and rendering
    // through any of them is wrong in a different way:
    //   fine -> coarse while still wide: the menu's CONTENTS change from the
    //     grouped Layout rows to the folded Show/Hide list under a trigger
    //     whose name changed too, so an open menu silently becomes a
    //     different menu.
    //   -> overflow: the early return below unmounts the portal without
    //     clearing this, so widening back re-opens a menu nobody reopened.
    //   overflow -> back: same state, restored under a different owner.
    // The anchor belongs to the trigger that opened it, and that trigger is
    // what these transitions replace.
    setMenuOpen(false);
  }, [bottomOnly, commandsInOverflowMenu]);
  const [menuAnchorRight, setMenuAnchorRight] = useState(8);

  const openMenu = useCallback((trigger: HTMLButtonElement) => {
    setMenuAnchorRight(
      window.innerWidth - trigger.getBoundingClientRect().right,
    );
    setMenuOpen(true);
  }, []);

  const shortcuts = surfaceList.flatMap((surface) =>
    surface.shortcut ? (
      <RegionShortcut
        key={surface.id}
        surface={surface}
        shortcut={surface.shortcut}
        onToggle={() => toggleSurface(surface)}
      />
    ) : (
      []
    ),
  );

  // #917: where the `⋯` overflow menu exists, it takes the region commands and
  // this row renders NO control at all. The 44px button plus its gap is
  // exactly what pushed the Settings gear off a 402px viewport once the
  // fieldset stopped packing below its contents, and a region button in that
  // row is what the connection button was colliding with in the first place.
  // An empty fieldset is not good enough — it still costs its own box and its
  // legend — so nothing is rendered here but the chords, which are `null`
  // elements. `commandsInOverflowMenu`, not `bottomOnly`: see the hook.
  if (commandsInOverflowMenu) return <>{shortcuts}</>;

  // #1536 F: ONE control, not five. The five per-region buttons were unlabeled
  // monochrome rectangles distinguished by a 6px divider and a 6px "+" badge,
  // and nothing on a fresh home said what any of them did. The commands are
  // unchanged — every Show/Hide, Place and Swap the buttons carried is a row
  // in this menu — and so are the chords above, which are the fast path.
  const label = bottomOnly ? 'Regions' : 'Layout regions';
  // ONE decision, read by the trigger and by the panel. The folded branch opens
  // a menu of commands; the fine pointer opens a group of `radiogroup` rows, and
  // `aria-haspopup` has no value that describes that — so it is omitted rather
  // than made up. `aria-expanded` still reports the panel's state either way.
  const popupRole: PopupRole = bottomOnly ? 'menu' : 'group';
  return (
    <fieldset className="app-toolbar__regions">
      <legend>Regions</legend>
      {shortcuts}
      <button
        type="button"
        className="app-toolbar__region-btn app-toolbar__region-layout"
        aria-label={label}
        title={label}
        {...(popupRole === 'menu' ? { 'aria-haspopup': 'menu' as const } : {})}
        aria-expanded={menuOpen}
        onClick={(event) => openMenu(event.currentTarget)}
      >
        <LayoutGlyph />
        {/* A visible word, because the glyph alone is what nothing on a fresh
            home explained. The accessible name contains it (WCAG 2.5.3). The
            folded branch keeps its glyph-only button: it renders on a coarse
            pointer too wide to be mobile, where #917's width budget is the
            live constraint and the menu it opens is a flat Show/Hide list, not
            a four-region arrangement needing a name. */}
        {bottomOnly ? null : (
          <span className="app-toolbar__region-layout-label">Layout</span>
        )}
      </button>
      {menuOpen ? (
        <ToolbarMenuSurface
          ariaLabel={bottomOnly ? 'Region surfaces' : 'Layout regions'}
          dismissLabel={bottomOnly ? 'Close regions menu' : 'Close layout menu'}
          anchorRight={menuAnchorRight}
          // The folded list IS a menu of commands and keeps the role (and with
          // it `useMenuFocus`'s arrow keys). The picker is a `group` of
          // `radiogroup`s — see `ToolbarMenuSurface`. Same value the trigger's
          // `aria-haspopup` is derived from.
          role={popupRole}
          initialFocusSelector={bottomOnly ? undefined : CHECKED_SEGMENT}
          className={bottomOnly ? undefined : 'region-placement'}
          onClose={() => setMenuOpen(false)}
        >
          {bottomOnly ? (
            <FoldedRegionMenu
              items={menuItems}
              onClose={() => setMenuOpen(false)}
            />
          ) : (
            <RegionPlacementPicker
              rows={placementRows}
              onClose={() => setMenuOpen(false)}
            />
          )}
        </ToolbarMenuSurface>
      ) : null}
    </fieldset>
  );
}

export function RegionToolbarControls() {
  return useRegionModelOptional() ? <ConnectedRegionToolbarControls /> : null;
}
