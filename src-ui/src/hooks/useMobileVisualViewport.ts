import {
  responsiveVisualViewportStyle,
  serverVisualViewportSnapshot,
  subscribeVisualViewport,
  visualViewportSnapshot,
  visualViewportStore,
} from '@kontourai/station-shared/visual-viewport';
import { useMemo, useSyncExternalStore } from 'react';

/** The visual viewport, from the one shared per-window subscription. */
export function useMobileVisualViewport() {
  const metrics = useSyncExternalStore(
    subscribeVisualViewport,
    visualViewportSnapshot,
    serverVisualViewportSnapshot,
  );

  return useMemo(
    () => ({
      ...metrics,
      style: {
        ...responsiveVisualViewportStyle(metrics),
        '--chat-visual-viewport-height': `${metrics.height}px`,
        '--chat-visual-viewport-top': `${metrics.offsetTop}px`,
        '--chat-visual-viewport-bottom': `${metrics.bottomInset}px`,
      } as React.CSSProperties,
    }),
    [metrics],
  );
}

/**
 * The shared, DOCUMENT-scoped name for the same inset.
 *
 * `useMobileVisualViewport`'s `style` publishes the inset onto whichever
 * element consumes the hook, which is exactly right for a surface positioning
 * itself — and invisible to anything outside that subtree. The chat dock
 * publishes it on itself and rides above the keyboard; the agent editor's
 * sticky Save bar is a SIBLING, offsets itself by the dock's height, and had no
 * way to read the inset the dock had just moved by, so with an input focused
 * the dock rose and the bar stayed behind the keyboard.
 *
 * Published once on the document element, from the same shared store, so any
 * fixed surface can consume it without owning a subscription.
 */
export const VISUAL_VIEWPORT_BOTTOM_INSET_VAR =
  '--visual-viewport-bottom-inset';

/**
 * Install the document-scoped publisher. Called once, from `main.tsx`, beside
 * `installAndroidSafeArea` — the same shape as the `--safe-*` projection, and
 * for the same reason: a geometry fact several unrelated surfaces need.
 */
export function installVisualViewportInset(
  target: Window = window,
): () => void {
  const root = target.document?.documentElement;
  if (!root) return () => undefined;
  const store = visualViewportStore(target);
  let published = '';
  const apply = () => {
    const next = `${store.getSnapshot().bottomInset}px`;
    if (next === published) return;
    published = next;
    root.style.setProperty(VISUAL_VIEWPORT_BOTTOM_INSET_VAR, next);
  };
  const unsubscribe = store.subscribe(apply);
  apply();
  return unsubscribe;
}
