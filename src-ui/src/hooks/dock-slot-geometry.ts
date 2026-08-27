import type { DockMode } from '../types';

/** The ambient slot's complete geometry, as declared by its occupant. */
export interface DockSlotGeometry {
  /** Bottom-row height, or zero when the dock is a desktop side panel. */
  size: number;
  /** Desktop side-panel width, absent when the dock is below the route. */
  width: number | null;
}

/**
 * The collapsed bar's height is a CSS-owned responsive fact. Both an ambient
 * Chat occupant and the host fallback for a non-Chat occupant must read this
 * one value rather than carrying a second `38px` mobile approximation.
 */
export function readCollapsedDockSlotSize(root = document.documentElement) {
  return (
    Number.parseFloat(
      getComputedStyle(root).getPropertyValue('--chat-dock-header-height'),
    ) || 38
  );
}

export function deriveDockSlotGeometry({
  placement,
  isOpen,
  height,
  width,
  liveDragHeight = null,
}: {
  placement: DockMode;
  isOpen: boolean;
  height: number;
  width: number;
  liveDragHeight?: number | null;
}): DockSlotGeometry {
  if (placement !== 'bottom') return { size: 0, width };
  return {
    size: liveDragHeight ?? (isOpen ? height : readCollapsedDockSlotSize()),
    width: null,
  };
}
