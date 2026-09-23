/**
 * What a reader is told about a tool call that was still open when its
 * SESSION ended (station#1558's `tool.completed` status `'unresolved'`).
 *
 * The two honest facts are that no result was reported and that Station
 * cannot tell whether the tool ran — the engine is gone, and a result it may
 * or may not have produced went with it. Anything more specific ("the tool
 * failed", "the call was cancelled") would be a claim nothing observed.
 *
 * Promoted out of `claude-adapter-events.ts` by station#1569 (item 4), when
 * the ACP, Codex and station-agent adapters gained the same settle. It is one
 * sentence on purpose: a reader who sees an unresolved row from two different
 * engines is being told the same thing, so it must not drift per adapter.
 * (Same promotion pattern as `capability-delivery-metadata.ts` and
 * `agent-tool-server-mapping.ts`.)
 */
export const UNRESOLVED_TOOL_OUTPUT =
  'No result was reported before the session ended; whether the tool ran is unknown.';

/**
 * The same two facts for an engine whose process lives for ONE TURN (Muse:
 * one `muse exec` per turn). When that turn settles, the process that ran
 * the tool is finished with, so the call is settled at turn end rather than
 * session end — and saying "session" would misstate which boundary passed.
 * Engines that settle at session end keep {@link UNRESOLVED_TOOL_OUTPUT}.
 */
export const UNRESOLVED_TURN_TOOL_OUTPUT =
  'No result was reported before the turn ended; whether the tool ran is unknown.';
