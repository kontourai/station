import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRegionModelOptional } from '../../contexts/RegionModelContext';
import { useKeyboardShortcut } from '../../hooks/useKeyboardShortcut';
import { useLongPress } from '../../hooks/useLongPress';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import type { RegisteredSurface } from '../../regions/region-model';
import { ChartGlyph, HomeGlyph, MessageGlyph } from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import './HeaderMenu.css';
import {
  type RegionToggle,
  useRegionSurfaceMenu,
} from './useRegionSurfaceMenu';

/**
 * #2154's chooser, loaded only when a toggle's long press or right-click
 * opens one. The toolbar is in the ENTRY chunk and the chooser is not: it
 * reaches the pane inventory and the dock's project read, which are the host
 * chunk's, and a panel most sessions never open must not be in the initial
 * download. Every call returns a new promise, which the module registry makes
 * free — memoizing it is what livelocked React's `lazy` in station#1301.
 */
const loadRegionChooserPanel = () =>
  import('../../workspace-panes/RegionChooserPanel').then((module) => ({
    default: module.RegionChooserPanel,
  }));

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
 * What a toolbar panel is. Both panels today are menus of commands; the type
 * is kept so a panel that is NOT one has to say so and gets no roving arrow
 * keys from `useMenuFocus` (#1552 review M1: a trigger once announced `menu`
 * while opening a `group`).
 */
type PopupRole = 'menu' | 'group';

/**
 * How a region's edge is drawn inside the frame — the three states a toggle
 * has (#2155 D4), as a ramp a reader can order at a glance:
 *
 * - `filled`: the region is on screen.
 * - `outlined`: hidden, and HOLDING panes — there is something to come back
 *   to. Drawn as the edge's own rectangle in outline, at the family's stroke
 *   weight, rather than as a dot or a badge: it is the same shape the filled
 *   state paints, one step down.
 * - `none`: hidden and empty. The frame alone, which is what the region is.
 *
 * The middle state is the one #2143 could not say: an empty region and a
 * region holding two hidden tabs drew the same unpressed glyph.
 */
type RegionEdgeFill = 'filled' | 'outlined' | 'none';

/**
 * The region frame with ONE edge marked: which dock region this toggle is,
 * drawn the way every comparable shell draws its layout toggles (#2143).
 * The mark follows the same facts `aria-pressed` and the tooltip report, so
 * the glyph cannot depict a state the button denies.
 */
function RegionGlyph({
  region,
  fill,
}: {
  region: RegionToggle['region'];
  fill: RegionEdgeFill;
}) {
  const edge =
    region === 'left'
      ? { x: 1, y: 1, width: 6, height: 14 }
      : region === 'right'
        ? { x: 13, y: 1, width: 6, height: 14 }
        : { x: 1, y: 9, width: 18, height: 6 };
  return (
    <svg aria-hidden="true" viewBox="0 0 20 16">
      <rect x="1" y="1" width="18" height="14" rx="2" />
      <rect
        {...edge}
        rx="1"
        fill={fill === 'filled' ? 'currentColor' : 'none'}
        // The sheet's `stroke: currentColor` reaches every rect, so an
        // unmarked edge has to say so explicitly or it would outline.
        stroke={fill === 'outlined' ? 'currentColor' : 'none'}
      />
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
  /**
   * Present for a Show/Hide toggle; ABSENT for a one-shot command — the
   * "Move <title> to the dock" row a surface occupying `main` gets (#1523),
   * which has no checked state to claim.
   */
  checked?: boolean;
  onSelect: () => void;
}

/**
 * The portalled panel and its dismiss backdrop under the app toolbar. Its one
 * caller since #2155 is the folded device's flat Show/Hide menu: the
 * per-region toggles' panel is #2154's chooser, which anchors to its trigger
 * and flips above it, while this surface fixes its `top` to the toolbar's
 * height.
 *
 * `role` is the CALLER'S: `useMenuFocus` gives arrow-key roving focus to a
 * `role="menu"` container only, and the folded menu is a menu of commands, so
 * it passes `menu`. The type is kept narrow so a later panel that is NOT a
 * menu (#1552 D2's picker was a `group` of `radiogroup`s) has to say so and
 * gets focus entry, Escape and focus-return without the roving handler.
 */
function ToolbarMenuSurface({
  ariaLabel,
  dismissLabel,
  anchorRight,
  className,
  role,
  onClose,
  children,
}: {
  ariaLabel: string;
  dismissLabel: string;
  anchorRight: number;
  className?: string;
  /**
   * Never absent — the panel has an `aria-label`, and a labelled element with
   * no role is not reachable by role from a test or an assistive technology's
   * rotor. The trigger's `aria-haspopup` says the same thing.
   */
  role: PopupRole;
  onClose: () => void;
  children: ReactNode;
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

  // ONE dismissal closure for the three events that mean "the gesture ended
  // on the backdrop", rather than three identical ones in the JSX.
  const dismiss = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    onClose();
  };

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
        // The press is swallowed so the menu keeps focus and its "Close …
        // menu" button stays operable; the RELEASE is what dismisses.
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        // `click` alone was the whole dismissal, and a touch on the backdrop
        // that turns into a scroll never becomes one — it ends in
        // `pointercancel`, and the menu stayed open until the next input
        // (#1386). `pointercancel` is what fixes that case.
        //
        // `pointerup` is not a second fix for it: `click` targets the
        // inclusive common ancestor of the press and the release, so a press
        // AND release both on the backdrop always produced a click anyway.
        // What it adds is dismissing at the release rather than at the click,
        // which also covers a gesture that starts inside the menu and ends on
        // the backdrop. A press released outside the window is still covered
        // by neither; Escape and the next click remain the recovery there.
        //
        // `onClose` is idempotent by contract — the panel's owner sets its
        // `menuOpen` state to false, and focus is returned once by
        // `useMenuFocus`'s cleanup, not by this callback — so a normal click,
        // whose `pointerup` closes the panel before `click` is dispatched, is
        // not a double dismissal. `onClick` is kept because it is the only
        // channel a caller without pointer events has. The backdrop is
        // removed on `pointerup`, and in Chromium and Gecko the click that
        // follows retargets to the nearest connected ancestor rather than to
        // whatever sits underneath; that is expected rather than verified
        // here, since jsdom cannot reproduce retargeting and no e2e drives
        // this backdrop over a live control.
        onPointerUp={dismiss}
        onPointerCancel={dismiss}
        onClick={dismiss}
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

/**
 * The folded device's flat list — one row per dock surface.
 *
 * Two row shapes, and the difference is #1523's: a surface in a dock region
 * gets a Show/Hide TOGGLE, while one occupying `main` gets a one-shot "Move
 * <title> to the dock" command, because a dock toggle can neither show it where
 * it already is nor hide the always-visible primary area. The role follows the
 * shape — `menuitemcheckbox` only where there is a checked state to report — so
 * the row never announces a state it does not have.
 */
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
 * One dock region's toolbar control (#2155). It is a TOGGLE, always, in every
 * state: `aria-pressed` is the region's visibility derived from the model, a
 * press shows or hides the region with every tab it holds, and no state of it
 * is inert or a menu trigger. #2143 made an EMPTY region's button open an
 * offer menu instead — which put a second answer to "what goes here" beside
 * the region's own chooser (#2154), left `aria-haspopup` and `aria-pressed`
 * alternating on one control, and gave a region nothing declared an
 * `aria-disabled` button. The owner's direction settles it: "by default if
 * you just click it it should just open or close it"; the toggles do not
 * control content, the pane does.
 *
 * The hide is the region bar chevron's own act, not a bare visibility write:
 * `RegionToggle.onToggle` calls the mounted shell's `setRegionOpen` through
 * `region-visibility-appliers.ts`, so the snap and the maximize memory come
 * out the same whichever control the user pressed.
 *
 * A HOLD (500ms) or a right-click opens #2154's chooser anchored here — the
 * "maybe if you do a long tap or click that could be an option" half. It is
 * deliberately NOT advertised with `aria-haspopup`: this button's primary act
 * is the toggle, the panel is a shortcut to a control that is also reachable
 * in the region itself, and announcing a popup would describe the press the
 * user is about to make as opening a menu. On a coarse pointer the hold is
 * the only route, which is why it exists at all.
 *
 * The name is the region's — "Left region", "Bottom region" — with the state
 * and the panes it holds in the tooltip, so the accessible name is stable
 * across every arrangement (an e2e can always find "Bottom region") and what
 * the region HOLDS is still one hover away.
 */
function RegionToggleButton({
  toggle,
  onOpenChooser,
}: {
  toggle: RegionToggle;
  onOpenChooser: (trigger: HTMLElement) => void;
}) {
  const label = `${toggle.label} region`;
  const holds = toggle.paneTitles.length > 0;
  // The act the press performs, then what the region is. An EMPTY region
  // takes the same verb — since #2153 showing one is a thing that happens,
  // and since #2154 what it shows is the chooser — with "(empty)" where the
  // pane list would be, so no state of this control names an act it does not
  // perform.
  const title = `${toggle.visible ? 'Hide' : 'Show'} ${label}${
    holds ? `: ${toggle.paneTitles.join(', ')}` : ' (empty)'
  }`;
  const gesture = useLongPress({
    onLongPress: onOpenChooser,
    onClick: toggle.onToggle,
  });
  return (
    <button
      type="button"
      className={`app-toolbar__region-btn app-toolbar__region-toggle${
        toggle.visible ? ' is-pressed' : holds ? ' is-holding' : ''
      }`}
      aria-label={label}
      title={title}
      aria-pressed={toggle.visible}
      {...gesture}
    >
      <RegionGlyph
        region={toggle.region}
        fill={toggle.visible ? 'filled' : holds ? 'outlined' : 'none'}
      />
    </button>
  );
}

function ConnectedRegionToolbarControls() {
  const {
    bottomOnly,
    commandsInOverflowMenu,
    surfaceList,
    toggleSurface,
    menuItems,
    regionToggles,
  } = useRegionSurfaceMenu();
  // Whether the folded device's one flat menu is open. Since #2155 it is the
  // only MENU this row opens: the per-region toggles open #2154's chooser
  // instead, which is its own state below because it carries an anchor box
  // and loads its own chunk.
  const [foldedMenuOpen, setFoldedMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setFoldedMenuOpen(false), []);
  // The chooser a toggle's hold or right-click opened: which region it is
  // for, and the box of the toggle it hangs under (#2155 D2). One state, so
  // exactly one panel is portalled at a time.
  const [chooser, setChooser] = useState<{
    region: RegionToggle['region'];
    anchor: { right: number; top: number; bottom: number };
  } | null>(null);
  const closeChooser = useCallback(() => setChooser(null), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the layout owners are this effect's trigger, not values it reads — it exists to fire when they change.
  useEffect(() => {
    // Close whenever the branch that OWNS the panel changes, not only when the
    // overflow branch takes over. Three transitions reach this, and rendering
    // through any of them is wrong in a different way:
    //   fine -> coarse while still wide: the toggles are replaced by the
    //     folded control, so an open chooser would float over a trigger
    //     that no longer exists.
    //   -> overflow: the early return below unmounts the portal without
    //     clearing this, so widening back re-opens a panel nobody reopened.
    //   overflow -> back: same state, restored under a different owner.
    setFoldedMenuOpen(false);
    setChooser(null);
  }, [bottomOnly, commandsInOverflowMenu]);
  const [menuAnchorRight, setMenuAnchorRight] = useState(8);

  const anchorTo = useCallback((trigger: HTMLElement) => {
    setMenuAnchorRight(
      window.innerWidth - trigger.getBoundingClientRect().right,
    );
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

  // A bottom-only device (a coarse pointer, or a viewport at or under 768px)
  // has ONE dock, so a toggle per region would be one toggle, and what it
  // needs to say is which of the region's panes is up: the folded Show/Hide
  // menu (#1536 F, #2046 D2). The chords above are the fast path either way.
  if (bottomOnly) {
    const label = 'Regions';
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
          aria-expanded={foldedMenuOpen}
          onClick={(event) => {
            anchorTo(event.currentTarget);
            setFoldedMenuOpen(true);
          }}
        >
          <RegionGlyph region="bottom" fill="none" />
        </button>
        {foldedMenuOpen ? (
          <ToolbarMenuSurface
            ariaLabel="Region surfaces"
            dismissLabel="Close regions menu"
            anchorRight={menuAnchorRight}
            role="menu"
            onClose={closeMenu}
          >
            <FoldedRegionMenu items={menuItems} onClose={closeMenu} />
          </ToolbarMenuSurface>
        ) : null}
      </fieldset>
    );
  }

  // #2143, settled by #2155: one toggle per dock region, in screen order, and
  // every one of them a toggle. #1536 F folded five unlabeled per-region
  // rectangles into one "Layout" control and #1552 D2 made that control a
  // per-SURFACE placement picker; this is the third shape, and it is per
  // REGION again — each button answering exactly one question ("is this
  // region open?") with a pressed state the model derives, which is what the
  // five glyphs and the picker both lacked. What a region holds lives in its
  // own tab strip (#2046) and its chooser (#2154); how a pane moves is the
  // tab's own menu (`RegionChromeBar`).
  return (
    <fieldset className="app-toolbar__regions">
      <legend>Regions</legend>
      {shortcuts}
      {regionToggles.map((toggle) => (
        <RegionToggleButton
          key={toggle.region}
          toggle={toggle}
          onOpenChooser={(trigger) => {
            const box = trigger.getBoundingClientRect();
            setChooser({
              region: toggle.region,
              anchor: { right: box.right, top: box.top, bottom: box.bottom },
            });
          }}
        />
      ))}
      {chooser ? (
        // `pending={null}`: the chunk is small and the panel is the response
        // to a gesture the user just completed, so a skeleton hanging under
        // the toggle for a frame would be more motion than information.
        <LazyBoundary
          load={loadRegionChooserPanel}
          componentProps={{
            regionId: chooser.region,
            anchor: chooser.anchor,
            onClose: closeChooser,
          }}
          pending={null}
        />
      ) : null}
    </fieldset>
  );
}

export function RegionToolbarControls() {
  return useRegionModelOptional() ? <ConnectedRegionToolbarControls /> : null;
}
