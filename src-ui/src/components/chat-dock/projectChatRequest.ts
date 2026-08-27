import type { DockSnap } from './dockSnap';

export type ProjectChatSession = {
  id: string;
  conversationId?: string;
  projectSlug?: string;
  messages: Array<{ timestamp?: number }>;
};

export function focusRoutableChatSession(
  sessions: ProjectChatSession[],
  sessionId: string,
  projectFilter: string | null,
  clearProjectFilter: () => void,
  focusSession: (sessionId: string) => void,
): boolean {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return false;
  if (projectFilter && session.projectSlug !== projectFilter) {
    clearProjectFilter();
  }
  focusSession(sessionId);
  return true;
}

export function mostRecentProjectSession(
  sessions: ProjectChatSession[],
  projectSlug: string,
) {
  return sessions
    .map((session, index) => ({ session, index }))
    .filter(({ session }) => session.projectSlug === projectSlug)
    .sort(
      (left, right) =>
        (right.session.messages.at(-1)?.timestamp ?? 0) -
          (left.session.messages.at(-1)?.timestamp ?? 0) ||
        right.index - left.index,
    )[0]?.session;
}

/**
 * Project-chat entry is intentionally active-tab only. Keeping the Full snap
 * either side of focus prevents `focusSession`'s remembered-size restore from
 * overriding the explicit sidebar request.
 */
export function activateProjectChat({
  sessions,
  projectSlug,
  focusSession,
  applyDockSnap,
}: {
  sessions: ProjectChatSession[];
  projectSlug: string;
  focusSession: (sessionId: string) => void;
  applyDockSnap: (snap: DockSnap) => void;
}): 'focused' | 'new-chat' {
  applyDockSnap('full');
  const session = mostRecentProjectSession(sessions, projectSlug);
  if (!session) return 'new-chat';
  focusSession(session.id);
  applyDockSnap('full');
  return 'focused';
}

export function shouldClearProjectChatScope(
  projectFilter: string | null,
  activeChatRef: string | null,
  sessions: ProjectChatSession[],
): boolean {
  if (!projectFilter || !activeChatRef) return false;
  const activeSession = sessions.find(
    (session) =>
      session.id === activeChatRef || session.conversationId === activeChatRef,
  );
  return Boolean(activeSession && activeSession.projectSlug !== projectFilter);
}
