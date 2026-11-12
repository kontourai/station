import type { VisualViewportMetrics } from '@kontourai/station-shared/visual-viewport';
import { type RefObject, useCallback, useEffect, useRef } from 'react';

/** How long the visual viewport must be still before the check runs. */
const SETTLE_MS = 150;
/** Keys that scroll the page when focus is not in a text field. */
const SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
]);

/** The nearest ancestor that scrolls vertically, else the document. */
function scrollParent(element: HTMLElement): Element {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      node.scrollHeight > node.clientHeight
    )
      return node;
  }
  return document.scrollingElement ?? document.documentElement;
}

/**
 * Keeps a focused phone composer above the software keyboard (#4810).
 *
 * The composer lifts itself over the keyboard; when the page cannot make room
 * for that, the page scrolls the composer's bottom back to the visible
 * viewport's bottom. One check does that, and it is idempotent: it runs once
 * the visual viewport has been still for a moment, and when focus enters the
 * composer. Once the reader scrolls (wheel, touch, a scroll key outside a
 * text field, or any scroll the check did not make), nothing moves the page
 * again until focus next enters the composer.
 */
export function useKeepAboveKeyboard(
  root: RefObject<HTMLElement | null>,
  enabled: boolean,
  viewport: VisualViewportMetrics,
) {
  const metrics = useRef(viewport);
  metrics.current = viewport;
  const userScrolledSinceFocus = useRef(false);
  /** The scroll the check just made, so its event is not the reader's. */
  const programmatic = useRef<{ target: Element; top: number } | undefined>(
    undefined,
  );
  const timer = useRef(0);
  const generation = useRef(0);

  const ensureComposerVisible = useCallback(() => {
    const element = root.current;
    const { offsetTop, height } = metrics.current;
    if (!element || userScrolledSinceFocus.current || height <= 0) return;
    if (!element.contains(document.activeElement)) return;
    const overhang =
      element.getBoundingClientRect().bottom - (offsetTop + height);
    if (overhang <= 0) return;
    const scroller = scrollParent(element);
    const before = scroller.scrollTop;
    scroller.scrollBy({ top: overhang });
    if (scroller.scrollTop !== before)
      programmatic.current = { target: scroller, top: scroller.scrollTop };
  }, [root]);

  const schedule = useCallback(() => {
    window.clearTimeout(timer.current);
    const scheduled = ++generation.current;
    timer.current = window.setTimeout(() => {
      // The lift over the keyboard animates for longer than the settle delay;
      // measured mid-lift, the composer sits lower than it lands and the page
      // would scroll too far. With reduced motion nothing is running.
      const lifting =
        root.current
          ?.getAnimations?.()
          .filter(
            (animation) =>
              animation instanceof CSSTransition &&
              animation.transitionProperty === 'margin-bottom',
          ) ?? [];
      void Promise.allSettled(
        lifting.map((animation) => animation.finished),
      ).then(() => {
        if (scheduled === generation.current) ensureComposerVisible();
      });
    }, SETTLE_MS);
  }, [root, ensureComposerVisible]);

  useEffect(() => {
    const element = root.current;
    if (!enabled || !element) return;
    // A focus can scroll the field into view; that scroll's event lands in
    // the next frame and is the browser's, not the reader's.
    let revealing = false;
    let reveal = 0;
    const onFocusIn = (event: FocusEvent) => {
      if (element.contains(event.relatedTarget as Node | null)) return;
      userScrolledSinceFocus.current = false;
      revealing = true;
      cancelAnimationFrame(reveal);
      reveal = requestAnimationFrame(() => {
        reveal = requestAnimationFrame(() => {
          revealing = false;
        });
      });
      schedule();
    };
    const readerScrolled = () => {
      userScrolledSinceFocus.current = true;
    };
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as Element | null;
      if (
        SCROLL_KEYS.has(event.key) &&
        !target?.closest?.('textarea, input, select, [contenteditable]')
      )
        readerScrolled();
    };
    // Only a scroll of something holding the composer counts; a list inside
    // the room following its newest message does not.
    const onScroll = (event: Event) => {
      const target =
        event.target === document
          ? document.scrollingElement
          : (event.target as Element | null);
      if (!target?.contains(element) || revealing) return;
      const made = programmatic.current;
      if (
        made?.target === target &&
        Math.abs(target.scrollTop - made.top) <= 1
      ) {
        programmatic.current = undefined;
        return;
      }
      readerScrolled();
    };
    const passive = { capture: true, passive: true };
    element.addEventListener('focusin', onFocusIn);
    window.addEventListener('wheel', readerScrolled, passive);
    window.addEventListener('touchmove', readerScrolled, passive);
    window.addEventListener('keydown', onKey, true);
    // Scroll events do not bubble; capture sees every element's.
    document.addEventListener('scroll', onScroll, passive);
    return () => {
      element.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('wheel', readerScrolled, passive);
      window.removeEventListener('touchmove', readerScrolled, passive);
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onScroll, passive);
      window.clearTimeout(timer.current);
      cancelAnimationFrame(reveal);
      generation.current += 1;
    };
  }, [enabled, root, schedule]);

  // Every visual viewport resize or pan restarts the settle delay.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the metrics are the trigger; the check reads them through a ref.
  useEffect(() => {
    if (enabled && viewport.height > 0) schedule();
  }, [enabled, schedule, viewport.height, viewport.offsetTop]);
}
