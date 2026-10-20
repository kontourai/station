import type {
  ChildWorkModel,
  ChildWorkStatus,
  ChildWorkUsage,
} from '@kontourai/station-contracts/child-work';

/**
 * The words every child-work surface (the Agents pane's row, the transcript's
 * subagent card) uses for one child, so the two cannot disagree about what an
 * outcome is called.
 *
 * A terminal reads as what was OBSERVED: "No result" and "Stop requested —
 * not confirmed" are not "Completed" and not "Stopped".
 */
export const CHILD_WORK_STATUS_LABEL: Record<ChildWorkStatus, string> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Stopped',
  // Decision F: a stop nobody confirmed is not a stop that happened.
  'stopped-unconfirmed': 'Stop requested — not confirmed',
  // The reporter stopped listing it without an outcome.
  unresolved: 'No result',
};

/** `m:ss`, or `h:mm:ss` past an hour. */
export function formatChildWorkElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/** Only the members the engine reported; a reported 0 prints. */
export function childWorkUsageClauses(
  usage: ChildWorkUsage | undefined,
): string[] {
  if (!usage) return [];
  const clauses: string[] = [];
  if (usage.totalTokens !== undefined)
    clauses.push(`${usage.totalTokens.toLocaleString()} tokens`);
  if (usage.toolUses !== undefined)
    clauses.push(
      `${usage.toolUses} tool ${usage.toolUses === 1 ? 'use' : 'uses'}`,
    );
  if (usage.durationMs !== undefined)
    clauses.push(`ran ${formatChildWorkElapsed(usage.durationMs)}`);
  return clauses;
}

/** #3163: where the model shown came from, in the engine's terms. */
export const CHILD_WORK_MODEL_SOURCE_TEXT: Record<
  ChildWorkModel['source'],
  string
> = {
  'subagent-reply': "Reported on the subagent's own reply",
  'spawn-result': 'Reported by the engine when it spawned the subagent',
  'child-thread': "Reported by the subagent's own thread",
};
