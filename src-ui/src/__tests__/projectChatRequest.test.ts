import { describe, expect, test, vi } from 'vitest';
import {
  activateProjectChat,
  focusRoutableChatSession,
  mostRecentProjectSession,
  shouldClearProjectChatScope,
} from '../components/chat-dock/projectChatRequest';

describe('project chat request', () => {
  const sessions = [
    { id: 'old', projectSlug: 'alpha', messages: [{ timestamp: 20 }] },
    { id: 'latest', projectSlug: 'alpha', messages: [{ timestamp: 40 }] },
    { id: 'other', projectSlug: 'beta', messages: [{ timestamp: 80 }] },
  ];

  test('focuses the most recently active matching chat and keeps the dock Full', () => {
    const focusSession = vi.fn();
    const applyDockSnap = vi.fn();

    expect(
      activateProjectChat({
        sessions,
        projectSlug: 'alpha',
        focusSession,
        applyDockSnap,
      }),
    ).toBe('focused');
    expect(mostRecentProjectSession(sessions, 'alpha')?.id).toBe('latest');
    expect(focusSession).toHaveBeenCalledWith('latest');
    expect(applyDockSnap).toHaveBeenNthCalledWith(1, 'full');
    expect(applyDockSnap).toHaveBeenLastCalledWith('full');
  });

  test('keeps Full and directs the caller to project-preselected New Chat when no active tab matches', () => {
    const focusSession = vi.fn();
    const applyDockSnap = vi.fn();

    expect(
      activateProjectChat({
        sessions,
        projectSlug: 'missing',
        focusSession,
        applyDockSnap,
      }),
    ).toBe('new-chat');
    expect(focusSession).not.toHaveBeenCalled();
    expect(applyDockSnap).toHaveBeenCalledWith('full');
  });

  test('uses the newest matching tab as a deterministic fallback when chats have no messages', () => {
    expect(
      mostRecentProjectSession(
        [
          { id: 'older-empty', projectSlug: 'alpha', messages: [] },
          { id: 'newer-empty', projectSlug: 'alpha', messages: [] },
        ],
        'alpha',
      )?.id,
    ).toBe('newer-empty');
  });

  test('clears a stale scope when an external launcher selects a chat from another project', () => {
    expect(shouldClearProjectChatScope('alpha', 'other', sessions)).toBe(true);
    expect(shouldClearProjectChatScope('alpha', 'latest', sessions)).toBe(
      false,
    );
    expect(shouldClearProjectChatScope('alpha', null, sessions)).toBe(false);
  });

  test('keeps cross-project sessions routable while project scope filters presentation', () => {
    const visibleSessions = sessions.filter(
      (session) => session.projectSlug === 'alpha',
    );

    expect(visibleSessions.some((session) => session.id === 'other')).toBe(
      false,
    );
    expect(
      sessions.find((session) => session.id === 'other')?.projectSlug,
    ).toBe('beta');
  });

  test('focus event routing clears scope before selecting a conversationless cross-project tab', () => {
    const clearProjectFilter = vi.fn();
    const focusSession = vi.fn();
    const conversationlessSessions = sessions.map((session) => ({
      ...session,
      conversationId: undefined,
    }));

    expect(
      focusRoutableChatSession(
        conversationlessSessions,
        'other',
        'alpha',
        clearProjectFilter,
        focusSession,
      ),
    ).toBe(true);
    expect(clearProjectFilter).toHaveBeenCalledOnce();
    expect(focusSession).toHaveBeenCalledWith('other');
    expect(clearProjectFilter.mock.invocationCallOrder[0]).toBeLessThan(
      focusSession.mock.invocationCallOrder[0],
    );
  });
});
