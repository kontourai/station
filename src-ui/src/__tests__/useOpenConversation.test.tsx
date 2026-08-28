/**
 * @vitest-environment jsdom
 */

/**
 * archive#1312 (should-fix #2): `conversationsStore.fetchMessages`
 * swallows its own errors and leaves `messages` as `[]` — before this fix,
 * `useOpenConversation` awaited it unconditionally and always "succeeded,"
 * so an orchestration row whose agent exists but whose conversation fetch
 * 404s/errors rehydrated into a live, permanently EMPTY chat tab with no
 * visible error. That is a regression against the pre-archive#1297
 * always-navigate-to-/activity fallback for that population. These tests
 * pin the fix: a failed fetch tears the just-created tab back down
 * (`removeChat`) and resolves `null` so `useChatDockActions`' `openConversation`
 * reports failure to the row-open policy, which then falls back to
 * `onOpenSession`/`/activity` instead of leaving an orphaned empty tab.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initChat: vi.fn(),
  updateChat: vi.fn(),
  removeChat: vi.fn(),
  fetchMessages: vi.fn(),
  messages: {} as Record<string, unknown[]>,
}));

vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({
    initChat: mocks.initChat,
    updateChat: mocks.updateChat,
    removeChat: mocks.removeChat,
  }),
}));

vi.mock('../contexts/ConversationsContext', () => ({
  useConversationActions: () => ({ fetchMessages: mocks.fetchMessages }),
  conversationsStore: {
    getSnapshot: () => ({ messages: mocks.messages }),
  },
}));

vi.mock('../contexts/active-chats-store', () => ({
  activeChatsStore: {
    getSnapshot: () => ({}),
  },
}));

import {
  useCreateChatSession,
  useOpenConversation,
} from '../hooks/useActiveChatSessionLifecycle';

// archive#1311: `useOpenConversation` now also calls `useQueryClient`
// (to resolve a reopened conversation's real `updatedAt` — see
// `resolveConversationUpdatedAt`), so every `renderHook` needs a
// `QueryClientProvider` in its tree; an empty, otherwise-unused client is
// enough since these tests only exercise the fetch-failure/success paths.
function withQueryClient() {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper };
}

describe('useOpenConversation fetch-failure handling', () => {
  beforeEach(() => {
    mocks.initChat.mockClear();
    mocks.updateChat.mockClear();
    mocks.removeChat.mockClear();
    mocks.fetchMessages.mockReset();
    mocks.messages = {};
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('starts a new chat with a neutral local label, never an agent-name placeholder', () => {
    const { result } = renderHook(() => useCreateChatSession());

    result.current('claude-code', 'Claude Code');

    expect(mocks.initChat).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ title: 'New chat' }),
    );
  });

  it('tears down the just-created tab and resolves null when the fetch fails (agent exists)', async () => {
    mocks.fetchMessages.mockResolvedValue(false);
    const { result } = renderHook(
      () => useOpenConversation('http://api'),
      withQueryClient(),
    );

    const sessionId = await result.current(
      'thread-1',
      'claude-code',
      'Claude Code',
      'station',
      'Station',
    );

    expect(sessionId).toBeNull();
// The tab was created (initChat) before the fetch resolved...
    expect(mocks.initChat).toHaveBeenCalledTimes(1);
    expect(mocks.initChat).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ title: 'New chat' }),
    );
    const createdSessionId = mocks.initChat.mock.calls[0][0];
//.and then torn back down — no orphan tab left in the store.
    expect(mocks.removeChat).toHaveBeenCalledWith(createdSessionId);
    expect(mocks.updateChat).not.toHaveBeenCalled();
  });

  it('keeps the tab and resolves the session id when the fetch succeeds', async () => {
    mocks.fetchMessages.mockResolvedValue(true);
    const { result } = renderHook(
      () => useOpenConversation('http://api'),
      withQueryClient(),
    );

    const sessionId = await result.current(
      'thread-2',
      'claude-code',
      'Claude Code',
    );

    expect(sessionId).not.toBeNull();
    expect(mocks.removeChat).not.toHaveBeenCalled();
    expect(mocks.updateChat).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ messages: expect.any(Array) }),
    );
  });

  it('reopens a conversation without a recorded model using the agent default', async () => {
    mocks.fetchMessages.mockResolvedValue(true);
    const { result } = renderHook(
      () => useOpenConversation('http://api'),
      withQueryClient(),
    );

    await result.current(
      'thread-default',
      'claude-code',
      'Claude Code',
      undefined,
      undefined,
      {
        executionMode: 'external',
        model: 'claude-sonnet',
        modelSource: 'agent default',
        defaultModel: 'claude-sonnet',
        defaultModelSource: 'agent default',
        providerOptions: {},
      },
    );

    expect(mocks.initChat).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        model: 'claude-sonnet',
        modelSource: 'agent default',
      }),
    );
  });

  it('anchors a cold-cache inbox reopen to the explicit inventory updatedAt', async () => {
    mocks.fetchMessages.mockResolvedValue(true);
    mocks.messages = {
      'messages:claude-code:thread-cold': [
        { role: 'user', content: 'old message without a timestamp' },
      ],
    };
    const { result } = renderHook(
      () => useOpenConversation('http://api'),
      withQueryClient(),
    );
    const updatedAt = '2020-06-15T12:00:00.000Z';

    const sessionId = await result.current(
      'thread-cold',
      'claude-code',
      'Claude Code',
      undefined,
      undefined,
      undefined,
      updatedAt,
    );

    expect(mocks.updateChat).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        messages: [
          expect.objectContaining({ timestamp: Date.parse(updatedAt) }),
        ],
      }),
    );
  });

  it('opens every managed provider conversation through its bounded session reader', async () => {
    const { result } = renderHook(
      () => useOpenConversation('http://api'),
      withQueryClient(),
    );

    const sessionId = await result.current(
      'thread-managed',
      'claude-code',
      'Claude Code',
      undefined,
      undefined,
      { provider: 'bedrock', executionMode: 'station', providerOptions: {} },
    );

    expect(sessionId).toBe('thread-managed');
    expect(mocks.fetchMessages).not.toHaveBeenCalled();
    expect(mocks.initChat).toHaveBeenCalledWith(
      'thread-managed',
      expect.objectContaining({
        orchestrationSessionStarted: true,
        provider: 'bedrock',
      }),
    );
  });

  it('hydrates copied replay history for a fork before its first managed Session', async () => {
    mocks.fetchMessages.mockResolvedValue(true);
    mocks.messages = {
      'messages:claude-code:fork-child': [
        { role: 'assistant', content: 'Copied parent answer' },
      ],
    };
    const { result } = renderHook(
      () => useOpenConversation('http://api'),
      withQueryClient(),
    );

    const sessionId = await result.current(
      'fork-child',
      'claude-code',
      'Claude Code',
      undefined,
      undefined,
      { provider: 'claude', executionMode: 'external', providerOptions: {} },
      undefined,
      true,
    );

    expect(sessionId).toBe('fork-child');
    expect(mocks.fetchMessages).toHaveBeenCalledWith(
      'http://api',
      'claude-code',
      'fork-child',
    );
    expect(mocks.updateChat).toHaveBeenCalledWith(
      'fork-child',
      expect.objectContaining({
        messages: [
          expect.objectContaining({ content: 'Copied parent answer' }),
        ],
      }),
    );
    expect(mocks.initChat).toHaveBeenCalledWith(
      'fork-child',
      expect.objectContaining({ orchestrationSessionStarted: false }),
    );
  });
});
