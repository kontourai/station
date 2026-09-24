import crypto from 'node:crypto';
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
import {
  extractString,
  extractTokenFigure,
  isRecord,
} from './codex-adapter-events.js';
import type { CodexSessionRecord } from './codex-adapter-types.js';

/**
 * #2458 (epic #2455): Codex subagents, mapped onto the child-work contract.
 *
 * What codex-cli 0.155.1 actually puts on the wire (live captures in
 * `__tests__/fixtures/codex-0.155.1-collab-*.jsonl`):
 *
 * - The PARENT thread reports its children as ThreadItems, in one of two
 *   formats chosen per model, so this branches on the observed item type and
 *   never on the model:
 *   - v1 `collabAgentToolCall` (`spawnAgent`, `wait`, `closeAgent`, ...) with
 *     `receiverThreadIds` and an `agentsStates` map;
 *   - v2 `subAgentActivity` (`started`/`interacted`/`interrupted`/
 *     `completed`) with `agentThreadId` and `agentPath`.
 * - Each CHILD is a thread of its own and streams its own notifications
 *   (`turn/started`, `item/*`, `thread/tokenUsage/updated`,
 *   `turn/completed`, `thread/closed`) over the parent's stdio. The transport
 *   routes those here — never into `handleCodexNotification`, whose
 *   `turn/completed` would close the PARENT's turn and whose usage would be
 *   counted as the parent's.
 * - A child's first notification arrives BEFORE the parent item that names
 *   it, so notifications for a thread nobody has claimed yet are held
 *   (bounded) and replayed when a parent item claims it.
 *
 * Terminal status comes only from facts about the child's outcome: its own
 * `turn/completed` or `thread/closed`, a `wait` result's `agentsStates`, or
 * a v2 `completed` activity. `closeAgent`/`interruptAgent` results ECHO the
 * child's previous status by design (core `interrupt_spawned_agent`), so
 * their `agentsStates` are never read; the call itself only records that a
 * stop was requested (`stopped-unconfirmed`, correctable by the real
 * outcome). Nothing defaults to success.
 *
 * Deltas are folded into a per-session registry here with the contract's own
 * reducer, and only a delta that changes it is published, so the adapter's
 * running set is exactly what every consumer folds.
 */

/** Child notification methods the mapper reads; nothing else is buffered. */
const CHILD_METHODS = new Set([
  'turn/started',
  'turn/completed',
  'thread/tokenUsage/updated',
  'thread/closed',
  'item/started',
  'item/completed',
]);

/** Bounds on notifications held for threads no parent item has claimed. */
const PENDING_THREADS_MAX = 16;
const PENDING_NOTIFICATIONS_PER_THREAD_MAX = 32;
const TITLE_MAX_CHARS = 200;

interface CodexChildFacts {
  depth?: number;
  totalTokens?: number;
  lastAgentMessage?: string;
  stopRequested?: boolean;
}

export interface CodexChildWorkState {
  registry: ChildWorkRegistryState;
  /** child codex thread id → what the child's own stream has told us. */
  children: Map<string, CodexChildFacts>;
  /** unclaimed codex thread id → its notifications, in arrival order. */
  pending: Map<string, CodexChildNotification[]>;
  /** Set once the session has ended; nothing is mapped after that. */
  closed: boolean;
}

export interface CodexChildNotification {
  method: string;
  params?: unknown;
}

interface ChildWorkContext {
  record: CodexSessionRecord;
  nowIso: () => string;
  publish: (event: CanonicalRuntimeEvent) => void;
}

function stateOf(record: CodexSessionRecord): CodexChildWorkState {
  record.childWork ??= {
    registry: createEmptyChildWorkRegistry(),
    children: new Map(),
    pending: new Map(),
    closed: false,
  };
  return record.childWork;
}

/**
 * The Codex agent status vocabulary (`CollabAgentStatus`), as child work.
 * `running` means "not terminal"; everything unrecognised is `unresolved`,
 * never a success.
 */
export function mapCodexCollabAgentStatus(
  status: unknown,
): 'running' | ChildWorkTerminalStatus {
  switch (status) {
    case 'pendingInit':
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'errored':
      return 'failed';
    case 'interrupted':
    case 'shutdown':
      return 'cancelled';
    default:
      // `notFound`, and any status this build does not know.
      return 'unresolved';
  }
}

/** A child's own `turn/completed` `turn.status`, as child work. */
export function mapCodexChildTurnStatus(
  status: unknown,
): ChildWorkTerminalStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'interrupted':
      return 'cancelled';
    default:
      return 'unresolved';
  }
}

function emit(context: ChildWorkContext, delta: ChildWorkDelta): boolean {
  const state = stateOf(context.record);
  const next = applyChildWorkDelta(state.registry, delta);
  if (next === state.registry) return false;
  state.registry = next;
  context.publish({
    eventId: crypto.randomUUID(),
    provider: 'codex',
    threadId: context.record.externalThreadId,
    createdAt: context.nowIso(),
    method: 'child-work.updated',
    delta,
  });
  return true;
}

function runningChildren(record: CodexSessionRecord): ChildWorkItem[] {
  return childWorkForReporter(
    stateOf(record).registry,
    record.externalThreadId,
  ).filter(
    (item) => item.producer === 'engine-subagent' && item.status === 'running',
  );
}

function emitSnapshot(context: ChildWorkContext): void {
  emit(context, {
    kind: 'snapshot',
    producer: 'engine-subagent',
    reporterThreadId: context.record.externalThreadId,
    running: runningChildren(context.record),
  });
}

function itemFor(
  record: CodexSessionRecord,
  childId: string,
): ChildWorkItem | undefined {
  return childWorkForReporter(
    stateOf(record).registry,
    record.externalThreadId,
  ).find(
    (item) => item.producer === 'engine-subagent' && item.childId === childId,
  );
}

function isRunning(record: CodexSessionRecord, childId: string): boolean {
  return itemFor(record, childId)?.status === 'running';
}

interface ChildIdentity {
  parent?: ChildWorkParent;
  depth?: number;
  title?: string;
  kindLabel?: string;
}

/**
 * Registers `childId` as running (a snapshot listing it), then replays any
 * notifications its thread sent before this claim. A child already known is
 * only enriched with identity it lacked; a settled one is never revived.
 */
function registerChild(
  context: ChildWorkContext,
  childId: string,
  identity: ChildIdentity,
): void {
  const state = stateOf(context.record);
  if (state.closed) return;
  const facts = state.children.get(childId) ?? {};
  if (facts.depth === undefined && identity.depth !== undefined) {
    facts.depth = identity.depth;
  }
  state.children.set(childId, facts);
  const existing = itemFor(context.record, childId);
  if (!existing) {
    const item: ChildWorkItem = {
      producer: 'engine-subagent',
      reporterThreadId: context.record.externalThreadId,
      childId,
      status: 'running',
      ...(identity.parent ? { parent: identity.parent } : {}),
      ...(facts.depth !== undefined ? { depth: facts.depth } : {}),
      ...(identity.title ? { title: identity.title } : {}),
      ...(identity.kindLabel ? { kindLabel: identity.kindLabel } : {}),
      startedAt: context.nowIso(),
    };
    emit(context, {
      kind: 'snapshot',
      producer: 'engine-subagent',
      reporterThreadId: context.record.externalThreadId,
      running: [...runningChildren(context.record), item],
    });
  } else if (existing.status === 'running') {
    const missing: Partial<ChildWorkItem> = {};
    if (!existing.parent && identity.parent) missing.parent = identity.parent;
    if (existing.depth === undefined && facts.depth !== undefined) {
      missing.depth = facts.depth;
    }
    if (!existing.title && identity.title) missing.title = identity.title;
    if (!existing.kindLabel && identity.kindLabel) {
      missing.kindLabel = identity.kindLabel;
    }
    if (Object.keys(missing).length > 0) {
      emit(context, { kind: 'upsert', item: { ...existing, ...missing } });
    }
  }
  const held = state.pending.get(childId);
  if (held) {
    state.pending.delete(childId);
    for (const notification of held) {
      handleKnownChildNotification(context, childId, notification);
    }
  }
}

function settleChild(
  context: ChildWorkContext,
  childId: string,
  status: ChildWorkTerminalStatus,
  extra: { summary?: string; durationMs?: number } = {},
): void {
  const state = stateOf(context.record);
  if (state.closed) return;
  const facts = state.children.get(childId) ?? {};
  const usage: ChildWorkUsage = {
    ...(facts.totalTokens !== undefined
      ? { totalTokens: facts.totalTokens }
      : {}),
    ...(extra.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
  };
  const result: ChildWorkResult | undefined = extra.summary
    ? { summary: extra.summary }
    : undefined;
  const changed = emit(context, {
    kind: 'settle',
    producer: 'engine-subagent',
    reporterThreadId: context.record.externalThreadId,
    childId,
    status,
    ...(result ? { result } : {}),
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
    identity: {
      endedAt: context.nowIso(),
      ...(facts.depth !== undefined ? { depth: facts.depth } : {}),
    },
  });
  if (changed) emitSnapshot(context);
}

function titleFrom(value: unknown): string | undefined {
  const text = extractString(value)?.trim();
  if (!text) return undefined;
  const firstLine = text.split('\n')[0].trim();
  return firstLine.length > TITLE_MAX_CHARS
    ? `${firstLine.slice(0, TITLE_MAX_CHARS - 1)}…`
    : firstLine;
}

/**
 * v2 `agentPath` is `/root/<name>` for a top-level child, one more segment
 * per level below it. Anything not rooted at `root` has no depth.
 */
export function depthFromCodexAgentPath(path: unknown): number | undefined {
  const segments = (extractString(path) ?? '').split('/').filter(Boolean);
  if (segments[0] !== 'root' || segments.length < 2) return undefined;
  return segments.length - 1;
}

/**
 * The depth of a child spawned by `senderThreadId`: 1 under the session's
 * own thread, one below a known child, unknown otherwise.
 */
function depthUnder(
  record: CodexSessionRecord,
  senderThreadId: string | null,
): number | undefined {
  if (!senderThreadId) return undefined;
  if (senderThreadId === record.codexThreadId) return 1;
  const senderDepth = stateOf(record).children.get(senderThreadId)?.depth;
  return senderDepth !== undefined ? senderDepth + 1 : undefined;
}

function parentFor(
  record: CodexSessionRecord,
  reportingThreadId: string,
  turnId: string | null,
  toolCallId: string | null,
): ChildWorkParent | undefined {
  const parent: ChildWorkParent = {};
  if (reportingThreadId === record.codexThreadId) {
    if (turnId) parent.turnId = turnId;
  } else {
    // Spawned by a child: name that child as the producer names it.
    parent.taskId = reportingThreadId;
  }
  if (toolCallId) parent.toolCallId = toolCallId;
  return Object.keys(parent).length > 0 ? parent : undefined;
}

/**
 * A `collabAgentToolCall` or `subAgentActivity` ThreadItem, reported by
 * `reportingThreadId` (the session's own thread, or a child's for a nested
 * spawn). Returns true when the item was a subagent item, so the caller does
 * not also treat it as a tool call.
 */
export function observeCodexSubagentItem(
  context: ChildWorkContext,
  params: { item: Record<string, unknown>; turnId: string | null },
  phase: 'started' | 'completed',
  reportingThreadId: string,
): boolean {
  const { item, turnId } = params;
  if (stateOf(context.record).closed) {
    return (
      item.type === 'collabAgentToolCall' || item.type === 'subAgentActivity'
    );
  }
  if (item.type === 'subAgentActivity') {
    observeSubAgentActivity(context, item, turnId, reportingThreadId);
    return true;
  }
  if (item.type !== 'collabAgentToolCall') return false;
  // A call's outcome is only known once it completes; `spawnAgent` names
  // its receiver only then.
  if (phase !== 'completed') return true;
  const tool = extractString(item.tool);
  const toolCallId = extractString(item.id);
  const senderThreadId =
    extractString(item.senderThreadId) ?? reportingThreadId;
  const receivers = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      )
    : [];
  const agentsStates = isRecord(item.agentsStates) ? item.agentsStates : {};
  switch (tool) {
    case 'spawnAgent': {
      const model = extractString(item.model);
      for (const childId of receivers) {
        registerChild(context, childId, {
          parent: parentFor(
            context.record,
            reportingThreadId,
            turnId,
            toolCallId,
          ),
          depth: depthUnder(context.record, senderThreadId),
          title: titleFrom(item.prompt),
          ...(model ? { kindLabel: model } : {}),
        });
        // The spawn result's state is the child's CURRENT state (normally
        // `pendingInit`), unlike a close/interrupt echo.
        applyAgentState(context, childId, agentsStates[childId]);
      }
      return true;
    }
    case 'wait': {
      for (const [childId, agentState] of Object.entries(agentsStates)) {
        if (!itemFor(context.record, childId)) {
          registerChild(context, childId, {
            depth: depthUnder(context.record, senderThreadId),
          });
        }
        applyAgentState(context, childId, agentState);
      }
      return true;
    }
    case 'closeAgent':
    case 'interruptAgent': {
      // The result's `agentsStates` is the child's PREVIOUS status, echoed
      // by design: never read it. A completed call is only a stop REQUEST.
      if (extractString(item.status) !== 'completed') return true;
      for (const childId of receivers) requestStop(context, childId);
      return true;
    }
    default:
      // sendInput / resumeAgent / sendMessage / followupTask / listAgents
      // carry no fact about a child's outcome that this maps.
      return true;
  }
}

function applyAgentState(
  context: ChildWorkContext,
  childId: string,
  agentState: unknown,
): void {
  if (!isRecord(agentState)) return;
  const status = mapCodexCollabAgentStatus(agentState.status);
  if (status === 'running') return;
  const message = extractString(agentState.message) ?? undefined;
  if (
    agentState.status === 'shutdown' &&
    itemFor(context.record, childId)?.status !== 'running' &&
    !stateOf(context.record).children.get(childId)?.stopRequested
  ) {
    // An outcome was already observed; a shutdown only restates the end.
    return;
  }
  settleChild(context, childId, status, message ? { summary: message } : {});
}

function requestStop(context: ChildWorkContext, childId: string): void {
  const facts = stateOf(context.record).children.get(childId);
  if (facts) facts.stopRequested = true;
  if (!isRunning(context.record, childId)) return;
  settleChild(context, childId, 'stopped-unconfirmed');
}

function observeSubAgentActivity(
  context: ChildWorkContext,
  item: Record<string, unknown>,
  turnId: string | null,
  reportingThreadId: string,
): void {
  const childId = extractString(item.agentThreadId);
  if (!childId) return;
  const kind = extractString(item.kind);
  const agentPath = extractString(item.agentPath);
  const name = agentPath?.split('/').filter(Boolean).at(-1);
  registerChild(context, childId, {
    parent: parentFor(
      context.record,
      reportingThreadId,
      turnId,
      kind === 'started' ? extractString(item.id) : null,
    ),
    depth: depthFromCodexAgentPath(agentPath),
    ...(name ? { title: name } : {}),
  });
  if (kind === 'completed') {
    settleChild(context, childId, 'completed');
  } else if (kind === 'interrupted') {
    requestStop(context, childId);
  }
  // `started` registered above; `interacted` changes nothing mapped here.
}

/**
 * `thread/started` for a thread whose `source` says a subagent spawned it
 * (`source.subAgent.thread_spawn`). Not seen in the 0.155.1 captures, but
 * it is the earliest signal when it does arrive, so it registers the child.
 * Returns false for any other thread.
 */
export function observeCodexThreadStarted(
  context: ChildWorkContext,
  params: unknown,
): boolean {
  if (!isRecord(params) || !isRecord(params.thread)) return false;
  const thread = params.thread;
  const childId = extractString(thread.id);
  const source = isRecord(thread.source) ? thread.source : undefined;
  const subAgent = isRecord(source?.subAgent) ? source.subAgent : undefined;
  const spawn = isRecord(subAgent?.thread_spawn)
    ? subAgent.thread_spawn
    : isRecord(subAgent?.threadSpawn)
      ? subAgent.threadSpawn
      : undefined;
  if (!childId || !spawn || childId === context.record.codexThreadId) {
    return false;
  }
  const parentThreadId =
    extractString(spawn.parent_thread_id) ??
    extractString(spawn.parentThreadId);
  const known =
    parentThreadId === context.record.codexThreadId ||
    (parentThreadId !== null &&
      stateOf(context.record).children.has(parentThreadId));
  if (!known || parentThreadId === null) return false;
  const depth = extractTokenFigure(spawn.depth);
  const agentPath =
    extractString(spawn.agent_path) ?? extractString(spawn.agentPath);
  const nickname =
    extractString(spawn.agent_nickname) ?? extractString(spawn.agentNickname);
  const role =
    extractString(spawn.agent_role) ?? extractString(spawn.agentRole);
  registerChild(context, childId, {
    ...(parentThreadId !== context.record.codexThreadId
      ? { parent: { taskId: parentThreadId } }
      : {}),
    depth:
      depth !== null && depth > 0
        ? depth
        : (depthFromCodexAgentPath(agentPath) ??
          depthUnder(context.record, parentThreadId)),
    ...(nickname || agentPath
      ? { title: nickname ?? agentPath?.split('/').at(-1) }
      : {}),
    ...(role ? { kindLabel: role } : {}),
  });
  return true;
}

/**
 * A notification carrying a `threadId` that is not the session's own: a
 * child's stream. Mapped when the child is known, held (bounded) until a
 * parent item claims the thread otherwise. Never publishes a turn, session,
 * tool or usage event.
 */
export function routeCodexChildNotification(
  context: ChildWorkContext,
  threadId: string,
  notification: CodexChildNotification,
): void {
  const state = stateOf(context.record);
  if (state.closed || context.record.stopped) return;
  if (threadId === context.record.codexThreadId) return;
  if (!CHILD_METHODS.has(notification.method)) return;
  if (state.children.has(threadId)) {
    handleKnownChildNotification(context, threadId, notification);
    return;
  }
  let held = state.pending.get(threadId);
  if (!held) {
    if (state.pending.size >= PENDING_THREADS_MAX) {
      const oldest = state.pending.keys().next().value;
      if (oldest !== undefined) state.pending.delete(oldest);
    }
    held = [];
    state.pending.set(threadId, held);
  }
  // Past the bound the OLDEST goes: a child's outcome (`turn/completed`) and
  // latest usage come last, and are what a late claim most needs.
  if (held.length >= PENDING_NOTIFICATIONS_PER_THREAD_MAX) held.shift();
  held.push(notification);
}

function handleKnownChildNotification(
  context: ChildWorkContext,
  childId: string,
  notification: CodexChildNotification,
): void {
  const facts = stateOf(context.record).children.get(childId);
  if (!facts || !isRecord(notification.params)) return;
  const params = notification.params;
  switch (notification.method) {
    case 'thread/tokenUsage/updated': {
      const tokenUsage = isRecord(params.tokenUsage)
        ? params.tokenUsage
        : undefined;
      const total = isRecord(tokenUsage?.total) ? tokenUsage.total : undefined;
      const totalTokens = extractTokenFigure(total?.totalTokens);
      if (totalTokens === null) return;
      facts.totalTokens = totalTokens;
      const existing = itemFor(context.record, childId);
      if (existing?.status === 'running') {
        emit(context, {
          kind: 'upsert',
          item: { ...existing, usage: { ...existing.usage, totalTokens } },
        });
      }
      return;
    }
    case 'item/started':
    case 'item/completed': {
      if (!isRecord(params.item)) return;
      const item = params.item;
      if (
        notification.method === 'item/completed' &&
        item.type === 'agentMessage'
      ) {
        const text = extractString(item.text);
        if (text) facts.lastAgentMessage = text;
        return;
      }
      // A nested spawn, reported on the child's own stream.
      observeCodexSubagentItem(
        context,
        { item, turnId: extractString(params.turnId) },
        notification.method === 'item/started' ? 'started' : 'completed',
        childId,
      );
      return;
    }
    case 'turn/completed': {
      if (!isRecord(params.turn)) return;
      const turn = params.turn;
      const status = mapCodexChildTurnStatus(turn.status);
      const durationMs = extractTokenFigure(turn.durationMs) ?? undefined;
      const summary =
        status === 'failed'
          ? (extractString(isRecord(turn.error) ? turn.error.message : null) ??
            undefined)
          : status === 'completed'
            ? (finalAgentMessage(turn.items) ?? facts.lastAgentMessage)
            : undefined;
      settleChild(context, childId, status, {
        ...(summary ? { summary } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
      return;
    }
    case 'thread/closed': {
      if (!isRunning(context.record, childId)) {
        // A stop was requested and the thread is now gone: the stop took.
        if (
          facts.stopRequested &&
          itemFor(context.record, childId)?.status === 'stopped-unconfirmed'
        ) {
          settleChild(context, childId, 'cancelled');
        }
        return;
      }
      settleChild(
        context,
        childId,
        facts.stopRequested ? 'cancelled' : 'unresolved',
      );
      return;
    }
    default:
      // `turn/started` needs no mapping: the child is already running.
      return;
  }
}

/** The turn's final answer: a `final_answer` agentMessage, else the last one. */
function finalAgentMessage(items: unknown): string | undefined {
  if (!Array.isArray(items)) return undefined;
  const messages = items.filter(
    (item): item is Record<string, unknown> =>
      isRecord(item) &&
      item.type === 'agentMessage' &&
      typeof item.text === 'string' &&
      item.text.length > 0,
  );
  const finalAnswers = messages.filter((item) => item.phase === 'final_answer');
  const final = finalAnswers.at(-1) ?? messages.at(-1);
  return final ? (final.text as string) : undefined;
}

/**
 * Session end: every child still running can no longer report, so it settles
 * `unresolved` (nothing observed says how it ended). Called beside
 * `settleUnresolvedCodexToolCalls`, before `session.exited`. Idempotent.
 */
export function settleOpenCodexChildren(context: ChildWorkContext): void {
  const state = context.record.childWork;
  if (!state || state.closed) return;
  for (const item of runningChildren(context.record)) {
    settleChild(context, item.childId, 'unresolved');
  }
  state.closed = true;
  state.pending.clear();
}
