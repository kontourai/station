import { HighlightCache, highlightCacheKey } from './shared';

// Shared with the lazy client so remounts can read settled HTML without
// loading the worker or waiting for a passive effect.
export const highlightedHtmlCache = new HighlightCache(300);

export function peekHighlight(code: string, lang?: string): string | null {
  return lang
    ? (highlightedHtmlCache.get(highlightCacheKey(code, lang)) ?? null)
    : null;
}
