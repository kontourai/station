/**
 * @vitest-environment jsdom
 *
 * `prepareOutgoingText` is the send preparation every path out of the
 * composer takes, including a send armed for an Agent/engine handoff: quotes
 * are composed in, the size limit and the quote's Station are checked, and
 * nothing is sent (nothing reaches the ordinary sender) while preparing.
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
const showToast = vi.hoisted(() => vi.fn());
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useSkillsQuery: () => ({ data: [] }),
  useFeaturePreviewsQuery: () => ({ data: [] }),
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

import { CHAT_INPUT_MAX_CHARS } from '@shared/chat-input-limits';
import { mentionToken } from '../components/chat/composer-mentions';
import { activeChatsStore } from '../contexts/active-chats-store';
import { chatDraftsStore } from '../contexts/chat-drafts-store';
import { type PreparedOutgoingText, useChatInput } from '../hooks/useChatInput';

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
        workingDirectory: '/work/app',
        mentionAuthority: 'station-authority',
        mentionRequestScope: {
          apiBase: 'http://station.test',
          authorityKey: 'station-authority',
          isCurrent: () => true,
        },
      }),
    { wrapper },
  );
}

const quote = (origin = 'http://station.test') => ({
  version: 1 as const,
  origin,
  sessionId: CHAT,
  turnId: 'turn-1',
  messageId: 'message-1',
  revision: 'a'.repeat(64),
  excerpt: 'the quoted answer',
});

describe('prepareOutgoingText', () => {
  beforeEach(() => {
    send.mockClear();
    showToast.mockClear();
    activeChatsStore.removeChat(CHAT);
    activeChatsStore.initChat(CHAT, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'key',
      conversationId: CHAT,
    });
  });
  afterEach(() => {
    chatDraftsStore.consumeQuotes(CHAT, chatDraftsStore.getQuotes(CHAT));
    activeChatsStore.removeChat(CHAT);
  });

  test('a quote-only draft yields the quote as the text, with its quotes', async () => {
    chatDraftsStore.addQuote(CHAT, quote());
    const { result } = renderChatInput();
    let prepared: Awaited<
      ReturnType<typeof result.current.prepareOutgoingText>
    > = null;
    await act(async () => {
      prepared = await result.current.prepareOutgoingText('');
    });
    expect((prepared as unknown as PreparedOutgoingText).text).toContain(
      'the quoted answer',
    );
    expect((prepared as unknown as PreparedOutgoingText).draft).toBe('');
    expect((prepared as unknown as PreparedOutgoingText).quotes).toHaveLength(
      1,
    );
    expect(send).not.toHaveBeenCalled();
  });

  test('a quote from another Station is refused', async () => {
    chatDraftsStore.addQuote(CHAT, quote('http://other.test'));
    const { result } = renderChatInput();
    let prepared: unknown = 'unset';
    await act(async () => {
      prepared = await result.current.prepareOutgoingText('hi');
    });
    // The reason comes back for the caller to show; nothing is toasted here.
    expect(prepared).toEqual({
      refused: expect.stringContaining('another Station'),
    });
    expect(showToast).not.toHaveBeenCalled();
  });

  test('a draft over the message limit is refused', async () => {
    const { result } = renderChatInput();
    let prepared: unknown = 'unset';
    await act(async () => {
      prepared = await result.current.prepareOutgoingText(
        'x'.repeat(CHAT_INPUT_MAX_CHARS + 1),
      );
    });
    expect(prepared).toEqual({
      refused: expect.stringContaining('message limit'),
    });
  });

  test('a file mention is expanded to its workspace path; the raw draft is kept', async () => {
    const token = mentionToken({
      label: 'notes.md',
      path: 'docs/notes.md',
      workspace: '/work/app',
      authority: 'station-authority',
      type: 'file',
    });
    const { result } = renderChatInput();
    let prepared: Awaited<
      ReturnType<typeof result.current.prepareOutgoingText>
    > = null;
    await act(async () => {
      prepared = await result.current.prepareOutgoingText(
        `Read ${token} please`,
      );
    });
    expect((prepared as unknown as PreparedOutgoingText).text).toBe(
      'Read @"/work/app/docs/notes.md" please',
    );
    expect((prepared as unknown as PreparedOutgoingText).draft).toBe(
      `Read ${token} please`,
    );
    expect(send).not.toHaveBeenCalled();
  });

  test('an ordinary send still shows a refusal, as a toast', async () => {
    chatDraftsStore.addQuote(CHAT, quote('http://other.test'));
    const { result } = renderChatInput();
    await act(async () => {
      await result.current.handleSend('hi', []);
    });
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('another Station'),
      'error',
    );
    expect(send).not.toHaveBeenCalled();
  });
});
