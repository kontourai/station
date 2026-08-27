import { beforeEach, describe, expect, test, vi } from 'vitest';

const { showToolActivity, setDockState, setActiveChat, getSnapshot } =
  vi.hoisted(() => ({
    showToolActivity: vi.fn(),
    setDockState: vi.fn(),
    setActiveChat: vi.fn(),
    getSnapshot: vi.fn(),
  }));

vi.mock('../contexts/ToastContext', () => ({
  toastStore: {
    showToolActivity,
  },
}));

vi.mock('../contexts/NavigationContext', () => ({
  navigationStore: {
    getSnapshot,
    setDockState,
    setActiveChat,
  },
}));

import type { ChatUIState } from '../contexts/active-chats-state';
import {
  notifyToolCompletion,
  shouldNotifyForToolCompletion,
  summarizeToolActivityDetail,
} from '../hooks/orchestration/toolActivityNotifications';

const baseChat: ChatUIState = {
  input: '',
  attachments: [],
  queuedMessages: [],
  inputHistory: [],
  hasUnread: false,
  agentSlug: 'dev-agent',
  agentName: 'Dev Agent',
  title: 'Repo Chat',
  conversationId: 'conv-1',
};

describe('tool activity notifications', () => {
  beforeEach(() => {
    showToolActivity.mockReset();
    setDockState.mockReset();
    setActiveChat.mockReset();
    getSnapshot.mockReturnValue({
      activeChat: 'other-session',
      activeConversation: 'other-conversation',
      isDockOpen: true,
    });
  });

  test('summarizes useful tool output details', () => {
    expect(summarizeToolActivityDetail('  alpha  ')).toBe('alpha');
    expect(
      summarizeToolActivityDetail({ output: 'directory listing complete' }),
    ).toBe('directory listing complete');
  });

  test('suppresses success toasts for the foreground chat', () => {
    getSnapshot.mockReturnValue({
      activeChat: 'conv-1',
      activeConversation: 'conv-1',
      isDockOpen: true,
    });

    expect(
      shouldNotifyForToolCompletion(
        {
          provider: 'codex',
          threadId: 'session-1',
          createdAt: '2026-04-11T00:00:00.000Z',
          method: 'tool.completed',
          itemId: 'tool-1',
          toolCallId: 'tool-1',
          toolName: 'shell_exec',
          status: 'success',
          output: { output: 'done' },
        },
        baseChat,
      ),
    ).toBe(false);
  });

  test('always surfaces error tool outcomes and wires navigation back to the session', () => {
    notifyToolCompletion(
      {
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-04-11T00:00:00.000Z',
        method: 'tool.completed',
        itemId: 'tool-1',
        toolCallId: 'tool-1',
        toolName: 'shell_exec',
        status: 'error',
        error: 'Permission denied',
      },
      baseChat,
    );

    expect(showToolActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        toolName: 'shell exec',
        agentName: 'Dev Agent',
        conversationTitle: 'Repo Chat',
        status: 'error',
        detail: 'Permission denied',
        onNavigate: expect.any(Function),
      }),
    );

    const onNavigate = showToolActivity.mock.calls[0][0]
      .onNavigate as () => void;
    onNavigate();
    expect(setDockState).toHaveBeenCalledWith(true);
    expect(setActiveChat).toHaveBeenCalledWith('conv-1');
  });
});
