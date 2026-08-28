// station#1301 — "Background tasks" Running/Finished projection folded
// client-side from events already streaming (design plan on issue #1301).
// Same module-scope external-store shape as `active-chats-store`
// (subscribe/getSnapshot/notify), split into pure fold functions (this file)
// so the fold logic is unit-testable without a React tree.
//
// Card lifecycle (exact events — see the #1301 plan §2/§3):
// - Tool/Shell card (kind 'tool', chat's own threadId): opened by
//   `tool.started`, detail refreshed by `tool.progress`, closed by
//   `tool.completed`. Safety net: `turn.completed`/`turn.aborted`/
//   `session.exited` on that thread closes any still-open tool cards as
//   Stopped (a tool that never got its own `tool.completed`).
// - Agent/Delegate card (kind 'agent', delegate threadId bound via
//   `metadata.taskId === threadId` + `metadata.parentTaskId`): opened by the
//   bind event (`session.started`/`session.configured`) or the delegate's own
//   `turn.started` (title from the prompt's first line), closed by
//   `turn.completed` (Completed), `turn.aborted` (Stopped),
//   `session.exited`/`runtime.error` (Stopped/Failed).
// - Provider background subagent card (Claude Code backgrounded Task): NOT
//   folded here — merged at selector level from the existing
//   `ChatUIState.backgroundTasks` registry (`selectChatBackgroundTasks`),
//   deduped by `toolCallId` (a provider task suppresses the raw tool card it
//   was spawned from).
import type { OrchestrationDelegationContext } from '@kontourai/station-contracts/orchestration';
import type {
  OrchestrationEvent,
  OrchestrationSnapshotPayload,
} from '../hooks/orchestration/types';
import type { ChatBackgroundTask } from './active-chats-state';

export type BackgroundTaskKind = 'tool' | 'agent';
export type BackgroundTaskSource =
  | 'tool-event'
  | 'delegate-session'
  | 'provider-task';
export type BackgroundTaskState =
  | 'running'
  | 'completed'
  | 'stopped'
  | 'failed';

export interface BackgroundTaskEntry {
  /** toolCallId | delegate threadId | provider taskId — already globally unique. */
  id: string;
  kind: BackgroundTaskKind;
  source: BackgroundTaskSource;
  chatThreadId: string;
  title: string;
  detail?: string;
  startedAt: number;
  endedAt?: number;
  state: BackgroundTaskState;
  /** Transcript link for an agent/delegate card. */
  delegateThreadId?: string;
  /** A task-scoped stop seam that the UI may safely expose. */
  stop?: { kind: 'delegate-interrupt' | 'turn-interrupt' };
}

export interface BackgroundTasksState {
  entries: Record<string, BackgroundTaskEntry>;
  /** delegate threadId (taskId) -> parent chat threadId. */
  delegateParents: Record<string, string>;
}

/** Finished list is bounded per chat, drop-oldest (by end time), per the plan §3. */
export const FINISHED_LIMIT_PER_CHAT = 50;

export function createEmptyBackgroundTasksState(): BackgroundTasksState {
  return { entries: {}, delegateParents: {} };
}

function parseTime(iso: string | undefined, fallback: number): number {
  if (!iso) return fallback;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function metaString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function firstLine(text: string | undefined, limit = 80): string | undefined {
  if (!text) return undefined;
  const line = text.split('\n')[0]?.trim();
  if (!line) return undefined;
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** Bounds a chat's finished list, dropping the oldest-ended entries first. */
function pruneFinished(
  entries: Record<string, BackgroundTaskEntry>,
  chatThreadId: string,
): Record<string, BackgroundTaskEntry> {
  const finishedIds = Object.values(entries)
    .filter((entry) => entry.chatThreadId === chatThreadId)
    .filter((entry) => entry.state !== 'running')
    .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt))
    .map((entry) => entry.id);
  const excess = finishedIds.length - FINISHED_LIMIT_PER_CHAT;
  if (excess <= 0) return entries;
  const next = { ...entries };
  for (let i = 0; i < excess; i++) {
    delete next[finishedIds[i]];
  }
  return next;
}

function foldToolStarted(
  state: BackgroundTasksState,
  event: Extract<OrchestrationEvent, { method: 'tool.started' }>,
): BackgroundTasksState {
  const args =
    event.arguments && typeof event.arguments === 'object'
      ? (event.arguments as Record<string, unknown>)
      : undefined;
  const description =
    typeof args?.description === 'string' ? args.description : undefined;
  const entry: BackgroundTaskEntry = {
    id: event.toolCallId,
    kind: 'tool',
    source: 'tool-event',
    chatThreadId: event.threadId,
    title: description || event.toolName,
    startedAt: parseTime(event.createdAt, Date.now()),
    state: 'running',
  };
  return { ...state, entries: { ...state.entries, [entry.id]: entry } };
}

function foldToolProgress(
  state: BackgroundTasksState,
  event: Extract<OrchestrationEvent, { method: 'tool.progress' }>,
): BackgroundTasksState {
  const existing = state.entries[event.toolCallId];
  if (existing?.state !== 'running') return state;
  if (existing.detail === event.message) return state;
  return {
    ...state,
    entries: {
      ...state.entries,
      [existing.id]: { ...existing, detail: event.message },
    },
  };
}

function foldToolCompleted(
  state: BackgroundTasksState,
  event: Extract<OrchestrationEvent, { method: 'tool.completed' }>,
): BackgroundTasksState {
  const existing = state.entries[event.toolCallId];
  if (existing?.state !== 'running') return state;
  const nextState: BackgroundTaskState =
    event.status === 'success'
      ? 'completed'
      : event.status === 'cancelled'
        ? 'stopped'
        : 'failed';
  const endedAt = parseTime(event.createdAt, Date.now());
  const entries = {
    ...state.entries,
    [existing.id]: { ...existing, state: nextState, endedAt },
  };
  return { ...state, entries: pruneFinished(entries, existing.chatThreadId) };
}

/** Turn-terminal safety net: closes any still-open TOOL cards on `threadId` as Stopped. */
function closeOrphanedToolCards(
  state: BackgroundTasksState,
  threadId: string,
  atIso: string | undefined,
): BackgroundTasksState {
  const orphans = Object.values(state.entries).filter(
    (entry) =>
      entry.kind === 'tool' &&
      entry.chatThreadId === threadId &&
      entry.state === 'running',
  );
  if (orphans.length === 0) return state;
  const endedAt = parseTime(atIso, Date.now());
  const entries = { ...state.entries };
  for (const orphan of orphans) {
    entries[orphan.id] = { ...orphan, state: 'stopped', endedAt };
  }
  return { ...state, entries: pruneFinished(entries, threadId) };
}

/**
 * Bind seam: `session.started`/`session.configured` carrying
 * `metadata.taskId === threadId` (this IS the delegate's own thread) and
 * `metadata.parentTaskId` (the calling chat, auto-stamped server-side for the
 * built-in assistant path — `mcp-manager.ts`). Opens the agent card at bind
 * time; `foldDelegateTurnStarted` refines the title once the prompt is known.
 */
function foldSessionLifecycle(
  state: BackgroundTasksState,
  event: Extract<
    OrchestrationEvent,
    { method: 'session.started' | 'session.configured' }
  >,
): BackgroundTasksState {
  const metadata =
    event.metadata && typeof event.metadata === 'object'
      ? (event.metadata as Record<string, unknown>)
      : undefined;
  const taskId = metaString(metadata, 'taskId');
  const parentTaskId = metaString(metadata, 'parentTaskId');
  if (!taskId || taskId !== event.threadId || !parentTaskId) return state;

  const alreadyBound = state.delegateParents[taskId] === parentTaskId;
  const existing = state.entries[taskId];
  if (alreadyBound && existing) return state;

  const delegateParents = alreadyBound
    ? state.delegateParents
    : { ...state.delegateParents, [taskId]: parentTaskId };

  if (existing) {
    return { ...state, delegateParents };
  }

  const entry: BackgroundTaskEntry = {
    id: taskId,
    kind: 'agent',
    source: 'delegate-session',
    chatThreadId: parentTaskId,
    delegateThreadId: taskId,
    stop: { kind: 'delegate-interrupt' },
    title: 'Delegated task',
    startedAt: parseTime(event.createdAt, Date.now()),
    state: 'running',
  };
  return {
    ...state,
    delegateParents,
    entries: { ...state.entries, [taskId]: entry },
  };
}

function foldDelegateTurnStarted(
  state: BackgroundTasksState,
  event: Extract<OrchestrationEvent, { method: 'turn.started' }>,
): BackgroundTasksState {
  const existing = state.entries[event.threadId];
  const parentTaskId = state.delegateParents[event.threadId];
  const isKnownDelegate =
    Boolean(parentTaskId) || existing?.source === 'delegate-session';
  if (!isKnownDelegate) return state;

  const title = firstLine(event.prompt) ?? existing?.title ?? 'Delegated task';
  if (existing) {
    if (existing.state === 'running' && existing.title === title) return state;
    const reopened = existing.state !== 'running';
    return {
      ...state,
      entries: {
        ...state.entries,
        [existing.id]: {
          ...existing,
          title,
          ...(reopened
            ? {
                state: 'running' as const,
                startedAt: parseTime(event.createdAt, Date.now()),
                endedAt: undefined,
                stop: { kind: 'delegate-interrupt' as const },
              }
            : {}),
        },
      },
    };
  }

  // Bind event was missed this connection (e.g. a fresh reconnect) but the
  // snapshot already recorded the parent binding — open the card now.
  const entry: BackgroundTaskEntry = {
    id: event.threadId,
    kind: 'agent',
    source: 'delegate-session',
    chatThreadId: parentTaskId!,
    delegateThreadId: event.threadId,
    stop: { kind: 'delegate-interrupt' },
    title,
    startedAt: parseTime(event.createdAt, Date.now()),
    state: 'running',
  };
  return { ...state, entries: { ...state.entries, [entry.id]: entry } };
}

function closeDelegate(
  state: BackgroundTasksState,
  threadId: string,
  atIso: string | undefined,
  outcome: BackgroundTaskState,
): BackgroundTasksState {
  const existing = state.entries[threadId];
  if (existing?.source !== 'delegate-session' || existing.state !== 'running') {
    return state;
  }
  const endedAt = parseTime(atIso, Date.now());
  const entries = {
    ...state.entries,
    [threadId]: { ...existing, state: outcome, endedAt },
  };
  return { ...state, entries: pruneFinished(entries, existing.chatThreadId) };
}

/**
 * Live-ingest fold — the seam called from `eventHandlers.ts` BEFORE the
 * `if (!chat) return` guard so delegate-thread events (never opened as a
 * chat) still reach this registry. Cheap method-switch; `content.*-delta`
 * (the highest-frequency events in the stream) exits before any other work,
 * and every branch returns the identical `state` reference on a no-op so the
 * store's `commit` can skip notifying subscribers — no render churn from
 * folding events a chat's UI doesn't otherwise care about.
 */
export function ingestBackgroundTaskEvent(
  state: BackgroundTasksState,
  event: OrchestrationEvent,
): BackgroundTasksState {
  switch (event.method) {
    case 'content.text-delta':
    case 'content.reasoning-delta':
      return state;
    case 'tool.started':
      return foldToolStarted(state, event);
    case 'tool.progress':
      return foldToolProgress(state, event);
    case 'tool.completed':
      return foldToolCompleted(state, event);
    case 'session.started':
    case 'session.configured':
      return foldSessionLifecycle(state, event);
    case 'turn.started':
      return foldDelegateTurnStarted(state, event);
    // Tool safety net (all three) + delegate close, per the plan's exact
    // status mapping — merged into one branch (rather than one per method)
    // to keep this switch's minified footprint down; DELEGATE_TERMINAL_OUTCOME
    // carries the one difference between them.
    case 'turn.completed':
    case 'turn.aborted':
    case 'session.exited': {
      const next = closeOrphanedToolCards(
        state,
        event.threadId,
        event.createdAt,
      );
      return closeDelegate(
        next,
        event.threadId,
        event.createdAt,
        DELEGATE_TERMINAL_OUTCOME[event.method],
      );
    }
    case 'runtime.error':
      return closeDelegate(state, event.threadId, event.createdAt, 'failed');
    default:
      return state;
  }
}

const DELEGATE_TERMINAL_OUTCOME: Record<
  'turn.completed' | 'turn.aborted' | 'session.exited',
  BackgroundTaskState
> = {
  'turn.completed': 'completed',
  'turn.aborted': 'stopped',
  'session.exited': 'stopped',
};

function snapshotSessionDelegateThreadId(session: {
  threadId: string;
  delegation?: OrchestrationDelegationContext;
}): string {
  return session.delegation?.taskId ?? session.threadId;
}

/**
 * Snapshot reconciliation — seeds/reconciles delegate bindings and terminal
 * states from the connect-time (or reconnect-fallback) `orchestration:snapshot`
 * frame. Per the plan's risk note: a snapshot's `hasActiveTurn === false`
 * demotes a delegate this client still shows as running (server restarted, or
 * this client missed the terminal event) rather than leaving a phantom
 * "running" card forever.
 */
export function reconcileBackgroundTasksSnapshot(
  state: BackgroundTasksState,
  payload: OrchestrationSnapshotPayload,
): BackgroundTasksState {
  let next = state;
  for (const session of payload.sessions) {
    const parentTaskId = session.delegation?.parentTaskId;
    if (!parentTaskId) continue;
    const taskId = snapshotSessionDelegateThreadId(session);

    if (next.delegateParents[taskId] !== parentTaskId) {
      next = {
        ...next,
        delegateParents: { ...next.delegateParents, [taskId]: parentTaskId },
      };
    }

    const existing = next.entries[session.threadId];
    const isActive = session.hasActiveTurn !== false;

    if (!existing) {
      // A bare status snapshot carries no turn history — only seed a card
      // for a delegate the snapshot itself says is still active. A finished
      // one this client never saw live has nothing worth backfilling.
      if (!isActive) continue;
      const entry: BackgroundTaskEntry = {
        id: session.threadId,
        kind: 'agent',
        source: 'delegate-session',
        chatThreadId: parentTaskId,
        delegateThreadId: session.threadId,
        stop: { kind: 'delegate-interrupt' },
        // The sheet replaces this reconnect fallback with the persisted first
        // turn prompt once its bounded session-detail query resolves.
        title: session.delegation?.targetId
          ? `Delegated task — ${session.delegation.targetId}`
          : 'Delegated task',
        startedAt: parseTime(session.createdAt, Date.now()),
        state: 'running',
      };
      next = { ...next, entries: { ...next.entries, [entry.id]: entry } };
      continue;
    }

    if (existing.state === 'running' && !isActive) {
      const endedAt = parseTime(session.lastEventAt, Date.now());
      const entries = {
        ...next.entries,
        [existing.id]: {
          ...existing,
          state: 'stopped' as BackgroundTaskState,
          endedAt,
        },
      };
      next = {
        ...next,
        entries: pruneFinished(entries, existing.chatThreadId),
      };
    }
  }
  // A snapshot is authoritative for liveness.  Do not leave raw tools or
  // delegates visible merely because their terminal SSE event was missed.
  const sessionsByThread = new Map(
    payload.sessions.map((session) => [session.threadId, session]),
  );
  const stale = Object.values(next.entries).filter((entry) => {
    if (entry.state !== 'running') return false;
    if (entry.kind === 'agent')
      return !sessionsByThread.has(entry.delegateThreadId ?? entry.id);
    const parent = sessionsByThread.get(entry.chatThreadId);
    return !parent || parent.hasActiveTurn === false;
  });
  if (stale.length) {
    const entries = { ...next.entries };
    for (const entry of stale)
      entries[entry.id] = { ...entry, state: 'stopped', endedAt: Date.now() };
    next = { ...next, entries };
  }
  return next;
}

export interface ChatBackgroundTasksView {
  running: BackgroundTaskEntry[];
  finished: BackgroundTaskEntry[];
}

function makeProviderEntry(
  task: ChatBackgroundTask,
  chatThreadId: string,
  startedAt: number,
): BackgroundTaskEntry {
  return {
    id: task.taskId,
    kind: 'agent',
    source: 'provider-task',
    chatThreadId,
    title: task.description || task.subagentType || 'Background task',
    detail: task.subagentType,
    startedAt,
    state: 'running',
  };
}

/**
 * The one read the UI consumes: this chat's Running/Finished entries, with
 * provider background subagents (`ChatUIState.backgroundTasks`, tracked
 * separately per station#1301 §1.4) merged in at selector level. Dedup rule
 * per the plan: a provider task sharing a `toolCallId` with a raw tool card
 * suppresses that tool card — the provider task's richer representation
 * (description, subagent type) wins for as long as the provider still lists
 * it as active.
 */
export function selectChatBackgroundTasks(
  state: BackgroundTasksState,
  chatThreadId: string,
  providerTasks: ChatBackgroundTask[] | undefined,
): ChatBackgroundTasksView {
  const forChat = Object.values(state.entries).filter(
    (entry) => entry.chatThreadId === chatThreadId,
  );
  const suppressedToolCallIds = new Set(
    (providerTasks ?? [])
      .map((task) => task.toolCallId)
      .filter((id): id is string => Boolean(id)),
  );
  const visible = forChat.filter(
    (entry) => !(entry.kind === 'tool' && suppressedToolCallIds.has(entry.id)),
  );

  const providerEntries = (providerTasks ?? []).map((task) => {
    const matchedTool = task.toolCallId
      ? state.entries[task.toolCallId]
      : undefined;
    return makeProviderEntry(
      task,
      chatThreadId,
      matchedTool?.startedAt ?? Date.now(),
    );
  });

  const running = [
    ...visible.filter((entry) => entry.state === 'running'),
    ...providerEntries,
  ].sort((a, b) => a.startedAt - b.startedAt);

  const finished = visible
    .filter((entry) => entry.state !== 'running')
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));

  return { running, finished };
}

// Constructed in unit tests via dynamic import; the app uses the singleton below.
// fallow-ignore-next-line unused-export
export class BackgroundTasksStore {
  private state: BackgroundTasksState = createEmptyBackgroundTasksState();
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): BackgroundTasksState => this.state;

  private commit(next: BackgroundTasksState) {
    if (next === this.state) return;
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }

  ingest(event: OrchestrationEvent) {
    this.commit(ingestBackgroundTaskEvent(this.state, event));
  }

  reconcileSnapshot(payload: OrchestrationSnapshotPayload) {
    this.commit(reconcileBackgroundTasksSnapshot(this.state, payload));
  }

  /** Test-only: clears all tracked entries/bindings between test cases. */
  reset() {
    this.state = createEmptyBackgroundTasksState();
  }
}

export const backgroundTasksStore = new BackgroundTasksStore();
