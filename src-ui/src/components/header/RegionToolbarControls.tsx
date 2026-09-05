import { Fragment, useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRegionModelOptional } from '../../contexts/RegionModelContext';
import { useKeyboardShortcut } from '../../hooks/useKeyboardShortcut';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import type { RegisteredSurface } from '../../regions/region-model';
import './HeaderMenu.css';
import { useRegionSurfaceMenu } from './useRegionSurfaceMenu';

const DOCK_WHEN = { not: 'composerFocused' } as const;

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
  /** Present for a toggle; absent for a one-shot command. */
  checked?: boolean;
  onSelect: () => void;
}

interface ToolbarMenuSection {
  key: string;
  /** `null` renders the rows directly under the menu, with no group heading. */
  label: string | null;
  items: readonly ToolbarMenuRow[];
}

function ToolbarMenu({
  ariaLabel,
  dismissLabel,
  anchorRight,
  onClose,
  sections,
}: {
  ariaLabel: string;
  dismissLabel: string;
  anchorRight: number;
  onClose: () => void;
  sections: readonly ToolbarMenuSection[];
}) {
  const menuRef = useMenuFocus<HTMLDivElement>(true, onClose);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const row = (item: ToolbarMenuRow) => (
    <button
      key={item.key}
      type="button"
      {...(item.checked === undefined
        ? { role: 'menuitem' as const }
        : {
            role: 'menuitemcheckbox' as const,
            'aria-checked': item.checked,
          })}
      onClick={() => {
        item.onSelect();
        onClose();
      }}
    >
      {item.label}
    </button>
  );

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
      <div
        ref={menuRef}
        className="app-toolbar__overflow-menu app-toolbar__region-menu"
        role="menu"
        aria-label={ariaLabel}
        tabIndex={-1}
        style={{ right: `${anchorRight}px` }}
      >
        {sections.map((section) =>
          section.label === null ? (
            <Fragment key={section.key}>{section.items.map(row)}</Fragment>
          ) : (
            // A `fieldset`, whose implicit role IS `group` — a legal child of
            // `menu`, with the rows staying `menuitem`/`menuitemcheckbox`
            // inside it — so the region a command belongs to is announced
            // instead of being repeated in the label of every single row
            // ("Hide Chat Bottom region" five times over). The `legend` is the
            // group's name AND its visible heading, so there is no second
            // aria-hidden copy of the same word to keep in step.
            <fieldset
              key={section.key}
              className="app-toolbar__region-menu-group"
            >
              <legend>{section.label}</legend>
              {section.items.map(row)}
            </fieldset>
          ),
        )}
      </div>
    </>,
    document.body,
  );
}

function ConnectedRegionToolbarControls() {
  const {
    bottomOnly,
    commandsInOverflowMenu,
    surfaceList,
    toggleSurface,
    menuItems,
    layoutGroups,
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
  return (
    <fieldset className="app-toolbar__regions">
      <legend>Regions</legend>
      {shortcuts}
      <button
        type="button"
        className="app-toolbar__region-btn app-toolbar__region-layout"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
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
        <ToolbarMenu
          ariaLabel={bottomOnly ? 'Region surfaces' : 'Layout regions'}
          dismissLabel={bottomOnly ? 'Close regions menu' : 'Close layout menu'}
          anchorRight={menuAnchorRight}
          onClose={() => setMenuOpen(false)}
          sections={
            bottomOnly
              ? [{ key: 'folded', label: null, items: menuItems }]
              : layoutGroups.map((group) => ({
                  key: group.region,
                  label: group.label,
                  items: group.items,
                }))
          }
        />
      ) : null}
    </fieldset>
  );
}

export function RegionToolbarControls() {
  return useRegionModelOptional() ? <ConnectedRegionToolbarControls /> : null;
}
