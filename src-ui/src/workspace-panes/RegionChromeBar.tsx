import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { DockPlacementControl } from '../components/chat-dock/DockPlacementControl';
import { CloseGlyph } from '../components/icons/Glyph';
import { withShortcutHint } from '../contexts/KeyboardShortcutsContext';
import type { DockShellChrome } from '../hooks/useDockShellChrome';
import { useShortcutDisplay } from '../hooks/useKeyboardShortcut';
import { useMenuFocus } from '../hooks/useMenuFocus';
import {
  type DockRegionId,
  type RegionId,
  regionLabel,
  surfaceMayOccupy,
} from '../regions/region-model';
import type { DockMode } from '../types';
import { nextTabIndex } from '../utils/tab-navigation';
import {
  workspacePaneHostPanelIdentity,
  workspacePaneHostTabIdentity,
} from './workspacePaneHostIdentity';

/** One tab of a region's strip: a surface the region holds, as a pane. */
export interface RegionChromeTab {
  surfaceId: string;
  /** The pane's instance id — what the `dock` host's panel is identified by. */
  instanceId: string;
  /** The surface's registered title. */
  title: string;
}

/**
 * What a click on the bar's non-interactive surface must NOT reach through:
 * a real control, or the actions cluster, whose non-control text (a session
 * count, an unread badge) sits beside controls and reads as part of them.
 */
/** The gap between a tab and the move menu it opens, above or below. */
const GAP = 4;

const TOGGLE_EXEMPT =
  'a, button, [role="button"], [role="link"], [role="tab"], input, select, textarea, [data-dock-toggle-shield]';

function RegionAddGlyph() {
  return (
    <svg
      aria-hidden="true"
      className="chat-dock__extent-svg"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function RegionExtentGlyph({ expanded }: { expanded: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className="chat-dock__extent-svg"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      {expanded ? (
        <path d="M9 3v6H3m12-6v6h6M9 21v-6H3m12 6v-6h6" />
      ) : (
        <path d="M3 9h6V3m12 6h-6V3M3 15h6v6m12-6h-6v6" />
      )}
    </svg>
  );
}

/** A pane leaving its box: the bar's Move button (#2160), one stroke family. */
function RegionMoveGlyph() {
  return (
    <svg
      aria-hidden="true"
      className="chat-dock__extent-svg"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M14 4h6v6M20 4l-8 8M16 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h5" />
    </svg>
  );
}

/**
 * A pane's placement (#2143): a `menu` of the regions this pane may move to,
 * opened from the tab's context menu (right-click, or Shift+F10 / the Menu
 * key on a focused tab) and — for the SELECTED pane — from the bar's Move
 * button (#2160), which is the only route a LONE pane has, since a region
 * holding one pane renders no strip and so has no tab to press. One pane
 * moves — `placeSurface` into the chosen
 * region, which joins that region's panes and leaves this one (#2046 2a) —
 * where the bar's ⋮⋮ grab moves the whole region. `main` is offered to a
 * pane that declares it (Activity), and takes the primary area the way
 * `placeSurface` documents (the displaced surface is unplaced).
 *
 * This is where #1552 D2's placement picker went: a surface's placement is a
 * property of its tab, not of the app toolbar, so it is chosen on the tab.
 * The row set is the model's own `surfaceMayOccupy` over the regions this
 * device can use, so no row offers a move `placeSurface` would refuse.
 */
function RegionTabMoveMenu({
  tab,
  regions,
  anchor,
  onMove,
  onClose,
}: {
  tab: RegionChromeTab;
  regions: readonly RegionId[];
  /** `x`/`y`: where the menu opens (the trigger's left, bottom + gap); `top`: its top, for the flip. */
  anchor: { x: number; y: number; top: number };
  onMove: (region: RegionId) => void;
  onClose: () => void;
}) {
  const menuRef = useMenuFocus<HTMLDivElement>(true, onClose);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);
  // Anchored under its trigger (a tab, or the bar's Move button), then kept
  // inside the viewport. Sideways it is pulled back to the edge; vertically it
  // FLIPS ABOVE the trigger when there is no room below, never slides up over
  // it — a panel that is pulled up over its own trigger is the #2112 shape
  // the backdrop family forbids (a press on the trigger must reach the
  // backdrop). Measured after mount, the way the grab's own menu measures
  // before it picks a direction. `anchor.y` is the trigger's bottom edge;
  // `anchor.top` its top edge, for the flip.
  const [position, setPosition] = useState({ x: anchor.x, y: anchor.y });
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const box = menu.getBoundingClientRect();
    const left = Math.max(0, Math.min(anchor.x, window.innerWidth - box.width));
    const below = anchor.y;
    const top =
      below + box.height <= window.innerHeight
        ? below
        : Math.max(0, anchor.top - GAP - box.height);
    setPosition((current) =>
      current.x === left && current.y === top ? current : { x: left, y: top },
    );
  }, [anchor, menuRef]);
  // ONE dismissal for the events that mean "the gesture ended on the
  // backdrop" (#1386): a touch that becomes a scroll ends in `pointercancel`
  // and never clicks, so `click` alone left the menu open. `pointerdown` is
  // swallowed so the menu keeps focus — the same contract as the toolbar's
  // `ToolbarMenuSurface`, with one difference: from a tab this menu opens on
  // `contextmenu`, which Chromium fires on the PRESS of a right-click, so
  // that gesture's release lands on a backdrop that did not exist when it
  // began. A release dismisses only after this backdrop saw the press. (The
  // bar's Move button opens on `click`, whose release is already spent.)
  const pressed = useRef(false);
  const dismiss = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    onClose();
  };
  const dismissIfPressed = (event: { stopPropagation: () => void }) => {
    if (!pressed.current) return;
    dismiss(event);
  };
  return createPortal(
    <>
      <button
        type="button"
        tabIndex={-1}
        className="header-menu__dismiss-backdrop chat-dock__more-backdrop"
        aria-label={`Close move menu for ${tab.title}`}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          pressed.current = true;
        }}
        onPointerUp={dismissIfPressed}
        onPointerCancel={dismissIfPressed}
        onClick={dismiss}
      />
      <div
        ref={menuRef}
        className="menu-surface dock-placement-menu region-tabs__move-menu"
        role="menu"
        aria-label={`Move ${tab.title}`}
        tabIndex={-1}
        style={{ position: 'fixed', left: position.x, top: position.y }}
      >
        {regions.map((region) => (
          <button
            key={region}
            type="button"
            role="menuitem"
            className="menu-row"
            onClick={(event) => {
              event.stopPropagation();
              onClose();
              onMove(region);
            }}
          >
            <span className="menu-row__glyph" aria-hidden="true" />
            Move to {regionLabel(region)}
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
}

/**
 * The one open move menu, and which trigger opened it (#2160). The state lives
 * in `RegionChromeBar` rather than in the strip so the strip's tabs and the
 * bar's Move button share ONE menu instance. The button reports
 * `aria-expanded` only when `from` is the bar AND the menu's pane is the pane
 * the button names — the selection can move while the menu is open, and the
 * button then names a different pane. Because the instance is shared, a
 * second trigger UPDATES the open menu's props rather than remounting it
 * (no `key`): the roving focus and the return-focus target stay with the
 * first open. That transition is not reachable by pointer (the backdrop
 * takes the press) and is pinned as state ownership, not as a gesture.
 */
interface RegionMoveState {
  tab: RegionChromeTab;
  anchor: { x: number; y: number; top: number };
  from: 'tab' | 'bar';
}

/** The anchor a trigger's box gives the menu: under it, its top kept for the flip. */
function moveAnchorFrom(rect: DOMRect): RegionMoveState['anchor'] {
  return { x: rect.left, y: rect.bottom + GAP, top: rect.top };
}

/**
 * The region's tab strip (#2046 2b): one tab per pane the region holds, in
 * `RegionState.panes` order, the selected one pressed. Driven by the REGION
 * MODEL, not the pane host's controller — a tab click is the model's
 * `selectPane` (the host then follows the arrangement, the way it already
 * followed a chord), close is `removePane`, and a reorder writes `panes`
 * — so the arrangement stays the one authority for what a region holds and
 * which pane shows, and the host's persisted document carries nothing the
 * arrangement does not.
 *
 * Keyboard: the arrow keys, Home and End move the selection (the same
 * contract as every other tablist in the app, `nextTabIndex`); Alt+Left /
 * Alt+Right move the focused tab one place. Pointer: a press selects, and a
 * drag over another tab reorders as it passes — the same pointer-capture
 * shape as the placement grab's drag (`DockPlacementControl`).
 *
 * Close renders only with two or more tabs: the last pane of a region is the
 * region, and the region has its own visibility control beside this strip.
 * No "+" here: the region's "+" (#2047) sits in the bar's actions cluster,
 * beside maximize, because a ONE-pane region — which renders no strip —
 * must be able to add a pane too.
 */
function RegionTabStrip({
  groupId,
  tabs,
  selectedSurfaceId,
  onSelect,
  onClose,
  onReorder,
  canMove,
  onOpenMove,
}: {
  groupId: string;
  tabs: readonly RegionChromeTab[];
  selectedSurfaceId: string | undefined;
  onSelect: (surfaceId: string) => void;
  onClose: ((surfaceId: string) => void) | undefined;
  onReorder: (surfaceId: string, toIndex: number) => void;
  /** Whether this pane has anywhere to go — false leaves the browser's own menu alone. */
  canMove: (surfaceId: string) => boolean;
  /** Opens the bar's one move menu for this tab; the menu itself is the bar's. */
  onOpenMove: (tab: RegionChromeTab, anchor: RegionMoveState['anchor']) => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const tabAt = (x: number, y: number): number => {
    const element = document.elementFromPoint(x, y);
    const target =
      element?.closest<HTMLElement>('[data-region-tab]')?.dataset.regionTab;
    return target === undefined
      ? -1
      : tabs.findIndex((tab) => tab.surfaceId === target);
  };
  const onKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
    surfaceId: string,
  ) => {
    if (
      event.altKey &&
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
    ) {
      const toIndex = index + (event.key === 'ArrowRight' ? 1 : -1);
      if (toIndex < 0 || toIndex >= tabs.length) return;
      event.preventDefault();
      onReorder(surfaceId, toIndex);
      return;
    }
    const next = nextTabIndex(index, tabs.length, event.key);
    if (next === null) return;
    event.preventDefault();
    const target = tabs[next];
    if (!target) return;
    onSelect(target.surfaceId);
    event.currentTarget
      .closest('[role="tablist"]')
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      [next]?.focus();
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragging === null) return;
    const from = tabs.findIndex((tab) => tab.surfaceId === dragging);
    const to = tabAt(event.clientX, event.clientY);
    if (from === -1 || to === -1 || to === from) return;
    onReorder(dragging, to);
  };
  const endDrag = () => setDragging(null);
  return (
    <div
      role="tablist"
      aria-label="Region panes"
      className="region-tabs"
      data-dock-toggle-shield=""
    >
      {tabs.map((tab, index) => {
        const isSelected = tab.surfaceId === selectedSurfaceId;
        return (
          <div className="region-tabs__item" key={tab.surfaceId}>
            <button
              type="button"
              role="tab"
              id={workspacePaneHostTabIdentity(groupId, tab.instanceId)}
              aria-selected={isSelected}
              // Only the selected pane is mounted (the dock host renders
              // one tabpanel), so only its tab names a panel that exists.
              aria-controls={
                isSelected
                  ? workspacePaneHostPanelIdentity(groupId, tab.instanceId)
                  : undefined
              }
              tabIndex={isSelected ? 0 : -1}
              data-region-tab={tab.surfaceId}
              className="region-tabs__tab"
              onClick={() => onSelect(tab.surfaceId)}
              onKeyDown={(event) => onKeyDown(event, index, tab.surfaceId)}
              // The tab's own menu (#2143), opened by `contextmenu` — a
              // right-click, or the keyboard's context-menu gesture. Anchored
              // BELOW THE TAB, never at the pointer: a panel at the pointer
              // sits over the tab that opened it, which is the #2112 shape
              // the backdrop family forbids (a press on the trigger must reach
              // the backdrop), and the keyboard has no pointer anyway.
              onContextMenu={(event) => {
                if (!canMove(tab.surfaceId)) return;
                event.preventDefault();
                onOpenMove(
                  tab,
                  moveAnchorFrom(event.currentTarget.getBoundingClientRect()),
                );
              }}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.currentTarget.setPointerCapture?.(event.pointerId);
                setDragging(tab.surfaceId);
              }}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onLostPointerCapture={endDrag}
            >
              {tab.title}
            </button>
            {onClose ? (
              <button
                type="button"
                className="region-tabs__close"
                aria-label={`Close ${tab.title}`}
                onClick={(event) => {
                  // The button under focus is about to unmount; keep focus
                  // in the bar. With two tabs the strip itself goes, so the
                  // bar's first control is the stable target; with more,
                  // the tab the model selects next (the neighbour).
                  const bar =
                    event.currentTarget.closest<HTMLElement>('.region-chrome');
                  onClose(tab.surfaceId);
                  queueMicrotask(() => {
                    if (document.activeElement !== document.body) return;
                    const target =
                      bar?.querySelector<HTMLElement>(
                        '[role="tab"][aria-selected="true"]',
                      ) ?? bar?.querySelector<HTMLElement>('button');
                    target?.focus();
                  });
                }}
              >
                <CloseGlyph />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A dock region's chrome bar (#2046 2b): the one `.chat-dock__header` of a
 * region's shell, rendered by `RegionPaneHost` above the region's panes.
 * It carries what belongs to the REGION — the placement grab (moves every
 * pane, `commitDockPlacement`), the tab strip, the maximize control and the
 * visibility chevron, all read from and written through the shell's
 * `DockShellChrome` — and two slots the SELECTED pane's own toolbar renders
 * into (`RegionChromeSlots`; Chat's identity, context and More menu), so a
 * dock still has one bar. The bar's own surface collapses and expands the
 * region on click, as `ChatDockHeader`'s did before it (#1064: a convenience
 * mouse surface; the chevron is the keyboard path).
 *
 * Collapsed (D1): the bar alone, at the `--chat-dock-header-height` the
 * collapsed shell is sized to; the strip hides with the body, and the
 * selected pane's toolbar keeps its collapsed-state affordances ("Start a
 * chat", #800). A coarse device (D2/6): no strip — the region's panes are
 * rows of the toolbar's `⋯` menu and of Chat's own overflow sheet — and,
 * while the selected pane is Chat, no bar at all: `ChatDockMobileHeader` is
 * Chat's bar there, with the drag surface and the dock toggle of its own.
 *
 * The "+" (#2047 D4): `onAddPane` opens the region's catalog. Fine pointer
 * only (D2: the app gains no dock control on phones), and absent when the
 * host has nothing to add with (no region model, no active project — D6:
 * a catalog whose every Open would land a pane that cannot render is not
 * offered). It renders for a one-pane region too, the case the acceptance
 * starts from.
 *
 * The Move button (#2160): opens the selected pane's move menu — the same
 * `RegionTabMoveMenu` a tab's context menu opens — so a lone pane, which
 * renders no strip, can reach any region it declares, Main included. Fine
 * pointer only and absent without `onMoveTab` or with nowhere to go. Like
 * the "+", it renders on a COLLAPSED bar too: a collapsed region is still
 * the region, and moving its pane is a bar action, not a body one.
 */
export function RegionChromeBar({
  chrome,
  groupId,
  tabs,
  selectedSurfaceId,
  onSelectTab,
  onCloseTab,
  onReorderTab,
  onMoveTab,
  onAddPane,
  leadingSlotRef,
  trailingSlotRef,
}: {
  chrome: DockShellChrome;
  groupId: string;
  tabs: readonly RegionChromeTab[];
  selectedSurfaceId: string | undefined;
  onSelectTab: (surfaceId: string) => void;
  /** Absent when a tab cannot be closed (one pane; no region model). */
  onCloseTab: ((surfaceId: string) => void) | undefined;
  onReorderTab: (surfaceId: string, toIndex: number) => void;
  /** A tab's move to another region (#2143); absent for the model-less mount. */
  onMoveTab?: (surfaceId: string, region: RegionId) => void;
  /** Opens the region's catalog; absent when there is nothing to add with. */
  onAddPane?: () => void;
  leadingSlotRef: (element: HTMLElement | null) => void;
  trailingSlotRef: (element: HTMLElement | null) => void;
}) {
  const barRef = useRef<HTMLDivElement | null>(null);
  // ONE open move menu for the whole bar, whichever trigger opened it (#2160).
  const [moving, setMoving] = useState<RegionMoveState | null>(null);
  // The menu acts on ONE pane, and that pane can leave the region while the
  // menu is open — its tab closed by ⌘D or a chord, a route or an agent
  // unplacing it; the backdrop absorbs pointer presses but only Escape is
  // intercepted on the keyboard. Before #2160 the menu lived in the strip and
  // unmounted with it; at bar level it would outlive the pane and re-place
  // one that is no longer here. Derived from the same `tabs` the strip
  // renders, so the menu cannot outlive the state that justified it.
  const movingIsStale =
    moving !== null &&
    !tabs.some((tab) => tab.surfaceId === moving.tab.surfaceId);
  useEffect(() => {
    if (movingIsStale) setMoving(null);
  }, [movingIsStale]);
  const isDockOpen = chrome.isDockOpen;
  const isDockMaximized = chrome.isDockMaximized;
  const toggleShortcut = useShortcutDisplay(chrome.surfaceShortcutId);
  const registeredMaximizeShortcut = useShortcutDisplay('dock.maximize');
  const maximizeShortcut = chrome.ownsMaximizeShortcut
    ? registeredMaximizeShortcut
    : '';
  const visibilityLabel = `${isDockOpen ? 'Hide' : 'Show'} ${chrome.surfaceTitle}`;
  const side =
    chrome.effectiveDockSlotPlacement === 'bottom'
      ? null
      : chrome.effectiveDockSlotPlacement;
  const applyDockSnap = chrome.applyDockSnap;
  const mobileChat = chrome.isMobile && selectedSurfaceId === 'chat';
  const addLabel = `Add pane to ${regionLabel(chrome.effectiveDockSlotPlacement)}`;
  // The regions a tab may be moved to (#2143): every region this device can
  // use plus `main`, minus the one this shell RENDERS in on this device
  // (`effectiveDockSlotPlacement`: the region's own id where the device
  // offers it, else the device's fallback edge — on a coarse-wide device a
  // `left` shell renders at `bottom` and that is the edge excluded), filtered
  // by the model's own `surfaceMayOccupy` so no row offers a refused
  // placement. ONE derivation feeds both triggers — the strip's tabs and the
  // bar's Move button (#2160) — so a lone pane, whose region renders no strip
  // (`showStrip`), still reaches every region it declares, `main` included,
  // rather than only the dock edges the ⋮⋮ grab offers.
  const here: DockRegionId = chrome.effectiveDockSlotPlacement;
  const moveTargets = (surfaceId: string): RegionId[] =>
    [...(chrome.availableDockSlotPlacements as readonly DockMode[]), 'main']
      .filter((region): region is RegionId => region !== here)
      .filter((region) => surfaceMayOccupy(surfaceId, region));
  const canMove = (surfaceId: string): boolean =>
    Boolean(onMoveTab) && moveTargets(surfaceId).length > 0;
  const selectedTab = tabs.find((tab) => tab.surfaceId === selectedSurfaceId);
  // The bar's Move button acts on the pane the region SHOWS, so it is offered
  // only where that pane has somewhere to go, and — like the "+" — only on a
  // fine pointer (D2: the app gains no dock control on phones).
  const barMoveTab =
    selectedTab && !chrome.isMobile && canMove(selectedTab.surfaceId)
      ? selectedTab
      : undefined;
  const barMoveLabel = barMoveTab ? `Move ${barMoveTab.title}` : '';

  // A NATIVE listener rather than `onClick`: the pane toolbar is portalled
  // into this bar, and a React handler on the bar never sees a click that
  // starts inside a portal (React bubbles along its own tree). The DOM
  // bubbles along the bar's, which is the surface the user sees. Interactive
  // descendants and the actions cluster are exempt, the same rule the
  // `ChatDockHeader` handler applied (#1064).
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || mobileChat) return;
    const onClick = (event: MouseEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest(TOGGLE_EXEMPT)
      )
        return;
      applyDockSnap(isDockOpen ? 'collapsed' : 'half');
    };
    bar.addEventListener('click', onClick);
    return () => bar.removeEventListener('click', onClick);
  }, [applyDockSnap, isDockOpen, mobileChat]);

  if (mobileChat) return null;

  const showStrip =
    tabs.length > 1 &&
    !chrome.isMobile &&
    (isDockOpen || chrome.isCollapsedDragPreview);

  return (
    <div
      ref={barRef}
      className={`chat-dock__header region-chrome ${isDockMaximized ? 'is-maximized' : ''} ${chrome.isDragging ? 'is-dragging' : ''}`}
    >
      <div className="chat-dock__title">
        <DockPlacementControl
          availablePlacements={chrome.availableDockSlotPlacements}
          effectivePlacement={chrome.effectiveDockSlotPlacement}
          onPlacementChange={chrome.commitDockPlacement}
        />
        {showStrip ? (
          <RegionTabStrip
            groupId={groupId}
            tabs={tabs}
            selectedSurfaceId={selectedSurfaceId}
            onSelect={onSelectTab}
            onClose={onCloseTab}
            onReorder={onReorderTab}
            canMove={canMove}
            onOpenMove={(tab, anchor) =>
              setMoving({ tab, anchor, from: 'tab' })
            }
          />
        ) : null}
        <span className="chat-dock__pane-toolbar" ref={leadingSlotRef} />
        <span className="chat-dock__title-spacer" />
      </div>
      <div className="chat-dock__header-actions" data-dock-toggle-shield="">
        <span className="chat-dock__pane-toolbar" ref={trailingSlotRef} />
        {barMoveTab ? (
          <button
            type="button"
            className="chat-dock__icon-btn"
            aria-haspopup="menu"
            aria-expanded={
              moving?.from === 'bar' &&
              moving.tab.surfaceId === barMoveTab.surfaceId
            }
            onClick={(event) =>
              setMoving({
                tab: barMoveTab,
                anchor: moveAnchorFrom(
                  event.currentTarget.getBoundingClientRect(),
                ),
                from: 'bar',
              })
            }
            title={barMoveLabel}
            aria-label={barMoveLabel}
          >
            <RegionMoveGlyph />
          </button>
        ) : null}
        {onAddPane && !chrome.isMobile ? (
          <button
            type="button"
            className="chat-dock__icon-btn"
            onClick={onAddPane}
            title={addLabel}
            aria-label={addLabel}
          >
            <RegionAddGlyph />
          </button>
        ) : null}
        {chrome.canMaximize ? (
          <button
            type="button"
            className="chat-dock__maximize-btn"
            onClick={() => applyDockSnap(isDockMaximized ? 'half' : 'full')}
            title={withShortcutHint(
              isDockMaximized
                ? 'Restore dock region size'
                : 'Expand dock region to workspace',
              'dock.maximize',
              () => maximizeShortcut,
            )}
            aria-label={
              isDockMaximized
                ? 'Restore dock region size'
                : 'Expand dock region to workspace'
            }
          >
            <RegionExtentGlyph expanded={isDockMaximized} />
          </button>
        ) : null}
        <button
          type="button"
          className="chat-dock__icon-btn"
          // Reopens to the shell's own snap (`chrome.dockSnap`): Chat's
          // region seeds it from the persisted `station.chatDock.snap`
          // (archive#795, a Full-height collapse reopens Full) and every
          // other region keeps its own in memory, so "Show Activity" can
          // never maximize Activity because Chat's key says `full` (#1385).
          onClick={() =>
            applyDockSnap(
              isDockOpen
                ? 'collapsed'
                : chrome.canMaximize && chrome.dockSnap === 'full'
                  ? 'full'
                  : 'half',
            )
          }
          title={withShortcutHint(
            visibilityLabel,
            chrome.surfaceShortcutId,
            () => toggleShortcut,
          )}
          aria-label={visibilityLabel}
        >
          <svg
            aria-hidden="true"
            className={`chat-dock__chevron-svg ${side ? `is-${side}-${isDockOpen ? 'open' : 'closed'}` : isDockOpen ? 'is-open' : 'is-closed'}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </button>
      </div>
      {moving && !movingIsStale && onMoveTab ? (
        <RegionTabMoveMenu
          tab={moving.tab}
          regions={moveTargets(moving.tab.surfaceId)}
          anchor={moving.anchor}
          onMove={(region) => onMoveTab(moving.tab.surfaceId, region)}
          onClose={() => setMoving(null)}
        />
      ) : null}
    </div>
  );
}
