import { useSyncExternalStore } from 'react';

const QUERY = '(pointer: coarse)';

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
 * Whether the primary pointer is coarse (a finger). A component decision,
 * not a stylesheet one: a surface that reveals controls on hover has to
 * render a different chrome for a pointer that cannot hover, and a
 * page-local media query cannot change what is rendered.
 */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
