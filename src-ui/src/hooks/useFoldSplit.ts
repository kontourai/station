import { type RefObject, useLayoutEffect, useRef, useState } from 'react';
import {
  type FoldSplit,
  foldSplitWithin,
  sameFoldSplit,
} from '../platform/fold/foldGeometry';
import {
  getFoldGeometry,
  subscribeFoldGeometry,
} from '../platform/fold/foldStore';

/**
 * Where the display's crease crosses the element in `ref`, kept current.
 *
 * This is the one way a layout learns about the fold. It measures the element
 * (never its children, so a layout that reacts to the answer cannot move what
 * is measured) on fold changes, element resizes and window resizes, and
 * writes the answer onto the element for CSS:
 *
 * - `data-fold-split="vertical|horizontal"` and `data-fold-larger="start|end"`
 *   while a folded crease crosses it;
 * - `--fold-split-start`, `--fold-split-gap`, `--fold-split-end` in px.
 *
 * The shared treatments read those: a split layout puts its first pane in
 * `start` and its second after the crease (SplitPaneLayout, the dock's Inbox
 * row); a single column (`.fold-avoid-crease`) moves into the larger side.
 * The same value is returned for a layout that must decide in script.
 *
 * The element may mount after the component does (the dock's row exists only
 * while the dock is open), so the hook re-attaches whenever `ref` starts
 * pointing at a different element.
 */
export function useFoldSplit(
  ref: RefObject<HTMLElement | null>,
): FoldSplit | null {
  const [split, setSplit] = useState<FoldSplit | null>(null);
  const attachment = useRef<{
    element: HTMLElement;
    detach: () => void;
  } | null>(null);

  useLayoutEffect(() => {
    const element = ref.current ?? null;
    if (attachment.current?.element === element) return;
    attachment.current?.detach();
    attachment.current = element
      ? { element, detach: observeFoldSplit(element, setSplit) }
      : null;
  });

  useLayoutEffect(
    () => () => {
      attachment.current?.detach();
      attachment.current = null;
    },
    [],
  );

  return split;
}

function observeFoldSplit(
  element: HTMLElement,
  changed: (split: FoldSplit | null) => void,
): () => void {
  let applied: FoldSplit | null = null;
  let frame: number | undefined;

  const write = (next: FoldSplit | null) => {
    if (sameFoldSplit(applied, next)) return;
    applied = next;
    if (next) {
      element.dataset.foldSplit = next.axis;
      element.dataset.foldLarger = next.larger;
      element.style.setProperty('--fold-split-start', `${next.start}px`);
      element.style.setProperty('--fold-split-gap', `${next.gap}px`);
      element.style.setProperty('--fold-split-end', `${next.end}px`);
    } else {
      delete element.dataset.foldSplit;
      delete element.dataset.foldLarger;
      element.style.removeProperty('--fold-split-start');
      element.style.removeProperty('--fold-split-gap');
      element.style.removeProperty('--fold-split-end');
    }
    changed(next);
  };

  const measure = () => {
    frame = undefined;
    write(foldSplitWithin(element.getBoundingClientRect(), getFoldGeometry()));
  };
  const schedule = () => {
    if (frame === undefined) frame = window.requestAnimationFrame(measure);
  };

  measure();
  const unsubscribe = subscribeFoldGeometry(schedule);
  window.addEventListener('resize', schedule);
  const observer =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  observer?.observe(element);
  return () => {
    unsubscribe();
    window.removeEventListener('resize', schedule);
    observer?.disconnect();
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    write(null);
  };
}
