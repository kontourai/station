/**
 * Reads an integer query parameter at the route seam, clamped to
 * `[bounds.min, bounds.max]`.
 *
 * Answers `undefined` when the parameter is absent or is not a plain decimal
 * integer, so the caller supplies its own default with `??`. Several routes
 * passed `parseInt(...)` or `Number(...)` of a query string straight to a
 * `slice`, a SQL `LIMIT` or a command-line flag: `NaN` and negative values
 * reached all three, and nothing bounded the upper end. Out-of-range values
 * are clamped rather than refused, so a request that asks for too much still
 * gets the most the route serves.
 */
export function boundedIntQuery(
  value: string | undefined,
  bounds: { min: number; max: number },
): number | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (!/^[+-]?\d+$/.test(text)) return undefined;
  // A digit run too long for a double parses as Infinity, which clamps to
  // `max` like any other oversized value.
  return Math.min(bounds.max, Math.max(bounds.min, Number(text)));
}
