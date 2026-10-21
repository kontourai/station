import crypto from 'node:crypto';
import type {
  SDKAssistantMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  applyChildWorkDelta,
  type ChildWorkDelta,
  type ChildWorkItem,
  type ChildWorkModel,
  type ChildWorkParent,
  type ChildWorkRegistryState,
  type ChildWorkResult,
  type ChildWorkTerminalStatus,
  type ChildWorkUsage,
  childWorkForReporter,
  createEmptyChildWorkRegistry,
  isReportableChildWorkModelId,
  isReportableChildWorkToolName,
} from '@kontourai/station-contracts/child-work';
import type { ProviderRuntimeEvent as CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
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
 *   `agentProgressSummaries` on; else `description`), the child's
 *   `last_tool_name` independently, and running usage.
 * - The terminal arrives TWICE (station#1892): a `task_updated` whose patch
 *   carries the status (`completed`/`failed`/`killed`) and no result, then a
 *   `task_notification` (`completed`/`failed`/`stopped`) carrying the
 *   summary, the transcript `output_file` and usage. Both are emitted as
 *   settles; the contract's reducer keeps the first terminal and lets the
 *   second only fill what it lacked, so the result is not lost and nothing
 *   here has to remember which task already settled. The one exception is
 *   usage: the first settle carries none, so the child still holds its last
 *   `task_progress` figure, and the notification's final usage replaces it
 *   (#3308).
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
  /**
   * A child's own reply model/tool that arrived before its `task_started`,
   * keyed by the spawn or corroborated resume `tool_use_id`. Consumed by
   * `task_started`; bounded oldest first so unregistered replies can't pin memory.
   */
  pendingReplies: Map<string, Pick<ChildWorkItem, 'model' | 'latestTool'>>;
  /** Settled task id → observed top-level SendMessage call awaiting a start. */
  pendingResumes: Map<string, string>;
  /** Bounded replay history; API message ids can span multiple SDK frames. */
  seenReplyFrames: Set<string>;
  seenReplyTools: Set<string>;
  seenResumeCalls: Set<string>;
}

/** Bound on pending reply facts and corroborated resumes. */
const CLAUDE_PENDING_REPLIES_MAX = 64;
const CLAUDE_SEEN_IDENTITIES_MAX = 64;

/** The slice of the adapter's per-session record this module reads. */
export interface ClaudeChildWorkRecord {
  session: Pick<ProviderSession, 'threadId'>;
  activeTurnId?: string;
  /**
   * #3163: the CLAUDE_CONFIG_DIR this session's engine was spawned with
   * (absent: the server's own global config home). Subagent transcripts
   * live under it.
   */
  claudeConfigHome?: string;
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
    pendingReplies: new Map(),
    pendingResumes: new Map(),
    seenReplyFrames: new Set(),
    seenReplyTools: new Set(),
    seenResumeCalls: new Set(),
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

/** Admit each SDK frame/tool identity once within the bounded replay window. */
function rememberNewIdentity(seen: Set<string>, value: unknown): boolean {
  const id = nonEmpty(value);
  if (!id) return true;
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > CLAUDE_SEEN_IDENTITIES_MAX) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return true;
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
  const reply = message.tool_use_id
    ? state.pendingReplies.get(message.tool_use_id)
    : undefined;
  if (message.tool_use_id) state.pendingReplies.delete(message.tool_use_id);
  const resumeCall = state.pendingResumes.get(message.task_id);
  state.pendingResumes.delete(message.task_id);
  if (resumeCall) state.pendingReplies.delete(resumeCall);
  // #3163: an agent's transcript lives under the parent Claude session by
  // agent id (its task id). Only `local_agent` tasks have one; a shell task's
  // output is not a conversation. The contract drops a malformed ref.
  const sessionId = nonEmpty(message.session_id);
  const transcript =
    message.task_type === 'local_agent' && sessionId
      ? {
          kind: 'claude-subagent' as const,
          sessionId,
          agentId: message.task_id,
          ...(context.record.claudeConfigHome
            ? { configHome: context.record.claudeConfigHome }
            : {}),
        }
      : undefined;
  const item: ChildWorkItem = {
    producer: 'engine-subagent',
    reporterThreadId: context.record.session.threadId,
    childId,
    status: 'running',
    ...(Object.keys(parent).length > 0 ? { parent } : {}),
    ...(title ? { title } : {}),
    ...(kindLabel ? { kindLabel } : {}),
    ...reply,
    ...(transcript ? { transcript } : {}),
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

/**
 * The model a reply frame names, when it is a real model id. A
 * `<synthetic>` frame (an API error, an interruption) names none, so it can
 * never replace the child's real model.
 */
function replyModel(message: SDKAssistantMessage): string | undefined {
  const model = message.message?.model;
  return typeof model === 'string' && isReportableChildWorkModelId(model)
    ? model.trim()
    : undefined;
}

/**
 * #3163: an assistant frame produced INSIDE a subagent
 * (`parent_tool_use_id` is the tool call that spawned it). Its `model` is
 * that child's own model, whatever its agent definition or the Agent tool's
 * input chose. It is attributed by the spawning tool call, so a nested
 * subagent's reply sets the nested child's model, never its parent's or the
 * session's. A top-level SendMessage to a settled child identifies a pending
 * resume; other top-level frames contribute no child model or tool.
 *
 * Its `tool_use` blocks also name the child's own latest tool, independently
 * of its model and without copying tool inputs. A reply can beat its
 * `task_started`: these facts are held, bounded, until that task registers.
 */
export function observeClaudeSubagentReply(
  context: ClaudeChildWorkContext,
  message: SDKAssistantMessage,
): void {
  const state = stateOf(context.record);
  const toolUseId = message.parent_tool_use_id;
  if (state.closed) return;
  const content = message.message?.content;
  if (toolUseId === null) {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type !== 'tool_use' || block.name !== 'SendMessage') continue;
      if (!rememberNewIdentity(state.seenResumeCalls, block.id)) continue;
      const input = block.input;
      if (!input || typeof input !== 'object' || !('recipient' in input))
        continue;
      const taskId = nonEmpty(input.recipient);
      if (!taskId) continue;
      const existing = itemFor(
        context.record,
        childIdFor(context.record, taskId),
      );
      if (
        !existing ||
        existing.status === 'running' ||
        itemFor(context.record, `${taskId}:${block.id}`)
      )
        continue;
      const priorCall = state.pendingResumes.get(taskId);
      if (priorCall === block.id) continue;
      if (priorCall) state.pendingReplies.delete(priorCall);
      state.pendingResumes.delete(taskId);
      state.pendingResumes.set(taskId, block.id);
      if (state.pendingResumes.size > CLAUDE_PENDING_REPLIES_MAX) {
        const oldest = state.pendingResumes.keys().next().value;
        if (oldest !== undefined) {
          const call = state.pendingResumes.get(oldest);
          if (call) state.pendingReplies.delete(call);
          state.pendingResumes.delete(oldest);
        }
      }
    }
    return;
  }
  if (!toolUseId) return;
  if (!rememberNewIdentity(state.seenReplyFrames, message.uuid)) return;
  const id = replyModel(message);
  const model: ChildWorkModel | undefined = id
    ? { id, source: 'subagent-reply' }
    : undefined;
  let latestTool: string | undefined;
  let hasTools = false;
  let hasNewTools = false;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      hasTools = true;
      if (!rememberNewIdentity(state.seenReplyTools, block.id)) continue;
      hasNewTools = true;
      if (
        typeof block.name === 'string' &&
        isReportableChildWorkToolName(block.name)
      )
        latestTool = block.name.trim();
    }
  }
  if (hasTools && !hasNewTools) return;
  if (!model && !latestTool) return;
  const reply = {
    ...(model ? { model } : {}),
    ...(latestTool ? { latestTool } : {}),
  };
  const spawned = childWorkForReporter(
    state.registry,
    context.record.session.threadId,
  ).find(
    (item) =>
      item.producer === 'engine-subagent' &&
      item.parent?.toolCallId === toolUseId,
  );
  // A resumed agent keeps replying under its ORIGINAL spawn's tool call
  // (captured: `nested-agent`), so the reply belongs to that task's current
  // run, which is keyed by the resume's own call.
  const existing = spawned
    ? itemFor(
        context.record,
        childIdFor(context.record, taskIdOf(context.record, spawned.childId)),
      )
    : undefined;
  if (existing?.status !== 'running') {
    const resumeCall = existing
      ? state.pendingResumes.get(taskIdOf(context.record, existing.childId))
      : undefined;
    // A terminal reply alone is not evidence that the agent resumed.
    if (existing && !resumeCall) return;
    const pendingCall = resumeCall ?? toolUseId;
    const pending = state.pendingReplies.get(pendingCall);
    state.pendingReplies.delete(pendingCall);
    state.pendingReplies.set(pendingCall, { ...pending, ...reply });
    if (state.pendingReplies.size > CLAUDE_PENDING_REPLIES_MAX) {
      const oldest = state.pendingReplies.keys().next().value;
      if (oldest !== undefined) state.pendingReplies.delete(oldest);
    }
    return;
  }
  emit(context, { kind: 'upsert', item: { ...existing, ...reply } });
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
  const progress = nonEmpty(message.summary) ?? described;
  const latestTool =
    typeof message.last_tool_name === 'string' &&
    isReportableChildWorkToolName(message.last_tool_name)
      ? message.last_tool_name.trim()
      : undefined;
  const usage = readTaskUsage(message.usage);
  if (!progress && !latestTool && !usage) return;
  emit(context, {
    kind: 'upsert',
    // The title is the child's name, not its status: progress never
    // replaces it.
    item: {
      ...existing,
      ...(progress ? { progress } : {}),
      ...(latestTool ? { latestTool } : {}),
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
    ...(existing?.model ? { model: existing.model } : {}),
    ...(existing?.latestTool ? { latestTool: existing.latestTool } : {}),
    ...(existing?.transcript ? { transcript: existing.transcript } : {}),
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
  state.pendingReplies.clear();
  state.pendingResumes.clear();
  state.seenReplyFrames.clear();
  state.seenReplyTools.clear();
  state.seenResumeCalls.clear();
  return open.map((item) => taskIdOf(context.record, item.childId));
}
