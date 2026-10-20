import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../lib/reduced-motion';

export interface ExitTransition {
  /** Whether the surface should be in the tree at all. */
  mounted: boolean;
  /** Mounted only to play its exit; already gone as far as the user decided. */
  exiting: boolean;
}

/**
 * Keeps a surface mounted for its exit animation after `open` goes false, then
 * unmounts it (archive#3309).
 *
 * Under `prefers-reduced-motion: reduce` there is no exit to wait for, so the
 * unmount is synchronous — deferring it anyway would leave an invisible
 * element in the accessibility tree and the layout for the exit budget, which
 * is the opposite of what the preference asks for. That branch is the reason
 * this is a hook and not a CSS class: CSS can hide an exiting element, it
 * cannot decline to keep it mounted.
 *
 * Re-opening during an exit cancels the pending unmount rather than queueing a
 * second one, so a fast toggle never unmounts a surface the user just reopened.
 */
export function useExitTransition(
  open: boolean,
  exitMs: number,
): ExitTransition {
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  const wasOpen = useRef(open);

  useEffect(() => {
    const clear = () => {
      if (timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
    };
    if (open) {
      clear();
      setExiting(false);
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    if (prefersReducedMotion() || exitMs <= 0) {
      clear();
      setExiting(false);
      return;
    }
    setExiting(true);
    clear();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      setExiting(false);
    }, exitMs);
  }, [open, exitMs]);

  useEffect(
    () => () => {
      if (timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current);
      }
    },
    [],
  );

  return { mounted: open || exiting, exiting: !open && exiting };
}
