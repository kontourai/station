import type { DockMode } from '../../types';

/** Pure placement decision so desktop/mobile hosts cannot drift. */
export type SessionInventoryCompactHost = 'aside' | 'card' | 'full-fallback';

export function resolveSessionInventoryCompactHost({
  isMobile,
  dockMode,
  fullscreen,
}: {
  isMobile: boolean;
  dockMode: DockMode;
  fullscreen: boolean;
}): SessionInventoryCompactHost {
  if (isMobile) return 'full-fallback';
  if (fullscreen || dockMode === 'bottom') return 'aside';
  return 'card';
}
