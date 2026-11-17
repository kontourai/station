import { createContext } from 'react';

/**
 * An element in the host's header row (the chat dock's title bar, or a pane's
 * origin row) where a conversation surface may place its one primary action,
 * so the action sits with the conversation's name and origin instead of in a
 * row of its own. `null`: the host offers none, and the surface keeps the
 * action in its own row.
 */
export const ConversationHeaderActionSlot = createContext<HTMLElement | null>(
  null,
);
