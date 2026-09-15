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

/**
 * A tab's own placement (#2143): a `menu` of the regions this pane may move to,
 * opened from the tab's context menu (right-click, or Shift+F10 / the Menu
 * key on a focused tab). One pane moves — `placeSurface` into the chosen
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
  anchor: { x: number; y: number };
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
  // Anchored under the tab, then kept inside the viewport: a tab low in a
  // short bottom dock or near the right edge would otherwise push rows off
  // screen with no scroll to recover them. Measured after mount, the way the
  // grab's own menu measures before it picks a direction.
  const [position, setPosition] = useState(anchor);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const box = menu.getBoundingClientRect();
    const left = Math.max(0, Math.min(anchor.x, window.innerWidth - box.width));
    const top = Math.max(
      0,
      Math.min(anchor.y, window.innerHeight - box.height),
    );
    setPosition((current) =>
      current.x === left && current.y === top ? current : { x: left, y: top },
    );
  }, [anchor, menuRef]);
  // ONE dismissal for the events that mean "the gesture ended on the
  // backdrop" (#1386): a touch that becomes a scroll ends in `pointercancel`
  // and never clicks, so `click` alone left the menu open. `pointerdown` is
  // swallowed so the menu keeps focus — the same contract as the toolbar's
  // `ToolbarMenuSurface`.
  const dismiss = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    onClose();
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
        }}
        onPointerUp={dismiss}
        onPointerCancel={dismiss}
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
  onMove,
  moveTargets,
}: {
  groupId: string;
  tabs: readonly RegionChromeTab[];
  selectedSurfaceId: string | undefined;
  onSelect: (surfaceId: string) => void;
  onClose: ((surfaceId: string) => void) | undefined;
  onReorder: (surfaceId: string, toIndex: number) => void;
  /** Absent for the model-less mount, which has nowhere to move a pane to. */
  onMove: ((surfaceId: string, region: RegionId) => void) | undefined;
  /** The regions a pane may be offered, for `onMove`: this device's, minus the one it is in. */
  moveTargets: (surfaceId: string) => RegionId[];
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [moving, setMoving] = useState<{
    tab: RegionChromeTab;
    anchor: { x: number; y: number };
  } | null>(null);
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
                if (!onMove || moveTargets(tab.surfaceId).length === 0) return;
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                setMoving({
                  tab,
                  anchor: { x: rect.left, y: rect.bottom + 4 },
                });
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
      {moving && onMove ? (
        <RegionTabMoveMenu
          tab={moving.tab}
          regions={moveTargets(moving.tab.surfaceId)}
          anchor={moving.anchor}
          onMove={(region) => onMove(moving.tab.surfaceId, region)}
          onClose={() => setMoving(null)}
        />
      ) : null}
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
  // placement. The strip this feeds renders only for two or more panes and
  // only off the mobile layout (`showStrip`), so a lone pane has no move menu
  // and reaches another region through the bar's ⋮⋮ grab, dock edges only.
  const here: DockRegionId = chrome.effectiveDockSlotPlacement;
  const moveTargets = (surfaceId: string): RegionId[] =>
    [...(chrome.availableDockSlotPlacements as readonly DockMode[]), 'main']
      .filter((region): region is RegionId => region !== here)
      .filter((region) => surfaceMayOccupy(surfaceId, region));

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
            onMove={onMoveTab}
            moveTargets={moveTargets}
          />
        ) : null}
        <span className="chat-dock__pane-toolbar" ref={leadingSlotRef} />
        <span className="chat-dock__title-spacer" />
      </div>
      <div className="chat-dock__header-actions" data-dock-toggle-shield="">
        <span className="chat-dock__pane-toolbar" ref={trailingSlotRef} />
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
    </div>
  );
}
