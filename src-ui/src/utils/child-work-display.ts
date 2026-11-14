import type {
  ChildWorkDisplayStatus,
  ChildWorkModel,
  ChildWorkSummarySource,
  ChildWorkUsage,
} from '@kontourai/station-contracts/child-work';
import {
  type ChildWorkItem,
  type ChildWorkKey,
  childWorkKey,
  childWorkKindOf,
} from '@kontourai/station-contracts/child-work';
import type { OrchestrationSessionEventWindow } from '@kontourai/station-contracts/orchestration';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { formatDuration as formatChildWorkElapsed } from './relativeTime';

/**
 * The words every child-work surface (the Agents pane's row, the transcript's
 * subagent card) uses for one child, so the two cannot disagree about what an
 * outcome is called.
 *
 * A terminal reads as what was OBSERVED: "No result" and "Stop requested —
 * not confirmed" are not "Run finished" and not "Stopped".
 */
export const CHILD_WORK_STATUS_LABEL: Record<ChildWorkDisplayStatus, string> = {
  running: 'Running',
  completed: 'Run finished',
  failed: 'Failed',
  cancelled: 'Stopped',
  // Decision F: a stop nobody confirmed is not a stop that happened.
  'stopped-unconfirmed': 'Stop requested — not confirmed',
  // The reporter stopped listing it without an outcome.
  unresolved: 'No result',
  // `unresolved` with `endedBy: 'engine-exit'` (`childWorkDisplayStatus`):
  // its engine process ended while it ran, an observed end, not a gap.
  interrupted: 'Interrupted',
};

/**
 * A status as a count's tail in a group heading ("2 finished · 1 running"),
 * where the card's own "Run finished" would read "2 run finished".
 */
export const CHILD_WORK_GROUP_STATUS_LABEL: Record<
  ChildWorkDisplayStatus,
  string
> = {
  running: 'running',
  completed: 'finished',
  failed: 'failed',
  cancelled: 'stopped',
  'stopped-unconfirmed': 'stop not confirmed',
  unresolved: 'no result',
  interrupted: 'interrupted',
};

/**
 * The producer's kind label as a person reads it: a subagent type
 * ("Explore") prints, an engine's raw task type (`local_agent`,
 * `local_bash`) does not.
 */
export function childWorkKindLabel(
  item: Pick<ChildWorkItem, 'kindLabel'>,
): string | undefined {
  const label = item.kindLabel?.trim();
  if (!label || /^(?:local|remote|in_process)_[a-z_]+$/.test(label))
    return undefined;
  return label;
}

/**
 * What a group of children is called: "2 subagents", "2 background
 * commands", or "3 background tasks" when they are of more than one kind.
 */
export function childWorkGroupLabel(
  items: readonly Pick<ChildWorkItem, 'workKind' | 'kindLabel'>[],
): string {
  const kinds = new Set(items.map((item) => childWorkKindOf(item)));
  const count = items.length;
  if (kinds.size === 1) {
    const [kind] = kinds;
    if (kind === 'agent')
      return count === 1 ? '1 subagent' : `${count} subagents`;
    if (kind === 'monitor')
      return count === 1 ? '1 monitor' : `${count} monitors`;
    return count === 1
      ? '1 background command'
      : `${count} background commands`;
  }
  return `${count} background tasks`;
}

const CLAUDE_COMMAND_SUMMARY =
  /^Background command "[\s\S]*" (?:completed|failed|was stopped|stopped|killed)(?: \(exit code (-?\d+)\))?\.?$/;

/**
 * The text worth showing as a child's result, or undefined. A result that
 * only restates the title says nothing; Claude's summary for a background
 * command ('Background command "…" completed (exit code 0)') repeats the
 * title, so only its exit code is kept.
 */
export function childWorkResultText(
  item: Pick<ChildWorkItem, 'result' | 'workKind' | 'kindLabel'>,
  title: string,
): string | undefined {
  const summary = item.result?.summary?.trim();
  if (!summary || summary === title.trim()) return undefined;
  if (childWorkKindOf(item) !== 'agent') {
    const match = CLAUDE_COMMAND_SUMMARY.exec(summary);
    if (match)
      return match[1] !== undefined ? `Exit code ${match[1]}` : undefined;
  }
  return summary;
}

export { formatDuration as formatChildWorkElapsed } from './relativeTime';

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

/** Most recent tool started by this execution in its current loaded turn. */
export function latestChildTool(
  events: readonly CanonicalRuntimeEvent[],
  threadId: string,
  latestTool?: OrchestrationSessionEventWindow['latestTool'],
): string | undefined {
  if (latestTool !== undefined) return latestTool?.name;
  let turnId: string | undefined;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.threadId === threadId && event.method === 'turn.started') {
      turnId = event.turnId;
      break;
    }
  }
  let crossedStart = false;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.threadId !== threadId) continue;
    if (
      event.method === 'tool.started' &&
      (event.turnId ? !turnId || event.turnId === turnId : !crossedStart)
    )
      return event.toolName;
    if (event.method === 'turn.started') {
      crossedStart = true;
      if (event.turnId !== turnId) return undefined;
    }
  }
  return undefined;
}

export function childWorkSummaryLabel(
  source: ChildWorkSummarySource | undefined,
): string {
  switch (source) {
    case 'tool-return':
      return 'Returned result';
    case 'provider-summary':
      return 'Provider summary';
    case 'child-message':
      return 'Child message';
    case 'provider-error':
      return 'Provider error';
    default:
      return 'Summary · source not recorded';
  }
}

const NOTICE_SCOPE = 'station-child-work-notice-v1';

export function childWorkNoticeKey(
  child: ChildWorkKey,
  apiBase?: string,
): string {
  const key = childWorkKey(child);
  return !apiBase ? key : JSON.stringify([NOTICE_SCOPE, apiBase, key]);
}

/** A foreign Station's notice is hidden; legacy identities keep their old behavior. */
export function visibleChildWorkNoticeKey(
  key: string,
  apiBase: string,
): string | null {
  let value: unknown;
  try {
    value = JSON.parse(key);
  } catch {
    return key;
  }
  if (!Array.isArray(value) || value[0] !== NOTICE_SCOPE) return key;
  if (
    value.length !== 3 ||
    typeof value[1] !== 'string' ||
    typeof value[2] !== 'string'
  )
    return null;
  return value[1] === apiBase ? value[2] : null;
}
