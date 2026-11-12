/**
 * Package-internal record primitive with no imports and no public package
 * subpath: the one loose object guard this package's boundary readers share.
 */

/**
 * Any non-null object that is not an array, whatever its prototype. A class
 * instance or an object with accessor members passes; a reader that must
 * refuse those keeps its own stricter guard.
 */
export function isObjectRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
