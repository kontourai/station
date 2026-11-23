/**
 * @vitest-environment jsdom
 *
 * A slash command Station runs is not unsent text: once it has run, the
 * chat's saved draft keeps none of its line, while the draft's quotes stay.
 * A command that did not run keeps its line in the composer, and saved, so it
 * can be corrected (#5491). The composer, the send, the command dispatch and
 * the draft store are the real ones; only the contexts around them are stood
 * in for.
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
const OTHER = 'slash-draft-other-chat';

const QUOTE = {
  version: 1 as const,
  origin: apiBase,
  sessionId: CHAT,
  turnId: 'turn-1',
  messageId: 'message-1',
  revision: 'a'.repeat(64),
  excerpt: 'the line the person quoted',
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <SDKProvider value={{ apiBase, contexts: {}, hooks: {} }}>
        <ActiveChatsProvider>{children}</ActiveChatsProvider>
      </SDKProvider>
    </QueryClientProvider>
  );
}

function renderComposer(onOpenNewChat = vi.fn(), sessionId = CHAT) {
  return renderHook(
    ({ id }: { id: string }) =>
      useChatInput({
        apiBase,
        sessionId: id,
        agentSlug: 'assistant',
        conversationId: undefined,
        availableModels: [],
        onOpenNewChat,
      }),
    { wrapper, initialProps: { id: sessionId } },
  );
}

const composerText = (id = CHAT) =>
  activeChatsStore.getSnapshot()[id]?.input ?? '';
const notices = () =>
  (activeChatsStore.getSnapshot()[CHAT]?.ephemeralMessages ?? []).map(
    (message) => String(message.content),
  );
/** Longer than the composer's 500 ms draft save. */
const pastDraftSave = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 650)));
const helpPick = {
  cmd: '/help',
  description: 'Show available commands',
  source: 'builtin' as const,
};

function openChat(id: string) {
  activeChatsStore.removeChat(id);
  activeChatsStore.initChat(id, {
    agentSlug: 'assistant',
    agentName: 'Assistant',
    title: 'Slash',
  });
  activeChatsStore.updateChat(id, { status: 'idle', provider: 'ollama' });
}

describe('slash commands and the saved draft', () => {
  beforeEach(() => {
    for (const id of [CHAT, OTHER]) {
      chatDraftsStore.clear(id);
      openChat(id);
    }
  });
  afterEach(() => {
    cleanup();
    for (const id of [CHAT, OTHER]) {
      chatDraftsStore.clear(id);
      activeChatsStore.removeChat(id);
    }
  });

  test('a command that ran leaves no saved text, so reopening the chat shows none', async () => {
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
      await result.current.handleCommandSelect(helpPick);
    });
    await pastDraftSave();
    expect(notices().some((notice) => notice.includes('/help'))).toBe(true);
    expect(chatDraftsStore.get(CHAT)).toBe('');
  });

  for (const path of ['Send', 'menu pick'] as const) {
    test(`a command that ran by ${path} keeps the draft's quotes, and its draft marker`, async () => {
      chatDraftsStore.addQuote(CHAT, QUOTE);
      const { result } = renderComposer();
      act(() => result.current.handleInputChange('/help'));
      await waitFor(() => expect(chatDraftsStore.get(CHAT)).toBe('/help'));
      await act(async () => {
        if (path === 'Send') await result.current.handleSend();
        else await result.current.handleCommandSelect(helpPick);
      });
      await pastDraftSave();
      expect(notices().some((notice) => notice.includes('/help'))).toBe(true);
      expect(chatDraftsStore.get(CHAT)).toBe('');
      expect(chatDraftsStore.getQuotes(CHAT)).toEqual([QUOTE]);
      // The inbox row's draft marker reads this: a quote alone still counts.
      expect(chatDraftsStore.hasDraft(CHAT)).toBe(true);
    });
  }

  test('/new runs by opening New chat and keeps no draft of its line', async () => {
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

  // Unknown, and refused before running (a line the parser cannot read):
  // nothing ran, so the line stays to be corrected, saved with it.
  for (const [line, said] of [
    ['/hlep me', 'Unknown command: /hlep me'],
    ['/help "unclosed', 'Could not read /help "unclosed'],
  ] as const) {
    test(`a command that did not run (${line}) keeps its line in the composer and saved`, async () => {
      const { result } = renderComposer();
      act(() => result.current.handleInputChange(line));
      await act(async () => {
        await result.current.handleSend();
      });
      await pastDraftSave();
      expect(notices().some((notice) => notice.startsWith(said))).toBe(true);
      expect(composerText()).toBe(line);
      expect(chatDraftsStore.get(CHAT)).toBe(line);
    });
  }

  test("a command in one chat leaves another chat's pending save to land", async () => {
    const { result, rerender } = renderComposer(vi.fn(), OTHER);
    // Typed in the other chat; its save is still pending when the person
    // moves to this chat and runs a command there.
    act(() => result.current.handleInputChange('notes for the other chat'));
    rerender({ id: CHAT });
    await act(async () => {
      await result.current.handleCommandSelect(helpPick);
    });
    await pastDraftSave();
    expect(chatDraftsStore.get(OTHER)).toBe('notes for the other chat');
    expect(chatDraftsStore.get(CHAT)).toBe('');
  });
});
