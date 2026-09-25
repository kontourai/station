import crypto from 'node:crypto';
import type {
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  applyChildWorkDelta,
  type ChildWorkDelta,
  type ChildWorkItem,
  type ChildWorkParent,
  type ChildWorkRegistryState,
  type ChildWorkResult,
  type ChildWorkTerminalStatus,
  type ChildWorkUsage,
  childWorkForReporter,
  createEmptyChildWorkRegistry,
} from '@kontourai/station-contracts/child-work';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { ProviderSession } from '../adapter-shape.js';

/**
 * #2457 (epic #2455): Claude Code subagents, mapped onto the child-work
 * contract.
 *
 * What claude 2.1.281 puts on the wire (live captures in
 * `__tests__/fixtures/claude-2.1.281-*.jsonl` and
 * `claude-task-subagents.jsonl`):
 *
 * - `task_started` names the child (`task_id`), the tool call that spawned it
 *   (`tool_use_id`), its description, `subagent_type`/`task_type`,
 *   `is_backgrounded` and — for an agent — `spawn_depth`.
 * - `task_progress` carries a status line (`summary`, with
 *   `agentProgressSummaries` on; else `description` plus `last_tool_name`)
 *   and running usage.
 * - The terminal arrives TWICE (station#1892): a `task_updated` whose patch
 *   carries the status (`completed`/`failed`/`killed`) and no result, then a
 *   `task_notification` (`completed`/`failed`/`stopped`) carrying the
 *   summary, the transcript `output_file` and usage. Both are emitted as
 *   settles; the contract's reducer keeps the first terminal and lets the
 *   second only fill what it lacked, so the result is not lost and nothing
 *   here has to remember which task already settled.
 * - `Query.stopTask` yields `task_updated` `killed` + `task_notification`
 *   `stopped` (captured: `stop-task`).
 * - Closing input sends NO terminal for a running background agent, and the
 *   iterator ends only when the query is closed (captured: `close-kills`).
 *   So the session end settles every still-running child here.
 * - A subagent's own shell call arrives as a `local_bash` task with
 *   `owned_by_subagent: true`. It is the child's internal work, not a
 *   sibling child, so it is not listed.
 * - A resumed agent reuses its `task_id` under a new `tool_use_id`
 *   (captured: `nested-agent`). The contract never revives a settled child,
 *   so a re-run of a settled `task_id` is a child of its own, keyed
 *   `${task_id}:${tool_use_id}`. The FIRST run keeps the bare `task_id`, the
 *   key pre-#2457 history carries. Frames name only the `task_id`, so they
 *   are routed to that id's current run, and a stop addressed to a re-run's
 *   key reaches the engine as its `task_id` (`resolveClaudeChildStop`).
 *   Accepted limitation: only SEQUENTIAL re-runs are modelled (all the
 *   capture shows) — a `task_started` for a `task_id` whose run is still
 *   RUNNING is ignored, since its frames could not be told apart anyway.
 * - After the session ends, only a REAL terminal is still mapped: when
 *   `stopSession`'s grace elapses, the SDK can still drain a queued
 *   `task_notification`, and that observed outcome corrects the
 *   `unresolved`/`stopped-unconfirmed` the session end recorded (the reducer
 *   lets a real settle replace those two).
 *
 * Status mapping never reads a stop, a kill or an unknown value as success:
 * an unrecognised `task_notification` status is `unresolved`, and an
 * unrecognised or non-terminal `task_updated` status changes nothing.
 *
 * Deltas are folded into a per-session registry with the contract's own
 * reducer, and only a delta that changes it is published, so the adapter's
 * running set is exactly what every consumer folds.
 */

export interface ClaudeChildWorkState {
  registry: ChildWorkRegistryState;
  /** Children (by child id) Station asked the engine to stop. */
  stopRequested: Set<string>;
  /** SDK `task_id` → the child id of its current run (re-runs only). */
  runs: Map<string, string>;
  /** Set once the session has ended; only real terminals are mapped after. */
  closed: boolean;
}

/** The slice of the adapter's per-session record this module reads. */
export interface ClaudeChildWorkRecord {
  session: Pick<ProviderSession, 'threadId'>;
  activeTurnId?: string;
  childWork?: ClaudeChildWorkState;
}

export interface ClaudeChildWorkContext {
  provider: ProviderSession['provider'];
  record: ClaudeChildWorkRecord;
  publish: (event: CanonicalRuntimeEvent) => void;
  createdAt: string;
  onBackgroundChildSettling?: () => void;
}

function stateOf(record: ClaudeChildWorkRecord): ClaudeChildWorkState {
  record.childWork ??= {
    registry: createEmptyChildWorkRegistry(),
    stopRequested: new Set(),
    runs: new Map(),
    closed: false,
  };
  return record.childWork;
}

/**
 * `task_started` / `task_notification` fields the SDK types do not declare
 * but the CLI sends (captured on 2.1.281).
 */
interface ClaudeTaskWireExtras {
  owned_by_subagent?: boolean;
  ambient?: boolean;
  skip_transcript?: boolean;
}

/**
 * Whether a task is child work at all. A `skip_transcript`/`ambient` task is
 * housekeeping the SDK asks hosts to keep out of activity; an
 * `owned_by_subagent` task is a subagent's own tool call.
 */
function isClaudeChildWorkTask(message: ClaudeTaskWireExtras): boolean {
  return (
    message.skip_transcript !== true &&
    message.ambient !== true &&
    message.owned_by_subagent !== true
  );
}

/** A `task_notification` status as child work; unknown is `unresolved`. */
function mapNotificationStatus(status: unknown): ChildWorkTerminalStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'stopped':
    case 'killed':
      return 'cancelled';
    default:
      return 'unresolved';
  }
}

/**
 * A `task_updated` patch status as child work. Non-terminal (`pending`,
 * `running`, `paused`) and unrecognised values are no change: the
 * `task_notification` that follows a real terminal settles it.
 */
function mapUpdatedStatus(
  status: unknown,
): ChildWorkTerminalStatus | undefined {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'killed':
    case 'stopped':
      return 'cancelled';
    default:
      return undefined;
  }
}

/**
 * station#1879: the SDK's optional per-task usage. Absence is ordinary and is
 * never reported as zeroes; the contract's reducer drops invalid figures.
 */
function readTaskUsage(usage: unknown): ChildWorkUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const raw = usage as Record<string, unknown>;
  const read = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  const next: ChildWorkUsage = {};
  const totalTokens = read(raw.total_tokens);
  const toolUses = read(raw.tool_uses);
  const durationMs = read(raw.duration_ms);
  if (totalTokens !== undefined) next.totalTokens = totalTokens;
  if (toolUses !== undefined) next.toolUses = toolUses;
  if (durationMs !== undefined) next.durationMs = durationMs;
  return Object.keys(next).length > 0 ? next : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function emit(context: ClaudeChildWorkContext, delta: ChildWorkDelta): boolean {
  const state = stateOf(context.record);
  const next = applyChildWorkDelta(state.registry, delta);
  if (next === state.registry) return false;
  state.registry = next;
  context.publish({
    eventId: crypto.randomUUID(),
    provider: context.provider,
    threadId: context.record.session.threadId,
    createdAt: context.createdAt,
    method: 'child-work.updated',
    delta,
  });
  return true;
}

function itemFor(
  record: ClaudeChildWorkRecord,
  childId: string,
): ChildWorkItem | undefined {
  return childWorkForReporter(
    stateOf(record).registry,
    record.session.threadId,
  ).find(
    (item) => item.producer === 'engine-subagent' && item.childId === childId,
  );
}

/** The child id of the current run of SDK task `taskId`. */
function childIdFor(record: ClaudeChildWorkRecord, taskId: string): string {
  return stateOf(record).runs.get(taskId) ?? taskId;
}

/** The SDK `task_id` a child id belongs to. */
function taskIdOf(record: ClaudeChildWorkRecord, childId: string): string {
  for (const [taskId, current] of stateOf(record).runs) {
    if (current === childId) return taskId;
  }
  return childId;
}

/**
 * What a stop addressed to `id` (a child id as clients hold it, or a bare
 * SDK `task_id`) reaches: the engine's `task_id` for `Query.stopTask`, and
 * the child whose stop is recorded.
 */
export function resolveClaudeChildStop(
  record: ClaudeChildWorkRecord,
  id: string,
): { taskId: string; childId: string } {
  const taskId = taskIdOf(record, id);
  return { taskId, childId: childIdFor(record, taskId) };
}

function runningChildren(record: ClaudeChildWorkRecord): ChildWorkItem[] {
  return childWorkForReporter(
    stateOf(record).registry,
    record.session.threadId,
  ).filter(
    (item) => item.producer === 'engine-subagent' && item.status === 'running',
  );
}

/**
 * `task_started`: the running set plus the new child, as an authoritative
 * snapshot. A re-run of a settled `task_id` is a new child (see the module
 * note on resumed agents).
 */
export function observeClaudeTaskStarted(
  context: ClaudeChildWorkContext,
  message: SDKTaskStartedMessage & ClaudeTaskWireExtras,
): void {
  const state = stateOf(context.record);
  if (state.closed || !isClaudeChildWorkTask(message)) return;
  let childId = childIdFor(context.record, message.task_id);
  const previous = itemFor(context.record, childId);
  if (previous?.status === 'running') return;
  if (previous) {
    childId = `${message.task_id}:${message.tool_use_id ?? context.createdAt}`;
    if (itemFor(context.record, childId)) return;
    state.runs.set(message.task_id, childId);
  }
  const parent: ChildWorkParent = {};
  if (message.tool_use_id) parent.toolCallId = message.tool_use_id;
  if (context.record.activeTurnId) parent.turnId = context.record.activeTurnId;
  const title = nonEmpty(message.description);
  const kindLabel =
    nonEmpty(message.subagent_type) ?? nonEmpty(message.task_type);
  const item: ChildWorkItem = {
    producer: 'engine-subagent',
    reporterThreadId: context.record.session.threadId,
    childId,
    status: 'running',
    ...(Object.keys(parent).length > 0 ? { parent } : {}),
    ...(title ? { title } : {}),
    ...(kindLabel ? { kindLabel } : {}),
    ...(typeof message.is_backgrounded === 'boolean'
      ? { backgrounded: message.is_backgrounded }
      : {}),
    // The contract drops a depth that is not a positive finite number.
    ...(typeof message.spawn_depth === 'number'
      ? { depth: message.spawn_depth }
      : {}),
    startedAt: context.createdAt,
    // station#1877: `stopProviderTask` → `Query.stopTask`, which the
    // `stop-task` capture shows the engine honours with a `stopped` settle.
    controls: { stop: 'provider-task-stop' },
  };
  emit(context, {
    kind: 'snapshot',
    producer: 'engine-subagent',
    reporterThreadId: context.record.session.threadId,
    running: [...runningChildren(context.record), item],
  });
}

/** `task_progress`: the latest status line and running usage. */
export function observeClaudeTaskProgress(
  context: ClaudeChildWorkContext,
  message: SDKTaskProgressMessage,
): void {
  if (stateOf(context.record).closed) return;
  const existing = itemFor(
    context.record,
    childIdFor(context.record, message.task_id),
  );
  if (existing?.status !== 'running') return;
  const described = nonEmpty(message.description);
  const progress =
    nonEmpty(message.summary) ??
    (described && message.last_tool_name
      ? `${described} — ${message.last_tool_name}`
      : described);
  const usage = readTaskUsage(message.usage);
  if (!progress && !usage) return;
  emit(context, {
    kind: 'upsert',
    // The title is the child's name, not its status: progress never
    // replaces it.
    item: {
      ...existing,
      ...(progress ? { progress } : {}),
      ...(usage ? { usage: { ...existing.usage, ...usage } } : {}),
    },
  });
}

/**
 * `task_updated`: a backgrounding or a renamed description upserts; a
 * terminal status settles; every other status changes nothing.
 */
export function observeClaudeTaskUpdated(
  context: ClaudeChildWorkContext,
  message: SDKTaskUpdatedMessage,
): void {
  const childId = childIdFor(context.record, message.task_id);
  const existing = itemFor(context.record, childId);
  // Untracked here means not child work (owned, ambient) or started before
  // this process attached: its task_notification settles it.
  if (!existing) return;
  const patch = message.patch ?? {};
  const terminal = mapUpdatedStatus(patch.status);
  if (terminal) {
    // A real terminal is mapped even after the session end (module note).
    settle(context, childId, terminal, {
      ...(terminal === 'failed' && nonEmpty(patch.error)
        ? { result: { summary: patch.error } }
        : {}),
    });
    return;
  }
  if (stateOf(context.record).closed || existing.status !== 'running') return;
  const description = nonEmpty(patch.description);
  const backgrounded =
    typeof patch.is_backgrounded === 'boolean'
      ? patch.is_backgrounded
      : undefined;
  if (description === undefined && backgrounded === undefined) return;
  emit(context, {
    kind: 'upsert',
    item: {
      ...existing,
      ...(description !== undefined ? { title: description } : {}),
      ...(backgrounded !== undefined ? { backgrounded } : {}),
    },
  });
}

/**
 * `task_notification`: the settle carrying the outcome — its summary, the
 * transcript file, usage, and the identity the message names, so a settle
 * for a child this process never listed is still attributable.
 */
export function observeClaudeTaskNotification(
  context: ClaudeChildWorkContext,
  message: SDKTaskNotificationMessage & ClaudeTaskWireExtras,
  options: { ownedBySubagent?: boolean } = {},
): void {
  // A real terminal: mapped even after the session end (module note).
  if (options.ownedBySubagent || !isClaudeChildWorkTask(message)) return;
  const summary = nonEmpty(message.summary);
  const outputFile = nonEmpty(message.output_file);
  const result: ChildWorkResult | undefined =
    summary || outputFile
      ? {
          ...(summary ? { summary } : {}),
          ...(outputFile
            ? { handle: { kind: 'transcript-file' as const, path: outputFile } }
            : {}),
        }
      : undefined;
  const usage = readTaskUsage(message.usage);
  const childId = childIdFor(context.record, message.task_id);
  settle(context, childId, mapNotificationStatus(message.status), {
    ...(result ? { result } : {}),
    ...(usage ? { usage } : {}),
    ...(message.tool_use_id
      ? { identity: { parent: { toolCallId: message.tool_use_id } } }
      : {}),
  });
}

function settle(
  context: ClaudeChildWorkContext,
  childId: string,
  status: ChildWorkTerminalStatus,
  extra: {
    result?: ChildWorkResult;
    usage?: ChildWorkUsage;
    identity?: Partial<ChildWorkItem>;
  } = {},
): void {
  const existing = itemFor(context.record, childId);
  if (existing?.status === 'running' && existing.backgrounded)
    context.onBackgroundChildSettling?.();
  // The identity a settle carries is everything this child is known by, so
  // a client that missed the listing (a reconnect mid-run) can still
  // attribute and announce the outcome.
  const identity: NonNullable<
    Extract<ChildWorkDelta, { kind: 'settle' }>['identity']
  > = {
    ...(existing?.parent ? { parent: existing.parent } : {}),
    ...(existing?.title ? { title: existing.title } : {}),
    ...(existing?.kindLabel ? { kindLabel: existing.kindLabel } : {}),
    ...(existing?.backgrounded !== undefined
      ? { backgrounded: existing.backgrounded }
      : {}),
    ...(existing?.depth !== undefined ? { depth: existing.depth } : {}),
    ...(existing?.startedAt ? { startedAt: existing.startedAt } : {}),
    ...(extra.identity?.parent && !existing?.parent
      ? { parent: extra.identity.parent }
      : {}),
    endedAt: context.createdAt,
  };
  emit(context, {
    kind: 'settle',
    producer: 'engine-subagent',
    reporterThreadId: context.record.session.threadId,
    childId,
    status,
    ...(extra.result ? { result: extra.result } : {}),
    ...(extra.usage ? { usage: extra.usage } : {}),
    identity,
  });
}

/**
 * `stopProviderTask` asked the engine to stop this child. The engine's own
 * `stopped` settle normally follows; if the session ends first, the child
 * settles `stopped-unconfirmed` rather than `unresolved`.
 */
export function markClaudeChildStopRequested(
  record: ClaudeChildWorkRecord,
  childId: string,
): void {
  stateOf(record).stopRequested.add(childId);
}

/** The stop request did not reach the engine: nothing was requested. */
export function clearClaudeChildStopRequested(
  record: ClaudeChildWorkRecord,
  childId: string,
): void {
  stateOf(record).stopRequested.delete(childId);
}

/**
 * Session end: no child still running can report any more. One whose stop
 * was requested settles `stopped-unconfirmed`; every other one `unresolved`,
 * through an empty snapshot. Called beside `settleUnresolvedClaudeToolCalls`,
 * before `session.exited`. Idempotent. Returns the SDK `task_id` of every
 * child it settled, so the adapter can withdraw what they left pending.
 *
 * The registry is kept: a real terminal the SDK still drains afterwards
 * corrects the outcome recorded here.
 */
export function settleOpenClaudeChildren(
  context: ClaudeChildWorkContext,
): string[] {
  const state = context.record.childWork;
  if (!state || state.closed) return [];
  const open = runningChildren(context.record);
  for (const item of open) {
    if (state.stopRequested.has(item.childId)) {
      settle(context, item.childId, 'stopped-unconfirmed');
    }
  }
  if (runningChildren(context.record).length > 0) {
    emit(context, {
      kind: 'snapshot',
      producer: 'engine-subagent',
      reporterThreadId: context.record.session.threadId,
      running: [],
    });
  }
  state.closed = true;
  state.stopRequested.clear();
  return open.map((item) => taskIdOf(context.record, item.childId));
}
