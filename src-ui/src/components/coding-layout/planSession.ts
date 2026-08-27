export interface WorkflowPlanSessionLike {
  id: string;
  conversationId?: string;
  messages: Array<{ timestamp?: number }>;
}

export function selectWorkflowPlanSession<T extends WorkflowPlanSessionLike>(
  projectSessions: T[],
  activeChat: string | null,
): T | null {
  if (projectSessions.length === 0) {
    return null;
  }

  if (activeChat) {
    const activeSession = projectSessions.find(
      (session) =>
        session.id === activeChat || session.conversationId === activeChat,
    );
    if (activeSession) {
      return activeSession;
    }
  }

  return (
    [...projectSessions].sort((left, right) => {
      const leftLastMessage =
        left.messages[left.messages.length - 1]?.timestamp || 0;
      const rightLastMessage =
        right.messages[right.messages.length - 1]?.timestamp || 0;
      return rightLastMessage - leftLastMessage;
    })[0] || null
  );
}
