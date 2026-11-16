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
import {
  type ChildWorkDisplayStatus,
  type ChildWorkItem,
  type ChildWorkRegistryState,
  childWorkDisplayStatus,
} from '@kontourai/station-contracts/child-work';
import type { OrchestrationDelegationContext } from '@kontourai/station-contracts/orchestration';
import { runtimeEventContentText } from '@kontourai/station-contracts/runtime-event-content';
import type { ChatStationBindingV1 } from '../connections/station-connection';
import {
  type StationStateSource,
  stationPartitionKey,
  stationStateKey,
} from '../connections/station-state';
import type {
  OrchestrationEvent,
  OrchestrationSnapshotPayload,
} from '../hooks/orchestration/types';
import { parseEpochMs } from '../utils/parseEpochMs';
import type { ChatBackgroundTask } from './active-chats-state';
import { childWorkGlobalStore } from './child-work-global-store';

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
  /**
   * The engine process a child ran in ended while it ran. Not `stopped`
   * (nobody asked for it) and not `unresolved` (the end was observed).
   */
  | 'interrupted'
  | 'failed';

export interface BackgroundTaskEntry {
  /** toolCallId | delegate threadId | provider taskId — already globally unique. */
  id: string;
  kind: BackgroundTaskKind;
  source: BackgroundTaskSource;
  chatThreadId: string;
  title: string;
  delegationTitle?: string;
  detail?: string;
  /** A tool card's tool, kept even when a description names the card. */
  toolName?: string;
  /**
   * A tool card's arguments as one bounded display line (the command, path,
   * URL or query it ran with), so the expanded row says what ran.
   */
  toolInput?: string;
  latestTool?: string;
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
  /** Some raw tool cards were dropped; counts describe only retained rows. */
  limitedToolChats?: Record<string, true>;
  /** Present after chat lifecycle tracking begins; retains only open aliases. */
  openChatThreads?: Record<string, true>;
  /** Source-scoped reporter to chat association for engine subagents. */
  providerReporters?: Record<string, string>;
}

/** Finished list is bounded per chat, drop-oldest (by end time), per the plan §3. */
export const FINISHED_LIMIT_PER_CHAT = 50;
const RUNNING_TOOL_LIMIT_PER_CHAT = 100;
const CLOSED_CHAT_ROW_LIMIT = 150;
const CLOSED_CHAT_RECOVERY_LIMIT = 50;

export function createEmptyBackgroundTasksState(): BackgroundTasksState {
  return { entries: {}, delegateParents: {} };
}

function parseTime(iso: string | undefined, fallback: number): number {
  return parseEpochMs(iso) ?? fallback;
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

const CHILD_WORK_CARD_STATE: Record<
  ChildWorkDisplayStatus,
  BackgroundTaskState
> = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'stopped',
  // #2459: a stop nobody confirmed is not a stop that happened.
  'stopped-unconfirmed': 'stopped-unconfirmed',
  unresolved: 'unresolved',
  interrupted: 'interrupted',
};

/**
 * #2456: the ONE renderer from provider-neutral child work to a card. Every
 * delegate card and every provider-subagent card is built here; the per-
 * producer branches keep each card's members exactly what the pre-contract
 * builders produced, which `background-tasks-child-work-parity.test.ts` pins
 * member for member.
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
  const state = CHILD_WORK_CARD_STATE[childWorkDisplayStatus(item)];
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
    // #2457: the child's live status line when it reports one, else its kind.
    // #3163: else its own reported model (Codex children carry no kind).
    detail: item.progress ?? item.kindLabel ?? item.model?.id,
    ...(item.latestTool ? { latestTool: item.latestTool } : {}),
    ...(placement.startedAt !== undefined
      ? { startedAt: placement.startedAt }
      : {}),
    state,
    ...(item.reporterThreadId
      ? { sessionThreadId: item.reporterThreadId }
      : {}),
    ...(item.controls?.stop && item.reporterThreadId
      ? {
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
    ...(task.model ? { model: task.model } : {}),
    ...(task.progress ? { progress: task.progress } : {}),
    ...(task.latestTool ? { latestTool: task.latestTool } : {}),
    // #2459: a stop only for a child that carried the seam itself, and only
    // with a session to address it to. A session thread alone is not a seam:
    // deriving one from it offered a Codex child a Stop wired to nothing.
    ...(task.sessionThreadId && task.stop === 'provider-task-stop'
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
  state: BackgroundTasksState,
  entries: Record<string, BackgroundTaskEntry>,
  chatThreadId: string,
): BackgroundTasksState {
  const retired = Object.values(entries).filter(
    (entry) =>
      entry.chatThreadId === chatThreadId &&
      entry.state !== 'running' &&
      entry.state !== 'unresolved' &&
      state.openChatThreads !== undefined &&
      !state.openChatThreads[chatThreadId],
  );
  if (retired.length) {
    entries = { ...entries };
    const delegateParents = { ...state.delegateParents };
    for (const entry of retired) {
      delete entries[entry.id];
      delete delegateParents[entry.id];
    }
    state = { ...state, delegateParents };
  }
  const finishedIds = Object.values(entries)
    .filter((entry) => entry.chatThreadId === chatThreadId)
    .filter((entry) => entry.state !== 'running')
    .sort((a, b) => settledAt(a) - settledAt(b))
    .map((entry) => entry.id);
  const excess = finishedIds.length - FINISHED_LIMIT_PER_CHAT;
  if (excess <= 0) return { ...state, entries };
  const next = { ...entries };
  for (let i = 0; i < excess; i++) delete next[finishedIds[i]];
  return pruneUnrepresentedBindings({ ...state, entries: next });
}

/** Inactive legacy rows have no card to participate in finished-card pruning. */
function pruneUnrepresentedBindings(
  state: BackgroundTasksState,
): BackgroundTasksState {
  const byParent = new Map<string, string[]>();
  for (const [threadId, parent] of Object.entries(state.delegateParents)) {
    if (state.entries[threadId]) continue;
    const ids = byParent.get(parent) ?? [];
    ids.push(threadId);
    byParent.set(parent, ids);
  }
  let delegateParents = state.delegateParents;
  for (const ids of byParent.values()) {
    const excess = ids.length - FINISHED_LIMIT_PER_CHAT;
    if (excess <= 0) continue;
    if (delegateParents === state.delegateParents)
      delegateParents = { ...delegateParents };
    for (const id of ids.slice(0, excess)) delete delegateParents[id];
  }
  return delegateParents === state.delegateParents
    ? state
    : { ...state, delegateParents };
}

const TOOL_INPUT_LIMIT = 240;
const TOOL_INPUT_KEYS = [
  'command',
  'cmd',
  'file_path',
  'path',
  'url',
  'query',
  'pattern',
  'prompt',
] as const;

/**
 * The argument a reader recognizes the call by, else the arguments as JSON,
 * as a single display line of at most TOOL_INPUT_LIMIT characters. A display
 * summary, never a value anything executes or parses back.
 */
function toolInputSummary(
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!args) return undefined;
  const named = TOOL_INPUT_KEYS.map((key) => args[key]).find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  let text = named;
  if (text === undefined) {
    const { description: _description, ...rest } = args;
    if (Object.keys(rest).length === 0) return undefined;
    try {
      text = JSON.stringify(rest);
    } catch {
      return undefined;
    }
  }
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return undefined;
  return line.length > TOOL_INPUT_LIMIT
    ? `${line.slice(0, TOOL_INPUT_LIMIT - 1)}…`
    : line;
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
  const toolInput = toolInputSummary(args);
  const entry: BackgroundTaskEntry = {
    id: event.toolCallId,
    kind: 'tool',
    source: 'tool-event',
    chatThreadId: event.threadId,
    title: description || event.toolName,
    toolName: event.toolName,
    ...(toolInput ? { toolInput } : {}),
    startedAt: parseTime(event.createdAt, Date.now()),
    state: 'running',
  };
  return boundRunningTools(
    state,
    { ...state.entries, [entry.id]: entry },
    event.threadId,
  );
}

function boundRunningTools(
  state: BackgroundTasksState,
  entries: Record<string, BackgroundTaskEntry>,
  chatThreadId: string,
): BackgroundTasksState {
  const running = Object.values(entries)
    .filter(
      (item) =>
        item.chatThreadId === chatThreadId &&
        item.kind === 'tool' &&
        item.state === 'running',
    )
    .sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0));
  const excess = running.length - RUNNING_TOOL_LIMIT_PER_CHAT;
  if (excess <= 0) return { ...state, entries };
  for (const item of running.slice(0, excess)) delete entries[item.id];
  return {
    ...state,
    entries,
    limitedToolChats: { ...state.limitedToolChats, [chatThreadId]: true },
  };
}

function foldToolProgress(
  state: BackgroundTasksState,
  event: Extract<OrchestrationEvent, { method: 'tool.progress' }>,
): BackgroundTasksState {
  const existing = state.entries[event.toolCallId];
  if (
    existing?.chatThreadId !== event.threadId ||
    (existing.state !== 'running' && existing.state !== 'unresolved')
  )
    return state;
  if (existing.state === 'running' && existing.detail === event.message)
    return state;
  return boundRunningTools(
    state,
    {
      ...state.entries,
      [existing.id]: {
        ...existing,
        state: 'running',
        endedAt: undefined,
        detail: event.message,
      },
    },
    event.threadId,
  );
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
  return pruneFinished(state, entries, existing.chatThreadId);
}

function clearLimitedToolChat(
  state: BackgroundTasksState,
  threadId: string,
): BackgroundTasksState {
  if (!state.limitedToolChats?.[threadId]) return state;
  const limitedToolChats = { ...state.limitedToolChats };
  delete limitedToolChats[threadId];
  return { ...state, limitedToolChats };
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
  return pruneFinished(state, entries, threadId);
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
      title: metaString(event.metadata, 'delegationTitle'),
    },
  );
  return {
    ...state,
    delegateParents,
    entries: {
      ...state.entries,
      [taskId]: {
        ...entry,
        ...(metaString(metadata, 'delegationTitle')
          ? { delegationTitle: metaString(metadata, 'delegationTitle') }
          : {}),
      },
    },
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

  const title =
    existing?.delegationTitle ??
    firstLine(runtimeEventContentText(event.prompt)?.text) ??
    existing?.title ??
    'Delegated task';
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
  const parent = state.delegateParents[threadId];
  if (
    !existing &&
    parent &&
    state.openChatThreads !== undefined &&
    !state.openChatThreads[parent]
  ) {
    const delegateParents = { ...state.delegateParents };
    delete delegateParents[threadId];
    return { ...state, delegateParents };
  }
  if (
    existing?.source !== 'delegate-session' ||
    (existing.state !== 'running' && existing.state !== 'unresolved')
  ) {
    return state;
  }
  const endedAt = parseTime(atIso, Date.now());
  const entries = {
    ...state.entries,
    [threadId]: { ...existing, state: outcome, endedAt },
  };
  return pruneFinished(state, entries, existing.chatThreadId);
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
        clearLimitedToolChat(state, event.threadId),
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
    if (
      next.openChatThreads !== undefined &&
      !next.openChatThreads[parentTaskId] &&
      child.status !== 'running' &&
      child.status !== 'unresolved'
    ) {
      const entries = { ...next.entries };
      const delegateParents = { ...next.delegateParents };
      delete entries[session.threadId];
      delete delegateParents[taskId];
      next = { ...next, entries, delegateParents };
      continue;
    }

    const existing = next.entries[session.threadId];
    const isActive = child.status === 'running';

    if (next.delegateParents[taskId] !== parentTaskId) {
      next = {
        ...next,
        delegateParents: { ...next.delegateParents, [taskId]: parentTaskId },
      };
    }

    if (!existing) {
      // A current server's asChild carries the terminal fact and exact end.
      // An older delegation-only row cannot backfill a finished card, but
      // its live binding is needed if a later turn arrives without a new bind.
      if (!isActive && !session.childWork?.asChild) continue;
      const entry = backgroundTaskEntryFromChildWork(child, {
        chatThreadId: parentTaskId,
        startedAt: parseTime(child.startedAt ?? session.createdAt, Date.now()),
        // Keep the durable delegation title stable across reconnects.
        title:
          session.delegation?.title ??
          session.displayTitle ??
          (child.kindLabel
            ? `Delegated task — ${child.kindLabel}`
            : 'Delegated task'),
      });
      if (session.delegation?.title)
        entry.delegationTitle = session.delegation.title;
      const settled =
        !isActive && child.endedAt
          ? { ...entry, endedAt: parseTime(child.endedAt, Date.now()) }
          : entry;
      next = pruneFinished(
        next,
        { ...next.entries, [entry.id]: settled },
        parentTaskId,
      );
      continue;
    }

    if (isActive && existing.state !== 'running') {
      next = {
        ...next,
        entries: {
          ...next.entries,
          [existing.id]: {
            ...existing,
            state: 'running',
            endedAt: undefined,
            ...(child.startedAt
              ? {
                  startedAt: parseTime(
                    child.startedAt,
                    existing.startedAt ?? Date.now(),
                  ),
                }
              : {}),
            stop: child.controls?.stop
              ? { kind: child.controls.stop }
              : undefined,
          },
        },
      };
      continue;
    }

    if (
      !isActive &&
      (existing.state === 'running' ||
        (existing.state === 'unresolved' && child.status !== 'unresolved'))
    ) {
      const endedAt = parseTime(
        child.endedAt ?? session.lastEventAt,
        Date.now(),
      );
      const entries = {
        ...next.entries,
        [existing.id]: {
          ...existing,
          // station#2530 review 2 round 2: `child.status` is already the
          // honest fact for BOTH server vintages — `snapshotDelegateChildWork`
          // synthesizes 'unresolved' for an older server's bare `delegation`
          // row exactly as `projectDelegateChildWork` does for a current
          // server's own demotion (see both functions above). Neither means
          // a stop was requested; 'stopped' is a claim nothing derived. Map
          // through `CHILD_WORK_CARD_STATE` unconditionally so a genuine
          // richer terminal status (completed/failed/cancelled/
          // stopped-unconfirmed) still comes through, and the two server
          // vintages agree on 'unresolved' when nothing settled it.
          state: CHILD_WORK_CARD_STATE[childWorkDisplayStatus(child)],
          endedAt,
        },
      };
      next = pruneFinished(next, entries, existing.chatThreadId);
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
      entries[entry.id] = {
        ...entry,
        state: 'unresolved',
        endedAt: Date.now(),
      };
    next = { ...next, entries };
    for (const chatThreadId of new Set(
      stale.map((entry) => entry.chatThreadId),
    ))
      next = pruneFinished(next, next.entries, chatThreadId);
  }
  for (const threadId of Object.keys(next.limitedToolChats ?? {})) {
    const session = sessionsByThread.get(threadId);
    if (!session || session.hasActiveTurn === false)
      next = clearLimitedToolChat(next, threadId);
  }
  return pruneUnrepresentedBindings(next);
}

export interface ChatBackgroundTasksView {
  running: BackgroundTaskEntry[];
  finished: BackgroundTaskEntry[];
  toolHistoryLimited?: true;
}

/** Provider tasks are selected only from the Station that reported them. */
export function selectStationProviderItems(
  state: BackgroundTasksState,
  registry: ChildWorkRegistryState,
  chatThreadId: string,
): ChildWorkItem[] {
  return Object.values(registry.items).filter(
    (item) =>
      item.producer === 'engine-subagent' &&
      item.status === 'running' &&
      state.providerReporters?.[item.reporterThreadId] === chatThreadId,
  );
}
export function stationProviderTasks(
  items: readonly ChildWorkItem[],
): ChatBackgroundTask[] {
  return items.map((item) => ({
    taskId: item.childId,
    toolCallId: item.parent?.toolCallId,
    description: item.title,
    subagentType: item.kindLabel,
    ...(item.model ? { model: item.model } : {}),
    backgrounded: item.backgrounded === true,
    spawnDepth: item.depth,
    sessionThreadId: item.reporterThreadId,
    ...(item.controls?.stop === 'provider-task-stop'
      ? { stop: 'provider-task-stop' as const }
      : {}),
    ...(item.progress ? { progress: item.progress } : {}),
    ...(item.latestTool ? { latestTool: item.latestTool } : {}),
  }));
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

  return {
    running,
    finished,
    ...(state.limitedToolChats?.[chatThreadId]
      ? { toolHistoryLimited: true as const }
      : {}),
  };
}

/** Closed chats retain a bounded recovery cache, not an unbounded second inventory. */
function pruneClosedChatHistory(
  state: BackgroundTasksState,
): BackgroundTasksState {
  if (state.openChatThreads === undefined) return state;
  const closed = (chat: string) => !state.openChatThreads?.[chat];
  const expiredRows = Object.values(state.entries)
    .filter((entry) => closed(entry.chatThreadId))
    .sort((left, right) => settledAt(left) - settledAt(right))
    .slice(0, -CLOSED_CHAT_ROW_LIMIT);
  let entries = state.entries;
  if (expiredRows.length) {
    entries = { ...entries };
    for (const row of expiredRows) delete entries[row.id];
  }
  const expiredBindings = Object.entries(state.delegateParents)
    .filter(([id, parent]) => closed(parent) && !entries[id])
    .slice(0, -CLOSED_CHAT_RECOVERY_LIMIT);
  let delegateParents = state.delegateParents;
  if (expiredBindings.length) {
    delegateParents = { ...delegateParents };
    for (const [id] of expiredBindings) delete delegateParents[id];
  }
  const expiredLimits = Object.keys(state.limitedToolChats ?? {})
    .filter(closed)
    .slice(0, -CLOSED_CHAT_RECOVERY_LIMIT);
  let limitedToolChats = state.limitedToolChats;
  if (expiredLimits.length) {
    limitedToolChats = { ...limitedToolChats };
    for (const chat of expiredLimits) delete limitedToolChats[chat];
  }
  return entries === state.entries &&
    delegateParents === state.delegateParents &&
    limitedToolChats === state.limitedToolChats
    ? state
    : { ...state, entries, delegateParents, limitedToolChats };
}

// Constructed in unit tests via dynamic import; the app uses the singleton below.
const EMPTY_BACKGROUND_TASKS_STATE = createEmptyBackgroundTasksState();

export class BackgroundTasksStore {
  private partitions = new Map<string, BackgroundTasksState>();
  private listeners = new Set<() => void>();
  private retainedPartitions = new Map<string, number>();
  private openChatThreads = new Map<string, Record<string, true>>();
  private partitionOwners = new Map<string, string>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = (source?: StationStateSource): BackgroundTasksState =>
    this.partitions.get(stationPartitionKey(source)) ??
    EMPTY_BACKGROUND_TASKS_STATE;
  private stateFor(apiBase: string): BackgroundTasksState {
    const open = this.openChatThreads.get(
      this.partitionOwners.get(apiBase) ?? 'host',
    );
    return (
      this.partitions.get(apiBase) ??
      (open === undefined
        ? EMPTY_BACKGROUND_TASKS_STATE
        : {
            ...EMPTY_BACKGROUND_TASKS_STATE,
            openChatThreads: open,
          })
    );
  }
  retainPartition(source: StationStateSource): () => void {
    const apiBase = stationPartitionKey(source);
    this.retainedPartitions.set(
      apiBase,
      (this.retainedPartitions.get(apiBase) ?? 0) + 1,
    );
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.retainedPartitions.get(apiBase) ?? 0;
      if (count <= 1) this.retainedPartitions.delete(apiBase);
      else this.retainedPartitions.set(apiBase, count - 1);
    };
  }
  private hasUnsettledProvider(apiBase: string, reporter?: string): boolean {
    return Object.values(
      childWorkGlobalStore.getPartition(apiBase).registry.items,
    ).some(
      (item) =>
        (!reporter || item.reporterThreadId === reporter) &&
        (item.status === 'running' ||
          (this.retainedPartitions.has(apiBase) &&
            (item.status === 'unresolved' ||
              item.status === 'stopped-unconfirmed'))),
    );
  }
  private commit(apiBase: string, next: BackgroundTasksState) {
    if (next === this.partitions.get(apiBase)) return;
    this.partitions.delete(apiBase);
    this.partitions.set(apiBase, pruneClosedChatHistory(next));
    const inactive = [...this.partitions].filter(
      ([key, state]) =>
        key !== '' &&
        !this.retainedPartitions.has(key) &&
        !this.hasUnsettledProvider(key) &&
        !Object.values(state.entries).some(
          (entry) => entry.state === 'running',
        ),
    );
    for (const [key] of inactive.slice(0, Math.max(0, inactive.length - 4))) {
      this.partitions.delete(key);
      this.partitionOwners.delete(key);
    }
    this.listeners.forEach((listener) => listener());
  }
  ingest(event: OrchestrationEvent, source?: StationStateSource) {
    if (typeof source === 'object' && !source.isCurrent()) return;
    const apiBase = stationPartitionKey(source);
    this.partitionOwners.set(
      apiBase,
      stationStateKey(typeof source === 'object' ? source.binding : undefined),
    );
    const previous = this.stateFor(apiBase);
    const next = ingestBackgroundTaskEvent(previous, event);
    if (next !== previous) this.commit(apiBase, next);
  }
  reconcileSnapshot(
    payload: OrchestrationSnapshotPayload,
    source?: StationStateSource,
  ) {
    if (typeof source === 'object' && !source.isCurrent()) return;
    const apiBase = stationPartitionKey(source);
    this.partitionOwners.set(
      apiBase,
      stationStateKey(typeof source === 'object' ? source.binding : undefined),
    );
    const previous = this.stateFor(apiBase);
    const next = reconcileBackgroundTasksSnapshot(previous, payload);
    if (next !== previous) this.commit(apiBase, next);
  }
  bindProviderReporter(
    source: StationStateSource,
    reporterThreadId: string,
    chatThreadId: string,
  ) {
    if (typeof source === 'object' && !source.isCurrent()) return;
    const apiBase = stationPartitionKey(source);
    this.partitionOwners.set(
      apiBase,
      stationStateKey(typeof source === 'object' ? source.binding : undefined),
    );
    const previous = this.stateFor(apiBase);
    let aliases = previous.providerReporters ?? {};
    if (aliases[reporterThreadId] !== chatThreadId)
      aliases = { ...aliases, [reporterThreadId]: chatThreadId };
    const needed = this.neededProviderReporters(apiBase);
    const inactiveByChat = new Map<string, string[]>();
    for (const [reporter, chat] of Object.entries(aliases)) {
      if (needed.has(reporter)) continue;
      const inactive = inactiveByChat.get(chat) ?? [];
      inactive.push(reporter);
      inactiveByChat.set(chat, inactive);
    }
    for (const inactive of inactiveByChat.values()) {
      for (const reporter of inactive.slice(
        0,
        Math.max(0, inactive.length - CLOSED_CHAT_RECOVERY_LIMIT),
      )) {
        if (aliases === previous.providerReporters) aliases = { ...aliases };
        delete aliases[reporter];
      }
    }
    if (aliases === previous.providerReporters) return;
    this.commit(apiBase, { ...previous, providerReporters: aliases });
  }
  private neededProviderReporters(apiBase: string): Set<string> {
    return new Set(
      Object.values(childWorkGlobalStore.getPartition(apiBase).registry.items)
        .filter(
          (item) =>
            item.status === 'running' ||
            item.status === 'unresolved' ||
            item.status === 'stopped-unconfirmed',
        )
        .map((item) => item.reporterThreadId),
    );
  }
  reconcileProviderReporters(
    source: StationStateSource,
    threadIds: ReadonlySet<string>,
  ) {
    if (typeof source === 'object' && !source.isCurrent()) return;
    const apiBase = stationPartitionKey(source);
    this.partitionOwners.set(
      apiBase,
      stationStateKey(typeof source === 'object' ? source.binding : undefined),
    );
    const previous = this.stateFor(apiBase);
    if (!previous.providerReporters) return;
    const needed = this.neededProviderReporters(apiBase);
    const entries = Object.entries(previous.providerReporters).filter(
      ([threadId]) => threadIds.has(threadId) || needed.has(threadId),
    );
    if (entries.length === Object.keys(previous.providerReporters).length)
      return;
    this.commit(apiBase, {
      ...previous,
      providerReporters: Object.fromEntries(entries),
    });
  }
  /** Preserve live routing; completed history belongs only to open chats. */
  forgetChat(chatThreadId: string, binding?: ChatStationBindingV1) {
    const owner = stationStateKey(binding);
    const open = { ...this.openChatThreads.get(owner) };
    delete open[chatThreadId];
    this.openChatThreads.set(owner, open);
    for (const apiBase of [...this.partitions.keys()]) {
      if ((this.partitionOwners.get(apiBase) ?? 'host') !== owner) continue;
      const state = this.partitions.get(apiBase);
      if (!state) continue;
      const openChatThreads = { ...state.openChatThreads };
      delete openChatThreads[chatThreadId];
      const entries = { ...state.entries };
      const delegateParents = { ...state.delegateParents };
      for (const entry of Object.values(entries)) {
        if (
          entry.chatThreadId === chatThreadId &&
          entry.state !== 'running' &&
          entry.state !== 'unresolved'
        )
          delete entries[entry.id];
      }
      for (const [id, parent] of Object.entries(delegateParents)) {
        if (parent === chatThreadId && !entries[id]) delete delegateParents[id];
      }
      const providerReporters = Object.fromEntries(
        Object.entries(state.providerReporters ?? {}).filter(
          ([reporter, parent]) =>
            parent !== chatThreadId ||
            this.hasUnsettledProvider(apiBase, reporter),
        ),
      );
      this.commit(apiBase, {
        ...state,
        openChatThreads,
        entries,
        delegateParents,
        providerReporters,
      });
    }
  }
  retainChat(chatThreadId: string, binding?: ChatStationBindingV1) {
    const owner = stationStateKey(binding);
    const open = this.openChatThreads.get(owner);
    if (open?.[chatThreadId]) return;
    this.openChatThreads.set(owner, { ...open, [chatThreadId]: true });
    for (const apiBase of [...this.partitions.keys()]) {
      if ((this.partitionOwners.get(apiBase) ?? 'host') !== owner) continue;
      const state = this.partitions.get(apiBase);
      if (!state) continue;
      this.commit(apiBase, {
        ...state,
        openChatThreads: { ...state.openChatThreads, [chatThreadId]: true },
      });
    }
  }
  /** Test-only: clears all tracked entries/bindings between test cases. */
  reset() {
    this.partitions.clear();
    this.retainedPartitions.clear();
    this.openChatThreads.clear();
    this.partitionOwners.clear();
  }
}

export const backgroundTasksStore = new BackgroundTasksStore();
