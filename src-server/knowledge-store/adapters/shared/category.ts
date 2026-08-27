/**
 * Category validation (store-contract.md §3): a dot-separated string of one or more
 * non-empty segments, each matching `[a-z0-9_-]+`. Shared by both Station-owned
 * Kit-format adapters (`kit-default-store`, `kit-obsidian-store`) so category
 * acceptance is identical regardless of which adapter backs a root.
 */
const CATEGORY_SEGMENT_RE = /^[a-z0-9_-]+$/;

export function isValidCategory(category: unknown): category is string {
  if (!category || typeof category !== 'string') return false;
  return category
    .split('.')
    .every((segment) => CATEGORY_SEGMENT_RE.test(segment));
}
