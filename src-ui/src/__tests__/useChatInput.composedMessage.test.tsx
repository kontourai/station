/**
 * @vitest-environment jsdom
 *
 * Continue after a restart sends a message Station composed through
 * `sendComposedMessage`: under the caller's key, with the composer left out of
 * it (no saved quotes, no attachments, the composer kept). An ordinary
 * `handleSend` still leaves the key to the send.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const send = vi.hoisted(() => vi.fn(async () => true));

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
  useAgent: () => ({ slug: 'codex', name: 'Codex' }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useSkillsQuery: () => ({ data: [] }),
  useProviderCommandsQuery: () => ({ data: [] }),
  useRunSkill: () => ({ mutateAsync: vi.fn() }),
  useSkillDetailReader: () => vi.fn(),
  agentMcpPromptsQueryKey: (slug: string) => ['agent-mcp-prompts', slug],
  runAgentMcpPrompt: vi.fn(),
  useAgentMcpPromptsQuery: () => ({ data: undefined }),
}));
vi.mock('../contexts/ActiveChatsContext', async () => {
  const { activeChatsStore } = await import('../contexts/active-chats-store');
  return {
    useActiveChatActions: () => ({
      updateChat: activeChatsStore.updateChat.bind(activeChatsStore),
      clearInput: activeChatsStore.clearInput.bind(activeChatsStore),
      addToInputHistory:
        activeChatsStore.addToInputHistory.bind(activeChatsStore),
    }),
    useActiveChatSelector: (
      sessionId: string,
      selector: (s: unknown) => unknown,
    ) => selector(activeChatsStore.getSnapshot()[sessionId] || null),
  };
});
vi.mock('../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => send,
  useCancelMessage: () => vi.fn(),
}));

import { activeChatsStore } from '../contexts/active-chats-store';
import { chatDraftsStore } from '../contexts/chat-drafts-store';
import { useChatInput } from '../hooks/useChatInput';

const CHAT = 'codex:client-turn-id';

function renderChatInput() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(
    () =>
      useChatInput({
        apiBase: 'http://station.test',
        sessionId: CHAT,
        agentSlug: 'codex',
        conversationId: CHAT,
        availableModels: [],
        attachmentCapabilities: { images: true, files: true },
      }),
    { wrapper },
  );
}

/** `sendMessage`'s seventh argument is the turn's send key. */
const sentKey = () => (send.mock.calls[0] as unknown[] | undefined)?.[6];

describe('sendComposedMessage', () => {
  beforeEach(() => {
    send.mockClear();
    activeChatsStore.removeChat(CHAT);
    activeChatsStore.initChat(CHAT, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'key',
      conversationId: CHAT,
    });
    chatDraftsStore.addQuote(CHAT, {
      version: 1,
      origin: 'http://station.test',
      sessionId: CHAT,
      turnId: 'turn-1',
      messageId: 'message-1',
      revision: 'a'.repeat(64),
      excerpt: 'a saved quote',
    });
  });
  afterEach(() => {
    chatDraftsStore.consumeQuotes(CHAT, chatDraftsStore.getQuotes(CHAT));
    activeChatsStore.removeChat(CHAT);
  });

  test('sends the text alone under the caller’s key, keeping the composer', async () => {
    const { result } = renderChatInput();
    await act(async () => {
      await result.current.sendComposedMessage(
        'Continue',
        'continue-interrupted:turn-boundary:1',
      );
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toEqual([
      CHAT,
      'codex',
      CHAT,
      'Continue',
      [],
      undefined,
      'continue-interrupted:turn-boundary:1',
      { preserveComposer: true },
    ]);
    // The saved quote stays for the person's own next message.
    expect(chatDraftsStore.getQuotes(CHAT)).toHaveLength(1);
  });

  test('an ordinary send leaves the key to the send', async () => {
    const { result } = renderChatInput();
    await act(async () => {
      await result.current.handleSend('hello', []);
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(sentKey()).toBeUndefined();
  });
});
