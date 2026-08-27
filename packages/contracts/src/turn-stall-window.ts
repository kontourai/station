import type { AgentExecutionConfig } from './agent.js';

/**
 * station#2959: default per-agent turn-stall window — how long a turn may run
 * with no observed progress event (a streamed content/reasoning chunk, a
 * tool lifecycle event, or a session state transition) before
 * `OrchestrationService` treats it as stalled.
 *
 * This is a distinct, deliberately longer ceiling than station#1207/#1256's
 * stream-chunk-read stall timeout (`STATION_AGENT_STREAM_STALL_TIMEOUT_MS` /
 * `CHAT_STREAM_STALL_TIMEOUT_MS`, both 45s): that watchdog fires on a single
 * silent READ and is reset by literally the next chunk. This window fires on
 * a silent TURN and is reset by any progress event, so it has to stay clear
 * of a real single long-running tool call (a build, a test run, a web
 * fetch) whose own chunks are exactly what keeps resetting the shorter
 * stream watchdog underneath it. Three minutes covers that case while still
 * bounding how long a genuinely wedged, unattended turn goes unnoticed.
 */
export const DEFAULT_TURN_STALL_WINDOW_MS = 180_000;

/**
 * Resolve the turn-stall window for an agent: its own declared
 * `execution.turnStallWindowMs` override when authored as a positive finite
 * number, otherwise `DEFAULT_TURN_STALL_WINDOW_MS`. An absent, zero,
 * negative, or non-finite override is treated as unauthored — it can never
 * silently disable detection by resolving to `0`/`Infinity`/`NaN`.
 */
export function resolveTurnStallWindowMs(
  execution?: Pick<AgentExecutionConfig, 'turnStallWindowMs'>,
): number {
  const override = execution?.turnStallWindowMs;
  if (
    typeof override === 'number' &&
    Number.isFinite(override) &&
    override > 0
  ) {
    return override;
  }
  return DEFAULT_TURN_STALL_WINDOW_MS;
}
