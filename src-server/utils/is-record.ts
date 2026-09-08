/**
 * The narrowing guard ~20 src-server modules had each spelled for themselves,
 * under three names (`isRecord`, `isPlainObject`, `isObject`) and four
 * equivalent spellings of the same three conditions.
 *
 * `!Array.isArray(value)` is load-bearing, not decoration: `typeof []` is
 * `'object'`, so without it every array satisfies the guard and callers that
 * go on to read named fields get `undefined` from an array rather than a
 * rejection. That is the semantics the large majority of the copies had, and
 * the one this module publishes.
 *
 * Two neighbouring contracts deliberately do NOT live here:
 *
 * - The adapters' array-permitting variant
 *   (`providers/adapters/codex-adapter-events.ts`,
 *   `providers/adapters/muse-adapter-events.ts`) omits the array check.
 * - The prototype-walking `isPlainObject` used by the kit, plugin, task-graph
 *   and connection-smoke stores additionally rejects class instances and
 *   anything with an exotic prototype. Rejecting more is a different contract,
 *   not a stricter spelling of this one.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
