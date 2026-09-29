import { activeChatsStore } from '../../contexts/active-chats-store';
import { navigationStore } from '../../contexts/navigation-store';
import type { WorkspacePaneFailureContext } from '../../workspace-panes/WorkspacePaneFailure';

/**
 * The Chat pane's side of a renderer crash: which conversation was open and a
 * way back to the chat list.
 *
 * The open conversation is the URL's `chat` parameter, and a remounted Chat
 * pane reopens it (`useChatDockActiveChatSync`). So when the crash is specific
 * to that conversation, a plain retry reopens the same conversation and
 * crashes again; clearing the parameter is the recovery a retry cannot give.
 * Without an open conversation there is nothing to go back from, and the
 * failure state offers only the retry.
 *
 * A plain read of the two stores, not a hook: the failure state is a static
 * screen rendered by the pane host, which supplies no chat context of its own
 * (`RegionPaneHost` takes its renderers from the caller for the same reason).
 */
export function ambientChatPaneFailureContext():
  | WorkspacePaneFailureContext
  | undefined {
  const activeChat = navigationStore.getSnapshot().activeChat;
  if (!activeChat) return undefined;
  const open = Object.entries(activeChatsStore.getSnapshot()).find(
    ([storeId, chat]) =>
      storeId === activeChat || chat.conversationId === activeChat,
  )?.[1];
  const title = open?.title?.trim();
  return {
    ...(title ? { subject: title } : {}),
    back: {
      label: 'Back to chats',
      onBack: () => navigationStore.setActiveChat(null),
    },
  };
}
