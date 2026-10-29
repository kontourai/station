/**
 * The UI's two object guards. Each was spelled privately in several modules;
 * these are the shared spellings for the copies whose semantics matched
 * exactly.
 *
 * `!Array.isArray(value)` is load-bearing: `typeof []` is `'object'`, so
 * without it an array passes and a caller reading named fields gets
 * `undefined` instead of a rejection.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `isRecord` whose prototype is exactly `Object.prototype`, so class
 * instances and null-prototype objects are rejected. Persisted-store parsers
 * use it. It is a different contract from `isRecord`, not a stricter spelling
 * of the same one.
 */
export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return isRecord(value) && Object.getPrototypeOf(value) === Object.prototype;
}
