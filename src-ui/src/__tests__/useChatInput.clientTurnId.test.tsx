/**
 * @vitest-environment jsdom
 *
 * A caller that derives its send key (Continue after a restart) passes it to
 * `handleSend`, and the send it makes carries exactly that key, so a repeat
 * names the same turn. An ordinary send leaves the key to the send itself.
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

describe('handleSend send key', () => {
  beforeEach(() => {
    send.mockClear();
    activeChatsStore.removeChat(CHAT);
    activeChatsStore.initChat(CHAT, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'key',
      conversationId: CHAT,
    });
  });
  afterEach(() => activeChatsStore.removeChat(CHAT));

  test('a caller-derived key reaches the send unchanged', async () => {
    const { result } = renderChatInput();
    await act(async () => {
      await result.current.handleSend('Continue', [], {
        clientTurnId: 'continue-interrupted:turn-boundary:1',
      });
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(sentKey()).toBe('continue-interrupted:turn-boundary:1');
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
