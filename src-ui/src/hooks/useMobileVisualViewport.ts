import { useEffect, useMemo, useState } from 'react';

export interface MobileVisualViewportMetrics {
  height: number;
  offsetTop: number;
  bottomInset: number;
}

export function readMobileVisualViewport(
  target: Window = window,
): MobileVisualViewportMetrics {
  const viewport = target.visualViewport;
  const height = Math.max(0, viewport?.height ?? target.innerHeight);
  const offsetTop = Math.max(0, viewport?.offsetTop ?? 0);
  return {
    height,
    offsetTop,
    // Fixed bottom sheets are positioned against the layout viewport. The
    // visual viewport may end above Android system chrome or the software
    // keyboard, so expose that gap as an explicit inset instead of leaving
    // the dock's controls underneath it.
    bottomInset: Math.max(0, target.innerHeight - (offsetTop + height)),
  };
}

export function useMobileVisualViewport() {
  const [metrics, setMetrics] = useState<MobileVisualViewportMetrics>(() =>
    typeof window === 'undefined'
      ? { height: 0, offsetTop: 0, bottomInset: 0 }
      : readMobileVisualViewport(),
  );

  useEffect(() => {
    const viewport = window.visualViewport;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = readMobileVisualViewport();
        setMetrics((current) =>
          current.height === next.height &&
          current.offsetTop === next.offsetTop &&
          current.bottomInset === next.bottomInset
            ? current
            : next,
        );
      });
    };
    const source: EventTarget = viewport ?? window;
    source.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      source.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
    };
  }, []);

  return useMemo(
    () => ({
      ...metrics,
      style: {
        '--responsive-visual-viewport-height': `${metrics.height}px`,
        '--responsive-visual-viewport-top': `${metrics.offsetTop}px`,
        '--responsive-visual-viewport-bottom': `${metrics.bottomInset}px`,
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
 * Published once on the document element, from the same `readMobileVisualViewport`
 * reader, so any fixed surface can consume it without owning a subscription.
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
  let frame = 0;
  let published = '';
  const apply = () => {
    const next = `${readMobileVisualViewport(target).bottomInset}px`;
    if (next === published) return;
    published = next;
    root.style.setProperty(VISUAL_VIEWPORT_BOTTOM_INSET_VAR, next);
  };
  const update = () => {
    target.cancelAnimationFrame?.(frame);
    if (target.requestAnimationFrame) {
      frame = target.requestAnimationFrame(apply);
    } else {
      apply();
      frame = 0;
    }
  };
  const viewport = target.visualViewport;
  const source: EventTarget = viewport ?? target;
  source.addEventListener('resize', update);
  viewport?.addEventListener('scroll', update);
  apply();
  return () => {
    target.cancelAnimationFrame?.(frame);
    source.removeEventListener('resize', update);
    viewport?.removeEventListener('scroll', update);
  };
}
