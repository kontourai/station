import type { ReactNode } from 'react';
import type { DockSlotGeometry } from '../../hooks/dock-slot-geometry';
import {
  type DockShellChrome,
  useDockShellChrome,
} from '../../hooks/useDockShellChrome';
import { ChatDockResizeHandle } from './ChatDockResizeHandle';

/**
 * The one dock chrome shell, mounted ONCE by the ambient host and shared by
 * every occupant it docks (Chat, Home, Activity — station#4460). It owns:
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
  onGeometryChange,
  children,
}: {
  onGeometryChange?: (geometry: DockSlotGeometry | null) => void;
  children: (chrome: DockShellChrome) => ReactNode;
}) {
  const chrome = useDockShellChrome({
    publishesDockSlotClearance: true,
    // `DockShell` is the ambient owner of the region maximize command.
    registersDockShortcuts: true,
    onGeometryChange,
  });

  const isPaneOpen = chrome.isDockOpen;
  const isPaneMaximized = chrome.isDockMaximized;
  const isSidePanel = chrome.effectiveDockSlotPlacement !== 'bottom';

  return (
    <section
      id="chat-dock"
      // A landmark region (station#4460 review L2): the per-occupant
      // `aria-label`s `.dock-slot` used to carry ("Home dock"/"Activity
      // dock") don't apply once the shell — not the occupant — owns the box.
      // "Dock" names the shell itself, not whichever occupant is docked;
      // `DockOccupantPicker`'s "Docked pane: X" trigger names the occupant.
      // `<section>` with an accessible name carries an implicit `region`
      // role — no explicit `role` needed (biome a11y/useSemanticElements).
      aria-label="Dock"
      className={`chat-dock ${!isPaneOpen && !chrome.isCollapsedDragPreview ? 'is-collapsed' : ''} ${isPaneMaximized ? 'is-maximized' : ''} ${chrome.isDragging ? 'is-dragging' : ''} chat-dock--${isSidePanel ? chrome.effectiveDockSlotPlacement : 'bottom'}`}
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
            className={`chat-dock__resize-handle chat-dock__resize-handle--horizontal${chrome.effectiveDockSlotPlacement === 'left' ? ' chat-dock__resize-handle--left' : ''}`}
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
