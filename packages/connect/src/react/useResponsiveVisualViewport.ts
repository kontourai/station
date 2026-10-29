import {
  responsiveVisualViewportStyle,
  serverVisualViewportSnapshot,
  subscribeVisualViewport,
  visualViewportSnapshot,
} from '@kontourai/station-shared/visual-viewport';
import { type CSSProperties, useMemo, useSyncExternalStore } from 'react';

/** The visual viewport, from the one shared per-window subscription. */
export function useResponsiveVisualViewport() {
  const viewport = useSyncExternalStore(
    subscribeVisualViewport,
    visualViewportSnapshot,
    serverVisualViewportSnapshot,
  );
  return useMemo(
    () => responsiveVisualViewportStyle(viewport) as CSSProperties,
    [viewport],
  );
}
