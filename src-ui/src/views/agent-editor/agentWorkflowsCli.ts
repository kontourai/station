/**
 * The CLI invocation that manages an agent's workflow files.
 *
 * Agent workflow routes are live (`/agents/:slug/workflows/*`) and the CLI
 * exposes them, but no UI does — the management view was removed by the
 * #2677 dead-surface sweep because nothing navigated to it (station#2693).
 * The editor points operators at this command rather than leaving the
 * capability invisible.
 *
 * Exported so the note and its test share one source: a note naming a command
 * the CLI no longer documents is worse than no note at all.
 */
export const AGENT_WORKFLOWS_CLI_COMMAND =
  'station agents workflows <list|get|create|update|delete> <slug> [id]';
