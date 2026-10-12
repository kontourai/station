/**
 * Entry-point side of bounded liveness scaling (#3302): samples host CPU
 * pressure once and publishes the factor. Consumers read it through
 * liveness-scale.mjs, which never samples.
 *
 * A liveness bound is a dead-child guard, not a performance budget. On a host
 * that other work has saturated, an honest run takes longer than a bound sized
 * for an idle machine, and the gate reports a timeout that says nothing about
 * the change. This module derives one scale factor from the same portable CPU
 * sampler the verification coordinator uses, and every consumer multiplies its
 * LIVENESS bound by it. Performance budgets and assertions are never scaled.
 *
 * Rules:
 * - Healthy host (and CI) is exactly 1. The sampled factor is capped at
 *   MAX_SAMPLED_LIVENESS_SCALE.
 * - A sample that is unavailable yields 1, the documented default, never an
 *   unbounded value.
 * - STATION_LIVENESS_SCALE may only RAISE the factor and is bounded to
 *   MAX_LIVENESS_SCALE. A value above the bound, below 1, or malformed is
 *   refused with an error rather than clamped.
 * - Every scaled bound stays finite, so a genuine hang still fails.
 * - Entry points call ensureLivenessScale() once; it publishes the result in
 *   the environment (with a marker) so children read it and never re-sample.
 *   Consumers call livenessScale() / scaleLivenessMs(), which never sample.
 */

import {
  LIVENESS_SCALE_ENV,
  LIVENESS_SCALE_RESOLVED_ENV,
  livenessScale,
  overrideFrom,
} from './liveness-scale.mjs';
import { invokedDirectly } from './module-entry.mjs';
import {
  createHostCpuSampler,
  DEFAULT_HOST_CPU_THRESHOLD_PERCENT,
} from './verification-host-pressure.mjs';

export const MAX_SAMPLED_LIVENESS_SCALE = 4;

/** Busy-percent steps: at or below `maxBusy` the factor is `scale`. */
const PRESSURE_STEPS = Object.freeze([
  { maxBusy: 60, scale: 1 },
  { maxBusy: 70, scale: 2 },
  { maxBusy: DEFAULT_HOST_CPU_THRESHOLD_PERCENT, scale: 3 },
]);

/** Pure mapping from busy percent to the sampled factor, in [1..4]. */
export function scaleFromBusyPercent(busyPercent) {
  if (!Number.isFinite(busyPercent)) return 1;
  for (const step of PRESSURE_STEPS) {
    if (busyPercent <= step.maxBusy) return step.scale;
  }
  return MAX_SAMPLED_LIVENESS_SCALE;
}

function isCiEnvironment(env = process.env) {
  return env.CI === 'true' || env.CI === '1' || env.GITHUB_ACTIONS === 'true';
}

/**
 * @typedef {{ status?: string, busyPercent?: number }} PressureSample
 * @typedef {Record<string, string | undefined>} LivenessEnv
 */

/**
 * Computes the factor for this run: max(sampled, override). Samples only when
 * not in CI. Returns the evidence for the visibility line.
 *
 * @param {{ env?: LivenessEnv, sampler?: () => Promise<PressureSample> }} [options]
 */
export async function resolveLivenessScale({
  env = process.env,
  sampler = createHostCpuSampler({
    threshold: {
      percent: DEFAULT_HOST_CPU_THRESHOLD_PERCENT,
      source: 'default',
    },
  }),
} = {}) {
  const override = overrideFrom(env);
  let sampled = 1;
  let busyPercent = null;
  if (!isCiEnvironment(env)) {
    let sample = null;
    try {
      sample = await sampler();
    } catch {
      sample = null;
    }
    if (
      sample &&
      sample.status !== 'unavailable' &&
      Number.isFinite(sample.busyPercent)
    ) {
      busyPercent = sample.busyPercent;
      sampled = scaleFromBusyPercent(busyPercent);
    }
  }
  const scale = Math.max(sampled, override ?? 1);
  return { scale, sampled, override, busyPercent };
}

/** The one visible line for a scale above 1; null when nothing is scaled. */
export function describeLivenessScale({ scale, sampled, busyPercent }) {
  if (!(scale > 1)) return null;
  if (sampled >= scale && busyPercent !== null)
    return `host under CPU pressure (${busyPercent}% busy): liveness bounds ×${scale}`;
  return `liveness bounds ×${scale} (${LIVENESS_SCALE_ENV} override; liveness guards only, not budgets)`;
}

/**
 * Entry-point call: resolves once, prints one line when above 1, and publishes
 * the factor to `env` so children read it instead of sampling again. When a
 * parent already resolved it (marker present) the value is reused as-is.
 *
 * @param {{
 *   env?: LivenessEnv,
 *   sampler?: () => Promise<PressureSample>,
 *   log?: (line: string) => unknown,
 * }} [options]
 */
export async function ensureLivenessScale({
  env = process.env,
  sampler,
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  if (env[LIVENESS_SCALE_RESOLVED_ENV] === '1') return livenessScale(env);
  const resolved = await resolveLivenessScale({
    env,
    ...(sampler ? { sampler } : {}),
  });
  env[LIVENESS_SCALE_ENV] = String(resolved.scale);
  env[LIVENESS_SCALE_RESOLVED_ENV] = '1';
  const line = describeLivenessScale(resolved);
  if (line) log(line);
  return resolved.scale;
}

// CLI for shell entry points such as .githooks/pre-push: the resolved factor
// goes to stdout, the visibility line to stderr, and a refused override exits 2.
if (invokedDirectly(import.meta.url)) {
  try {
    process.stdout.write(`${await ensureLivenessScale()}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
