import type { VisualViewportMetrics } from '@kontourai/station-shared/visual-viewport';
import { type RefObject, useCallback, useEffect, useRef } from 'react';

/** A bottom inset at least this tall is a software keyboard, not jitter. */
const KEYBOARD_OPEN_PX = 120;
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

interface Cycle {
  /** The viewport changed: correct once the lift over the keyboard settles. */
  schedule(): void;
  dispose(): void;
}

/**
 * Keeps a focused phone composer above the software keyboard (#4810).
 *
 * The composer lifts itself over the keyboard; when the page cannot make room
 * for that, the page scrolls the composer back into view. That correction runs
 * at most once per cycle, which focus entering the composer or the keyboard
 * opening starts. It waits for the animated lift to land, and it is dropped
 * the moment the reader scrolls (wheel, touch, a scroll key, or any scroll it
 * did not make), so the reader's position is never taken back. Smaller
 * viewport changes, such as a browser bar settling, do not start a cycle.
 */
export function useKeepAboveKeyboard(
  root: RefObject<HTMLElement | null>,
  enabled: boolean,
  viewport: VisualViewportMetrics,
) {
  const cycle = useRef<Cycle | undefined>(undefined);
  const metrics = useRef(viewport);
  metrics.current = viewport;
  const lastInset = useRef(viewport.bottomInset);

  const arm = useCallback(() => {
    cycle.current?.dispose();
    const element = root.current;
    if (!element) return;
    let pending: (() => void) | undefined;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as Element | null;
      if (
        SCROLL_KEYS.has(event.key) &&
        !target?.closest?.('textarea, input, select, [contenteditable]')
      )
        dispose();
    };
    // Only a scroll of something holding the composer is the reader's; a
    // list inside the room following its newest message is not.
    const onScroll = (event: Event) => {
      const target = event.target;
      if (
        target === document ||
        (target instanceof Node && target.contains(element))
      )
        dispose();
    };
    const dispose = () => {
      pending?.();
      pending = undefined;
      window.removeEventListener('wheel', dispose, true);
      window.removeEventListener('touchmove', dispose, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKey, true);
      if (cycle.current === current) cycle.current = undefined;
    };
    const correct = () => {
      const focused = element.contains(document.activeElement);
      const { offsetTop, height } = metrics.current;
      const overhang =
        element.getBoundingClientRect().bottom - (offsetTop + height);
      // Ends the cycle first, so this scroll is not mistaken for the reader's.
      dispose();
      // Which ancestor scrolls is known only once the lift has grown the page.
      if (focused && overhang > 0)
        scrollParent(element).scrollBy({ top: overhang });
    };
    const current: Cycle = {
      schedule() {
        pending?.();
        let live = true;
        let frame = 0;
        pending = () => {
          live = false;
          cancelAnimationFrame(frame);
        };
        // Measure where the composer lands, not the lift's first frame.
        const lifting =
          element
            .getAnimations?.()
            .filter(
              (animation) =>
                animation instanceof CSSTransition &&
                animation.transitionProperty === 'margin-bottom',
            ) ?? [];
        void Promise.allSettled(
          lifting.map((animation) => animation.finished),
        ).then(() => {
          if (live) frame = requestAnimationFrame(() => live && correct());
        });
      },
      dispose,
    };
    window.addEventListener('wheel', dispose, { capture: true, passive: true });
    window.addEventListener('touchmove', dispose, {
      capture: true,
      passive: true,
    });
    // Scroll events do not bubble; capture sees every element's.
    document.addEventListener('scroll', onScroll, {
      capture: true,
      passive: true,
    });
    window.addEventListener('keydown', onKey, true);
    cycle.current = current;
  }, [root]);

  // Focus arriving from outside the composer starts a cycle; leaving ends it.
  useEffect(() => {
    const element = root.current;
    if (!enabled || !element) return;
    const onFocusIn = (event: FocusEvent) => {
      if (!element.contains(event.relatedTarget as Node | null)) arm();
    };
    const onFocusOut = (event: FocusEvent) => {
      if (!element.contains(event.relatedTarget as Node | null))
        cycle.current?.dispose();
    };
    element.addEventListener('focusin', onFocusIn);
    element.addEventListener('focusout', onFocusOut);
    if (element.contains(document.activeElement)) arm();
    return () => {
      element.removeEventListener('focusin', onFocusIn);
      element.removeEventListener('focusout', onFocusOut);
      cycle.current?.dispose();
    };
  }, [enabled, root, arm]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a pan (offsetTop) moves the visible bottom, so it reschedules the pending correction too.
  useEffect(() => {
    const previous = lastInset.current;
    lastInset.current = viewport.bottomInset;
    const element = root.current;
    if (!enabled || viewport.height <= 0) return;
    if (!element?.contains(document.activeElement)) return;
    // A keyboard opening starts a cycle of its own; jitter never does.
    if (
      previous < KEYBOARD_OPEN_PX &&
      viewport.bottomInset >= KEYBOARD_OPEN_PX &&
      !cycle.current
    )
      arm();
    cycle.current?.schedule();
  }, [
    enabled,
    root,
    arm,
    viewport.height,
    viewport.offsetTop,
    viewport.bottomInset,
  ]);
}
