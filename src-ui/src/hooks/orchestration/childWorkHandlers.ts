import {
  applyChildWorkDelta,
  type ChildWorkDelta,
  type ChildWorkItem,
  type ChildWorkRegistryState,
  type ChildWorkSessionView,
  type ChildWorkTerminalStatus,
  childWorkForReporter,
  childWorkKey,
  createEmptyChildWorkRegistry,
  forgetChildWorkReporter,
} from '@kontourai/station-contracts/child-work';
import type { ChatBackgroundTask } from '../../contexts/active-chats-state';
import { activeChatsStore } from '../../contexts/active-chats-store';
import type { OrchestrationEvent } from './types';

/**
 * #2456: the client's child-work registry — the same contract reducer the
 * server folds with, fed by `child-work.updated` events, by the Claude
 * adapter's `claude-code` `task/registry`/`task/settled` tuples (the LIVE
 * Claude path until #2457, translated in `extensionHandlers.ts` by the
 * contract's `childWorkDeltaFromLegacyClaudeTaskNotification`, the same
 * function the server projection uses), and by the reconnect snapshot's
 * `childWork.children` view.
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
export function childWorkRegistrySnapshot(): ChildWorkRegistryState {
  return registry;
}

/** Test-only: clears the registry between cases. */
export function resetChildWorkRegistry(): void {
  registry = createEmptyChildWorkRegistry();
  reporterChat.clear();
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
  };
}

/** The legacy `ChatBackgroundTask` shape for ONE reporter's running subagents. */
export function chatBackgroundTasksFromChildWork(
  state: ChildWorkRegistryState,
  reporterThreadId: string,
): ChatBackgroundTask[] {
  return childWorkForReporter(state, reporterThreadId)
    .filter(
      (item) =>
        item.producer === 'engine-subagent' && item.status === 'running',
    )
    .map(toChatBackgroundTask);
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

function settleHeading(status: ChildWorkTerminalStatus): string {
  return status === 'failed'
    ? 'Background task failed'
    : status === 'cancelled'
      ? '⏹ Background task stopped'
      : 'Background task finished';
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
export function applyChildWorkToChat(
  threadId: string,
  delta: ChildWorkDelta,
): void {
  // A delta names its own reporter; one arriving on another session's thread
  // is not that session's to record (the server applies the same rule).
  if (deltaReporter(delta) !== threadId) return;
  const chatKey = activeChatsStore.getChatKeyForExecutionSession(threadId);
  if (!chatKey) return;
  hookChatRemoval();
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
    announceSettle(threadId, before.items[key], next.items[key]);
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
export function applySnapshotChildWork(
  threadId: string,
  view: ChildWorkSessionView | undefined,
): void {
  if (!view) return;
  if (!activeChatsStore.getChatForExecutionSession(threadId)) return;
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
 * The session ended: nothing it reported can still be running. The session
 * handler clears the chat's `backgroundTasks`; forgetting here keeps a later
 * delta from re-deriving the dead set, and restores any children a SIBLING
 * session of the same chat still has running.
 */
export function forgetChildWorkForThread(threadId: string): void {
  const chatKey = reporterChat.get(threadId);
  registry = forgetChildWorkReporter(registry, threadId);
  reporterChat.delete(threadId);
  // Another session of the same chat may still have children running (R1);
  // re-derive rather than leave the chat's list empty.
  if (chatKey && activeChatsStore.getSnapshot()[chatKey]) {
    const remaining = chatBackgroundTasksForChatKey(registry, chatKey);
    if (remaining.length > 0) {
      activeChatsStore.updateChat(chatKey, { backgroundTasks: remaining });
    }
  }
}

/** R5: a closed chat forgets every reporter that fed it. */
function forgetChildWorkForChat(chatKey: string): void {
  for (const [reporter, key] of [...reporterChat]) {
    if (key === chatKey) forgetChildWorkForThread(reporter);
  }
}
