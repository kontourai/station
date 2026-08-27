/**
 * Shared server-wide constants. Values used in more than one module live here
 * so the meaning is named once and changed in one place.
 */

/** Heartbeat interval for long-lived SSE streams (keep-alive ping). */
export const SSE_KEEPALIVE_INTERVAL_MS = 30_000;

/**
 * station#1092: reconnect replay-vs-snapshot gap threshold for the
 * orchestration event stream's sequence-cursor resume. A reconnecting
 * client whose `Last-Event-ID` cursor is within this many events of the
 * current head gets a bounded replay of exactly what it missed; further
 * behind (or an unknown/invalid cursor) gets a fresh snapshot with a new
 * resume cursor instead, capping worst-case reconnect cost.
 */
export const ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD = 1000;

/** Maximum serialized replay payload before reconnect switches to a snapshot. */
export const ORCHESTRATION_STREAM_REPLAY_MAX_SERIALIZED_BYTES = 96_000;

/**
 * Default agentic-loop step cap when none is configured. Set high enough to
 * impose no artificial limit — VoltAgent's own default is a stingy 10, so
 * Station overrides it with this everywhere (chat, the engine adapter, and the
 * one-shot invoke routes). `maxSteps` is validated as a positive integer, so
 * "unlimited" is expressed as this high cap, not 0.
 */
export const DEFAULT_MAX_STEPS = 200;

/**
 * Resolve the agentic-loop step cap from the configured precedence
 * (agent guardrails > agent spec > app config), falling back to the
 * no-artificial-limit {@link DEFAULT_MAX_STEPS}. A `0` or missing value at any
 * level falls through to the next, since `maxSteps` is always a positive cap.
 */
export function resolveMaxSteps(opts: {
  guardrailsMaxSteps?: number;
  specMaxSteps?: number;
  defaultMaxTurns?: number;
}): number {
  return (
    opts.guardrailsMaxSteps ||
    opts.specMaxSteps ||
    opts.defaultMaxTurns ||
    DEFAULT_MAX_STEPS
  );
}

/** Default Ollama server base URL. */
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
