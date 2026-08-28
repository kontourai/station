import { beforeEach, describe, expect, test, vi } from 'vitest';

const updateChat = vi.fn();
const fetchMessages = vi.fn();
const refreshMessages = vi.fn();
let messagesByKey: Record<string, unknown[]> = {};

vi.mock('../../../contexts/active-chats-store', () => ({
  activeChatsStore: {
    updateChat: (...args: unknown[]) => updateChat(...args),
  },
}));

vi.mock('../../../contexts/conversations-store', () => ({
  conversationsStore: {
    fetchMessages: (...args: unknown[]) => fetchMessages(...args),
    refreshMessages: (...args: unknown[]) => refreshMessages(...args),
    getSnapshot: () => ({ messages: messagesByKey }),
  },
}));

import { rehydrateChatSession } from '../rehydrateChatSession';

describe('rehydrateChatSession (station#1225)', () => {
  beforeEach(() => {
    updateChat.mockClear();
    fetchMessages.mockClear();
    refreshMessages.mockClear();
    messagesByKey = {};
  });

  test('is a no-op when the chat has no agentSlug/conversationId', async () => {
    await rehydrateChatSession('http://api', 'session-1', { inputHistory: [] });
    expect(fetchMessages).not.toHaveBeenCalled();
    expect(refreshMessages).not.toHaveBeenCalled();
    expect(updateChat).not.toHaveBeenCalled();
  });

  test('uses the cheaper fetchMessages path by default (mirrors pre-extraction useRehydrateSessions behavior)', async () => {
    messagesByKey['messages:agent-1:conv-1'] = [
      { role: 'user', content: 'hi' },
    ];
    await rehydrateChatSession('http://api', 'session-1', {
      agentSlug: 'agent-1',
      conversationId: 'conv-1',
      inputHistory: [],
    });

// archive#1225 the 4th positional arg is
// `queryClient` — `undefined` here since none was supplied, NOT simply
// absent from the call. Pinning the exact arity/shape is the point: the
// regressed extraction called `fetchMessages(apiBase, agentSlug,
// conversationId)` with no 4th arg at all, silently dropping the
// `toolMappings` cache lookup on every mount-time rehydrate.
    expect(fetchMessages).toHaveBeenCalledWith(
      'http://api',
      'agent-1',
      'conv-1',
      undefined,
    );
    expect(refreshMessages).not.toHaveBeenCalled();
    expect(updateChat).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        messages: [expect.objectContaining({ role: 'user', content: 'hi' })],
      }),
    );
  });

  test('force:true bypasses the in-flight/cached guard via refreshMessages', async () => {
    messagesByKey['messages:agent-1:conv-1'] = [];
    await rehydrateChatSession(
      'http://api',
      'session-1',
      { agentSlug: 'agent-1', conversationId: 'conv-1', inputHistory: [] },
      { force: true },
    );

    expect(refreshMessages).toHaveBeenCalledWith(
      'http://api',
      'agent-1',
      'conv-1',
      undefined,
    );
    expect(fetchMessages).not.toHaveBeenCalled();
  });

  test('station#1225 review (MEDIUM fix): a supplied queryClient is forwarded verbatim to fetchMessages', async () => {
    messagesByKey['messages:agent-1:conv-1'] = [];
    const fakeQueryClient = { getQueryData: vi.fn() } as any;
    await rehydrateChatSession(
      'http://api',
      'session-1',
      { agentSlug: 'agent-1', conversationId: 'conv-1', inputHistory: [] },
      { queryClient: fakeQueryClient },
    );

    expect(fetchMessages).toHaveBeenCalledWith(
      'http://api',
      'agent-1',
      'conv-1',
      fakeQueryClient,
    );
  });

  test('station#1225 review (MEDIUM fix): a supplied queryClient is forwarded verbatim to refreshMessages (force path)', async () => {
    messagesByKey['messages:agent-1:conv-1'] = [];
    const fakeQueryClient = { getQueryData: vi.fn() } as any;
    await rehydrateChatSession(
      'http://api',
      'session-1',
      { agentSlug: 'agent-1', conversationId: 'conv-1', inputHistory: [] },
      { force: true, queryClient: fakeQueryClient },
    );

    expect(refreshMessages).toHaveBeenCalledWith(
      'http://api',
      'agent-1',
      'conv-1',
      fakeQueryClient,
    );
  });

  test("preserves the chat's existing planArtifact when the refreshed transcript has none", async () => {
    messagesByKey['messages:agent-1:conv-1'] = [
      { role: 'assistant', content: 'no plan here' },
    ];
    await rehydrateChatSession('http://api', 'session-1', {
      agentSlug: 'agent-1',
      conversationId: 'conv-1',
      inputHistory: [],
      planArtifact: { title: 'existing plan' } as any,
    });

    expect(updateChat).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ planArtifact: { title: 'existing plan' } }),
    );
  });
});
