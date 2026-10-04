import { fetchOrchestrationConversationEventWindow } from '@kontourai/station-sdk';
import { readHarnessQuestionnaire } from '@kontourai/station-shared/harness-questions';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { toastStore } from '../../contexts/ToastContext';
import { raiseRequestOpenedToast } from './approvalHandlers';
import type { OrchestrationEvent } from './types';

/**
 * A snapshot names the requests that are open (`openRequestIds`) but not what
 * they ask, so a reload can only raise a generic placeholder for each. This
 * reads the chat's newest turn, where a blocking request waits, and replaces
 * each placeholder with the toast a live `request.opened` raises: same tool
 * name, preview, grant label and answer path. The snapshot already holds the
 * chat's state, so the only state written is the toast map and, for a request
 * still pending, the turn it names (`pendingApprovalTurnIds`). Never the status:
 * replaying the live handler's write set an ended turn back to awaiting-approval.
 *
 * Best effort by construction: an older server without the window route, a
 * failed read, or a request the window does not carry leaves the placeholder
 * in place. A request answered, or opened live, while the read was in flight
 * is left alone.
 */
export async function hydrateOpenApprovalToasts(
  apiBase: string,
  chatKey: string,
  placeholders: ReadonlyMap<string, string>,
): Promise<void> {
  let page: Awaited<
    ReturnType<typeof fetchOrchestrationConversationEventWindow>
  >;
  try {
    page = await fetchOrchestrationConversationEventWindow(chatKey, apiBase, {
      turnLimit: 1,
      direction: 'newest',
    });
  } catch {
    return;
  }
  for (const { event } of page.events) {
    if (event.method !== 'request.opened' || !event.eventId) continue;
    const placeholderToastId = placeholders.get(event.requestId);
    if (!placeholderToastId || event.blocking === false) continue;
    const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
    // The placeholder is still this request's toast: an answer, a newer
    // snapshot or a live `request.opened` since the read all replace it.
    if (chat?.approvalToasts?.get(event.requestId) !== placeholderToastId)
      continue;
    // The turn this request names, which a live `request.opened` records and a
    // snapshot cannot. Without it a live `turn.aborted` of that turn would not
    // settle the request here as it does on a client that saw it open.
    const learnedTurnId =
      typeof event.turnId === 'string' &&
      chat.pendingApprovals?.includes(event.requestId) &&
      chat.pendingApprovalTurnIds?.[event.requestId] === undefined
        ? event.turnId
        : undefined;
    const bindTurn = learnedTurnId
      ? {
          pendingApprovalTurnIds: {
            ...chat.pendingApprovalTurnIds,
            [event.requestId]: learnedTurnId,
          },
        }
      : {};
    if (readHarnessQuestionnaire(event.payload?.questionnaire)) {
      if (learnedTurnId) activeChatsStore.updateChat(event.threadId, bindTurn);
      continue;
    }
    toastStore.dismiss(placeholderToastId);
    const approvalToasts = new Map(chat.approvalToasts);
    approvalToasts.delete(event.requestId);
    activeChatsStore.updateChat(event.threadId, {
      approvalToasts,
      ...bindTurn,
    });
    raiseRequestOpenedToast(
      apiBase,
      event as Extract<OrchestrationEvent, { method: 'request.opened' }>,
    );
  }
}
