import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRegionModelOptional } from '../../contexts/RegionModelContext';
import { useKeyboardShortcut } from '../../hooks/useKeyboardShortcut';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import type { RegisteredSurface } from '../../regions/region-model';
import { ChartGlyph, HomeGlyph, MessageGlyph } from '../icons/Glyph';
import './HeaderMenu.css';
import {
  type RegionToggle,
  type RegionToggleOffer,
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
 * What a toolbar panel is. Both panels today are menus of commands; the type
 * is kept so a panel that is NOT one has to say so and gets no roving arrow
 * keys from `useMenuFocus` (#1552 review M1: a trigger once announced `menu`
 * while opening a `group`).
 */
type PopupRole = 'menu' | 'group';

/**
 * The region frame with ONE edge filled: which dock region this toggle is,
 * drawn the way every comparable shell draws its layout toggles (#2143). The
 * fill follows `pressed` — a shown region is a filled edge, a hidden one an
 * outlined edge — so the glyph depicts the same fact `aria-pressed` reports.
 */
function RegionGlyph({
  region,
  pressed,
}: {
  region: RegionToggle['region'];
  pressed: boolean;
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
        fill={pressed ? 'currentColor' : 'none'}
        stroke="none"
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
 * The portalled panel and its dismiss backdrop, shared by the folded device's
 * flat Show/Hide menu and an empty region's offer menu (#2143).
 *
 * `role` is the CALLER'S: `useMenuFocus` gives arrow-key roving focus to a
 * `role="menu"` container only, and both menus here are menus of commands, so
 * both pass `menu`. The type is kept narrow so a later panel that is NOT a
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
 * What an EMPTY region's control opens (#2143): the shell surfaces that
 * declare the region, one command row each. A region with no panes cannot be
 * shown — the shell mounts no host for it and the model hides a region its
 * last pane leaves — so its toggle would be a control that does nothing;
 * offering what can go there is the only honest thing the button can do.
 * Choosing a row is `placeSurface` through the hook, and closes the menu.
 */
function RegionOfferMenu({
  offers,
  onClose,
}: {
  offers: readonly RegionToggleOffer[];
  onClose: () => void;
}) {
  return (
    <>
      {offers.map((offer) => (
        <button
          key={offer.surfaceId}
          type="button"
          role="menuitem"
          className="menu-row"
          onClick={() => {
            offer.onSelect();
            onClose();
          }}
        >
          <span className="menu-row__glyph" aria-hidden="true">
            <SurfaceGlyph icon={offer.icon} />
          </span>
          Show {offer.label} here
        </button>
      ))}
    </>
  );
}

/**
 * One dock region's toolbar control (#2143). While the region holds panes it
 * is a TOGGLE — `aria-pressed` is the region's visibility, derived from the
 * model, and a press shows or hides the region with every tab it holds — the
 * shape VS Code's three layout toggles and T3 Code's panel toggle have, and
 * the shape #2044's outcome sentence asks for ("show/hide … per region").
 * While it holds none it opens `RegionOfferMenu`, and claims the popup only
 * then, so `aria-haspopup` and `aria-pressed` are never both on one button:
 * a control is a toggle or a menu trigger, not both at once.
 *
 * The name is the region's — "Left region", "Bottom region" — with the panes
 * it holds in the tooltip ("Bottom region: Chat, Activity"), so the accessible
 * name is stable across every arrangement (an e2e can always find "Bottom
 * region") and what the region HOLDS is still one hover away.
 */
function RegionToggleButton({
  toggle,
  menuOpen,
  onOpenMenu,
}: {
  toggle: RegionToggle;
  menuOpen: boolean;
  onOpenMenu: (trigger: HTMLButtonElement) => void;
}) {
  const empty = toggle.paneTitles.length === 0;
  // A menu trigger only while there is something to offer: an empty region
  // no shell surface declares (none today — both dock surfaces declare all
  // three edges — but the registry decides that, not this button) would
  // otherwise announce a popup and open an empty panel. It is inert instead
  // — `aria-disabled`, not `disabled`, so it stays in the tab order and its
  // accessible name carries the reason a `title` alone cannot deliver to a
  // keyboard or screen-reader user.
  const offers = empty && toggle.offers.length > 0;
  const label = `${toggle.label} region`;
  const inert = empty && !offers;
  const title = empty
    ? `${label}: empty${inert ? ', nothing can be shown here' : ''}`
    : `${toggle.visible ? 'Hide' : 'Show'} ${label}: ${toggle.paneTitles.join(', ')}`;
  return (
    <button
      type="button"
      className={`app-toolbar__region-btn app-toolbar__region-toggle${
        toggle.visible ? ' is-pressed' : ''
      }`}
      aria-label={inert ? title : label}
      title={title}
      {...(empty
        ? offers
          ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': menuOpen }
          : { 'aria-disabled': true }
        : { 'aria-pressed': toggle.visible })}
      onClick={(event) => {
        if (inert) return;
        if (empty) onOpenMenu(event.currentTarget);
        else toggle.onToggle();
      }}
    >
      <RegionGlyph region={toggle.region} pressed={toggle.visible} />
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
  // Which menu is open: the folded branch's one flat menu (`'folded'`), or an
  // empty region's offer menu, keyed by region. One state for both so exactly
  // one panel can be portalled at a time.
  const [openMenu, setOpenMenu] = useState<
    'folded' | RegionToggle['region'] | null
  >(null);
  const closeMenu = useCallback(() => setOpenMenu(null), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the layout owners are this effect's trigger, not values it reads — it exists to fire when they change.
  useEffect(() => {
    // Close whenever the branch that OWNS the menu changes, not only when the
    // overflow branch takes over. Three transitions reach this, and rendering
    // through any of them is wrong in a different way:
    //   fine -> coarse while still wide: the toggles are replaced by the
    //     folded control, so an open offer menu would float over a trigger
    //     that no longer exists.
    //   -> overflow: the early return below unmounts the portal without
    //     clearing this, so widening back re-opens a menu nobody reopened.
    //   overflow -> back: same state, restored under a different owner.
    setOpenMenu(null);
  }, [bottomOnly, commandsInOverflowMenu]);
  const [menuAnchorRight, setMenuAnchorRight] = useState(8);
  // The offer menu is a menu of what can be placed in an EMPTY region. The
  // region can stop being empty while it is open — the ⌘⇧A chord fires with
  // the menu holding focus (`DOCK_WHEN` excludes only the composer), and a
  // cross-tab arrangement sync arrives whenever it likes — and then its
  // trigger is a toggle again while a zero-row panel sits over a viewport
  // backdrop. Derived from the same toggles the trigger reads, so the panel
  // cannot outlive the state that justified it.
  const offering = regionToggles.find((toggle) => toggle.region === openMenu);
  const offeringIsStale =
    offering !== undefined && offering.offers.length === 0;
  useEffect(() => {
    if (offeringIsStale) setOpenMenu(null);
  }, [offeringIsStale]);

  const anchorTo = useCallback((trigger: HTMLButtonElement) => {
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
          aria-expanded={openMenu === 'folded'}
          onClick={(event) => {
            anchorTo(event.currentTarget);
            setOpenMenu('folded');
          }}
        >
          <RegionGlyph region="bottom" pressed={false} />
        </button>
        {openMenu === 'folded' ? (
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

  // #2143: one toggle per dock region, in screen order. #1536 F folded five
  // unlabeled per-region rectangles into one "Layout" control and #1552 D2
  // made that control a per-SURFACE placement picker; this is the third
  // shape, and it is per REGION again — but each button now answers exactly
  // one question ("is this region open?") with a pressed state the model
  // derives, which is what the five glyphs and the picker both lacked. What a
  // region holds lives in its own tab strip (#2046); how a pane moves is the
  // tab's own menu (`RegionChromeBar`).
  return (
    <fieldset className="app-toolbar__regions">
      <legend>Regions</legend>
      {shortcuts}
      {regionToggles.map((toggle) => (
        <RegionToggleButton
          key={toggle.region}
          toggle={toggle}
          menuOpen={openMenu === toggle.region}
          onOpenMenu={(trigger) => {
            anchorTo(trigger);
            setOpenMenu(toggle.region);
          }}
        />
      ))}
      {offering && !offeringIsStale ? (
        <ToolbarMenuSurface
          ariaLabel={`Show in ${offering.label} region`}
          dismissLabel="Close region menu"
          anchorRight={menuAnchorRight}
          role="menu"
          onClose={closeMenu}
        >
          <RegionOfferMenu offers={offering.offers} onClose={closeMenu} />
        </ToolbarMenuSurface>
      ) : null}
    </fieldset>
  );
}

export function RegionToolbarControls() {
  return useRegionModelOptional() ? <ConnectedRegionToolbarControls /> : null;
}
