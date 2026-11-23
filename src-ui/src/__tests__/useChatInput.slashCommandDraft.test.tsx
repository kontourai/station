/**
 * @vitest-environment jsdom
 *
 * A slash command Station answers is not unsent text: once it is answered, the
 * chat's saved draft does not keep its line (#5491). The composer, the send,
 * the command dispatch and the draft store are the real ones; only the
 * contexts around them are stood in for.
 */

import { SDKProvider } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const requestScope = vi.hoisted(() => ({
  apiBase: 'http://slash.station',
  authorityKey: 'reader',
  requiresEnrolledCredential: false,
  isCurrent: () => true,
}));

vi.mock('../contexts/AuthorityPersistenceContext', () => ({
  useAuthorityPersistence: () => ({ namespace: 'fixture', status: 'verified' }),
}));
vi.mock('../contexts/AccountPreferencesContext', () => ({
  useAccountPreferences: () => ({
    status: 'account',
    data: { schemaVersion: 1, values: { interactiveApprovalModes: {} } },
    requestScope,
  }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://slash.station' }),
  useHostRequestAuthorityScope: () => requestScope,
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [{ slug: 'assistant', name: 'Assistant' }],
  useAgentsLoaded: () => true,
  useAgent: () => ({ slug: 'assistant', name: 'Assistant' }),
}));

import { ActiveChatsProvider } from '../contexts/ActiveChatsContext';
import { activeChatsStore } from '../contexts/active-chats-store';
import { chatDraftsStore } from '../contexts/chat-drafts-store';
import { useChatInput } from '../hooks/useChatInput';

const apiBase = 'http://slash.station';
const CHAT = 'slash-draft-chat';

function renderComposer(onOpenNewChat = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <SDKProvider value={{ apiBase, contexts: {}, hooks: {} }}>
        <ActiveChatsProvider>{children}</ActiveChatsProvider>
      </SDKProvider>
    </QueryClientProvider>
  );
  return renderHook(
    () =>
      useChatInput({
        apiBase,
        sessionId: CHAT,
        agentSlug: 'assistant',
        conversationId: undefined,
        availableModels: [],
        onOpenNewChat,
      }),
    { wrapper },
  );
}

const composerText = () => activeChatsStore.getSnapshot()[CHAT]?.input ?? '';
const notices = () =>
  (activeChatsStore.getSnapshot()[CHAT]?.ephemeralMessages ?? []).map(
    (message) => String(message.content),
  );
/** Longer than the composer's 500 ms draft save. */
const pastDraftSave = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 650)));

describe('slash commands and the saved draft', () => {
  beforeEach(() => {
    chatDraftsStore.clear(CHAT);
    activeChatsStore.removeChat(CHAT);
    activeChatsStore.initChat(CHAT, {
      agentSlug: 'assistant',
      agentName: 'Assistant',
      title: 'Slash',
    });
    activeChatsStore.updateChat(CHAT, { status: 'idle', provider: 'ollama' });
  });
  afterEach(() => {
    cleanup();
    chatDraftsStore.clear(CHAT);
    activeChatsStore.removeChat(CHAT);
  });

  test('an answered command leaves no saved draft, so reopening the chat shows none', async () => {
    const { result, unmount } = renderComposer();
    act(() => result.current.handleInputChange('/help'));
    // Typed and not yet sent, the line is unsent text like any other.
    await waitFor(() => expect(chatDraftsStore.get(CHAT)).toBe('/help'));

    await act(async () => {
      await result.current.handleSend();
    });
    expect(notices().some((notice) => notice.includes('/help'))).toBe(true);
    expect(composerText()).toBe('');
    expect(chatDraftsStore.get(CHAT)).toBe('');

    // Reopening restores a saved draft into an empty composer; none is left.
    unmount();
    renderComposer();
    await pastDraftSave();
    expect(composerText()).toBe('');
  });

  test('a command picked from the menu also drops the half-typed line saved for it', async () => {
    const { result } = renderComposer();
    act(() => result.current.handleInputChange('/he'));
    await act(async () => {
      await result.current.handleCommandSelect({
        cmd: '/help',
        desc: 'Show available commands',
      } as Parameters<typeof result.current.handleCommandSelect>[0]);
    });
    await pastDraftSave();
    expect(notices().some((notice) => notice.includes('/help'))).toBe(true);
    expect(chatDraftsStore.get(CHAT)).toBe('');
  });

  test('/new answers by opening New chat and keeps no draft of its line', async () => {
    const onOpenNewChat = vi.fn();
    const { result } = renderComposer(onOpenNewChat);
    act(() => result.current.handleInputChange('/new'));
    await act(async () => {
      await result.current.handleSend();
    });
    expect(onOpenNewChat).toHaveBeenCalledTimes(1);
    expect(chatDraftsStore.get(CHAT)).toBe('');
  });

  test('a command that leaves its line in the composer keeps it saved', async () => {
    // `/new` takes no text: the line stays as typed so nothing is lost.
    const onOpenNewChat = vi.fn();
    const { result } = renderComposer(onOpenNewChat);
    act(() => result.current.handleInputChange('/new about the release'));
    await act(async () => {
      await result.current.handleSend();
    });
    expect(onOpenNewChat).not.toHaveBeenCalled();
    expect(composerText()).toBe('/new about the release');
    expect(chatDraftsStore.get(CHAT)).toBe('/new about the release');
  });
});
