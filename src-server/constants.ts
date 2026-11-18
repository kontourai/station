import type { AppConfig } from '@kontourai/station-contracts/config';

/**
 * Shared server-wide constants. Values used in more than one module live here
 * so the meaning is named once and changed in one place.
 */

/** Heartbeat interval for long-lived SSE streams (keep-alive ping). */
export const SSE_KEEPALIVE_INTERVAL_MS = 30_000;

/**
 * archive#1092: reconnect replay-vs-snapshot gap threshold for the
 * orchestration event stream's sequence-cursor resume. A reconnecting
 * client whose `Last-Event-ID` cursor is within this many events of the
 * current head gets a bounded replay of exactly what it missed; further
 * behind (or an unknown/invalid cursor) gets a fresh snapshot with a new
 * resume cursor instead, capping worst-case reconnect cost.
 */
export const ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD = 1000;

/** Maximum serialized replay payload before reconnect switches to a snapshot. */
export const ORCHESTRATION_STREAM_REPLAY_MAX_SERIALIZED_BYTES = 96_000;

/** VoltAgent's finite fallback for authored Agent runs with no configured cap. */
export const DEFAULT_MAX_STEPS = 200;

/** An authored Agent cap wins over the configured fallback. */
export function resolveMaxSteps(opts: {
  specMaxSteps?: number | null;
  defaultMaxTurns?: number;
}): number {
  return opts.specMaxSteps || opts.defaultMaxTurns || DEFAULT_MAX_STEPS;
}

/** Cap for Station's current framework, preserving its built-in default when unset. */
export function resolveStationRunMaxSteps(
  config: Pick<AppConfig, 'runtime' | 'defaultMaxTurns'>,
  {
    specMaxSteps,
    builtin = false,
  }: { specMaxSteps?: number | null; builtin?: boolean } = {},
): number | undefined {
  if (config.runtime === 'strands') return undefined;
  return builtin
    ? config.defaultMaxTurns || undefined
    : resolveMaxSteps({
        specMaxSteps,
        defaultMaxTurns: config.defaultMaxTurns,
      });
}

/** Default Ollama server base URL. */
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
