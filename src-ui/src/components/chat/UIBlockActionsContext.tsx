import { createContext, useContext } from 'react';

/**
 * A submitted chat-native form, captured at interaction time. The agent's run
 * has already ended by now, so this re-enters the conversation as a NEW user
 * turn (see UIBlockActionsProvider in ChatMessageList) rather than resolving a
 * pending tool call.
 */
export interface UIBlockFormSubmission {
  /** Stable key for the originating form block (id, or a derived fallback). */
  blockId: string;
  title?: string;
  /** Field values in declaration order, with labels for the human-readable summary. */
  values: Array<{ name: string; label: string; value: string | boolean }>;
}

export interface UIBlockActions {
  submitForm: (submission: UIBlockFormSubmission) => void;
  /** Block keys already submitted this session — used to lock a form after submit. */
  submittedBlockIds: ReadonlySet<string>;
}

const noop: UIBlockActions = {
  submitForm: () => {},
  submittedBlockIds: new Set(),
};

/**
 * Provides the form-submit action to chat-native UIBlocks. Defaults to a no-op
 * so the renderer works in contexts without a live conversation (tests,
 * read-only/persisted views): a form there renders but its submit is inert.
 */
export const UIBlockActionsContext = createContext<UIBlockActions>(noop);

export function useUIBlockActions(): UIBlockActions {
  return useContext(UIBlockActionsContext);
}
