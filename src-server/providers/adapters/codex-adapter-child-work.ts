import crypto from 'node:crypto';
import {
  applyChildWorkDelta,
  CHILD_WORK_SUMMARY_MAX_CHARS,
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

/**
 * Bounds on notifications held for threads no parent item has claimed: how
 * many threads, how many notifications each, and their total serialized size.
 * Past any of them the OLDEST go first — a child's outcome and latest usage
 * come last, and are what a late claim most needs.
 *
 * The real codex-cli 0.155.1 captures never NEED the hold: the only child
 * notification they show before the linking item is `thread/status/changed`,
 * which this mapper does not read. It exists because the protocol does not
 * order a child's stream against its parent's items, and it is proven on
 * reordered and synthetic streams only.
 */
const PENDING_THREADS_MAX = 16;
const PENDING_NOTIFICATIONS_PER_THREAD_MAX = 32;
/** UTF-8 bytes of serialized held notifications, across every thread. */
export const CODEX_CHILD_PENDING_BYTES_MAX = 256 * 1024;
/** Settled children still waiting on their own stream's end (see facts). */
export const SETTLED_AWAITING_OWN_TERMINAL_MAX = 64;
const TITLE_MAX_CHARS = 200;

interface CodexChildFacts {
  depth?: number;
  totalTokens?: number;
  lastAgentMessage?: string;
  stopRequested?: boolean;
  /**
   * The child's OWN stream has ended (`turn/completed` or `thread/closed`).
   * Until then a child the parent already reported settled keeps its facts
   * and its stream is still read: the reducer lets a later settle fill the
   * summary, tokens and duration the parent's report lacked.
   */
  ownTerminalSeen?: boolean;
  /**
   * #2486: the child's own currently-active turn id, from its own
   * `turn/started`. A client `turn/interrupt` targets a specific
   * {threadId, turnId} pair, so a per-child stop needs this — undefined
   * until the child's own stream has actually reported a turn starting
   * (registering a child from a `spawnAgent`/`subAgentActivity started`
   * item happens first and does not by itself carry a turn id). Cleared once
   * that turn's own `turn/completed` arrives.
   */
  activeTurnId?: string;
}

export interface CodexChildWorkState {
  registry: ChildWorkRegistryState;
  /**
   * child codex thread id → what the child's own stream has told us. Kept
   * only while the child runs or holds a CORRECTABLE terminal: once its
   * outcome is sticky the registry item carries everything, so its facts
   * are dropped (see `pruneFacts`).
   */
  children: Map<string, CodexChildFacts>;
  /** unclaimed codex thread id → its notifications, in arrival order. */
  pending: Map<string, HeldNotification[]>;
  /** Serialized UTF-8 size of everything in `pending`. */
  pendingBytes: number;
  /** Next arrival sequence number for a held notification. */
  pendingSeq: number;
  /** Set once the session has ended; nothing is mapped after that. */
  closed: boolean;
}

export interface CodexChildNotification {
  method: string;
  params?: unknown;
}

interface HeldNotification {
  notification: CodexChildNotification;
  bytes: number;
  /** Arrival order across ALL held threads, for oldest-first eviction. */
  seq: number;
}

export interface ChildWorkContext {
  record: CodexSessionRecord;
  nowIso: () => string;
  publish: (event: CanonicalRuntimeEvent) => void;
}

function stateOf(record: CodexSessionRecord): CodexChildWorkState {
  record.childWork ??= {
    registry: createEmptyChildWorkRegistry(),
    children: new Map(),
    pending: new Map(),
    pendingBytes: 0,
    pendingSeq: 0,
    closed: false,
  };
  return record.childWork;
}

/**
 * The Codex agent status vocabulary (`CollabAgentStatus`), as child work.
 * `running` means "not terminal"; everything unrecognised is `unresolved`,
 * never a success.
 */
function mapCodexCollabAgentStatus(
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
function mapCodexChildTurnStatus(status: unknown): ChildWorkTerminalStatus {
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
  pruneFacts(context.record);
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

/** A terminal no later observation can change (the reducer keeps it). */
function isStickyTerminal(item: ChildWorkItem | undefined): boolean {
  return (
    item !== undefined &&
    item.status !== 'running' &&
    item.status !== 'unresolved' &&
    item.status !== 'stopped-unconfirmed'
  );
}

/**
 * Drops the facts of every child whose item is gone (evicted, or never
 * accepted past the reducer's bound), or whose outcome is sticky AND whose
 * own stream has ended: nothing later can change or enrich it. A child the
 * parent settled before its own stream ended is kept, bounded: past
 * `SETTLED_AWAITING_OWN_TERMINAL_MAX` the oldest registered go first.
 */
function pruneFacts(record: CodexSessionRecord): void {
  const state = stateOf(record);
  const awaiting: string[] = [];
  for (const [childId, facts] of state.children) {
    const item = itemFor(record, childId);
    if (!item || (isStickyTerminal(item) && facts.ownTerminalSeen)) {
      state.children.delete(childId);
    } else if (isStickyTerminal(item)) {
      awaiting.push(childId);
    }
  }
  const excess = awaiting.length - SETTLED_AWAITING_OWN_TERMINAL_MAX;
  for (const childId of awaiting.slice(0, Math.max(0, excess))) {
    state.children.delete(childId);
  }
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
  const existing = itemFor(context.record, childId);
  if (isStickyTerminal(existing)) {
    // Settled for good: nothing to register, nothing held worth replaying.
    dropHeld(state, childId);
    return;
  }
  const facts = state.children.get(childId) ?? {};
  if (facts.depth === undefined && identity.depth !== undefined) {
    facts.depth = identity.depth;
  }
  state.children.set(childId, facts);
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
      // #2486 review: `stopProviderTask` needs the child's own active turn
      // id to target a `turn/interrupt` at — a control offered before that
      // arrives is a button `stopProviderTask` can only answer
      // `no-active-task`. Registration (this function, from spawnAgent/
      // subAgentActivity) almost never has it yet; `syncChildStopControl`
      // adds it the moment `turn/started` does (and removes it again on
      // settle) — stoppability is derived, never stamped at registration.
      ...(facts.activeTurnId !== undefined
        ? { controls: { stop: 'provider-task-stop' as const } }
        : {}),
      startedAt: context.nowIso(),
    };
    emit(context, {
      kind: 'snapshot',
      producer: 'engine-subagent',
      reporterThreadId: context.record.externalThreadId,
      running: [...runningChildren(context.record), item],
    });
    // Refused (the reducer's running bound): no item, so no facts either.
    pruneFacts(context.record);
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
    // A re-registration (e.g. a nested spawn's own identity arriving after
    // this child's turn/started already did) must not leave a stale item
    // without the control its known turn id now supports.
    syncChildStopControl(context, childId);
  }
  const held = dropHeld(state, childId);
  for (const { notification } of held) {
    handleKnownChildNotification(context, childId, notification);
  }
}

function dropHeld(
  state: CodexChildWorkState,
  threadId: string,
): HeldNotification[] {
  const held = state.pending.get(threadId) ?? [];
  state.pending.delete(threadId);
  for (const entry of held) state.pendingBytes -= entry.bytes;
  return held;
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
      // #2486 review: a settled child is never stoppable again — clear
      // `controls` rather than let it survive from the running item
      // (`mergeDefined`/`applyUpsert`'s own contract: an object VALUE here,
      // not `undefined`, is what overrides the prior one; `{}` has no
      // `.stop`, so `normalizeItem` drops the field entirely).
      controls: {},
    },
  });
  if (changed) emitSnapshot(context);
}

/**
 * #2486 review: `controls.stop` is derived from stoppability, never
 * stamped once and forgotten. A running child gets it the moment its own
 * `turn/started` supplies a `turn/interrupt` target (`facts.activeTurnId`);
 * called again after any later fact settles the item, this is a no-op
 * (`itemFor`'s status guard). Idempotent either way — skips the upsert
 * when the item already agrees.
 */
function syncChildStopControl(
  context: ChildWorkContext,
  childId: string,
): void {
  const existing = itemFor(context.record, childId);
  if (existing?.status !== 'running') return;
  const hasTarget =
    stateOf(context.record).children.get(childId)?.activeTurnId !== undefined;
  const hasControl = existing.controls?.stop === 'provider-task-stop';
  if (hasTarget === hasControl) return;
  emit(context, {
    kind: 'upsert',
    item: {
      ...existing,
      controls: hasTarget ? { stop: 'provider-task-stop' } : {},
    },
  });
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
function depthFromCodexAgentPath(path: unknown): number | undefined {
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
  const senderDepth =
    stateOf(record).children.get(senderThreadId)?.depth ??
    itemFor(record, senderThreadId)?.depth;
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

/**
 * #2486: also called directly from `codex-adapter.ts`'s `stopProviderTask`
 * right after it sends the child's own `turn/interrupt` RPC — the same
 * immediate "stop requested" feedback the MODEL-initiated `closeAgent`/
 * `interruptAgent`/`subAgentActivity interrupted` paths below already give,
 * now also for a CLIENT-initiated one. Never claims `cancelled`: only the
 * child's own later `turn/completed` does that (see `settleChild` callers).
 */
export function requestStop(context: ChildWorkContext, childId: string): void {
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
      (stateOf(context.record).children.has(parentThreadId) ||
        itemFor(context.record, parentThreadId) !== undefined));
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
  // A child whose outcome is already sticky: nothing it says can change it.
  if (itemFor(context.record, threadId)) return;
  const bytes = Buffer.byteLength(JSON.stringify(notification), 'utf8');
  if (bytes > CODEX_CHILD_PENDING_BYTES_MAX) return;
  let held = state.pending.get(threadId);
  if (!held) {
    if (state.pending.size >= PENDING_THREADS_MAX) {
      const oldest = state.pending.keys().next().value;
      if (oldest !== undefined) dropHeld(state, oldest);
    }
    held = [];
    state.pending.set(threadId, held);
  }
  if (held.length >= PENDING_NOTIFICATIONS_PER_THREAD_MAX) {
    const dropped = held.shift();
    if (dropped) state.pendingBytes -= dropped.bytes;
  }
  held.push({ notification, bytes, seq: state.pendingSeq++ });
  state.pendingBytes += bytes;
  // Total size: evict by GLOBAL arrival order. Each queue is in arrival
  // order, so the oldest held notification is the smallest queue head.
  while (state.pendingBytes > CODEX_CHILD_PENDING_BYTES_MAX) {
    let oldestThread: string | undefined;
    let oldestSeq = Number.POSITIVE_INFINITY;
    for (const [candidate, queue] of state.pending) {
      const head = queue[0];
      if (head && head.seq < oldestSeq) {
        oldestSeq = head.seq;
        oldestThread = candidate;
      }
    }
    if (oldestThread === undefined) break;
    const queue = state.pending.get(oldestThread) ?? [];
    const dropped = queue.shift();
    if (dropped) state.pendingBytes -= dropped.bytes;
    if (queue.length === 0) state.pending.delete(oldestThread);
  }
}

/**
 * #2486: the running child's own active turn id, the target a per-child
 * `turn/interrupt {threadId: childId, turnId}` needs. Undefined when the
 * child is not currently running (nothing to stop) or its own `turn/started`
 * has not yet arrived (nothing to target) — the caller must not guess.
 */
export function codexRunningChildTurnId(
  record: CodexSessionRecord,
  childId: string,
): string | undefined {
  if (itemFor(record, childId)?.status !== 'running') return undefined;
  return stateOf(record).children.get(childId)?.activeTurnId;
}

/**
 * #2486: every currently-running child this session has an active turn id
 * for, in the registry's own order — the set a cascading parent stop
 * interrupts before the parent. A child registered but not yet carrying a
 * turn id (see `codexRunningChildTurnId`) is omitted: there is nothing to
 * target for it yet.
 */
export function codexRunningChildTurns(
  record: CodexSessionRecord,
): { childId: string; turnId: string }[] {
  const state = stateOf(record);
  const turns: { childId: string; turnId: string }[] = [];
  for (const item of runningChildren(record)) {
    const turnId = state.children.get(item.childId)?.activeTurnId;
    if (turnId) turns.push({ childId: item.childId, turnId });
  }
  return turns;
}

/** Held notifications and their total size, for bound tests. */
export function codexChildHeldStats(record: CodexSessionRecord): {
  threads: number;
  notifications: number;
  bytes: number;
  facts: number;
} {
  const state = stateOf(record);
  let notifications = 0;
  for (const queue of state.pending.values()) notifications += queue.length;
  return {
    threads: state.pending.size,
    notifications,
    bytes: state.pendingBytes,
    facts: state.children.size,
  };
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
    case 'turn/started': {
      // #2486: the child's own turn id, the target a per-child
      // `turn/interrupt` needs. Not available from the parent item that
      // registered the child (spawnAgent/subAgentActivity carry no turn id
      // for the child it names).
      const turnId = isRecord(params.turn)
        ? extractString(params.turn.id)
        : null;
      if (turnId) {
        facts.activeTurnId = turnId;
        syncChildStopControl(context, childId);
      }
      return;
    }
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
        // One char past the contract bound, so the reducer still sees an
        // over-long summary and flags it truncated.
        if (text) {
          facts.lastAgentMessage = text.slice(
            0,
            CHILD_WORK_SUMMARY_MAX_CHARS + 1,
          );
        }
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
      // The child's own word: after this settle (or its enrichment of a
      // settle the parent already reported) its facts can go.
      facts.ownTerminalSeen = true;
      // #2486: this turn is over; a stop request must never target it again.
      facts.activeTurnId = undefined;
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
      pruneFacts(context.record);
      return;
    }
    case 'thread/closed': {
      facts.ownTerminalSeen = true;
      if (!isRunning(context.record, childId)) {
        // A stop was requested and the thread is now gone: the stop took.
        if (
          facts.stopRequested &&
          itemFor(context.record, childId)?.status === 'stopped-unconfirmed'
        ) {
          settleChild(context, childId, 'cancelled');
        }
        pruneFacts(context.record);
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
  state.children.clear();
  state.pending.clear();
  state.pendingBytes = 0;
  state.pendingSeq = 0;
  state.registry = createEmptyChildWorkRegistry();
}
