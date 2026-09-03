import type { ReactNode } from 'react';
import { useRegionModelOptional } from '../../contexts/RegionModelContext';
import type { DockSlotGeometry } from '../../hooks/dock-slot-geometry';
import {
  type DockShellChrome,
  useDockShellChrome,
} from '../../hooks/useDockShellChrome';
import type { DockMode } from '../../types';
import { ChatDockResizeHandle } from './ChatDockResizeHandle';

/**
 * The dock chrome shell, mounted once per occupied region by the ambient host
 * (`RegionShells`, #928) and shared by every occupant it docks (Chat, Home,
 * Activity — station#4460). It owns:
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
 * What it does NOT own: the header's occupant-specific content (identity,
 * project context, session controls) and the body. Those are composed by
 * whichever occupant is docked, using the SAME `ChatDockHeader` component and
 * the `DockShellChrome` this passes down through `children` — hoisted, not
 * duplicated: one header implementation, called once per occupant with
 * different content, not copy-pasted per occupant.
 */
export function DockShell({
  onRenderedRegionGeometryChange,
  regionId,
  children,
}: {
  onRenderedRegionGeometryChange?: (
    regionId: DockMode | null,
    geometry: DockSlotGeometry | null,
  ) => void;
  regionId?: DockMode;
  children: (chrome: DockShellChrome) => ReactNode;
}) {
  const regionModel = useRegionModelOptional();
  const occupant =
    regionId && regionModel ? regionModel.regions[regionId].occupant : 'chat';
  const chrome = useDockShellChrome({
    publishesDockSlotClearance: true,
    // `DockShell` owns the region maximize command, and only the shell
    // holding chat registers it: the registry is last-register-wins, so a
    // second shell's retraction would leave ⌘M dead (#1202's shape).
    registersDockShortcuts: occupant === 'chat',
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
      id={occupant === 'chat' ? 'chat-dock' : undefined}
      data-region={renderedRegion}
      // A landmark region (station#4460 review L2): the per-occupant
      // `aria-label`s `.dock-slot` used to carry ("Home dock"/"Activity
      // dock") don't apply once the shell — not the occupant — owns the box.
      // "Dock" names the shell itself, not whichever occupant is docked;
      // `DockOccupantPicker`'s "Docked pane: X" trigger names the occupant.
      // `<section>` with an accessible name carries an implicit `region`
      // role — no explicit `role` needed (biome a11y/useSemanticElements).
      aria-label="Dock"
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
            aria-label="Resize chat dock"
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
