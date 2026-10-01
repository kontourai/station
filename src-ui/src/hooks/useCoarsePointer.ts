import { useEffect, useState } from 'react';

const COARSE_POINTER_QUERY = '(pointer: coarse)';

function read(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(COARSE_POINTER_QUERY).matches;
}

/**
 * Whether the primary pointer is coarse (touch). The Browser pane and its
 * page-dialog card mark themselves with it (`data-coarse` /
 * `data-pointer`) instead of carrying page-local media queries: responsive
 * rules belong to the shared primitives (scripts/mobile-css-ratchet.mjs).
 */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(read);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia(COARSE_POINTER_QUERY);
    const onChange = (event: MediaQueryListEvent) => setCoarse(event.matches);
    setCoarse(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return coarse;
}
