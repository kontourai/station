import { fetchOrchestrationConversationEventWindow } from '@kontourai/station-sdk';
import { readHarnessQuestionnaire } from '@kontourai/station-shared/harness-questions';
import { readMcpElicitationForm } from '@kontourai/station-shared/mcp-elicitation';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { toastStore } from '../../contexts/ToastContext';
import { raiseRequestOpenedToast } from './approvalHandlers';
import type { OrchestrationEvent } from './types';

/** Older pages read after the newest turn while placeholders remain. */
export const OLDER_PAGE_LIMIT = 3;
/** Turns per older page (the route allows up to 20). */
export const OLDER_PAGE_TURNS = 5;

/**
 * A snapshot names the requests that are open (`openRequestIds`) but not what
 * they ask, so a reload can only raise a generic placeholder for each. This
 * reads the chat's newest turn, where a blocking request usually waits, and
 * replaces each placeholder with the toast a live `request.opened` raises: same tool
 * name, preview, grant label and answer path. The snapshot already holds the
 * chat's state, so the only state written is the toast map and, for a request
 * still pending, the turn it names (`pendingApprovalTurnIds`). Never the status:
 * replaying the live handler's write set an ended turn back to awaiting-approval.
 *
 * Best effort by construction: an older server without the window route, a
 * failed read, or a request the window does not carry leaves the placeholder
 * in place. A request answered, or opened live, while the read was in flight
 * is left alone.
 *
 * A request can wait in an older turn than the newest (a turn that ended
 * with the request open). While placeholders remain unresolved and the window
 * has an older page, this follows its cursor, at most `OLDER_PAGE_LIMIT`
 * pages of `OLDER_PAGE_TURNS` turns, so the cost is bounded. Nothing further
 * is read once every placeholder is resolved; whatever is still unresolved at
 * the cap keeps its placeholder.
 */
export async function hydrateOpenApprovalToasts(
  apiBase: string,
  chatKey: string,
  placeholders: ReadonlyMap<string, string>,
): Promise<void> {
  const unresolved = new Set(placeholders.keys());
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex <= OLDER_PAGE_LIMIT; pageIndex += 1) {
    let page: Awaited<
      ReturnType<typeof fetchOrchestrationConversationEventWindow>
    >;
    try {
      page = await fetchOrchestrationConversationEventWindow(
        chatKey,
        apiBase,
        cursor === undefined
          ? { turnLimit: 1, direction: 'newest' }
          : { cursor, turnLimit: OLDER_PAGE_TURNS, direction: 'newest' },
      );
    } catch {
      return;
    }
    hydratePage(apiBase, page.events, placeholders, unresolved);
    const next = page.nextCursor;
    if (unresolved.size === 0 || !page.hasMore || !next || next === cursor)
      return;
    cursor = next;
  }
}

function hydratePage(
  apiBase: string,
  events: ReadonlyArray<{ event: OrchestrationEvent }>,
  placeholders: ReadonlyMap<string, string>,
  unresolved: Set<string>,
): void {
  for (const { event } of events) {
    if (event.method !== 'request.opened' || !event.eventId) continue;
    const placeholderToastId = placeholders.get(event.requestId);
    if (!placeholderToastId || event.blocking === false) continue;
    // Found: whatever the guard below decides, no older page need be read.
    unresolved.delete(event.requestId);
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
    // A questionnaire or an MCP form is answered on its own card, not by the
    // approval toast, so the placeholder stays; only the turn is bound.
    if (
      readHarnessQuestionnaire(event.payload?.questionnaire) ||
      readMcpElicitationForm(event.payload?.mcpElicitation)
    ) {
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
