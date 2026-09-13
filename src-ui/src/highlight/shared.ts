/**
 * Entry-safe constants and helpers shared by the main-thread highlighter
 * (`SyntaxHighlighterContext`) and the async worker client. This module must
 * stay free of Shiki and worker imports — it is reachable from the entry
 * chunk; the worker bootstrap is deliberately NOT (see highlight-client.ts).
 *
 * The preload language list used to live here and no longer does: only
 * `core-highlighter` reads it, that module is lazy, and eighteen string
 * literals nothing in the entry chunk uses are eighteen too many.
 */

export const THEME = 'github-dark';

/** FNV-1a 32-bit hash — cache-key component for highlighted code. */
export function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

export function highlightCacheKey(code: string, lang: string): string {
  return `${lang}:${fnv1a(code)}`;
}

/** Simple LRU for highlighted-HTML strings. */
export class HighlightCache {
  private map = new Map<string, string>();
  private maxEntries: number;

  constructor(maxEntries = 300) {
    this.maxEntries = maxEntries;
  }

  get(key: string): string | undefined {
    const val = this.map.get(key);
    if (val !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key);
      this.map.set(key, val);
    }
    return val;
  }

  set(key: string, value: string) {
    if (this.map.size >= this.maxEntries) {
      // Evict oldest
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.set(key, value);
  }

  get size(): number {
    return this.map.size;
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
