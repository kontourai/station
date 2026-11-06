import { useSyncExternalStore } from 'react';

/** Below this width a viewer's chrome takes its one-row compact form. */
export const NARROW_VIEWPORT_PX = 480;

const QUERY = `(max-width: ${NARROW_VIEWPORT_PX - 1}px)`;

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const media = window.matchMedia(QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function read(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean(window.matchMedia) &&
    window.matchMedia(QUERY).matches
  );
}

/**
 * Whether the viewport is phone-narrow. A component decision, like
 * `useCoarsePointer`: the compact chrome renders different controls (a menu
 * instead of a row of buttons), which a stylesheet cannot do.
 */
export function useNarrowViewport(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
