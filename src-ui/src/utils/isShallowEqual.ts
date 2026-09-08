/**
 * One-level structural comparison, the default equality for the store
 * selector hooks (`useActiveChatSelector`, `useNavigation(selector)`).
 *
 * Enough for a selector that returns a primitive or a flat object of
 * primitives and stable references. A selector returning a fresh nested
 * object compares unequal every time and must supply its own comparator.
 */
export function isShallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== 'object' ||
    a === null ||
    typeof b !== 'object' ||
    b === null
  ) {
    return false;
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.is(aRecord[key], bRecord[key])) {
      return false;
    }
  }
  return true;
}
