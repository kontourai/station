import type { LayoutCatalogItem } from '@kontourai/station-contracts/distribution';

const STORAGE_KEY = 'recentLayouts';
const MAX_RECENT_LAYOUTS = 5;

function parseRecentLayoutIds(value: string | null): string[] {
  if (!value) return [];

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];

    return [
      ...new Set(
        parsed.filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        ),
      ),
    ].slice(0, MAX_RECENT_LAYOUTS);
  } catch {
    return [];
  }
}

/**
 * Returns the browser-local MRU of canonical LayoutCatalogItem IDs.
 *
 * Recency is intentionally only updated by trackRecentLayout after an apply
 * operation succeeds; reading this value has no storage side effects.
 */
export function getRecentLayoutIds(): string[] {
  try {
    return parseRecentLayoutIds(localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

/**
 * Joins the stored ID MRU with the current catalog, dropping layouts that are
 * no longer available to this client.
 */
export function getRecentLayouts(
  catalog: LayoutCatalogItem[],
): LayoutCatalogItem[] {
  const byId = new Map(catalog.map((item) => [item.id, item]));

  return getRecentLayoutIds().flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
}

/**
 * Records a canonical layout ID after a catalog apply succeeds.
 */
export function trackRecentLayout(id: LayoutCatalogItem['id']): void {
  const recent = getRecentLayoutIds().filter((recentId) => recentId !== id);
  recent.unshift(id);

  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(recent.slice(0, MAX_RECENT_LAYOUTS)),
    );
  } catch {
    // Browser storage can be disabled or full. Applying a layout still wins.
  }
}
