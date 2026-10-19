/**
 * How a conversation opener names its selection in a pane relation
 * (`PaneOpener.selection`): the session it shows, else its conversation.
 * One producer (`chatOpenerSelection`) and one reader (`openerSession`), so
 * Up asks Chat for exactly the session the preview was opened from.
 */
const THREAD_SELECTION = 'thread:';
const CONVERSATION_SELECTION = 'conversation:';

/** The opener occurrence for a conversation not hosted by a region pane. */
export const WORKSPACE_CHAT_OPENER = 'chat-workspace';

export function chatOpenerSelection(
  threadId: string | null | undefined,
  conversationId: string | null | undefined,
): string | null {
  if (threadId) return `${THREAD_SELECTION}${threadId}`;
  if (conversationId) return `${CONVERSATION_SELECTION}${conversationId}`;
  return null;
}

/** The session a selection names, when it names one. */
export function openerSession(selection: string): string | null {
  return selection.startsWith(THREAD_SELECTION)
    ? selection.slice(THREAD_SELECTION.length) || null
    : null;
}
