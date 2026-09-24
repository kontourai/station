// archive#1301 — "Background tasks" Running/Finished projection folded
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
import type {
  ChildWorkItem,
  ChildWorkStatus,
} from '@kontourai/station-contracts/child-work';
import type { OrchestrationDelegationContext } from '@kontourai/station-contracts/orchestration';
import type {
  OrchestrationEvent,
  OrchestrationSnapshotPayload,
} from '../hooks/orchestration/types';
import type { ChatBackgroundTask } from './active-chats-state';

type BackgroundTaskKind = 'tool' | 'agent';
type BackgroundTaskSource = 'tool-event' | 'delegate-session' | 'provider-task';
export type BackgroundTaskState =
  | 'running'
  | 'completed'
  | 'stopped'
  /**
   * station#1558: the session ended with this call still open, so no result
   * can ever arrive. Distinct from `stopped` (which names a stop someone
   * asked for — a turn abort, a session exit, the orphan safety net below)
   * and from `failed`: Station observed no failure, only the absence of any
   * outcome.
   */
  | 'unresolved'
  /**
   * #2459: a stop was requested and the engine never confirmed it. Not
   * `stopped` — that would claim the stop took effect.
   */
  | 'stopped-unconfirmed'
  | 'failed';

export interface BackgroundTaskEntry {
  /** toolCallId | delegate threadId | provider taskId — already globally unique. */
  id: string;
  kind: BackgroundTaskKind;
  source: BackgroundTaskSource;
  chatThreadId: string;
  title: string;
  detail?: string;
  /**
   * When the card's work started, on this client's clock basis. #2459:
   * absent for a provider subagent whose spawning tool call this client never
   * saw — no start was reported, and "now" is not one.
   */
  startedAt?: number;
  endedAt?: number;
  state: BackgroundTaskState;
  /** Transcript link for an agent/delegate card. */
  delegateThreadId?: string;
  /**
   * station#1877: the execution-session thread a provider task belongs to,
   * which a task-scoped stop must address. Absent on delegate and tool cards,
   * whose controls key off `delegateThreadId` and the chat thread instead.
   */
  sessionThreadId?: string;
  /** A task-scoped stop seam that the UI may safely expose. */
  stop?: {
    kind: 'delegate-interrupt' | 'turn-interrupt' | 'provider-task-stop';
  };
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

const CHILD_WORK_CARD_STATE: Record<ChildWorkStatus, BackgroundTaskState> = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'stopped',
  // #2459: a stop nobody confirmed is not a stop that happened.
  'stopped-unconfirmed': 'stopped-unconfirmed',
  unresolved: 'unresolved',
};

/**
 * #2456: the ONE renderer from provider-neutral child work to a card. Every
 * delegate card and every provider-subagent card is built here; the per-
 * producer branches keep each card's members (and their order) exactly what
 * the pre-contract builders produced, which
 * `background-tasks-child-work-parity.test.ts` pins byte for byte.
 *
 * `placement` carries what a child-work item does not know about the card:
 * which chat shows it, the card's start time on this client's clock basis,
 * and a title the caller already resolved.
 */
function backgroundTaskEntryFromChildWork(
  item: ChildWorkItem,
  placement: {
    chatThreadId: string;
    startedAt: number | undefined;
    title?: string;
  },
): BackgroundTaskEntry {
  const state = CHILD_WORK_CARD_STATE[item.status];
  if (item.producer === 'station-delegate') {
    return {
      id: item.childId,
      kind: 'agent',
      source: 'delegate-session',
      chatThreadId: placement.chatThreadId,
      delegateThreadId: item.childId,
      ...(item.controls?.stop ? { stop: { kind: item.controls.stop } } : {}),
      title: placement.title ?? item.title ?? 'Delegated task',
      startedAt: placement.startedAt,
      state,
    };
  }
  return {
    id: item.childId,
    kind: 'agent',
    source: 'provider-task',
    chatThreadId: placement.chatThreadId,
    title: placement.title || item.title || item.kindLabel || 'Background task',
    detail: item.kindLabel,
    ...(placement.startedAt !== undefined
      ? { startedAt: placement.startedAt }
      : {}),
    state,
    ...(item.controls?.stop && item.reporterThreadId
      ? {
          sessionThreadId: item.reporterThreadId,
          // station#1877: task-scoped, so stopping one subagent leaves its
          // siblings and the turn running. Deliberately NOT 'turn-interrupt'
          // as a fallback — that ends every other subagent too. Offered only
          // when the reporting session is known, since without it there is
          // nothing to address and a dead button is worse than none.
          stop: { kind: item.controls.stop },
        }
      : {}),
  };
}

/** A delegate this client is binding from its own events, as child work. */
function delegateChildWork(
  delegateThreadId: string,
  parentTaskId: string,
): ChildWorkItem {
  return {
    producer: 'station-delegate',
    reporterThreadId: delegateThreadId,
    childId: delegateThreadId,
    status: 'running',
    parent: { taskId: parentTaskId },
    controls: { stop: 'delegate-interrupt' },
  };
}

/**
 * A pre-contract CLIENT-TRANSLATED provider task (`ChatUIState.backgroundTasks`)
 * back as child work, for the one renderer. Absent `sessionThreadId` leaves
 * no stop control, exactly as before.
 */
function providerTaskChildWork(task: ChatBackgroundTask): ChildWorkItem {
  return {
    producer: 'engine-subagent',
    reporterThreadId: task.sessionThreadId ?? '',
    childId: task.taskId,
    status: 'running',
    ...(task.description ? { title: task.description } : {}),
    ...(task.subagentType ? { kindLabel: task.subagentType } : {}),
    ...(task.sessionThreadId
      ? { controls: { stop: 'provider-task-stop' as const } }
      : {}),
  };
}

/** A card's end for ordering: its end, else its start, else the oldest. */
function settledAt(entry: BackgroundTaskEntry): number {
  return entry.endedAt ?? entry.startedAt ?? 0;
}

/** Bounds a chat's finished list, dropping the oldest-ended entries first. */
function pruneFinished(
  entries: Record<string, BackgroundTaskEntry>,
  chatThreadId: string,
): Record<string, BackgroundTaskEntry> {
  const finishedIds = Object.values(entries)
    .filter((entry) => entry.chatThreadId === chatThreadId)
    .filter((entry) => entry.state !== 'running')
    .sort((a, b) => settledAt(a) - settledAt(b))
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
  // An `unresolved` card is the one settled state that is not final: the
  // engine can still report the real result after the session-end settle
  // (station#1569), and the transcript folds honour that correction, so the
  // card must too. Every other settled state stays put.
  const correctable =
    existing?.state === 'unresolved' && event.status !== 'unresolved';
  if (existing?.state !== 'running' && !correctable) return state;
  const nextState: BackgroundTaskState =
    event.status === 'success'
      ? 'completed'
      : event.status === 'cancelled'
        ? 'stopped'
        : event.status === 'unresolved'
          ? 'unresolved'
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

  const entry = backgroundTaskEntryFromChildWork(
    delegateChildWork(taskId, parentTaskId),
    {
      chatThreadId: parentTaskId,
      startedAt: parseTime(event.createdAt, Date.now()),
    },
  );
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
  const entry = backgroundTaskEntryFromChildWork(
    delegateChildWork(event.threadId, parentTaskId!),
    {
      chatThreadId: parentTaskId!,
      startedAt: parseTime(event.createdAt, Date.now()),
      title,
    },
  );
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
 * #2456: a snapshot row's delegate as child work. A current server sends
 * `childWork.asChild` (`projectDelegateChildWork`); an older one sends only
 * `delegation`, read exactly as this reconcile always read it — any
 * `hasActiveTurn` other than an explicit `false` counts as live, and the
 * interrupt is offered unconditionally.
 */
function snapshotDelegateChildWork(
  session: OrchestrationSnapshotPayload['sessions'][number],
): ChildWorkItem | undefined {
  const asChild = session.childWork?.asChild;
  if (asChild?.producer === 'station-delegate') return asChild;
  const delegation = session.delegation;
  if (!delegation) return undefined;
  return {
    producer: 'station-delegate',
    reporterThreadId: session.threadId,
    childId: session.threadId,
    status: session.hasActiveTurn !== false ? 'running' : 'unresolved',
    ...(delegation.parentTaskId
      ? { parent: { taskId: delegation.parentTaskId } }
      : {}),
    ...(delegation.targetId ? { kindLabel: delegation.targetId } : {}),
    controls: { stop: 'delegate-interrupt' },
  };
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
    const child = snapshotDelegateChildWork(session);
    const parentTaskId = child?.parent?.taskId;
    if (!child || !parentTaskId) continue;
    const taskId = snapshotSessionDelegateThreadId(session);

    if (next.delegateParents[taskId] !== parentTaskId) {
      next = {
        ...next,
        delegateParents: { ...next.delegateParents, [taskId]: parentTaskId },
      };
    }

    const existing = next.entries[session.threadId];
    const isActive = child.status === 'running';

    if (!existing) {
      // A bare status snapshot carries no turn history — only seed a card
      // for a delegate the snapshot itself says is still active. A finished
      // one this client never saw live has nothing worth backfilling.
      if (!isActive) continue;
      const entry = backgroundTaskEntryFromChildWork(child, {
        chatThreadId: parentTaskId,
        startedAt: parseTime(session.createdAt, Date.now()),
        // The sheet replaces this reconnect fallback with the persisted first
        // turn prompt once its bounded session-detail query resolves.
        title: child.kindLabel
          ? `Delegated task — ${child.kindLabel}`
          : 'Delegated task',
      });
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

/**
 * The one read the UI consumes: this chat's Running/Finished entries, with
 * provider background subagents (`ChatUIState.backgroundTasks`, tracked
 * separately per archive#1301 §1.4) merged in at selector level. Dedup rule
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
    return backgroundTaskEntryFromChildWork(providerTaskChildWork(task), {
      chatThreadId,
      // #2459: no spawning tool card, no start. `Date.now()` here was an
      // invented start that reset on every recompute.
      startedAt: matchedTool?.startedAt,
    });
  });

  // An unknown start sorts last rather than posing as "now".
  const running = [
    ...visible.filter((entry) => entry.state === 'running'),
    ...providerEntries,
  ].sort(
    (a, b) =>
      (a.startedAt ?? Number.POSITIVE_INFINITY) -
      (b.startedAt ?? Number.POSITIVE_INFINITY),
  );

  const finished = visible
    .filter((entry) => entry.state !== 'running')
    .sort((a, b) => settledAt(b) - settledAt(a));

  return { running, finished };
}

// Constructed in unit tests via dynamic import; the app uses the singleton below.
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
