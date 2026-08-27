// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { FileAttachment } from '../types';

const openConversation = vi.fn();
const updateChat = vi.fn();
const setActiveChat = vi.fn();
const setDockState = vi.fn();
const getSnapshot = vi.fn();

vi.mock('../hooks/useActiveChatSessionLifecycle', () => ({
  useOpenConversation: () => openConversation,
}));
vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({ updateChat }),
}));
vi.mock('../contexts/active-chats-store', () => ({
  activeChatsStore: { getSnapshot: () => getSnapshot() },
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ setActiveChat, setDockState }),
}));

import { useShareToConversation } from '../hooks/useShareToConversation';

const ATTACHMENT: FileAttachment = {
  id: 'att-1',
  name: 'shared.png',
  type: 'image/png',
  size: 3,
  data: 'data:image/png;base64,YWJj',
  preview: 'data:image/png;base64,YWJj',
};

const TARGET = {
  conversationId: 'conv-1',
  agentSlug: 'agent-one',
  agentName: 'Agent One',
};

beforeEach(() => {
  vi.clearAllMocks();
  openConversation.mockResolvedValue('agent-one:123');
  getSnapshot.mockReturnValue({});
});

describe('useShareToConversation', () => {
  test('opens the conversation and seeds the attachment into its composer', async () => {
    const { result } = renderHook(() =>
      useShareToConversation('http://api.test'),
    );

    const sessionId = await result.current(TARGET, [ATTACHMENT]);

    expect(sessionId).toBe('agent-one:123');
    expect(openConversation).toHaveBeenCalledWith(
      'conv-1',
      'agent-one',
      'Agent One',
      undefined,
      undefined,
      undefined,
    );
    expect(updateChat).toHaveBeenCalledWith('agent-one:123', {
      attachments: [ATTACHMENT],
    });
    expect(setActiveChat).toHaveBeenCalledWith('agent-one:123');
    expect(setDockState).toHaveBeenCalledWith(true);
  });

  test('appends to an existing composer draft instead of clobbering it', async () => {
    const existing: FileAttachment = { ...ATTACHMENT, id: 'existing' };
    getSnapshot.mockReturnValue({
      'agent-one:123': { attachments: [existing] },
    });

    const { result } = renderHook(() =>
      useShareToConversation('http://api.test'),
    );

    await result.current(TARGET, [ATTACHMENT]);

    expect(updateChat).toHaveBeenCalledWith('agent-one:123', {
      attachments: [existing, ATTACHMENT],
    });
  });

  test('skips the composer write when there are no attachments', async () => {
    const { result } = renderHook(() =>
      useShareToConversation('http://api.test'),
    );

    await result.current(TARGET, []);

    expect(updateChat).not.toHaveBeenCalled();
    expect(setActiveChat).toHaveBeenCalledWith('agent-one:123');
  });
});
