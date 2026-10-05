/**
 * Consumer side of bounded liveness scaling (#3302). Dependency-free so the
 * Vitest config and the transfer capture tool can import it. The sampling
 * entry point lives in liveness-scale-resolve.mjs.
 *
 * A liveness bound is a dead-child guard, not a performance budget. On a host
 * that other work has saturated, an honest run takes longer than a bound sized
 * for an idle machine. Every consumer multiplies its LIVENESS bound by one
 * factor that an entry point resolved once and published in the environment;
 * performance budgets and assertions are never scaled.
 *
 * - Absent means 1 (healthy host, CI, or no entry point involved).
 * - STATION_LIVENESS_SCALE may only RAISE bounds and is limited to
 *   MAX_LIVENESS_SCALE. A value above the limit, below 1, or malformed is
 *   refused with an error, never clamped.
 * - Every scaled bound stays finite, so a genuine hang still fails.
 */

export const LIVENESS_SCALE_ENV = 'STATION_LIVENESS_SCALE';
/** Set alongside the factor once an entry point has resolved it. */
export const LIVENESS_SCALE_RESOLVED_ENV = 'STATION_LIVENESS_SCALE_RESOLVED';
export const MAX_LIVENESS_SCALE = 8;

const OVERRIDE_PATTERN = /^\d+(?:\.\d+)?$/;

function refuse(raw) {
  return new Error(
    `${LIVENESS_SCALE_ENV} must be a number in [1..${MAX_LIVENESS_SCALE}] (it can only raise liveness bounds, which stay finite): ${JSON.stringify(raw)}`,
  );
}

/** Parses an explicit factor; throws for anything outside [1..8]. */
export function parseLivenessScale(raw) {
  const text = String(raw).trim();
  if (!OVERRIDE_PATTERN.test(text)) throw refuse(raw);
  const value = Number(text);
  if (!Number.isFinite(value) || value < 1 || value > MAX_LIVENESS_SCALE)
    throw refuse(raw);
  return value;
}

export function overrideFrom(env) {
  const raw = env[LIVENESS_SCALE_ENV];
  if (raw === undefined || String(raw).trim() === '') return null;
  return parseLivenessScale(raw);
}

/** Consumer read: never samples. Absent means 1; invalid is refused. */
export function livenessScale(env = process.env) {
  return overrideFrom(env) ?? 1;
}

/** A liveness bound multiplied by the factor. Always finite. */
export function scaleLivenessMs(baseMs, env = process.env) {
  if (!Number.isFinite(baseMs) || baseMs <= 0)
    throw new Error(`liveness bound must be a positive number: ${baseMs}`);
  return Math.ceil(baseMs * livenessScale(env));
}
