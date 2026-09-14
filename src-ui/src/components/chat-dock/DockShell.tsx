import type { ReactNode } from 'react';
import { useRegionModelOptional } from '../../contexts/RegionModelContext';
import type { DockSlotGeometry } from '../../hooks/dock-slot-geometry';
import {
  type DockShellChrome,
  useDockShellChrome,
} from '../../hooks/useDockShellChrome';
import { regionHoldsChat } from '../../regions/region-model';
import type { DockMode } from '../../types';
import { ChatDockResizeHandle } from './ChatDockResizeHandle';

/**
 * The dock chrome shell, mounted once per occupied region by the region host
 * (`RegionShells` → `RegionPaneHost`, #928, #2045) and shared by every
 * occupant it docks: Chat and Activity, each a pane of the region's document
 * since #2045 (the legacy ambient occupants, Chat and Home, were the
 * station#4460 shape). It owns:
 *
 * - the root `.chat-dock` element and its placement/state classes, so the
 *   large existing CSS surface (`:is(.chat-dock, .dock-slot)` and friends)
 *   keeps applying no matter which occupant is docked;
 * - the resize handle (bottom drag/snap, or the side-panel width grip);
 * - geometry, snap and drag state via `useDockShellChrome` — the single
 *   authority an occupant switch cannot desync, because this component (not
 *   the occupant) is what stays mounted across a switch;
 * - `dock.maximize` (region visibility lives in the app toolbar).
 *
 * What it does NOT own: the region bar (placement grab, tab strip, maximize,
 * visibility — `RegionChromeBar`, rendered by `RegionPaneHost` from the
 * `DockShellChrome` this passes down through `children`, #2046 2b), a pane's
 * own toolbar content (Chat's identity, project context and More menu, which
 * `ChatDockHeader` renders into the bar's slots) and the body.
 */
export function DockShell({
  onRenderedRegionGeometryChange,
  regionId,
  children,
}: {
  onRenderedRegionGeometryChange?: (
    regionId: DockMode,
    geometry: DockSlotGeometry | null,
  ) => void;
  regionId?: DockMode;
  children: (chrome: DockShellChrome) => ReactNode;
}) {
  const regionModel = useRegionModelOptional();
  const region = regionId && regionModel ? regionModel.regions[regionId] : null;
  const occupant = region ? region.occupant : 'chat';
  // Chat's shell is the shell whose region HOLDS Chat, selected or behind
  // another pane's tab (#2046 2b, ownership decision D3): `#chat-dock`, the
  // parity-pinned "Dock" landmark and the `dock.maximize` registration all
  // follow the pane set, not the pane the region shows. A region that holds
  // Chat and Activity is one shell, and it is Chat's shell whichever tab is
  // selected — so ⌘M keeps working while Chat is behind Activity's tab.
  const holdsChat =
    regionId && regionModel
      ? regionHoldsChat(regionModel.regions, regionId)
      : true;
  const landmarkLabel = holdsChat
    ? 'Dock'
    : (regionModel?.surfaces.get(occupant ?? '')?.title ?? 'Dock');
  const resizeLabel = holdsChat
    ? 'Resize chat dock'
    : `Resize ${landmarkLabel}`;
  const chrome = useDockShellChrome({
    publishesDockSlotClearance: true,
    // `DockShell` owns the region maximize command, and only the shell whose
    // region holds chat registers it: the registry is last-register-wins, so
    // a second shell's retraction would leave ⌘M dead (#1202's shape).
    registersDockShortcuts: holdsChat,
    regionId,
    onRenderedRegionGeometryChange,
  });

  const isPaneOpen = chrome.isDockOpen;
  const isPaneMaximized = chrome.isDockMaximized;
  // Rendered region, not `regionId`: coarse pointers fold side placements to
  // bottom (useIsMobile.ts `availablePlacements`) and index.css keys the grid
  // tracks on this attribute, so both must come from the one expression. The
  // fold also means every shell on a coarse device renders bottom, so at most
  // one shell may mount there (RegionShells.tsx).
  const renderedRegion = chrome.effectiveDockSlotPlacement;
  const isSidePanel = renderedRegion !== 'bottom';

  return (
    <section
      id={holdsChat ? 'chat-dock' : undefined}
      data-region={renderedRegion}
      // Chat keeps the parity-pinned "Dock" landmark. A second shell needs a
      // distinct accessible name, so a non-Chat region uses its registered
      // surface title (#928). `<section>` with an accessible name carries an
      // implicit `region` role — no explicit role is needed.
      aria-label={landmarkLabel}
      className={`chat-dock ${!isPaneOpen && !chrome.isCollapsedDragPreview ? 'is-collapsed' : ''} ${isPaneMaximized ? 'is-maximized' : ''} ${chrome.isDragging ? 'is-dragging' : ''} chat-dock--${renderedRegion}`}
      style={
        isSidePanel
          ? {
              ...chrome.visualViewport.style,
              width: isPaneMaximized ? '100%' : undefined,
            }
          : {
              ...chrome.visualViewport.style,
              height:
                chrome.liveDragHeight !== null
                  ? `${chrome.liveDragHeight}px`
                  : !isPaneOpen
                    ? 'calc(var(--chat-dock-header-height) + var(--safe-bottom, 0px))'
                    : isPaneMaximized
                      ? `calc(var(--chat-visual-viewport-height) - var(--app-toolbar-total-height) - var(--coding-mobile-panel-nav-height, 0px))`
                      : `${chrome.dockHeight}px`,
            }
      }
    >
      {isSidePanel ? (
        !isPaneMaximized && (
          <button
            type="button"
            tabIndex={-1}
            className={`chat-dock__resize-handle chat-dock__resize-handle--horizontal${renderedRegion === 'left' ? ' chat-dock__resize-handle--left' : ''}`}
            aria-label={resizeLabel}
            onPointerDown={chrome.onSidePanelResizePointerDown}
            // M5 (station#4460 review): this handle sits OUTSIDE any
            // occupant's file-drop boundary (Chat's, when Chat is docked;
            // Home/Activity have none at all). Without this, dropping a
            // file on the strip hits the browser's default "navigate to
            // this file" behavior instead of either being ignored or
            // handled — discarding whatever the app was doing.
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => event.preventDefault()}
          >
            <span className="chat-dock__resize-grip chat-dock__resize-grip--vertical" />
          </button>
        )
      ) : (
        <ChatDockResizeHandle
          ariaLabel={resizeLabel}
          mode={chrome.isMobile ? 'mobile-snap' : 'desktop-free'}
          currentHeight={chrome.dockHeight}
          snap={
            !isPaneOpen
              ? 'collapsed'
              : isPaneMaximized
                ? 'full'
                : chrome.dockSnap
          }
          toolbarHeight={chrome.toolbarHeight}
          collapsedHeight={chrome.collapsedHeight}
          onSnap={chrome.applyDockSnap}
          onCommitHeight={chrome.commitDesktopBottomHeight}
          onLiveHeight={chrome.setLiveDragHeight}
          onDragStateChange={chrome.setIsDragging}
        />
      )}
      {children(chrome)}
    </section>
  );
}
