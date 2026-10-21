import { openerSelectionKey, type PaneOpener } from './pane-relations';

/** The opener occurrence for a conversation not hosted by a region pane. */
export const WORKSPACE_CHAT_OPENER = 'chat-workspace';

/**
 * A conversation as a pane opener: the occurrence hosting it (a region pane's
 * surface, else the Coding centre's Chat) at the conversation and session it
 * shows. Null without a conversation to name.
 */
export function conversationOpener(
  occurrenceId: string | null,
  label: string,
  conversation: {
    conversationId: string | null | undefined;
    threadId: string | null | undefined;
    projectSlug: string | null | undefined;
  },
): PaneOpener | null {
  const conversationId = conversation.conversationId || null;
  const threadId = conversation.threadId || null;
  if (conversationId === null && threadId === null) return null;
  return {
    occurrenceId: occurrenceId ?? WORKSPACE_CHAT_OPENER,
    label: label.slice(0, 160) || 'Chat',
    source: {
      kind: 'conversation',
      conversationId,
      threadId,
      projectSlug: conversation.projectSlug || null,
    },
  };
}

/** The selection key an opener publishes for source hide/restore. */
export function conversationSelectionKey(
  conversation: Parameters<typeof conversationOpener>[2],
): string | null {
  const opener = conversationOpener(null, 'Chat', conversation);
  return opener ? openerSelectionKey(opener) : null;
}

/** A Files pane as a pane opener, with the Project it is bound to. */
export function filesOpener(
  occurrenceId: string,
  project: { projectId: string; projectSlug: string; projectName?: string },
): PaneOpener {
  return {
    occurrenceId,
    label: `Files · ${project.projectName || project.projectSlug}`.slice(
      0,
      160,
    ),
    source: {
      kind: 'files',
      projectId: project.projectId,
      projectSlug: project.projectSlug,
    },
  };
}
