import {
  applyChildWorkDelta,
  type ChildWorkDelta,
  type ChildWorkItem,
  type ChildWorkRegistryState,
  type ChildWorkSessionView,
  type ChildWorkTerminalStatus,
  childWorkKey,
  createEmptyChildWorkRegistry,
  forgetChildWorkReporter,
  type SessionChildWork,
} from '@kontourai/station-contracts/child-work';
import type { ChatBackgroundTask } from '../../contexts/active-chats-state';
import { activeChatsStore } from '../../contexts/active-chats-store';
import type { OrchestrationEvent } from './types';

/**
 * #2456: the client's child-work registry — the same contract reducer the
 * server folds with, fed by `child-work.updated` events (every engine's live
 * path, Claude's since #2457), by the reconnect snapshot's
 * `childWork.children` view, and — on REPLAY of pre-#2457 history only — by
 * the Claude adapter's legacy `claude-code` `task/registry`/`task/settled`
 * tuples, translated in `extensionHandlers.ts` by the contract's
 * `childWorkDeltaFromLegacyClaudeTaskNotification` (the same function the
 * server projection uses).
 *
 * `ChatUIState.backgroundTasks` stays what every reader already consumes; it
 * is now DERIVED here from the registry's running engine subagents and
 * written only when the registry changed, so the fold is the one source of
 * truth for it and chat-key resolution is untouched.
 *
 * `notReported` is carried but deliberately not rendered (#2456 F8).
 */
let registry: ChildWorkRegistryState = createEmptyChildWorkRegistry();
/**
 * reporterThreadId → the chat key it resolved to when it last reported. Kept
 * so a chat's removal can forget every reporter that fed it (R5): once the
 * chat is gone its reporters no longer resolve, and a later exit event for
 * them fails the chat guard before any forget can run.
 */
const reporterChat = new Map<string, string>();

/** Read-only view for tests and diagnostics. */
// childWorkHandlers.test.ts reads it through a dynamic import (vi.resetModules isolation) that fallow cannot trace.
// fallow-ignore-next-line unused-export
export function childWorkRegistrySnapshot(): ChildWorkRegistryState {
  return registry;
}

let removalHooked = false;
/**
 * R5: subscribe to chat removal the first time a reporter is recorded, so a
 * chat that never fed the registry costs nothing (and importing this module
 * has no side effect on the store).
 */
function hookChatRemoval(): void {
  if (removalHooked) return;
  removalHooked = true;
  activeChatsStore.onChatRemoved(forgetChildWorkForChat);
}

function toChatBackgroundTask(item: ChildWorkItem): ChatBackgroundTask {
  return {
    taskId: item.childId,
    toolCallId: item.parent?.toolCallId,
    description: item.title,
    subagentType: item.kindLabel,
    backgrounded: item.backgrounded === true,
    // Absent depth stays absent: "not reported" is not "top level".
    spawnDepth: item.depth,
    // station#1877: the EXECUTION SESSION that reported the child, which a
    // task-scoped stop must address.
    sessionThreadId: item.reporterThreadId,
    // #2459: only a seam the child itself carries becomes a stop.
    ...(item.controls?.stop === 'provider-task-stop'
      ? { stop: 'provider-task-stop' as const }
      : {}),
    // #2457: the live status line, for the sheet's card detail.
    ...(item.progress ? { progress: item.progress } : {}),
  };
}

/**
 * R1: a chat's `backgroundTasks` is the union over EVERY reporter resolving
 * to that chat — a conversation's root session and its continuation child
 * both land on one chat key, and writing only the reporting thread's list
 * would erase the other's children.
 */
function chatBackgroundTasksForChatKey(
  state: ChildWorkRegistryState,
  chatKey: string,
): ChatBackgroundTask[] {
  return Object.values(state.items)
    .filter(
      (item) =>
        item.producer === 'engine-subagent' &&
        item.status === 'running' &&
        reporterChat.get(item.reporterThreadId) === chatKey,
    )
    .map(toChatBackgroundTask);
}

function hasResult(item: ChildWorkItem | undefined): boolean {
  return Boolean(item?.result?.summary || item?.result?.handle);
}

/**
 * #2459: only `completed` is "finished". `unresolved` (no outcome observed)
 * and `stopped-unconfirmed` (a stop nobody confirmed) used to fall through to
 * "finished" and so announced an outcome Station never saw.
 */
const SETTLE_HEADING: Record<ChildWorkTerminalStatus, string> = {
  completed: 'Background task finished',
  failed: 'Background task failed',
  cancelled: '⏹ Background task stopped',
  'stopped-unconfirmed': 'Background task stop requested — not confirmed',
  unresolved: 'Background task ended — outcome unknown',
};

function settleHeading(status: ChildWorkTerminalStatus): string {
  return SETTLE_HEADING[status];
}

/**
 * station#1892, carried onto the contract: announce a backgrounded child's
 * outcome exactly once, on the settle that brought its RESULT. The engine's
 * first terminal has identity but no result, its second the result; the
 * reducer records the first and enriches it with the second, so "this settle
 * added a result" is the one moment to speak.
 *
 * station#1877: registry membership alone does not mean the user saw the
 * child as "still working" — an inline tool part already reports a same-turn
 * completion — so only a backgrounded child is announced. Either side's
 * `backgrounded` counts, as the pre-contract handler read both the settle's
 * own stamp and the registry entry.
 */
function announceSettle(
  threadId: string,
  before: ChildWorkItem | undefined,
  after: ChildWorkItem | undefined,
): void {
  if (!after || hasResult(before) || !hasResult(after)) return;
  if (after.backgrounded !== true && before?.backgrounded !== true) return;
  // R6: the registry's resulting status, which is sticky — a later terminal
  // that only enriches must not relabel the outcome it enriches.
  const heading = settleHeading(after.status as ChildWorkTerminalStatus);
  const label = after.title ? `${heading} — ${after.title}` : heading;
  const summary = after.result?.summary;
  activeChatsStore.addEphemeralMessage(threadId, {
    role: 'system',
    content: summary ? `${label}\n\n${summary}` : label,
  });
}

function deltaReporter(delta: ChildWorkDelta): string {
  return delta.kind === 'upsert'
    ? delta.item.reporterThreadId
    : delta.reporterThreadId;
}

/**
 * The one path every child-work source goes through: fold, then derive the
 * chat's `backgroundTasks` and announce a newly-resulted settle.
 */
/**
 * The chat a reporter's children belong to: the one it resolves to now, else
 * the one it resolved to when it last reported (D2). A reconnect can rebind a
 * chat to a newer session, after which the former session no longer resolves
 * — but its children still sit in that chat's union until something about
 * that session (its empty view, its exit) is folded against the same key.
 */
function chatKeyForReporter(threadId: string): string | undefined {
  const resolved = activeChatsStore.getChatKeyForExecutionSession(threadId);
  if (resolved) return resolved;
  const recorded = reporterChat.get(threadId);
  return recorded && activeChatsStore.getSnapshot()[recorded]
    ? recorded
    : undefined;
}

export function applyChildWorkToChat(
  threadId: string,
  delta: ChildWorkDelta,
): void {
  // A delta names its own reporter; one arriving on another session's thread
  // is not that session's to record (the server applies the same rule).
  if (deltaReporter(delta) !== threadId) return;
  const chatKey = chatKeyForReporter(threadId);
  if (!chatKey) return;
  hookChatRemoval();
  // #2457: a late settle the adapter drains after its session exited lands
  // here too (it resolves through the chat's retained currentSessionId), so
  // it may re-record a reporter the exit already forgot. That is accepted:
  // the entry is terminal, chat-scoped and bounded, and is cleared on chat
  // removal (R5) or by a full snapshot that no longer lists the session —
  // while dropping the settle would lose the user's result announcement.
  reporterChat.set(threadId, chatKey);
  const before = registry;
  const next = applyChildWorkDelta(before, delta);
  if (next === before) return;
  registry = next;
  activeChatsStore.updateChat(chatKey, {
    backgroundTasks: chatBackgroundTasksForChatKey(next, chatKey),
  });
  if (delta.kind === 'settle') {
    const key = childWorkKey(delta);
    announceSettle(chatKey, before.items[key], next.items[key]);
  }
}

export function handleChildWorkUpdatedEvent(
  event: Extract<OrchestrationEvent, { method: 'child-work.updated' }>,
): void {
  applyChildWorkToChat(event.threadId, event.delta);
}

/**
 * A reconnect snapshot's `childWork` view, as the deltas it stands for. The
 * `reported` view's running set is authoritative exactly like a live
 * snapshot delta, so a child that settled while this client was away stops
 * reading as running. Only chats this client tracks are fed.
 */
// Also called by childWorkHandlers.test.ts through a dynamic import that fallow cannot trace.
// fallow-ignore-next-line unused-export
export function applySnapshotChildWork(
  threadId: string,
  view: ChildWorkSessionView | undefined,
): void {
  if (!view) return;
  if (view.observability === 'not-reported') {
    applyChildWorkToChat(threadId, {
      kind: 'not-reported',
      reporterThreadId: threadId,
      reason: view.reason,
    });
    return;
  }
  applyChildWorkToChat(threadId, {
    kind: 'snapshot',
    producer: 'engine-subagent',
    reporterThreadId: threadId,
    running: view.running,
  });
}

/**
 * The session ended: nothing it reported can still be running. Forgetting it
 * re-derives its chat's list from the reporters that remain, so a SIBLING
 * session's children stay (R1) and this session's go. Safe to call more than
 * once, and for a session that never reported.
 */
// Also called by childWorkHandlers.test.ts through a dynamic import that fallow cannot trace.
// fallow-ignore-next-line unused-export
export function forgetChildWorkForThread(threadId: string): void {
  const chatKey = reporterChat.get(threadId);
  if (chatKey === undefined) {
    registry = forgetChildWorkReporter(registry, threadId);
    return;
  }
  registry = forgetChildWorkReporter(registry, threadId);
  reporterChat.delete(threadId);
  if (activeChatsStore.getSnapshot()[chatKey]) {
    activeChatsStore.updateChat(chatKey, {
      backgroundTasks: chatBackgroundTasksForChatKey(registry, chatKey),
    });
  }
}

/**
 * D2: the lifecycle half that must NOT wait for the chat guard. A session's
 * exit (or terminal state) can arrive after its chat was rebound to a newer
 * session, when `getChatForExecutionSession` no longer finds it; the event
 * dispatcher calls this before that guard.
 */
export function observeChildWorkLifecycle(event: OrchestrationEvent): void {
  if (
    event.method === 'session.exited' ||
    (event.method === 'session.state-changed' &&
      TERMINAL_CHILD_WORK_STATES.has(event.to))
  ) {
    forgetChildWorkForThread(event.threadId);
  }
}

/** The session states `sessionHandlers` treats as terminal. */
const TERMINAL_CHILD_WORK_STATES = new Set([
  'completed',
  'aborted',
  'errored',
  'exited',
]);

/**
 * D2: a FULL snapshot lists every session this client can read. A reporter it
 * recorded that is absent from the list no longer exists, so its children are
 * gone with it. Each present row's view is folded first (keyed by the
 * reporter, through its recorded chat when it no longer resolves).
 */
export function reconcileChildWorkSnapshot(
  sessions: ReadonlyArray<{ threadId: string; childWork?: SessionChildWork }>,
): void {
  for (const session of sessions) {
    applySnapshotChildWork(session.threadId, session.childWork?.children);
  }
  const listed = new Set(sessions.map((session) => session.threadId));
  for (const reporter of [...reporterChat.keys()]) {
    if (!listed.has(reporter)) forgetChildWorkForThread(reporter);
  }
}

/**
 * For the session handlers' own terminal write: forget `threadId` and return
 * what its chat should still show — a sibling session's running children —
 * or `undefined` when nothing remains, as that write always produced.
 */
export function backgroundTasksAfterSessionEnds(
  threadId: string,
): ChatBackgroundTask[] | undefined {
  const chatKey =
    reporterChat.get(threadId) ??
    activeChatsStore.getChatKeyForExecutionSession(threadId);
  registry = forgetChildWorkReporter(registry, threadId);
  reporterChat.delete(threadId);
  if (!chatKey) return undefined;
  const remaining = chatBackgroundTasksForChatKey(registry, chatKey);
  return remaining.length > 0 ? remaining : undefined;
}

/** R5: a closed chat forgets every reporter that fed it. */
function forgetChildWorkForChat(chatKey: string): void {
  for (const [reporter, key] of [...reporterChat]) {
    if (key === chatKey) forgetChildWorkForThread(reporter);
  }
}
