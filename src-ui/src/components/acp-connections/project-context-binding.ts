import type { ChatUIState } from '../../contexts/active-chats-state';

/**
 * A coding-panel Project is a creation default, never a continuation override.
 *
 * The panel stays mounted while a user moves between layouts. Once a chat has
 * started a conversation (or is in the middle of starting one), changing its
 * `projectSlug` would make the next turn claim a different workspace than the
 * one the engine session already owns. Keep the captured workspace identity
 * instead; a user who wants a new Project context starts a new chat.
 */
export function shouldBindPanelProjectContext(
  chat:
    | Pick<
        ChatUIState,
        | 'conversationId'
        | 'orchestrationSessionStarted'
        | 'pendingClientTurnId'
        | 'projectSlug'
        | 'status'
      >
    | null
    | undefined,
  projectSlug: string | undefined,
): boolean {
  return Boolean(
    chat &&
      projectSlug &&
      !chat.projectSlug &&
      !chat.conversationId &&
      !chat.orchestrationSessionStarted &&
      !chat.pendingClientTurnId &&
      chat.status !== 'sending',
  );
}
