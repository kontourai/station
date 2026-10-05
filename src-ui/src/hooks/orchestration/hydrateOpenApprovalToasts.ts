import { fetchOrchestrationConversationEventWindow } from '@kontourai/station-sdk';
import { inputRequestFromRequestEvent } from '@kontourai/station-shared/input-request';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { toastStore } from '../../contexts/ToastContext';
import { raiseRequestOpenedToast } from './approvalHandlers';
import type { OrchestrationEvent } from './types';

/**
 * A snapshot names the requests that are open (`openRequestIds`) but not what
 * they ask, so a reload can only raise a generic placeholder for each. This
 * reads the chat's newest turn, where a blocking request waits, and replaces
 * each placeholder with the toast a live `request.opened` raises: same tool
 * name, preview, grant label and answer path. Only the toast: the snapshot
 * already holds the chat's state.
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
    if (inputRequestFromRequestEvent(event)) continue;
    const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
    // The placeholder is still this request's toast: an answer, a newer
    // snapshot or a live `request.opened` since the read all replace it.
    if (chat?.approvalToasts?.get(event.requestId) !== placeholderToastId)
      continue;
    toastStore.dismiss(placeholderToastId);
    const approvalToasts = new Map(chat.approvalToasts);
    approvalToasts.delete(event.requestId);
    activeChatsStore.updateChat(event.threadId, { approvalToasts });
    raiseRequestOpenedToast(
      apiBase,
      event as Extract<OrchestrationEvent, { method: 'request.opened' }>,
    );
  }
}
